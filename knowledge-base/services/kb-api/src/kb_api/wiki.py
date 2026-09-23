"""Destilacao: a representacao WIKI, em paginas OKF atomicas (ING-11, E4b).

O CONTRASTE QUE DEFINE ESTE MODULO

A canonicalizacao (`extract.py`) PRESERVA o texto: extrai a essencia sem
reescrever. A destilacao REESCREVE. Sao o oposto uma da outra de proposito, e e
por isso que a wiki e uma representacao separada e nao um passo do indice: o
canonico continua sendo a fonte de verdade, e a wiki e uma leitura dele.

AUTONOMIA SOBRE A WIKI DO ESPACO, E NAO UMA PAGINA POR DOCUMENTO

A especificacao e explicita: a LLM "opera com autonomia sobre a wiki do Espaco
(criar, editar, mesclar, reorganizar paginas)". Isso muda o desenho de um jeito
que e facil errar: o modelo nao recebe so o documento, recebe tambem o INDICE DA
WIKI ATUAL, e decide onde aquele conhecimento cabe. Um documento novo sobre
ferias pode virar uma pagina nova, ou pode ser incorporado a pagina de ferias
que ja existe -- e as duas saidas sao corretas.

A consequencia pratica: uma pagina pode derivar de VARIOS documentos, e um
documento alimenta VARIAS paginas. Por isso `wiki_page_source` e tabela, e nao
um campo.

O CONTRATO DE DESTILACAO, QUE E O QUE MANTEM A WIKI UTIL

Regras fixas do prompt, independentes do modelo:

* **paginas atomicas**: um conceito por pagina, 200 a 800 palavras. E o que
  dispensa chunking -- a unidade de entrega ja nasce do tamanho certo;
* **OKF puro** (v0.2): frontmatter YAML com `type` obrigatorio, mais `title`,
  `description`, `tags` por convencao, `generated: {by, at}` na convencao de
  ator do padrao, e `sources` apontando para o id do documento canonico;
* **referencias cruzadas** como links Markdown comuns, que e o que transforma o
  diretorio num grafo navegavel pelo `fetch`.

O QUE NUNCA E DESTILADO

`sources` aponta para o documento CANONICO, nunca para o bruto nem para fonte
externa. E a amarra que mantem a rastreabilidade fechada dentro do sistema: uma
pagina que citasse o PDF original faria a auditoria sair do que o indice
realmente viu.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime

from . import llm, okf, progresso
from .config import settings
from .db import as_vector, conn, jsonb
from .embedding import embed

log = logging.getLogger(__name__)

# Contrato de destilacao: a faixa de tamanho de uma pagina atomica. Nao e
# estetica -- e o que dispensa o chunking na wiki. Pagina fora da faixa continua
# valendo (recusar seria jogar conhecimento fora), mas fica marcada para o lint.
PALAVRAS_MIN = 200
PALAVRAS_MAX = 800

# Quanto do canonico vai no pedido de destilacao. Um documento de 120 paginas
# nao cabe, e mandar tudo multiplicaria o custo sem melhorar a sintese: o modelo
# destila melhor um trecho coerente do que um despejo truncado no meio.
LIMITE_DOCUMENTO = 12000

# Teto de paginas por documento. Sem ele, um modelo prolixo transforma um
# documento em trinta paginas de duas linhas e a wiki perde a atomicidade que e
# o ponto dela.
MAX_PAGINAS_POR_DOCUMENTO = 6

_INSTRUCAO = """Você mantém uma wiki corporativa em formato OKF a partir de documentos.

Recebe UM documento e o índice das páginas que já existem. Decide onde aquele \
conhecimento cabe: criar página nova, reescrever uma existente para incorporá-lo, \
ou as duas coisas.

Responda APENAS com um objeto JSON:

{"paginas": [{"path": "pasta/nome.md", "acao": "escrever", "conteudo": "<arquivo OKF completo>"}]}

Contrato de cada página (obrigatório):

- **atômica**: UM conceito por página, entre %(min)d e %(max)d palavras no corpo \
(sem contar o frontmatter). Documento que cobre três assuntos vira três páginas, \
não uma. **Conte as palavras antes de responder**: abaixo de %(min)d, desenvolva \
o contexto e as implicações do conceito até chegar lá — medido, as páginas saem \
perto de 190 e ficam fora do contrato por pouco;
- **OKF puro**: começa com frontmatter YAML entre `---`, com `type` (obrigatório), \
`title`, `description` (uma frase) e `tags`. Depois, o corpo em Markdown com \
seções `##`;
- **reescreva, não copie**: sintetize em prosa direta. Não cole trechos do \
documento nem transcreva tabelas inteiras;
- **referências cruzadas**: quando citar outro conceito que existe no índice, use \
link Markdown para o caminho dele (`[férias](/rh/ferias.md)`);
- **`path`** em minúsculas, sem acento, terminando em `.md`.

Para incorporar conhecimento a uma página existente, use o `path` dela e devolva \
o conteúdo COMPLETO da página reescrita — não um trecho.

Regras:
- responda em português do Brasil;
- use SOMENTE o que está no documento. Não complete com conhecimento externo;
- no máximo %(teto)d páginas nesta resposta;
- não invente `generated` nem `sources` no frontmatter: o sistema preenche."""


@dataclass
class Pagina:
    """Uma pagina da wiki, ja com o frontmatter do sistema aplicado."""

    path: str
    content: str
    type: str = ""
    title: str = ""
    description: str = ""
    tags: list[str] = field(default_factory=list)
    words: int = 0
    secoes: list[tuple[str, str]] = field(default_factory=list)

    @property
    def fora_do_contrato(self) -> bool:
        return not (PALAVRAS_MIN <= self.words <= PALAVRAS_MAX)


_SECAO_RE = re.compile(r"^(#{1,6})\s+(.+)$", re.MULTILINE)


def secoes(corpo: str) -> list[tuple[str, str]]:
    """As secoes da pagina: (cabecalho, texto), para o multi-vetor.

    Cada uma vira UM vetor de matching, e todos resolvem para a pagina inteira.
    Pagina sem cabecalho nenhum devolve uma secao so com o corpo todo -- a rede
    de seguranca nao pode virar "pagina curta nao entra no indice".
    """
    corpo = (corpo or "").strip()
    if not corpo:
        return []
    marcas = list(_SECAO_RE.finditer(corpo))
    if not marcas:
        return [("", corpo)]
    saida: list[tuple[str, str]] = []
    inicio = marcas[0].start()
    if inicio > 0:
        # O texto antes do primeiro cabecalho e a abertura da pagina, e costuma
        # ser a definicao do conceito -- justamente o que mais casa com pergunta.
        abertura = corpo[:inicio].strip()
        if abertura:
            saida.append(("", abertura))
    for indice, marca in enumerate(marcas):
        fim = marcas[indice + 1].start() if indice + 1 < len(marcas) else len(corpo)
        titulo = marca.group(2).strip()
        texto = corpo[marca.end() : fim].strip()
        if texto or titulo:
            saida.append((titulo, f"{titulo}\n\n{texto}".strip()))
    return saida


# Palavra com letra acentuada inclusa: "férias" e "avaliação" sao exatamente os
# termos que decidem afinidade num acervo em portugues.
_PALAVRA = re.compile(r"[0-9A-Za-zÀ-ÿ]+")

# Teto do indice que vai no prompt, em paginas.
#
# ⚠ ELE CRESCE, E O PROMPT CRESCE JUNTO. O indice inteiro era reenviado em CADA
# destilacao. Medido numa carga real: 8.466 caracteres com 35 paginas, e a
# mesma base fechou com 74 -- perto de 18 mil caracteres de contexto gasto antes
# de o modelo ver uma linha do documento. Numa base de trezentos documentos isso
# nao cabe em orcamento nenhum.
#
# Quarenta e o ponto em que o indice ainda cabe em poucos milhares de caracteres
# e ainda descreve a wiki. O numero e um teto declarado, nao uma calibragem: o
# valor bom vem de medir a destilacao com e sem, que e trabalho de benchmark.
MAX_PAGINAS_NO_INDICE = 40


def _indice_do_espaco(space_slug: str, titulo: str = "") -> list[dict]:
    """O indice da wiki atual, que e o que da autonomia ao modelo.

    Sem ele a destilacao so saberia criar pagina nova, e a wiki viraria uma
    pagina por documento -- exatamente o que a especificacao NAO quer.

    Acima de `MAX_PAGINAS_NO_INDICE`, manda as paginas mais PROXIMAS do
    documento em vez das primeiras em ordem alfabetica. A proximidade e lexical
    (palavras em comum entre o titulo do documento e o titulo/descricao da
    pagina), e nao vetorial, de proposito: uma ida ao provedor de embedding para
    montar prompt encareceria a destilacao que ja e a representacao mais cara.

    Cortar por ordem alfabetica seria pior que cortar por afinidade: o modelo
    receberia sempre as mesmas paginas do comeco do alfabeto e nunca as do
    assunto que ele esta destilando.
    """
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            "SELECT path, type, title, description FROM wiki_page WHERE space_slug = %s "
            "ORDER BY path",
            (space_slug,),
        )
        paginas = [
            {"path": linha[0], "type": linha[1], "title": linha[2], "description": linha[3]}
            for linha in cur.fetchall()
        ]

    if len(paginas) <= MAX_PAGINAS_NO_INDICE:
        return paginas

    termos = {t for t in _PALAVRA.findall((titulo or "").lower()) if len(t) > 3}

    def afinidade(pagina: dict) -> int:
        texto = f"{pagina.get('title') or ''} {pagina.get('description') or ''}".lower()
        return sum(1 for t in termos if t in texto)

    ordenadas = sorted(paginas, key=afinidade, reverse=True)[:MAX_PAGINAS_NO_INDICE]
    # De volta a ordem de caminho: lista estavel e mais facil de o modelo ler, e
    # a ordem por afinidade nao significa nada para ele.
    return sorted(ordenadas, key=lambda p: p["path"])


# Cerca de codigo em volta do arquivo OKF. O modelo devolve o conteudo da pagina
# dentro de ```markdown ... ``` com alguma frequencia, mesmo o prompt pedindo o
# arquivo cru -- e `okf.parse` exige que o texto COMECE com `---`. Recusar por
# causa da embalagem joga fora uma pagina correta, e foi o que aconteceu: numa
# rodada do e2e as CINCO paginas foram descartadas por isso.
_CERCA = re.compile(r"\A\s*```[a-zA-Z]*\s*\n(.*?)\n?\s*```\s*\Z", re.DOTALL)


def _desembrulhar(bruto: str) -> str:
    """O arquivo OKF sem a embalagem que o modelo as vezes poe em volta."""
    texto = (bruto or "").strip()
    cerca = _CERCA.match(texto)
    return (cerca.group(1) if cerca else texto).strip()


def _preparar(path: str, bruto: str, document_id: int, modelo: str) -> Pagina | None:
    """Aplica o frontmatter do SISTEMA sobre o que o modelo escreveu.

    `generated` e `sources` sao do sistema, e nao do modelo: pedir que ele os
    escreva convidaria a inventar id de documento, e a rastreabilidade
    dependeria de o modelo acertar um numero. O prompt diz para nao escreve-los;
    aqui eles sao impostos, sobrescrevendo se vierem.
    """
    conceito = okf.parse(_desembrulhar(bruto))
    if conceito is None:
        # O comeco do que veio vai no log: sem ele, diagnosticar exige reproduzir
        # a ingestao inteira para ver o que o modelo escreveu.
        log.warning(
            "pagina %s nao saiu em OKF valido; descartada. Comeco: %r",
            path, (bruto or "")[:120],
        )
        return None

    meta = dict(conceito.meta)
    meta["generated"] = {
        "by": f"kb-api/{modelo}",
        "at": datetime.now(UTC).isoformat(timespec="seconds"),
    }
    # `resource` aponta para o CANONICO, nunca para o bruto: a auditoria tem de
    # cair no texto que o indice viu.
    anteriores = [s for s in (meta.get("sources") or []) if isinstance(s, dict)]
    resource = f"documento:{document_id}"
    if not any(s.get("resource") == resource for s in anteriores):
        anteriores.append({"resource": resource})
    meta["sources"] = anteriores

    try:
        import yaml

        frontmatter = yaml.safe_dump(meta, allow_unicode=True, sort_keys=False).strip()
    except Exception as exc:  # noqa: BLE001
        log.warning("nao consegui remontar o frontmatter de %s: %s", path, exc)
        return None

    corpo = conceito.body.strip()
    return Pagina(
        path=path,
        content=f"---\n{frontmatter}\n---\n\n{corpo}\n",
        type=conceito.type,
        title=conceito.title,
        description=conceito.description,
        tags=conceito.tags,
        words=len(corpo.split()),
        secoes=secoes(corpo),
    )


def destilar(
    space_slug: str, document_id: int, titulo: str, canonical: str
) -> tuple[list[Pagina], str]:
    """Pede ao modelo as paginas que este documento gera ou altera.

    NUNCA levanta. Sem provedor de chat, rede fora ou resposta invalida, devolve
    lista vazia -- e o build da wiki falha sozinho, sem derrubar o do indice. A
    especificacao pede exatamente isso: "os builds sao independentes entre si na
    execucao: a falha de um nao impede o andamento dos outros".
    """
    corpo = (canonical or "").strip()
    if not corpo:
        return [], "o documento canônico está vazio"

    indice = _indice_do_espaco(space_slug, titulo)
    contexto = json.dumps(indice, ensure_ascii=False) if indice else "(a wiki está vazia)"
    entrada = (
        f"Índice da wiki atual:\n{contexto}\n\n"
        f"---\n\nDocumento: {titulo}\n\n{corpo[:LIMITE_DOCUMENTO]}"
    )

    resposta = llm.complete_json(
        _INSTRUCAO % {"min": PALAVRAS_MIN, "max": PALAVRAS_MAX, "teto": MAX_PAGINAS_POR_DOCUMENTO},
        entrada,
        operation="wiki-destilar",
        # Pagina de 800 palavras em portugues passa de 1200 tokens, e sao ate
        # seis por resposta. O teto e alto de proposito: cortar no meio produz
        # YAML quebrado, que o `_preparar` descarta -- desperdicio total.
        max_tokens=8000,
        space=space_slug,
    )
    # ⚠ TRES CAMINHOS LEVAM A ZERO PAGINA, E ELES PEDEM CONSERTOS DIFERENTES.
    #
    # Ate aqui os tres viravam a mesma frase ("a destilacao nao produziu
    # pagina"), e a diferenca entre eles era invisivel. Medido numa carga real:
    # 3 de 14 documentos ficaram sem wiki, e nao havia como saber se o modelo
    # nao respondeu, se ele achou que o assunto ja estava coberto, ou se o que
    # ele devolveu foi recusado na porta.
    if resposta is None:
        return [], ("o modelo de chat não respondeu (rede, teto de tokens ou "
                    "recusa do provedor)")

    itens = [i for i in (resposta.dados.get("paginas") or []) if isinstance(i, dict)]
    if not itens:
        # O modelo respondeu e escolheu nao escrever nada. E legitimo -- ele ve
        # o indice da wiki e pode julgar o assunto coberto --, mas o documento
        # fica SEM cobertura mesmo assim, porque esta implementacao so cria
        # pagina, nao mescla conteudo numa existente. Quem opera precisa ver.
        return [], ("o modelo respondeu sem nenhuma página: avaliou que o documento "
                    "já está coberto pela wiki atual")

    paginas: list[Pagina] = []
    recusadas: list[str] = []
    for item in itens[:MAX_PAGINAS_POR_DOCUMENTO]:
        path = str(item.get("path") or "").strip().lstrip("/")
        conteudo = str(item.get("conteudo") or item.get("content") or "")
        if not path or not path.endswith(".md") or okf.is_reserved(path):
            log.info("destilacao devolveu caminho invalido (%r); ignorado", path)
            recusadas.append(f"caminho inválido ({path!r})")
            continue
        preparada = _preparar(path, conteudo, document_id, resposta.model)
        if preparada is None:
            recusadas.append(f"{path}: não saiu em OKF válido")
            continue
        paginas.append(preparada)

    if not paginas:
        return [], (f"o modelo devolveu {len(itens)} página(s) e todas foram recusadas: "
                    + "; ".join(recusadas[:3]))
    return paginas, ""


def gravar(space_slug: str, document_id: int, paginas: list[Pagina]) -> dict:
    """Grava as paginas, os vinculos de origem e o multi-vetor.

    A pagina e escrita POR CAMINHO (`ON CONFLICT`): e assim que a destilacao
    edita em vez de duplicar. Os vetores antigos daquela pagina saem antes dos
    novos entrarem -- sem isso, uma pagina reescrita acumularia vetores de
    versoes anteriores, e a busca casaria com texto que nao existe mais.
    """
    if not paginas:
        return {"paginas": 0, "vetores": 0, "tokens": 0, "fora_do_contrato": 0}

    # Um lote de embedding para TODAS as secoes de todas as paginas. Uma chamada
    # por secao multiplicaria a latencia da ingestao por dez, pelo mesmo motivo
    # que o corte semantico embeda em lote.
    textos: list[str] = []
    mapa: list[tuple[int, str]] = []
    for indice, pagina in enumerate(paginas):
        for titulo, texto in pagina.secoes:
            textos.append(texto)
            mapa.append((indice, titulo))

    embedded = embed(textos, "wiki", space_slug) if textos else None
    vetores = embedded.vectors if embedded else []

    gravadas = 0
    total_vetores = 0
    with conn() as connection:
        with connection.cursor() as cur:
            ids: list[int] = []
            for pagina in paginas:
                cur.execute(
                    """
                    INSERT INTO wiki_page
                        (space_slug, path, type, title, description, content,
                         frontmatter, words, tsv, updated_at)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,
                            to_tsvector('portuguese', unaccent(%s)), now())
                    ON CONFLICT (space_slug, path) DO UPDATE
                       SET type = EXCLUDED.type, title = EXCLUDED.title,
                           description = EXCLUDED.description, content = EXCLUDED.content,
                           frontmatter = EXCLUDED.frontmatter, words = EXCLUDED.words,
                           tsv = EXCLUDED.tsv, updated_at = now()
                    RETURNING id
                    """,
                    (
                        space_slug, pagina.path, pagina.type, pagina.title, pagina.description,
                        pagina.content, jsonb({"tags": pagina.tags}), pagina.words,
                        pagina.content,
                    ),
                )
                page_id = cur.fetchone()[0]
                ids.append(page_id)
                gravadas += 1
                cur.execute(
                    "INSERT INTO wiki_page_source (page_id, document_id) VALUES (%s,%s) "
                    "ON CONFLICT DO NOTHING",
                    (page_id, document_id),
                )
                cur.execute("DELETE FROM wiki_page_vector WHERE page_id = %s", (page_id,))

            for posicao, (indice, titulo) in enumerate(mapa):
                if posicao >= len(vetores):
                    break
                cur.execute(
                    """
                    INSERT INTO wiki_page_vector
                        (page_id, space_slug, section, ord, model, embedding)
                    VALUES (%s,%s,%s,%s,%s,%s::vector)
                    """,
                    (
                        ids[indice], space_slug, titulo[:200], posicao,
                        embedded.model if embedded else "", as_vector(vetores[posicao]),
                    ),
                )
                total_vetores += 1
        connection.commit()

    return {
        "paginas": gravadas,
        "vetores": total_vetores,
        "tokens": embedded.tokens if embedded else 0,
        "fora_do_contrato": sum(1 for p in paginas if p.fora_do_contrato),
    }


_TITULO_RE = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$", re.MULTILINE)


def secoes_do_documento(canonical: str, maximo: int) -> list[tuple[str, str]]:
    """Ate `maximo` pedacos (titulo, texto) espalhados pelo documento inteiro.

    POR QUE: a destilacao le `LIMITE_DOCUMENTO` caracteres. Num livro de 2,1
    milhoes de caracteres isso era o sumario e o prefacio, e a wiki do livro
    falava so do comeco dele. Aqui o documento vira secoes pelo nivel de titulo
    mais alto que o divide em mais de uma parte, e as secoes sao amostradas de
    ponta a ponta. Sem titulo nenhum, janelas de `LIMITE_DOCUMENTO` espalhadas.
    """
    titulos = list(_TITULO_RE.finditer(canonical))
    cortes: list[tuple[str, int]] = []
    for nivel in range(1, 7):
        deste = [(m.group(2).strip(), m.start()) for m in titulos if len(m.group(1)) <= nivel]
        if len(deste) >= 2:
            cortes = deste
            break
    if cortes:
        secoes = [
            (titulo, canonical[inicio:(cortes[i + 1][1] if i + 1 < len(cortes) else len(canonical))])
            for i, (titulo, inicio) in enumerate(cortes)
        ]
        # Secao minuscula (so o titulo, uma nota) nao sustenta uma pagina de wiki.
        secoes = [(t, x) for t, x in secoes if len(x.strip()) >= 1500] or secoes
    else:
        passo = LIMITE_DOCUMENTO
        secoes = [
            (f"parte {i // passo + 1}", canonical[i:i + passo])
            for i in range(0, len(canonical), passo)
        ]
    if len(secoes) <= maximo:
        return secoes
    if maximo <= 1:
        return secoes[:1]
    passo_amostra = (len(secoes) - 1) / (maximo - 1)
    return [secoes[round(i * passo_amostra)] for i in range(maximo)]


def construir(space_slug: str, document_id: int, titulo: str, canonical: str) -> dict:
    """O build da representacao wiki para um documento. Nunca levanta.

    Documento que cabe em `LIMITE_DOCUMENTO`: uma destilacao, como sempre.
    Maior que isso: uma destilacao por secao amostrada (`secoes_do_documento`),
    ate `settings.wiki_max_secoes`. Cada rodada ve o indice da wiki ja com as
    paginas da rodada anterior, entao a segunda secao edita em vez de duplicar.
    """
    try:
        corpo = (canonical or "").strip()
        if len(corpo) <= LIMITE_DOCUMENTO:
            partes = [(titulo, corpo)]
        else:
            partes = [
                (f"{titulo} — {secao}", texto)
                for secao, texto in secoes_do_documento(corpo, settings.wiki_max_secoes)
            ]
        total = {"paginas": 0, "vetores": 0, "tokens": 0, "fora_do_contrato": 0}
        motivos: list[str] = []
        for n, (titulo_parte, texto) in enumerate(partes):
            if len(partes) > 1:
                progresso.avancar("wiki", n, len(partes), f"seção {n + 1} de {len(partes)}")
            paginas, motivo = destilar(space_slug, document_id, titulo_parte, texto)
            if not paginas:
                motivos.append(motivo or "a destilação não produziu página")
                continue
            resultado = gravar(space_slug, document_id, paginas)
            for chave in total:
                total[chave] += int(resultado.get(chave) or 0)
        if not total["paginas"]:
            return {"status": "falha", "erro": "; ".join(dict.fromkeys(motivos))[:300],
                    "paginas": 0}
        return {"status": "ok", "secoes": len(partes), **total}
    except Exception as exc:  # noqa: BLE001 - o build da wiki nao derruba o do indice
        log.warning("build da wiki falhou em %s/%s: %s", space_slug, document_id, exc)
        return {"status": "falha", "erro": str(exc)[:300], "paginas": 0}


def paginas_do_documento(document_id: int) -> list[dict]:
    """Paginas que derivam deste documento, para o `fetch` (BUS-07)."""
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            SELECT p.id, p.path, p.type, p.title, p.description
              FROM wiki_page p
              JOIN wiki_page_source s ON s.page_id = p.id
             WHERE s.document_id = %s
             ORDER BY p.path
            """,
            (document_id,),
        )
        return [
            {"id": r[0], "path": r[1], "type": r[2], "title": r[3], "description": r[4]}
            for r in cur.fetchall()
        ]


_LINK_RE = re.compile(r"(?<!!)\[([^\]]*)\]\(\s*([^)\s]+?\.md)(?:#[^)\s]*)?\s*\)")


def buscar_pagina(page_id: int, spaces: list[str] | None) -> dict | None:
    """Uma pagina inteira com as referencias dela (BUS-07).

    O filtro de Espaco vale aqui igual a busca: ler uma pagina valida o Espaco
    dela contra os Espacos permitidos, e referencia fora de escopo nao aparece
    como navegavel (conceptual-model §7).
    """
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            SELECT id, space_slug, path, type, title, description, content, frontmatter,
                   words, updated_at
              FROM wiki_page
             WHERE id = %s AND (%s::text[] IS NULL OR space_slug = ANY(%s::text[]))
            """,
            (page_id, spaces, spaces),
        )
        linha = cur.fetchone()
        if linha is None:
            return None
        space = linha[1]

        # Referencias: os links do corpo resolvidos contra as paginas do MESMO
        # Espaco. Link quebrado nao vira erro -- a especificacao do OKF proibe
        # recusar um bundle por causa dele.
        alvos = [m.group(2).lstrip("/") for m in _LINK_RE.finditer(linha[6] or "")]
        referencias: list[dict] = []
        if alvos:
            cur.execute(
                "SELECT id, path, title FROM wiki_page WHERE space_slug = %s AND path = ANY(%s)",
                (space, alvos),
            )
            referencias = [{"id": r[0], "path": r[1], "title": r[2]} for r in cur.fetchall()]

        cur.execute(
            """
            SELECT d.id, d.filename, d.title
              FROM document d
              JOIN wiki_page_source s ON s.document_id = d.id
             WHERE s.page_id = %s AND d.active
             ORDER BY d.filename
            """,
            (page_id,),
        )
        fontes = [{"id": r[0], "filename": r[1], "title": r[2]} for r in cur.fetchall()]

    return {
        "id": linha[0],
        "space": space,
        "path": linha[2],
        "type": linha[3],
        "title": linha[4],
        "description": linha[5],
        "content": linha[6],
        "frontmatter": linha[7],
        "words": linha[8],
        "updated_at": linha[9].isoformat() if linha[9] else None,
        "references": referencias,
        "sources": fontes,
    }

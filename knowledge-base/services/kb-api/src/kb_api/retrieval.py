"""Métodos de acesso: cada um consulta UMA representação e devolve candidatos.

O contrato é o do requisito BUS-04 (mais de um método de acesso, combináveis e
selecionáveis por Espaço) somado ao BUS-05 (threshold por método, fusão). Cada
função aqui é um método: recebe a pergunta e a lista de Espaços em que ele
existe, e devolve candidatos num formato comum.

POR QUE UM REGISTRO, E NAO IFS NA BUSCA

O caso que manda no desenho: trinta bases, cada uma com representações
diferentes, e uma pergunta. Com condicionais na busca, cada representação nova
tocaria a função de busca inteira, e o caso de trinta bases viraria trinta
consultas. Com o registro, cada método roda **uma vez** sobre o grupo de Espaços
em que ele existe -- duas representações dão três métodos, não trinta buscas --
e acrescentar um método é uma entrada aqui.

CADA METODO ABRE A PROPRIA CONEXAO

Eles rodam em paralelo, e uma conexão do psycopg não é para ser compartilhada
entre threads. O pool tem oito conexões; a busca usa no máximo quatro de uma vez
(ver `MAX_PARALELO` em `search.py`), o que deixa folga para as outras
requisições do serviço enquanto uma busca está rodando.

O RECORTE DO CHAMADOR ENTRA NA CONSULTA, NAO DEPOIS DELA

`Filtros` carrega o nivel minimo de confianca e a data em que o conteudo
precisava estar vigente. Os dois viram clausula de WHERE dentro de cada metodo,
e nao um filtro sobre a lista que ele devolveu: o `LIMIT` e do banco, e o que
fosse descartado depois sairia do pool sem ser reposto.

O THRESHOLD E POR METODO, E ISSO NAO E DETALHE

Similaridade de cosseno e `ts_rank_cd` não querem dizer a mesma coisa nem vivem
na mesma escala. Um corte global ou zeraria um método ou não cortaria nada do
outro. É a mesma razão pela qual a fusão é por POSIÇÃO (RRF) e não por score
(retrieval-pipeline.md §3 F4).
"""

from __future__ import annotations

import logging
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass

from . import graph, okf, providers, representations
from .db import as_vector, conn
from .embedding import EmbeddingError, EmbedResult, embed

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Filtros:
    """O recorte que o chamador pediu, aplicado DENTRO da consulta.

    POR QUE NO SQL, E NAO DEPOIS

    A tentacao e filtrar em Python, sobre a lista que cada metodo devolveu: nao
    mexe em SQL nenhum e serve aos cinco metodos de uma vez. Foi recusado, e o
    motivo e o `LIMIT`. Cada metodo pede `pool_size` candidatos ao banco; o que
    for descartado depois sai do pool sem ser reposto. Uma base com muito
    conteudo revogado devolveria quarenta candidatos, o filtro deixaria tres, e a
    busca voltaria com tres resultados achando que o assunto nao existe -- sem
    erro, e sem nada na tela sugerindo que o pool foi consumido por conteudo que
    nunca poderia ser entregue.

    Os dois campos sao OPCIONAIS e o default e o comportamento de sempre. Nenhum
    deles amplia escopo: `trust_aceitos` so corta, `as_of` so corta, e nem um nem
    outro alcanca Espaco que o chamador nao alcancaria (ADR-0005).
    """

    # Niveis de confianca que passam. Vazio = todos, inclusive `unverified`.
    trust_aceitos: tuple[str, ...] = ()
    # Data do fato, em `AAAA-MM-DD`. Vazio = sem filtro de vigencia.
    as_of: str = ""

    @classmethod
    def de_parametros(cls, min_trust: str = "", as_of: str = "") -> Filtros:
        """Os filtros a partir do que veio na requisicao. Levanta `ValueError`.

        Levanta em vez de ignorar valor desconhecido de proposito. `min_trust`
        escrito errado (`"human_reviewed"` com sublinhado) ignorado em silencio
        devolveria conteudo nao revisado para quem pediu explicitamente que ele
        nao viesse, que e o modo de falha mais caro desta funcao inteira.
        """
        data = okf.data_iso(as_of) if as_of else ""
        if as_of and not data:
            raise ValueError(
                f"data do fato invalida: {as_of}. Use o formato AAAA-MM-DD"
            )
        return cls(trust_aceitos=tuple(okf.trust_aceitos(min_trust)), as_of=data)

    @property
    def ativo(self) -> bool:
        return bool(self.trust_aceitos or self.as_of)

    @property
    def exige_revisao(self) -> bool:
        """O chamador pediu mais do que `unverified`?

        E o que decide se as representacoes feitas de texto GERADO entram na
        busca. Ver `_wiki_fora`.
        """
        return bool(self.trust_aceitos) and okf.TRUST_PADRAO not in self.trust_aceitos

    def to_dict(self) -> dict:
        return {
            "min_trust": self.trust_aceitos[0] if self.trust_aceitos else "",
            "as_of": self.as_of,
        }


# Vigencia comparada como TEXTO, e nao como data. ISO-8601 com zero a esquerda
# ordena igual ao calendario, e o cast `::date` nao e `immutable` (depende do
# `DateStyle` da sessao), entao ele nao entra em indice de expressao -- o filtro
# so existiria varrendo a tabela. A normalizacao que garante o formato esta em
# `okf.data_iso`, na ENTRADA, que e onde ainda da para recusar barato.
#
# As duas ausencias sao tratadas como "sem limite", e essa e a parte que nao
# pode ser invertida: documento sem vigencia declarada e a imensa maioria de
# qualquer base, e esconde-lo esvaziaria a busca sem nada falhar.
_VIGENTE_EM = (
    "               AND COALESCE({campo}->'vigencia'->>'de', '') <= %s\n"
    "               AND COALESCE(NULLIF({campo}->'vigencia'->>'ate', ''), '{sem_fim}') >= %s\n"
)

_CONFIANCA = (
    "               AND COALESCE(d.okf->>'trust', %s) = ANY(%s::text[])\n"
)


def _onde_documento(filtros: Filtros | None) -> tuple[str, tuple]:
    """Recorte sobre `document.okf`, como pedaco de WHERE e os parametros dele.

    Devolve os dois juntos porque separar convida ao erro classico de consulta
    montada: o fragmento entra numa posicao do texto e os parametros em outra, e
    quem acrescentar um filtro depois tem de acertar as duas listas na mesma
    ordem. Aqui a ordem e uma so.
    """
    if filtros is None or not filtros.ativo:
        return "", ()
    partes: list[str] = []
    params: list[object] = []
    if filtros.trust_aceitos:
        partes.append(_CONFIANCA)
        # Documento que NAO e conceito OKF nao tem `trust`. Ele vale
        # `unverified`, e nao "passa": ninguem o conferiu, e e exatamente contra
        # isso que `min_trust` existe.
        params += [okf.TRUST_PADRAO, list(filtros.trust_aceitos)]
    if filtros.as_of:
        partes.append(_VIGENTE_EM.format(campo="d.okf", sem_fim=okf.SEM_FIM))
        params += [filtros.as_of, filtros.as_of]
    return "".join(partes), tuple(params)


def _onde_wiki(filtros: Filtros | None) -> tuple[str, tuple]:
    """Recorte sobre `wiki_page.frontmatter`. So vigencia -- ver `_wiki_fora`."""
    if filtros is None or not filtros.as_of:
        return "", ()
    return (
        _VIGENTE_EM.format(campo="p.frontmatter", sem_fim=okf.SEM_FIM),
        (filtros.as_of, filtros.as_of),
    )


def _wiki_fora(filtros: Filtros | None) -> bool:
    """A wiki inteira sai quando o chamador pede conteudo revisado?

    Sim, e isso e contrato, nao limitacao: toda pagina de wiki e texto que um
    modelo ESCREVEU a partir dos documentos (ADR-0018), e nenhuma delas passou
    por revisao humana -- nao ha, hoje, fluxo que registre essa revisao. Entao
    `min_trust` acima de `unverified` exclui a representacao inteira, e o curto
    circuito aqui poupa a ida ao banco e a chamada de embedding.

    O dia em que existir revisao de pagina e este o ponto que muda: a decisao
    passa a ser por pagina, com o nivel vindo do frontmatter dela.
    """
    return filtros is not None and filtros.exige_revisao


@dataclass
class Candidato:
    """O que um método de acesso devolve, antes da fusão.

    `key` é a identidade da **unidade de entrega**: o chunk pai no índice, a
    página na wiki. É por ela que a fusão agrupa, porque dois candidatos com a
    mesma unidade de entrega são a MESMA evidência, e somar as posições dos dois
    premiaria documento longo.

    `match` é a **unidade de matching**: o texto pequeno que de fato casou. Ele
    não é o que se entrega, mas é o que localiza a passagem dentro do PDF --
    procurar o pai inteiro no arquivo nunca casa.
    """

    key: str
    document_id: int
    space: str
    content: str
    match: str
    page: int | None
    score: float
    representacao: str
    # Aviso de armadilha do conteudo, vazio quando nao ha. Viaja com o
    # candidato, e nao numa consulta a parte: a leitura errada acontece na
    # primeira leitura, e um aviso que exige segunda chamada chega depois dela.
    armadilha: str = ""


def _grupos_de_embedding(spaces: list[str]) -> list[tuple[str, list[str]]]:
    """Espaços agrupados pelo modelo de embedding de cada um.

    O vetor da pergunta NÃO depende da representação consultada, só do modelo.
    Por isso o agrupamento é aqui, dentro do método semântico, e não na busca:
    acrescentar um método que também use vetor reaproveita esta função em vez de
    multiplicar chamadas de embedding.

    Um grupo só é o caso normal, e devolver a lista inteira num grupo mantém o
    caminho idêntico ao de antes quando ninguém escolheu modelo por base.
    """
    grupos: dict[int, list[str]] = {}
    for slug in spaces:
        try:
            grupos.setdefault(providers.padrao("embedding", slug).id, []).append(slug)
        except providers.ProviderError:
            # Espaço sem provedor resolvível fica fora do braço vetorial. Ele
            # continua aparecendo pelo lexical, que é melhor que sumir da busca.
            continue
    return [(membros[0], membros) for membros in grupos.values()]


# ── o vetor da pergunta, calculado UMA vez ────────────────────────────────
#
# O ADR-0017 diz que "o embedding da pergunta e calculado uma vez por modelo,
# compartilhado entre os metodos". O codigo nao fazia isso: `semantica` e
# `paginas` chamavam `embed` cada um, entao uma base com indice + wiki pagava
# DUAS idas ao provedor pela mesma pergunta -- e cobrava os tokens duas vezes.
#
# E o tamanho do premio e maior do que parece. Medido contra a stack: a ida ao
# provedor de embedding leva 1033, 1119 e 8435 ms em tres tentativas seguidas,
# enquanto a busca inteira leva ~1030 ms. O tempo da busca E a chamada de
# embedding; o Postgres e ruido ao lado dela.
#
# VOO UNICO, e nao so um dicionario: os metodos rodam em PARALELO, entao dois
# threads pedem o mesmo vetor no mesmo instante e um cache simples deixaria os
# dois chamarem o provedor. Quem chega depois espera o primeiro.
_CACHE_MAX = 256
# Cinco minutos. O vetor de uma pergunta so muda se o modelo do provedor mudar,
# e isso ja e operacao consciente que obriga a reindexar tudo -- o TTL existe
# para limitar a janela, nao porque se espere que aconteca.
_CACHE_TTL = 300.0
_ESPERA_MAX = 30.0
_cache: OrderedDict[tuple[int, str], tuple[float, EmbedResult]] = OrderedDict()
_em_voo: dict[tuple[int, str], threading.Event] = {}
_trava = threading.Lock()


def _do_cache(chave: tuple[int, str]) -> EmbedResult | None:
    with _trava:
        achado = _cache.get(chave)
        if achado is None or time.monotonic() - achado[0] > _CACHE_TTL:
            return None
        _cache.move_to_end(chave)
        return achado[1]


def vetor_da_pergunta(query: str, referencia: int) -> tuple[EmbedResult, bool]:
    """O vetor da pergunta, e se ele veio do cache.

    O segundo valor NAO e curiosidade: quem chama soma `tokens` no uso de IA, e
    contar de novo o que nao foi gasto inflaria a conta do provedor na tela de
    consumo. Cache servido custa zero token, e e assim que precisa aparecer.
    """
    chave = (referencia, query)
    pronto = _do_cache(chave)
    if pronto is not None:
        return pronto, True

    with _trava:
        evento = _em_voo.get(chave)
        dono = evento is None
        if dono:
            evento = threading.Event()
            _em_voo[chave] = evento

    if not dono:
        assert evento is not None
        evento.wait(timeout=_ESPERA_MAX)
        pronto = _do_cache(chave)
        if pronto is not None:
            return pronto, True
        # O dono falhou ou demorou demais. Calcular por conta propria e melhor
        # que propagar a falha dele: no pior caso gasta uma chamada a mais.
        return embed([query], "search", referencia), False

    try:
        resultado = embed([query], "search", referencia)
    finally:
        with _trava:
            _em_voo.pop(chave, None)
        assert evento is not None
        evento.set()

    with _trava:
        _cache[chave] = (time.monotonic(), resultado)
        _cache.move_to_end(chave)
        while len(_cache) > _CACHE_MAX:
            _cache.popitem(last=False)
    return resultado, False


# Ajustes do indice HNSW, aplicados NA SESSAO antes de consultar (migracao
# 0008). Sao `SET LOCAL`-equivalentes por conexao: o pool reusa conexoes, e
# deixar isso em `postgresql.conf` obrigaria a mexer no deploy do banco para
# afinar a busca.
#
# `iterative_scan` e o que faz indice aproximado conviver com filtro: a busca
# SEMPRE filtra por Espaco, e sem ele o indice devolveria 40 vizinhos dos quais
# o filtro deixaria tres. Com ele o scan continua puxando ate o LIMIT ser
# satisfeito depois dos filtros -- medido, 215 entradas para devolver 40.
#
# `relaxed_order` e nao `strict_order` porque a ordem exata nao importa aqui: o
# que sai deste metodo vai para o RRF, que funde por POSICAO junto com os outros
# metodos. Pagar reordenacao estrita para embaralhar depois seria desperdicio.
#
# `ef_search` 100 contra o padrao 40: mais recall por um custo pequeno num
# indice deste tamanho. O numero e o ponto em que o plano medido ainda ficou
# abaixo de 12 ms.
_AJUSTES_HNSW = (
    "SET hnsw.ef_search = 100",
    "SET hnsw.iterative_scan = relaxed_order",
)


def _preparar_sessao(cur) -> None:
    """Liga os ajustes do HNSW, tolerando um banco que nao os conheca.

    Um pgvector anterior ao 0.8 nao tem `iterative_scan`, e derrubar a busca por
    causa de um ajuste de desempenho seria trocar lentidao por indisponibilidade.
    """
    for ajuste in _AJUSTES_HNSW:
        try:
            cur.execute(ajuste)
        except Exception as exc:  # noqa: BLE001
            log.debug("ajuste de indice ignorado (%s): %s", ajuste, exc)
            break


def semantica(query: str, spaces: list[str], limit: int,
              texto_do_vetor: str | None = None,
              filtros: Filtros | None = None) -> tuple[list[Candidato], dict]:
    """Similaridade de cosseno no pgvector, sobre os chunks filhos do índice.

    `texto_do_vetor` e o slot F3 (embedding de query): quando vem preenchido, e
    ELE que vai para o embedding, e nao a pergunta. E o que o HyDE usa. O texto
    da pergunta continua sendo o que os outros metodos veem -- mandar um
    paragrafo hipotetico de cem palavras para o braco lexical encheria a consulta
    de termos inventados pelo modelo.
    """
    alvo_do_vetor = texto_do_vetor or query
    candidatos: list[Candidato] = []
    modelos: list[str] = []
    tokens = 0
    erro = ""

    consultas: list[tuple[list[float], list[str]]] = []
    for referencia, membros in _grupos_de_embedding(spaces):
        try:
            embedded, do_cache = vetor_da_pergunta(alvo_do_vetor, referencia)
            tokens += 0 if do_cache else embedded.tokens
            consultas.append((embedded.vectors[0], membros))
            if embedded.model not in modelos:
                modelos.append(embedded.model)
        except EmbeddingError as exc:
            # Um modelo fora do ar não derruba os outros: os Espaços dele saem
            # deste método e seguem no lexical.
            erro = str(exc)[:200]
            log.warning("busca sem etapa vetorial em %s: %s", membros, exc)

    recorte, recorte_params = _onde_documento(filtros)
    if consultas:
        with conn() as connection, connection.cursor() as cur:
            _preparar_sessao(cur)
            for vetor, alvo in consultas:
                # ⚠ A EXPRESSAO PRECISA SER IDENTICA A DO INDICE (migracao 0008).
                # Indice de expressao so entra se o `ORDER BY` a escreve igual;
                # voltar a `e.embedding <=> %s::vector` nao da erro nenhum, so
                # devolve o SEQ SCAN e a busca fica lenta de novo. Ha teste
                # travando os dois juntos.
                cur.execute(
                    f"""
                    SELECT c.id, c.document_id, c.space_slug, c.parent_id, c.content, c.page,
                           d.okf->>'armadilha' AS armadilha,
                           1 - (e.embedding::halfvec(3072) <=> %s::halfvec(3072)) AS similarity
                      FROM chunk_embedding e
                      JOIN chunk c ON c.id = e.chunk_id
                      JOIN document d ON d.id = c.document_id AND d.active
                     WHERE c.parent_id IS NOT NULL
                       AND c.space_slug = ANY(%s::text[])
{recorte}                     ORDER BY e.embedding::halfvec(3072) <=> %s::halfvec(3072)
                     LIMIT %s
                    """,
                    (as_vector(vetor), alvo, *recorte_params, as_vector(vetor), limit),
                )
                for linha in cur.fetchall():
                    chunk_id, document_id, space, parent_id, content, page, aviso, score = linha
                    candidatos.append(
                        Candidato(
                            # A unidade de entrega é o PAI. Sem pai (não deveria
                            # acontecer, o filtro é `parent_id IS NOT NULL`), o
                            # próprio filho serve de chave.
                            key=f"chunk:{parent_id or chunk_id}",
                            document_id=document_id,
                            space=space,
                            content=content,
                            match=content,
                            page=page,
                            score=float(score),
                            representacao=representations.INDICE,
                            armadilha=okf.aviso_de_armadilha(aviso),
                        )
                    )

    if len(consultas) > 1:
        # Cada grupo trouxe até `limit` sozinho, e a posição é o que o RRF usa.
        # Sem reordenar, o segundo grupo entraria inteiro atrás do primeiro por
        # ordem de laço, e não por similaridade.
        #
        # A ressalva fica registrada: similaridade de modelos diferentes não é
        # estritamente comparável. Ordenar por ela é a melhor aproximação
        # disponível, e é por isso que a recomendação é um modelo por
        # instalação, salvo quando se quer comparar dois.
        candidatos.sort(key=lambda c: c.score, reverse=True)
        candidatos = candidatos[:limit]

    trace = {
        "tecnica": f"pgvector cosseno / {' + '.join(modelos)}" if modelos else "pgvector cosseno",
        "tokens": tokens,
        "espacos": len(spaces),
    }
    if filtros is not None and filtros.ativo:
        trace["recorte"] = filtros.to_dict()
    if len(consultas) > 1:
        trace["modelos"] = len(consultas)
    if erro:
        trace["erro"] = erro
    return candidatos, trace


# tsquery com OR entre os lexemas da pergunta, nao AND.
#
# `websearch_to_tsquery` e `plainto_tsquery` juntam os termos com AND: "como
# solicitar ferias" vira 'solicit & feria' e nao casa com NADA, mesmo havendo 19
# chunks com "ferias" -- o braco lexical entregava zero candidatos em quase toda
# pergunta em linguagem natural. Num hibrido isso e o pior dos mundos: perde-se
# a recuperacao lexical (sigla, codigo de documento, nome proprio) e sobra so o
# vetor.
#
# A conversao passa pelo `to_tsvector` do proprio Postgres e depois junta os
# lexemas com ` | `: aproveita o stemmer e a lista de stopwords do dicionario
# portugues e nunca concatena texto do usuario em SQL.
_TSQUERY = """
    NULLIF(
        array_to_string(
            tsvector_to_array(to_tsvector('portuguese', unaccent(%s))), ' | '
        ), ''
    )::tsquery
"""


def lexical(query: str, spaces: list[str], limit: int,
            filtros: Filtros | None = None) -> tuple[list[Candidato], dict]:
    """Full-text do Postgres sobre os mesmos chunks filhos do índice.

    Cobre sigla, código de documento e nome próprio, onde o vetor costuma errar.
    """
    candidatos: list[Candidato] = []
    recorte, recorte_params = _onde_documento(filtros)
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            f"""
            SELECT c.id, c.document_id, c.space_slug, c.parent_id, c.content, c.page,
                   d.okf->>'armadilha' AS armadilha,
                   ts_rank_cd(c.tsv, {_TSQUERY}) AS rank
              FROM chunk c
              JOIN document d ON d.id = c.document_id AND d.active
             WHERE c.parent_id IS NOT NULL
               AND c.space_slug = ANY(%s::text[])
               AND c.tsv @@ {_TSQUERY}
{recorte}             ORDER BY rank DESC
             LIMIT %s
            """,
            (query, spaces, query, *recorte_params, limit),
        )
        for linha in cur.fetchall():
            chunk_id, document_id, space, parent_id, content, page, aviso, score = linha
            candidatos.append(
                Candidato(
                    key=f"chunk:{parent_id or chunk_id}",
                    document_id=document_id,
                    space=space,
                    content=content,
                    match=content,
                    page=page,
                    score=float(score),
                    representacao=representations.INDICE,
                    armadilha=okf.aviso_de_armadilha(aviso),
                )
            )
    trace = {
        "tecnica": representations.METODOS["lexical"].tecnica,
        "espacos": len(spaces),
    }
    if filtros is not None and filtros.ativo:
        trace["recorte"] = filtros.to_dict()
    return candidatos, trace


def paginas(query: str, spaces: list[str], limit: int,
            filtros: Filtros | None = None) -> tuple[list[Candidato], dict]:
    """Busca de páginas da wiki: multi-vetor por seção, entrega a página inteira.

    O padrão é o mesmo do pai/filho do índice -- "casar no pequeno, entregar o
    inteiro" -- com uma diferença que muda o código: aqui a unidade de entrega já
    nasceu pronta da destilação, então **qualquer vetor de seção que casar
    devolve a página toda**. Não há expansão de contexto depois, porque não há o
    que expandir.

    O `DISTINCT ON (p.id)` é o que materializa isso: uma página com seis seções
    que casem não vira seis candidatos, vira um, com o melhor score. Sem ele, a
    fusão receberia a mesma página seis vezes e ela dominaria o ranking por ter
    sido cortada em mais pedaços -- o mesmo defeito que a chave da fusão evita no
    índice.
    """
    if _wiki_fora(filtros):
        return [], {
            "tecnica": representations.METODOS["paginas"].tecnica,
            "espacos": len(spaces),
            "estado": "fora do recorte: página destilada é texto gerado, e nenhuma foi revisada",
            "recorte": filtros.to_dict() if filtros else {},
        }

    candidatos: list[Candidato] = []
    modelos: list[str] = []
    tokens = 0
    erro = ""
    consultas: list[tuple[list[float], list[str]]] = []

    for referencia, membros in _grupos_de_embedding(spaces):
        try:
            embedded, do_cache = vetor_da_pergunta(query, referencia)
            tokens += 0 if do_cache else embedded.tokens
            consultas.append((embedded.vectors[0], membros))
            if embedded.model not in modelos:
                modelos.append(embedded.model)
        except EmbeddingError as exc:
            erro = str(exc)[:200]
            log.warning("busca de paginas sem vetor em %s: %s", membros, exc)

    recorte, recorte_params = _onde_wiki(filtros)
    if consultas:
        with conn() as connection, connection.cursor() as cur:
            _preparar_sessao(cur)
            for vetor, alvo in consultas:
                cur.execute(
                    f"""
                    SELECT DISTINCT ON (p.id)
                           p.id, p.space_slug, p.path, p.title, p.content, v.section,
                           p.frontmatter->>'armadilha' AS armadilha,
                           1 - (v.embedding::halfvec(3072) <=> %s::halfvec(3072)) AS similarity
                      FROM wiki_page_vector v
                      JOIN wiki_page p ON p.id = v.page_id
                     WHERE v.space_slug = ANY(%s::text[])
{recorte}                     ORDER BY p.id, v.embedding::halfvec(3072) <=> %s::halfvec(3072)
                    """,
                    (as_vector(vetor), alvo, *recorte_params, as_vector(vetor)),
                )
                for page_id, space, _path, titulo, conteudo, secao, aviso, score in cur.fetchall():
                    candidatos.append(
                        Candidato(
                            key=f"pagina:{page_id}",
                            # A pagina nao pertence a UM documento: ela pode
                            # derivar de varios. O `fetch` resolve as fontes pelo
                            # vinculo, e por isso aqui nao ha documento.
                            document_id=0,
                            space=space,
                            content=conteudo,
                            # A unidade de MATCHING e a secao que casou: e ela
                            # que diz por que a pagina apareceu.
                            match=f"{titulo} · {secao}" if secao else titulo,
                            page=None,
                            score=float(score),
                            representacao=representations.WIKI,
                            armadilha=okf.aviso_de_armadilha(aviso),
                        )
                    )

    # O `DISTINCT ON` ordena por pagina, nao por score: o corte final tem de ser
    # por similaridade, senao o `limit` levaria as paginas de menor id.
    candidatos.sort(key=lambda c: c.score, reverse=True)
    candidatos = candidatos[:limit]

    trace = {
        "tecnica": representations.METODOS["paginas"].tecnica,
        "tokens": tokens,
        "espacos": len(spaces),
    }
    if modelos:
        trace["tecnica"] = f"{trace['tecnica']} / {' + '.join(modelos)}"
    if erro:
        trace["erro"] = erro
    if filtros is not None and filtros.ativo:
        trace["recorte"] = filtros.to_dict()
    return candidatos, trace


def lexical_paginas(query: str, spaces: list[str], limit: int,
                    filtros: Filtros | None = None) -> tuple[list[Candidato], dict]:
    """Full-text sobre a wiki, com granularidade de PAGINA.

    A busca de paginas resolve o ponto de entrada pelo vetor; este metodo cobre
    o que o vetor erra -- sigla, codigo, nome proprio -- e e por pagina inteira
    porque e a pagina que se entrega. Sem ele, uma wiki com o termo exato da
    pergunta so seria achada se o vetor colaborasse.
    """
    if _wiki_fora(filtros):
        return [], {
            "tecnica": representations.METODOS["paginas_lexical"].tecnica,
            "espacos": len(spaces),
            "estado": "fora do recorte: página destilada é texto gerado, e nenhuma foi revisada",
            "recorte": filtros.to_dict() if filtros else {},
        }

    candidatos: list[Candidato] = []
    recorte, recorte_params = _onde_wiki(filtros)
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            f"""
            SELECT p.id, p.space_slug, p.title, p.content,
                   p.frontmatter->>'armadilha' AS armadilha,
                   ts_rank_cd(p.tsv, {_TSQUERY}) AS rank
              FROM wiki_page p
             WHERE p.space_slug = ANY(%s::text[])
               AND p.tsv @@ {_TSQUERY}
{recorte}             ORDER BY rank DESC
             LIMIT %s
            """,
            (query, spaces, query, *recorte_params, limit),
        )
        for page_id, space, titulo, conteudo, aviso, score in cur.fetchall():
            candidatos.append(
                Candidato(
                    key=f"pagina:{page_id}",
                    document_id=0,
                    space=space,
                    content=conteudo,
                    match=titulo,
                    page=None,
                    score=float(score),
                    representacao=representations.WIKI,
                    armadilha=okf.aviso_de_armadilha(aviso),
                )
            )
    trace = {
        "tecnica": representations.METODOS["paginas_lexical"].tecnica,
        "espacos": len(spaces),
    }
    if filtros is not None and filtros.ativo:
        trace["recorte"] = filtros.to_dict()
    return candidatos, trace


def travessia(query: str, spaces: list[str], limit: int,
              filtros: Filtros | None = None) -> tuple[list[Candidato], dict]:
    """Chunks pais alcançados por entidade do grafo que casa com a pergunta.

    O que este método faz e os outros não: o **segundo salto**. Ele acha o
    documento que fala do que a pergunta NÃO nomeou, mas que se liga ao que ela
    nomeou -- "quem aprova férias" alcança a área de RH mesmo num trecho que só
    fala de "aprovação", porque a relação está no grafo.

    Devolve chunk pai, e não texto do grafo: o grafo é o caminho, o índice é o
    destino. É isso que mantém a evidência sendo sempre texto do documento, e o
    que permite perder o grafo inteiro sem custo de dado (ADR-0012).
    """
    termos = graph.terms(query, limit=6)
    achados = graph.travessia(termos, spaces, limit)
    if not achados:
        return [], {
            "tecnica": representations.METODOS["travessia"].tecnica,
            "espacos": len(spaces),
            "termos": termos,
            "estado": "nenhuma entidade casou" if termos else "pergunta sem termo distintivo",
        }

    # O grafo devolve ponteiro; o conteúdo vem do índice, numa consulta só.
    por_chunk = {int(a["chunk_id"]): a for a in achados if a.get("chunk_id") is not None}
    candidatos: list[Candidato] = []
    recorte, recorte_params = _onde_documento(filtros)
    if por_chunk:
        with conn() as connection, connection.cursor() as cur:
            # O recorte vale aqui pelo mesmo motivo que nos outros metodos: o
            # grafo alcanca o chunk, mas quem decide se aquele conteudo pode ser
            # entregue e o documento. Sem esta clausula, a travessia seria a
            # porta dos fundos do `min_trust`.
            cur.execute(
                f"""
                SELECT c.id, c.document_id, c.space_slug, c.content, c.page,
                       d.okf->>'armadilha' AS armadilha
                  FROM chunk c
                  JOIN document d ON d.id = c.document_id AND d.active
                 WHERE c.id = ANY(%s)
{recorte}                """,
                (list(por_chunk), *recorte_params),
            )
            for chunk_id, document_id, space, conteudo, pagina, aviso in cur.fetchall():
                achado = por_chunk[chunk_id]
                entidades = achado.get("entidades") or []
                candidatos.append(
                    Candidato(
                        key=f"chunk:{chunk_id}",
                        document_id=document_id,
                        space=space,
                        content=conteudo,
                        # A unidade de matching é a ENTIDADE que ligou: é ela
                        # que explica por que este trecho apareceu.
                        match=", ".join(entidades[:4]),
                        page=pagina,
                        # A força é quantas entidades alcançaram este chunk.
                        # Escala própria, incomparável com cosseno -- e é por
                        # isso que a fusão é por posição.
                        score=float(achado.get("forca") or 1),
                        representacao=representations.INDICE,
                        armadilha=okf.aviso_de_armadilha(aviso),
                    )
                )
    candidatos.sort(key=lambda c: c.score, reverse=True)
    trace = {
        "tecnica": representations.METODOS["travessia"].tecnica,
        "espacos": len(spaces),
        "termos": termos,
        "entidades_alcancadas": sum(len(a.get("entidades") or []) for a in achados),
    }
    if filtros is not None and filtros.ativo:
        trace["recorte"] = filtros.to_dict()
    return candidatos[:limit], trace


# O registro. Acrescentar um método de acesso é uma entrada aqui e uma em
# `representations.METODOS` -- a busca não muda.
RECUPERADORES = {
    "semantica": semantica,
    "lexical": lexical,
    "paginas": paginas,
    "paginas_lexical": lexical_paginas,
    "travessia": travessia,
}

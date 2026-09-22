"""Busca: mais de um metodo de acesso, fundidos por RRF, com score na resposta.

O contrato e o do requisito BUS-01: uma passada por chamada, passagens
candidatas devolvidas como **evidencia** -- texto, origem, scores e metadados --
nunca resposta gerada. Foi exatamente aqui que as tres ferramentas de mercado
avaliadas ficaram devendo: o Onyx nao devolve score na tool, o Dify devolve
resposta pronta, e nenhuma das tres tem `fetch` por id.

Etapas, cada uma nomeada na telemetria (FUN-06):

1. **escopo** -- Espacos permitidos do chamador, resolvidos no servidor
   (FUN-08). Nao ha caminho que pule esta etapa. Aqui tambem se descobre quais
   REPRESENTACOES cada Espaco tem ativas, e portanto quais metodos de acesso
   existem para consultar. O **recorte** pedido pelo chamador (`min_trust`,
   `as_of`) entra junto, e so RESTRINGE: ele nunca alcanca conteudo que o escopo
   nao alcancaria.
2. **metodos de acesso em paralelo** -- cada metodo (`semantica`, `lexical`,
   `paginas`) roda UMA vez, sobre o grupo de Espacos em que ele existe. Os
   recuperadores vivem em `retrieval.py`.
3. **fusao** -- threshold POR METODO, depois Reciprocal Rank Fusion (BUS-05).
   Combina por POSICAO, nao por score: os metodos tem escalas incomparaveis, e
   normalizar seria pior.
4. **expansao pai** -- o filho casa, o pai e entregue (ING-07), so para o
   indice: a pagina da wiki ja nasce do tamanho certo.
5. **dedup** -- uma unidade de entrega por posicao, mantendo o melhor score.

O CASO QUE MANDA NO DESENHO

Trinta bases, cada uma com representacoes diferentes, e uma pergunta. Isto NAO
vira trinta buscas: os Espacos sao agrupados pelo metodo que oferecem, cada
metodo roda uma vez, e a fusao junta. Duas representacoes dao tres metodos,
independentemente do numero de bases -- e o embedding da pergunta e calculado
uma vez por MODELO, compartilhado, porque o vetor da pergunta nao depende da
representacao que vai ser consultada.
"""

from __future__ import annotations

import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

from . import query as query_slot
from . import representations, retrieval, wiki
from .config import settings
from .db import conn, jsonb
from .extract import FIGURE_MARK_RE
from .retrieval import Candidato

log = logging.getLogger(__name__)


@dataclass
class Passage:
    chunk_id: int
    document_id: int
    space: str
    title: str
    filename: str
    content: str
    score: float
    # Posição e score POR MÉTODO de acesso, e não dois campos nomeados.
    #
    # A versão anterior tinha `vector_rank` e `lexical_rank` fixos, o que
    # obrigava a tocar o contrato a cada método novo — e a lista cresce (busca
    # de páginas na wiki, travessia de grafo). Com o mapa, um método novo
    # aparece aqui sozinho.
    ranks: dict[str, int] = field(default_factory=dict)
    method_scores: dict[str, float] = field(default_factory=dict)
    # De qual representação esta evidência veio. Vai no retorno para o agente
    # saber o que recebeu: um trecho do índice e uma página destilada não são a
    # mesma coisa, mesmo chegando na mesma lista.
    representacao: str = representations.INDICE
    # Pagina do ORIGINAL onde a evidencia esta. Vem do filho que casou, nao do
    # pai: o pai pode atravessar duas paginas, e a pergunta de quem le e "onde
    # exatamente", nao "mais ou menos onde".
    page: int | None = None
    # Total de paginas do original, para a UI saber se pode paginar.
    document_pages: int = 0
    # O texto do FILHO que casou. O que se entrega e o pai (contexto), mas para
    # achar a passagem dentro do PDF o que serve e o trecho curto -- procurar o
    # pai inteiro no arquivo nunca casa.
    match: str = ""
    # Aviso de armadilha, vazio quando nao ha. Sai NA MESMA passagem, e nao numa
    # chamada a parte: o conteudo que engana engana na primeira leitura, e o
    # aviso que exige uma segunda chamada chega depois do estrago.
    armadilha: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "chunk_id": self.chunk_id,
            "document_id": self.document_id,
            "space": self.space,
            "title": self.title,
            "filename": self.filename,
            "content": self.content,
            "representation": self.representacao,
            # score da fusao, e os componentes para a evidencia ser auditavel
            "page": self.page,
            "document_pages": self.document_pages,
            "match": self.match,
            "armadilha": self.armadilha,
            "score": round(self.score, 6),
            "scores": {
                # As duas chaves nomeadas continuam saindo porque o HISTÓRICO já
                # gravado tem esta forma: `search_run.results` guarda linhas
                # antigas, e a tela que as lê não pode quebrar por causa de um
                # contrato novo. As novas vivem em `by_method`.
                "vector": _arredonda(self.method_scores.get("semantica")),
                "lexical": _arredonda(self.method_scores.get("lexical")),
                "vector_rank": self.ranks.get("semantica"),
                "lexical_rank": self.ranks.get("lexical"),
                "by_method": {
                    metodo: {"score": _arredonda(self.method_scores.get(metodo)), "rank": posicao}
                    for metodo, posicao in sorted(self.ranks.items())
                },
            },
        }


def _arredonda(valor: float | None) -> float | None:
    return None if valor is None else round(valor, 6)


@dataclass
class SearchOutcome:
    passages: list[Passage]
    stages: dict[str, Any] = field(default_factory=dict)
    total_ms: int = 0
    embed_tokens: int = 0
    run_id: int | None = None


def _parents(cur, parent_ids: list[int]) -> dict[int, dict[str, Any]]:
    """O chunk pai e os dados do documento, para a expansão de contexto."""
    if not parent_ids:
        return {}
    cur.execute(
        """
        SELECT c.id, c.document_id, c.space_slug, c.content, c.page,
               d.title, d.filename, d.pages
          FROM chunk c
          JOIN document d ON d.id = c.document_id
         WHERE c.id = ANY(%s)
        """,
        (parent_ids,),
    )
    return {
        linha[0]: {
            "document_id": linha[1],
            "space": linha[2],
            "content": linha[3],
            "page": linha[4],
            "title": linha[5] or "",
            "filename": linha[6] or "",
            "document_pages": linha[7] or 0,
        }
        for linha in cur.fetchall()
    }


def _ativacoes(spaces: list[str] | None) -> dict[str, representations.Ativacao]:
    """As representações ativas de cada Espaço alcançável, numa consulta só.

    Uma consulta, e não uma por Espaço: com trinta bases a versão ingênua faria
    trinta idas ao banco só para descobrir o que consultar.
    """
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            SELECT slug, representations FROM space
             WHERE active AND (%s::text[] IS NULL OR slug = ANY(%s::text[]))
            """,
            (spaces, spaces),
        )
        return {
            linha[0]: representations.Ativacao.from_space(linha[1]) for linha in cur.fetchall()
        }


# Quantos métodos rodam ao mesmo tempo. O pool tem oito conexões e cada método
# abre a sua; quatro deixa folga para as outras requisições do serviço enquanto
# uma busca está rodando. Sem o teto, uma busca numa instalação com muitas
# representações poderia tomar o pool inteiro e travar o resto da API.
MAX_PARALELO = 4


def search(
    query: str,
    spaces: list[str] | None,
    top_k: int | None = None,
    principal: str = "",
    surface: str = "web",
    reescrita: str = "nenhuma",
    embedding_query: str = "crua",
    min_trust: str = "",
    as_of: str = "",
) -> SearchOutcome:
    """Uma passada, passagens candidatas de qualquer representação (BUS-01).

    O caso que manda no desenho é o real: trinta bases, cada uma com
    representações diferentes, e uma pergunta. Isto **não** vira trinta buscas.
    Os Espaços alcançáveis são agrupados pelo método de acesso que cada um
    oferece, cada método roda UMA vez sobre o seu grupo, e a fusão junta tudo.
    Duas representações dão três métodos, independentemente do número de bases.

    `min_trust` e `as_of` são o recorte do chamador, e os dois só restringem:
    o primeiro exige pelo menos aquele nível de confiança, o segundo exige que o
    conteúdo estivesse vigente naquela data. Levanta `ValueError` quando vêm
    escritos errado, em vez de ignorar em silêncio — devolver conteúdo não
    revisado a quem pediu que ele não viesse é o modo de falha caro aqui.
    """
    started = time.perf_counter()
    # ANTES de qualquer trabalho: recorte invalido tem de virar erro do
    # chamador, e nao uma busca completa que ele vai interpretar como recortada.
    filtros = retrieval.Filtros.de_parametros(min_trust, as_of)
    top_k = top_k or settings.default_top_k
    pool_size = max(settings.candidate_pool, top_k)
    stages: dict[str, Any] = {
        "escopo": {"tecnica": "space_grant", "espacos": spaces if spaces is not None else "todos"},
    }
    if filtros.ativo:
        # Etapa propria, e nao uma chave dentro de `escopo`: escopo e permissao
        # resolvida no servidor, recorte e escolha de quem chama. Juntar os dois
        # faria a telemetria sugerir que o chamador ampliou o proprio escopo.
        stages["recorte"] = {
            "tecnica": "min_trust e vigência na data do fato, na consulta",
            **filtros.to_dict(),
        }

    # --- F0. escopo ---
    #
    # Escopo vazio: o chamador nao alcanca nenhum Espaco. Resposta vazia, sem
    # erro -- um 403 aqui revelaria a existencia dos Espacos proibidos.
    if spaces is not None and not spaces:
        stages["escopo"]["resultado"] = "nenhum Espaco alcancavel"
        return SearchOutcome(passages=[], stages=stages, total_ms=0)

    ativacoes = _ativacoes(spaces)
    if not ativacoes:
        stages["escopo"]["resultado"] = "nenhum Espaco alcancavel"
        return SearchOutcome(passages=[], stages=stages, total_ms=0)
    grupos = representations.agrupar_por_metodo(ativacoes)
    stages["escopo"]["espacos_resolvidos"] = len(ativacoes)
    stages["escopo"]["metodos"] = sorted(grupos)

    # --- F1. melhoria de query (slot, default off) ---
    #
    # Desligada por padrao, e a razao e boa: cada variante custa uma chamada de
    # LLM ANTES da busca, na frente de quem espera. O texto que sai daqui vale
    # para TODOS os metodos, inclusive o lexical -- e por isso ele e uma
    # reescrita curta, e nao um paragrafo (isso e o F3, abaixo).
    #
    # O Espaco de referencia para escolher o modelo e o primeiro alcancavel: a
    # reescrita e uma so para a busca inteira, e ela nao pode depender de qual
    # base vai responder.
    espaco_do_modelo = sorted(ativacoes)[0] if ativacoes else ""
    texto_da_busca, trace_f1 = query_slot.reescrever(query, reescrita, espaco_do_modelo)
    stages["melhoria_query"] = trace_f1
    tokens_query = int(trace_f1.pop("tokens", 0) or 0)

    # --- F3 (parte). embedding de query ---
    #
    # Separado do F1 de proposito: isto troca o VETOR do metodo semantico sem
    # tocar no texto que o lexical usa.
    alvo_do_vetor, trace_vetor = query_slot.texto_para_vetor(
        texto_da_busca, embedding_query, espaco_do_modelo
    )
    tokens_query += int(trace_vetor.pop("tokens", 0) or 0)
    stages["melhoria_query"].update(trace_vetor)

    # --- F3. métodos de acesso em paralelo ---
    #
    # Em paralelo porque são I/O: cada um é uma ida ao Postgres (e, no
    # semântico, uma ao provedor de embedding). Em série, a latência da busca
    # seria a soma; em paralelo é a do mais lento.
    step = time.perf_counter()
    resultados: dict[str, list[Candidato]] = {}
    embed_tokens = 0

    def rodar(metodo: str) -> tuple[str, list[Candidato], dict]:
        recuperador = retrieval.RECUPERADORES[metodo]
        try:
            # So o semantico recebe o texto do vetor; os outros veem a pergunta
            # (reescrita, se o F1 estiver ligado).
            if metodo == "semantica" and alvo_do_vetor != texto_da_busca:
                candidatos, trace = recuperador(
                    texto_da_busca, grupos[metodo], pool_size, alvo_do_vetor, filtros=filtros
                )
            else:
                candidatos, trace = recuperador(
                    texto_da_busca, grupos[metodo], pool_size, filtros=filtros
                )
        except Exception as exc:  # noqa: BLE001
            # Um método que falha não derruba a busca: os outros seguem e a
            # resposta sai com o que deu. Uma busca sem o braço lexical é pior
            # que uma busca completa, e muito melhor que um erro.
            log.warning("metodo de acesso %s falhou: %s", metodo, exc)
            return metodo, [], {"erro": str(exc)[:200]}
        return metodo, candidatos, trace

    with ThreadPoolExecutor(max_workers=MAX_PARALELO) as executor:
        for metodo, candidatos, trace in executor.map(rodar, sorted(grupos)):
            resultados[metodo] = candidatos
            embed_tokens += int(trace.pop("tokens", 0) or 0)
            stages[metodo] = {**trace, "candidatos": len(candidatos)}

    # O gasto do slot de melhoria entra na conta: ele e IA gasta nesta busca, e
    # deixa-lo de fora faria a comparacao entre ligado e desligado parecer de
    # graca.
    embed_tokens += tokens_query

    stages["acesso"] = {
        "tecnica": "métodos por representação, em paralelo",
        "metodos": len(grupos),
        "latencia_ms": int((time.perf_counter() - step) * 1000),
    }

    # --- F4. threshold por método, fusão RRF e dedup ---
    step = time.perf_counter()
    k = settings.rrf_k
    fundidas: dict[str, Passage] = {}

    for metodo in sorted(resultados):
        corte = representations.METODOS[metodo].threshold
        posicao = 0
        descartados = 0
        for candidato in resultados[metodo]:
            # O corte é por método porque as escalas não são comparáveis entre
            # si — e é a mesma razão pela qual a fusão usa posição, e não score.
            if corte and candidato.score < corte:
                descartados += 1
                continue
            posicao += 1
            entrada = fundidas.get(candidato.key)
            if entrada is None:
                entrada = Passage(
                    chunk_id=_id_numerico(candidato.key),
                    document_id=candidato.document_id,
                    space=candidato.space,
                    title="",
                    filename="",
                    content=candidato.content,
                    score=0.0,
                    representacao=candidato.representacao,
                    page=candidato.page,
                    match=candidato.match,
                    armadilha=candidato.armadilha,
                )
                fundidas[candidato.key] = entrada
            elif not entrada.armadilha:
                # A mesma unidade de entrega pode chegar por varios metodos. O
                # aviso e do documento, entao e o mesmo nos dois -- mas se o
                # primeiro metodo a chegar tiver lido vazio por qualquer razao,
                # perder o aviso seria o pior desfecho possivel deste campo.
                entrada.armadilha = candidato.armadilha
            # Uma unidade de entrega que aparece por várias unidades de matching
            # NÃO acumula dentro do mesmo método: vale a melhor posição. Somar
            # premiaria documento longo, que tem mais filhos por acaso.
            anterior = entrada.ranks.get(metodo)
            if anterior is None or posicao < anterior:
                if anterior is not None:
                    entrada.score -= 1.0 / (k + anterior)
                entrada.ranks[metodo] = posicao
                entrada.method_scores[metodo] = candidato.score
                entrada.score += 1.0 / (k + posicao)
                # A unidade de matching de melhor posição é a que aponta a
                # página e o trecho: é a evidência mais forte daquela unidade.
                melhor = min(entrada.ranks.values())
                if posicao <= melhor:
                    entrada.page = candidato.page
                    entrada.match = candidato.match
        if descartados:
            stages[metodo]["descartados_por_threshold"] = descartados

    ranked = sorted(fundidas.values(), key=lambda p: p.score, reverse=True)[:top_k]
    stages["fusao"] = {
        "tecnica": f"RRF (k={k})",
        "candidatos_unicos": len(fundidas),
        "devolvidos": len(ranked),
        "latencia_ms": int((time.perf_counter() - step) * 1000),
    }
    marcadas = sum(1 for passage in ranked if passage.armadilha)
    if marcadas:
        # Na telemetria tambem, e nao so na passagem: e por aqui que a curadoria
        # descobre que uma armadilha esta sendo recuperada com frequencia.
        stages["fusao"]["armadilhas"] = marcadas

    # --- F4b. expansão de contexto: filho casa, pai entrega ---
    #
    # Só para o índice. A wiki entrega a página inteira, que já nasceu do
    # tamanho certo pelo contrato de destilação — expandi-la não faria sentido.
    step = time.perf_counter()
    do_indice = [p for p in ranked if p.representacao == representations.INDICE]
    if do_indice:
        with conn() as connection, connection.cursor() as cur:
            parents = _parents(cur, [p.chunk_id for p in do_indice])
        for passage in do_indice:
            parent = parents.get(passage.chunk_id)
            if parent:
                passage.content = parent["content"]
                passage.document_id = parent["document_id"]
                passage.space = parent["space"]
                passage.title = parent["title"]
                passage.filename = parent["filename"]
                passage.document_pages = parent["document_pages"]
                # A pagina do filho ganha da do pai: e mais precisa. A do pai
                # entra so quando o filho nao tinha nenhuma.
                if passage.page is None:
                    passage.page = parent["page"]
    stages["expansao_pai"] = {
        "tecnica": "filho casa, pai entrega (só índice)",
        "passagens": len(do_indice),
        "latencia_ms": int((time.perf_counter() - step) * 1000),
    }

    total_ms = int((time.perf_counter() - started) * 1000)

    # --- F6. telemetria por execucao (FUN-06) ---
    #
    # Resumo das passagens: o suficiente para auditar e comparar, sem duplicar o
    # texto do documento a cada busca.
    summary = [
        {
            "document_id": passage.document_id,
            "filename": passage.filename,
            "title": passage.title,
            "space": passage.space,
            "representation": passage.representacao,
            "score": round(passage.score, 6),
            "vector_score": passage.method_scores.get("semantica"),
            "lexical_score": passage.method_scores.get("lexical"),
            "page": passage.page,
            "armadilha": passage.armadilha,
            "excerpt": " ".join((passage.content or "").split())[:280],
        }
        for passage in ranked
    ]
    run_id = None
    try:
        with conn() as connection, connection.cursor() as cur:
            cur.execute(
                """
                INSERT INTO search_run
                    (query, spaces, principal, surface, stages, total_ms,
                     embed_tokens, result_count, results)
                VALUES (%s, %s::jsonb, %s, %s, %s::jsonb, %s, %s, %s, %s::jsonb)
                RETURNING id
                """,
                (
                    query,
                    jsonb(spaces if spaces is not None else []),
                    principal,
                    surface,
                    jsonb(stages),
                    total_ms,
                    embed_tokens,
                    len(ranked),
                    jsonb(summary),
                ),
            )
            run_id = cur.fetchone()[0]
            connection.commit()
    except Exception as exc:  # noqa: BLE001
        # Telemetria que derruba a busca e pior que telemetria ausente.
        log.warning("nao consegui registrar a execucao da busca: %s", exc)

    return SearchOutcome(
        passages=ranked,
        stages=stages,
        total_ms=total_ms,
        embed_tokens=embed_tokens,
        run_id=run_id,
    )


def _id_numerico(key: str) -> int:
    """O id que a chave da unidade de entrega carrega.

    A chave é prefixada pela origem (`chunk:123`, `pagina:45`) para duas
    representações nunca colidirem numa mesma fusão. O `chunk_id` do retorno
    continua sendo o número, porque é por ele que o `fetch` e a UI navegam.
    """
    _, _, numero = key.partition(":")
    try:
        return int(numero)
    except ValueError:
        return 0


def _with_figure_links(
    markdown: str, figuras: dict[str, dict[str, Any]], document_id: int
) -> str:
    """Marca de figura -> link Markdown para a imagem guardada.

    Sem isso, o canonico traz o texto que o OCR leu mas nao a imagem de onde
    ele saiu -- e quem le nao tem como conferir se a leitura corresponde a
    figura. O link vai junto da legenda e da pagina, para o proprio texto dizer
    de onde aquele trecho veio.

    Figura sem imagem guardada (falha no object store) mantem a marca: um link
    que da 404 seria pior do que nao ter link.
    """
    if not figuras:
        return markdown

    def trocar(match: re.Match[str]) -> str:
        ref = match.group(1)
        figura = figuras.get(ref)
        if figura is None or not figura["has_image"]:
            return match.group(0)
        rotulo = figura["caption"] or f"imagem {ref}"
        pagina = f" (pagina {figura['page']})" if figura["page"] else ""
        return f"![{rotulo}{pagina}](/v1/documents/{document_id}/figures/{ref}/image)"

    return FIGURE_MARK_RE.sub(trocar, markdown)


# Segredo com forma de segredo, mascarado na saida.
#
# NAO E PARANOIA: `document_representation.error` guarda, entre outras coisas, a
# mensagem que `llm.py` monta com 200 bytes CRUS do corpo de recusa do provedor.
# Provedor recusando credencial responde coisa como
# `Incorrect API key provided: sk-proj-AbC...XyZ`, e isso e um pedaco de chave.
#
# Enquanto esse texto so aparecia no log e na tela de ingestao, quem lia era
# administrador. Expo-lo em `/v1/documents/{id}` muda o publico: a rota depende
# de `current_principal`, entao qualquer identidade que alcance o Espaco passa a
# ler. O ADR-0009 diz que credencial sai no maximo com os quatro ultimos
# caracteres; mascarar aqui mantem a promessa no ponto onde a exposicao nasce, e
# cobre de uma vez a rota e o `fetch` do MCP, que usam a mesma funcao.
# A regra generica do fim e a delicada. `[A-Za-z0-9_-]{32,}` pegaria
# `Politica_de_Diversidade_e_Inclusao_2025`, que tem 39 caracteres e e o nome do
# arquivo -- justamente a parte do erro que serve para alguma coisa. Por isso ela
# recusa sublinhado e exige digito E letra na mesma sequencia: nome de arquivo em
# portugues separa palavra com `_` ou espaco, token opaco nao separa nada.
_PARECE_SEGREDO = re.compile(
    r"\b(?:sk|pk|rk|xai|gsk|ghp|ghs|xox[bapsr])-[A-Za-z0-9_\-]{8,}"
    r"|\bBearer\s+[A-Za-z0-9._\-]{16,}"
    r"|\b(?=[A-Za-z0-9\-]{32,}\b)(?=[^\s]*\d)(?=[^\s]*[A-Za-z])[A-Za-z0-9\-]{32,}\b"
)


def _sem_segredo(texto: str | None) -> str | None:
    """Troca o que tem forma de credencial pelos quatro ultimos caracteres."""
    if not texto:
        return texto
    return _PARECE_SEGREDO.sub(lambda m: f"[oculto:…{m.group(0)[-4:]}]", texto)


def fetch_document(document_id: int, spaces: list[str] | None) -> dict[str, Any] | None:
    """Documento canonico inteiro por id (BUS-07).

    O filtro de Espaco vale aqui igual a busca: o `fetch` nao e uma porta de
    servico para pular a permissao.
    """
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            SELECT d.id, d.space_slug, d.title, d.filename, d.canonical_md,
                   d.extractor, d.mime, d.size_bytes, d.version, d.content_sha,
                   d.created_at, d.indexed_at, d.tags, d.pages, d.okf
              FROM document d
             WHERE d.id = %s AND d.active
               AND (%s::text[] IS NULL OR d.space_slug = ANY(%s::text[]))
            """,
            (document_id, spaces, spaces),
        )
        row = cur.fetchone()
        if row is None:
            return None

        # As figuras do documento, para trocar cada marca por um link real. O
        # canonico e gravado com `<!-- figura fig-1 -->` (estavel, sem URL); o
        # link e montado aqui, na leitura. Assim o texto indexado nao carrega a
        # rota da API de hoje, e nenhuma reescrita desloca os offsets que dao a
        # pagina de cada trecho.
        cur.execute(
            "SELECT ref, page, caption, image_key FROM document_figure WHERE document_id = %s",
            (document_id,),
        )
        figuras = {
            ref: {"page": page, "caption": caption, "has_image": bool(key)}
            for ref, page, caption, key in cur.fetchall()
        }
        # O RESULTADO DE CADA REPRESENTACAO, que ate agora era gravado e nunca
        # lido. `document_representation` existe exatamente para responder "por
        # que a wiki deste documento nao saiu?", e sem rota nenhuma que a
        # devolvesse a resposta ficava enterrada no banco -- a tela mostrava
        # zero paginas e ninguem sabia se foi o modelo, o contrato ou a base.
        cur.execute(
            "SELECT representation, status, error, updated_at FROM document_representation "
            " WHERE document_id = %s ORDER BY representation",
            (document_id,),
        )
        construcoes = [
            {"representation": r[0], "status": r[1], "error": _sem_segredo(r[2]),
             "updated_at": r[3].isoformat() if r[3] else None}
            for r in cur.fetchall()
        ]
        return {
            "id": row[0],
            "space": row[1],
            "title": row[2],
            "filename": row[3],
            "canonical_md": _with_figure_links(row[4], figuras, document_id),
            "extractor": row[5],
            "mime": row[6],
            "size_bytes": row[7],
            "version": row[8],
            "content_sha": row[9],
            "created_at": row[10].isoformat() if row[10] else None,
            "indexed_at": row[11].isoformat() if row[11] else None,
            "tags": row[12],
            "pages": row[13] or 0,
            # BUS-07: o `fetch` de um documento traz as paginas da wiki que
            # derivam dele, quando a wiki esta ativa no Espaco. E o que abre a
            # navegacao nos dois sentidos -- da pagina para a fonte e da fonte
            # para a pagina.
            "wiki_pages": wiki.paginas_do_documento(document_id),
            # `representation_status`, e nao `representations`: no Espaco esse
            # nome ja e o mapa liga/desliga das representacoes. Aqui e o
            # RESULTADO do build de cada uma neste documento. Dois significados
            # no mesmo nome custariam uma leitura errada por ano.
            "representation_status": construcoes,
            # Vazio quando o documento nao e um conceito OKF, que e o caso da
            # maioria. A tela usa a presenca de `type` para decidir se mostra o
            # bloco do conceito.
            "okf": row[14] or {},
        }

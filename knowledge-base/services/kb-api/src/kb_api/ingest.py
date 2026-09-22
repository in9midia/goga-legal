"""Pipeline de ingestao: bruto -> canonico -> chunks -> embedding -> indice.

Ordem e por que ela importa:

1. **bruto no object store, intacto** (ING-02). Antes de qualquer processamento,
   para o reprocessamento com outra tecnica ser possivel sem o arquivo original.
2. **canonico** (ING-03) pelo extrator escolhido, versionado no Postgres.
3. **chunks pai/filho** (ING-07) pelo LlamaIndex.
4. **embedding do filho** (ING-09) em tabela separada.
5. **grafo** (ING-12), auxiliar e opcional.

Imutabilidade (FUN-02): reingerir o mesmo arquivo nao faz UPDATE de texto. A
versao anterior e desativada e uma nova e criada; chunk e embedding da antiga
cascateiam. Reingerir arquivo IDENTICO (mesmo sha) e no-op -- o que torna a
carga em massa (`scripts/ingest.sh`) segura de repetir.
"""

from __future__ import annotations

import hashlib
import logging
import mimetypes
import time
from dataclasses import dataclass, field
from typing import Any

from . import graph, okf, providers, representations, storage, wiki
from .chunking import ChunkConfig, plan
from .db import as_vector, conn, jsonb
from .embedding import embed
from .extract import ExtractionError, extract, page_of_offset

log = logging.getLogger(__name__)


@dataclass
class IngestResult:
    document_id: int | None
    filename: str
    status: str
    extractor: str = ""
    parents: int = 0
    children: int = 0
    embed_tokens: int = 0
    chunk_technique: str = ""
    # O motor PEDIDO. Pode diferir da tecnica efetiva: `semantic` que falha cai
    # para markdown, e so comparando os dois campos da para notar.
    chunk_engine: str = ""
    # Variante de enriquecimento PEDIDA, ao lado do motor. Os dois juntos sao o
    # que diz se um documento esta alinhado com a configuracao atual da base.
    chunk_enrichment: str = ""
    # Tipo do conceito OKF, vazio quando o arquivo nao era um. Existe para a
    # tela poder dizer "5 dos 40 arquivos do bundle nao foram reconhecidos":
    # sem isso, um Espaco em modo OKF onde o modo nao pegou em nada parece estar
    # funcionando, porque a ingestao reporta sucesso do mesmo jeito.
    okf_type: str = ""
    okf_links: int = 0
    # Conceito GERADO pelo modelo, e nao lido de um frontmatter escrito. Separa
    # no log de ingestao o que custou chamada de IA do que veio de graca.
    okf_derived: bool = False
    # O desfecho de cada representacao construida alem do indice. Fica no
    # retorno para a tela dizer o que foi feito, e o estado durável vive em
    # `document_representation`.
    representations: dict[str, Any] = field(default_factory=dict)
    graph_written: bool = False
    pages: int = 0
    figures: int = 0
    # Quantas figuras o OCR conseguiu ler. A diferenca entre `figures` e este
    # numero e o que a base NAO indexou por ser imagem sem texto legivel --
    # informacao que so aparece se for medida.
    figures_with_text: int = 0
    total_ms: int = 0
    error: str = ""
    already_indexed: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "document_id": self.document_id,
            "filename": self.filename,
            "status": self.status,
            "extractor": self.extractor,
            "parents": self.parents,
            "children": self.children,
            "embed_tokens": self.embed_tokens,
            "pages": self.pages,
            "figures": self.figures,
            "figures_with_text": self.figures_with_text,
            "chunk_technique": self.chunk_technique,
            "chunk_engine": self.chunk_engine,
            "chunk_enrichment": self.chunk_enrichment,
            "okf_type": self.okf_type,
            "okf_links": self.okf_links,
            "okf_derived": self.okf_derived,
            "representations": self.representations,
            "graph": self.graph_written,
            "total_ms": self.total_ms,
            "already_indexed": self.already_indexed,
            "error": self.error,
        }


def _run_open(space_slug: str, filename: str, size: int, principal: str) -> int | None:
    """Abre a linha do log de ingestao. Falha aqui nao impede a ingestao."""
    try:
        with conn() as connection, connection.cursor() as cur:
            cur.execute(
                """
                INSERT INTO ingest_run (space_slug, filename, size_bytes, principal)
                VALUES (%s,%s,%s,%s) RETURNING id
                """,
                (space_slug, filename, size, principal),
            )
            run_id = cur.fetchone()[0]
            connection.commit()
        return run_id
    except Exception as exc:  # noqa: BLE001
        log.warning("nao consegui abrir o log de ingestao: %s", exc)
        return None


def _run_close(run_id: int | None, result: IngestResult) -> None:
    """Fecha a linha com o desfecho. Idem: nunca derruba a ingestao."""
    if run_id is None:
        return
    try:
        with conn() as connection, connection.cursor() as cur:
            cur.execute(
                """
                UPDATE ingest_run
                   SET status = %s, document_id = %s, extractor = %s, pages = %s,
                       figures = %s, parents = %s, children = %s, embed_tokens = %s,
                       chunk_engine = %s, total_ms = %s, error = %s, finished_at = now()
                 WHERE id = %s
                """,
                (
                    "skipped" if result.already_indexed else result.status,
                    result.document_id, result.extractor, result.pages, result.figures,
                    result.parents, result.children, result.embed_tokens,
                    result.chunk_engine, result.total_ms, result.error[:1000], run_id,
                ),
            )
            connection.commit()
    except Exception as exc:  # noqa: BLE001
        log.warning("nao consegui fechar o log de ingestao %s: %s", run_id, exc)


def ingest_document(
    space_slug: str, filename: str, data: bytes, principal: str = "", force: bool = False
) -> IngestResult:
    """Ingestao de um documento, do bruto ao indice.

    Sincrona de proposito nesta v0: quando o POST retorna, o documento ja esta
    buscavel. O preco e que um PDF grande com OCR segura a conexao por minutos,
    e e por isso que existe o log de ingestao -- ele e a unica janela para o que
    esta acontecendo enquanto a chamada nao volta.
    """
    started = time.perf_counter()
    run_id = _run_open(space_slug, filename, len(data), principal)
    try:
        resultado = _ingest_document(space_slug, filename, data, started, force)
    except Exception as exc:  # noqa: BLE001
        # Erro inesperado tambem fecha a linha: log de ingestao que so registra
        # sucesso esconde justamente o que se quer investigar.
        #
        # E REGISTRA O DOCUMENTO, que e o que torna a retentativa possivel.
        # Antes, falha DEPOIS da extracao (provedor fora do ar, por exemplo)
        # subia a excecao e nao deixava linha nenhuma: o bruto ficava orfao no
        # object store, e nao havia de onde retentar nem como saber que aquele
        # arquivo tinha existido. Numa carga de trezentos arquivos, o que some
        # assim some para sempre.
        document_id = None
        try:
            content_sha = hashlib.sha256(data).hexdigest()
            document_id = _registrar_falha(
                space_slug, filename, content_sha,
                mimetypes.guess_type(filename)[0] or "application/octet-stream",
                len(data),
                f"{space_slug}/{content_sha[:2]}/{content_sha}/{filename}", str(exc),
            )
        except Exception as registro:  # noqa: BLE001
            log.warning("falha ao registrar %s para retentativa: %s", filename, registro)
        _run_close(
            run_id,
            IngestResult(
                document_id=document_id, filename=filename, status="failed",
                error=str(exc)[:500],
                total_ms=int((time.perf_counter() - started) * 1000),
            ),
        )
        raise
    _run_close(run_id, resultado)
    return resultado


def _ingest_document(
    space_slug: str, filename: str, data: bytes, started: float, force: bool = False
) -> IngestResult:
    content_sha = hashlib.sha256(data).hexdigest()
    mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"

    # --- no-op quando o conteudo ja esta indexado ---
    #
    # `force=True` PULA este atalho. E o que o reprocessamento precisa: o
    # conteudo e identico por definicao (vem do mesmo bruto), e sem isto a
    # ingestao responderia "ja indexado" sem refazer nada.
    #
    # Antes o reprocessamento resolvia isso APAGANDO o documento antes de
    # reingerir, e essa ordem tinha uma janela de perda real: a falha do
    # embedding acontece DEPOIS do delete e ANTES do insert da versao nova,
    # entao um provedor de IA mal configurado APAGAVA o documento em vez de
    # marca-lo como falho. Aconteceu com os quatro documentos do Espaco
    # `juridico` desta instalacao. Com o `force`, quem versiona e o caminho
    # normal (desativa a antiga e insere a nova na MESMA transacao), e a falha
    # deixa a versao antiga ativa e intacta.
    existing = None
    if not force:
        with conn() as connection, connection.cursor() as cur:
            cur.execute(
                """
                SELECT id, extractor FROM document
                 WHERE space_slug = %s AND content_sha = %s AND active
                   AND status = 'indexed'
                """,
                (space_slug, content_sha),
            )
            existing = cur.fetchone()
    if existing:
        return IngestResult(
            document_id=existing[0],
            filename=filename,
            status="indexed",
            extractor=existing[1],
            already_indexed=True,
            total_ms=int((time.perf_counter() - started) * 1000),
        )

    # --- 1. bruto intacto no object store ---
    raw_key = f"{space_slug}/{content_sha[:2]}/{content_sha}/{filename}"
    storage.put(raw_key, data, mime)

    # --- 2. canonico ---
    try:
        extracted = extract(data, filename)
    except ExtractionError as exc:
        document_id = _registrar_falha(
            space_slug, filename, content_sha, mime, len(data), raw_key, str(exc)
        )
        return IngestResult(
            document_id=document_id,
            filename=filename,
            status="failed",
            error=str(exc),
            total_ms=int((time.perf_counter() - started) * 1000),
        )

    # --- 3. chunks pai/filho ---
    #
    # O canonico GRAVADO guarda a figura como marca (`<!-- figura fig-1 -->`), e
    # nao como link. O link precisa do id do documento e da rota da API, e
    # gravar isso no texto teria dois custos: acoplaria o artefato ao layout de
    # rotas de hoje, e qualquer reescrita depois deslocaria os offsets que dao a
    # pagina de cada trecho. O link e assunto de LEITURA -- quem monta e o
    # fetch_document (search.py), na hora de servir.
    canonical = extracted.markdown

    # O motor de corte vem do ESPACO, nao de uma configuracao global: e o que
    # permite duas bases com estrategias diferentes convivendo na mesma
    # instalacao, cada uma com o corte que o formato dos documentos dela pede.
    # Junto vem o conjunto de REPRESENTACOES ativas, que decide o fan-out do
    # passo 6.
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            "SELECT chunking, representations FROM space WHERE slug = %s", (space_slug,)
        )
        linha = cur.fetchone()
    chunk_cfg = ChunkConfig.from_space(linha[0] if linha else None)
    ativas = representations.Ativacao.from_space(linha[1] if linha else None)

    # --- conceito OKF: lido quando vem escrito, derivado quando nao vem ---
    #
    # Fica AQUI, e nao dentro de `chunking.plan()`, por dois motivos: a
    # derivacao e uma chamada de rede que custa dinheiro por documento, e o
    # corte precisa continuar testavel sem provedor de IA nenhum. A politica de
    # qual conceito ganha esta em `okf.resolve`.
    concept = (
        okf.resolve(canonical, filename, chunk_cfg.okf_types, extracted.title, space_slug)
        if chunk_cfg.okf
        else None
    )

    chunk_plan = plan(canonical, chunk_cfg, concept=concept, space=space_slug)
    child_texts = [child.content for parent in chunk_plan.parents for child in parent.children]

    okf_alvos = okf.link_targets(concept) if concept else []

    # O titulo do conceito vale mais que o primeiro cabecalho do documento.
    # Num PDF de contrato, esse cabecalho costuma ser "CLAUSULA PRIMEIRA" ou o
    # nome do escritorio no papel timbrado, e era isso que ia para a tela e para
    # a citacao do agente.
    titulo = (concept.title if concept else "") or extracted.title or filename

    # --- 4. embedding do filho ---
    embedded = embed(child_texts, "index", space_slug) if child_texts else None
    vectors = embedded.vectors if embedded else []
    embed_tokens = embedded.tokens if embedded else 0

    # --- gravacao: versao nova, anterior desativada (FUN-02) ---
    with conn() as connection:
        with connection.cursor() as cur:
            cur.execute(
                "SELECT COALESCE(MAX(version), 0) FROM document WHERE space_slug=%s AND filename=%s",
                (space_slug, filename),
            )
            version = (cur.fetchone()[0] or 0) + 1
            cur.execute(
                "UPDATE document SET active = FALSE WHERE space_slug=%s AND filename=%s AND active"
                " RETURNING id",
                (space_slug, filename),
            )
            # Os ids que acabaram de sair de circulacao. O grafo deles precisa
            # sair junto, e o `RETURNING` e o unico momento em que eles sao
            # conhecidos -- depois do commit a consulta ja nao sabe distinguir
            # "desativado agora" de "desativado mes passado".
            desativados = [linha[0] for linha in cur.fetchall()]
            cur.execute(
                """
                INSERT INTO document
                    (space_slug, filename, title, content_sha, mime, size_bytes,
                     raw_key, canonical_md, extractor, chunk_engine, chunk_enrichment,
                     version, pages, okf, status, indexed_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'indexed',now())
                RETURNING id
                """,
                (
                    space_slug, filename, titulo, content_sha,
                    mime, len(data), raw_key, canonical,
                    extracted.extractor, chunk_cfg.engine, chunk_cfg.enrichment,
                    version, extracted.pages,
                    jsonb(concept.to_dict() if concept else {}),
                ),
            )
            document_id = cur.fetchone()[0]

            def page_for(start: int) -> int | None:
                # Offset -1 = pedaco que nao foi localizado no canonico. Nesse
                # caso a pagina fica nula: apontar a pagina errada e pior do que
                # nao apontar nenhuma.
                return page_of_offset(canonical, start) if start >= 0 else None

            child_index = 0
            for order, parent in enumerate(chunk_plan.parents):
                cur.execute(
                    """
                    INSERT INTO chunk
                        (document_id, space_slug, parent_id, ord, content, page, char_start, tsv)
                    VALUES (%s,%s,NULL,%s,%s,%s,%s, to_tsvector('portuguese', unaccent(%s)))
                    RETURNING id
                    """,
                    (document_id, space_slug, order, parent.content,
                     page_for(parent.start), parent.start if parent.start >= 0 else None,
                     parent.content),
                )
                parent_id = cur.fetchone()[0]

                for child_order, child in enumerate(parent.children):
                    cur.execute(
                        """
                        INSERT INTO chunk
                            (document_id, space_slug, parent_id, ord, content, page, char_start, tsv)
                        VALUES (%s,%s,%s,%s,%s,%s,%s, to_tsvector('portuguese', unaccent(%s)))
                        RETURNING id
                        """,
                        (document_id, space_slug, parent_id, child_order, child.content,
                         page_for(child.start), child.start if child.start >= 0 else None,
                         child.content),
                    )
                    chunk_id = cur.fetchone()[0]
                    if child_index < len(vectors):
                        cur.execute(
                            """
                            INSERT INTO chunk_embedding (chunk_id, space_slug, model, embedding)
                            VALUES (%s,%s,%s,%s::vector)
                            """,
                            # O modelo vem do RESULTADO, nao da configuracao:
                            # agora que o provedor e editavel, a config pode
                            # mudar no meio de uma ingestao longa e o vetor
                            # ficaria rotulado com o modelo errado.
                            (chunk_id, space_slug, embedded.model if embedded else "",
                             as_vector(vectors[child_index])),
                        )
                    child_index += 1

            # --- figuras: PNG no object store, texto e ponteiro no Postgres ---
            for figura in extracted.figures:
                image_key = f"{space_slug}/{content_sha}/figuras/{figura.ref}.png"
                try:
                    storage.put(image_key, figura.data, "image/png")
                except Exception as exc:  # noqa: BLE001
                    # Figura sem imagem guardada ainda vale pelo texto do OCR,
                    # que e o que a busca usa. Registra sem a chave.
                    log.warning("nao guardei a figura %s de %s: %s", figura.ref, filename, exc)
                    image_key = ""
                cur.execute(
                    """
                    INSERT INTO document_figure
                        (document_id, space_slug, ref, page, caption, ocr_text, image_key, bytes)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (document_id, ref) DO UPDATE
                       SET page = EXCLUDED.page, caption = EXCLUDED.caption,
                           ocr_text = EXCLUDED.ocr_text, image_key = EXCLUDED.image_key,
                           bytes = EXCLUDED.bytes
                    """,
                    (document_id, space_slug, figura.ref, figura.page, figura.caption,
                     figura.ocr_text, image_key, len(figura.data)),
                )
        connection.commit()

    # --- 5. grafo, auxiliar ---
    #
    # A VERSAO ANTIGA SAI DO GRAFO ANTES DA NOVA ENTRAR.
    #
    # O `DELETE` do Postgres tem cascata; a desativacao nem isso -- a linha
    # velha continua la, so com `active = FALSE`. O no `:Document` dela ficava
    # apontando para uma versao que a API ja nao serve, e clicar nele na tela do
    # grafo dava "documento nao encontrado" (armadilha 24).
    #
    # Medido numa carga real: reenviar um arquivo que ja estava na base deixou
    # o no da versao 1 para tras enquanto a versao 2 entrava com id novo. Um
    # orfao por reenvio, sem erro nenhum e sem rastro.
    #
    # Depois do commit, nunca antes: se a gravacao falhasse, a versao antiga
    # continuaria ativa e teria acabado de perder o grafo dela.
    for antigo in desativados:
        graph.forget_document(antigo)

    graph_written = graph.upsert_document(
        document_id,
        space_slug,
        titulo,
        graph.terms(canonical),
        # So conceito ESCRITO entra no grafo por nome de arquivo. Um conceito
        # derivado nao tem links e ninguem o referencia por caminho de bundle:
        # criar o no para ele encheria o grafo de conceitos com grau zero, que
        # nao ligam nada e ainda aparecem na contagem.
        okf_file=filename if concept and not concept.derived else "",
        okf_links=okf_alvos,
    )

    # --- 6. fan-out das demais representacoes ---
    #
    # Os builds sao INDEPENDENTES: a falha de um nao impede o andamento dos
    # outros (ingestion-pipeline.md §5). A wiki falhando nao pode levar junto um
    # indice que foi construido com sucesso -- o documento continua buscavel pelo
    # indice, e a representacao falha e reprocessavel sozinha.
    representacoes: dict[str, dict] = {}
    if representations.GRAFO in ativas.auxiliares:
        # Estrutura AUXILIAR do indice: roda depois de os chunks existirem,
        # porque e sobre os chunks pais que a extracao opera.
        resultado_grafo = graph.construir(space_slug, document_id)
        representacoes[representations.GRAFO] = resultado_grafo
        _registrar_representacao(document_id, representations.GRAFO, resultado_grafo)
    if ativas.tem(representations.WIKI):
        resultado_wiki = wiki.construir(space_slug, document_id, titulo, canonical)
        representacoes[representations.WIKI] = resultado_wiki
        _registrar_representacao(document_id, representations.WIKI, resultado_wiki)

    return IngestResult(
        document_id=document_id,
        filename=filename,
        status="indexed",
        representations=representacoes,
        extractor=extracted.extractor,
        parents=len(chunk_plan.parents),
        children=len(child_texts),
        embed_tokens=embed_tokens,
        chunk_technique=chunk_plan.technique,
        chunk_engine=chunk_cfg.engine,
        chunk_enrichment=chunk_cfg.enrichment,
        okf_type=concept.type if concept else "",
        okf_links=len(okf_alvos),
        okf_derived=concept.derived if concept else False,
        graph_written=graph_written,
        pages=extracted.pages,
        figures=len(extracted.figures),
        figures_with_text=sum(1 for f in extracted.figures if f.ocr_text),
        total_ms=int((time.perf_counter() - started) * 1000),
    )


# O que uma base NOVA recebe quando ninguem escolhe nada.
#
# ⚠ ISTO NAO E O MESMO QUE `chunking.ENRIQUECIMENTO_PADRAO`, e a diferenca
# importa. Aquele e o fallback de LEITURA: o valor que uma base gravada sem a
# chave assume. Mexer nele trocaria, em silencio, o comportamento de toda base ja
# existente -- inclusive as que foram indexadas com outro texto. Este aqui e
# gravado EXPLICITAMENTE na criacao, e so afeta quem nascer depois.
#
# POR QUE ESTES VALORES, medidos contra 275 manuais reais:
#
# * `markdown` -- o canonico sai do docling com titulo e secao. Cortar pela
#   estrutura mantem o trecho inteiro; o `sentence` corta no meio de um passo
#   numerado. Para texto sem estrutura nenhuma, `sentence` ainda e a escolha, e
#   por isso isto e um DEFAULT e nao uma regra.
# * `conceito` -- prepende "Tipo: TITULO -- descricao" antes do embedding
#   (Contextual Chunk Headers). Medido: `ts_rank_cd` de 0,0000 para 0,4000 na
#   mesma pergunta. Custa uma chamada de chat por documento.
# * `grafo` ligado -- medido em 32 perguntas sobre a base de manuais: a travessia
#   participou de 232 das 320 passagens do top-10, e foi a UNICA a achar 4 delas.
#   Custa ate seis chamadas por documento, e e o item mais caro daqui.
# * `wiki` DESLIGADA -- e a unica cujo beneficio nao foi medido em escala. Ela
#   custa uma destilacao por documento, e ligar o que nao se mediu contraria a
#   regra do projeto ("o criterio para promover e evidencia medida"). Fica a um
#   clique, para quem tiver perguntas de alto nivel e quiser medir.
CONFIGURACAO_PADRAO = {
    "engine": "markdown",
    "enrichment": "conceito",
}
REPRESENTACOES_PADRAO = {"indice": True, "wiki": False, "grafo": True}


# ── retentativa: o que adianta tentar de novo ─────────────────────────────

RECUPERAVEL = "recuperavel"
DEFINITIVO = "definitivo"

# Espera antes de cada tentativa, em minutos. Cresce porque os modos de falha
# crescem junto: um 429 passa em minutos, um provedor mal configurado espera
# alguem arrumar. A ultima espera e longa de proposito -- se ate la nao voltou,
# quase certamente precisa de gente.
BACKOFF_MINUTOS = (5, 15, 45, 180, 720)
MAX_TENTATIVAS = len(BACKOFF_MINUTOS)

# Trechos que marcam erro DEFINITIVO. A lista e por mensagem e nao por tipo de
# excecao porque o mesmo tipo cobre os dois casos: `EmbeddingError` tanto e o
# 429 que passa sozinho quanto o 400 que vai falhar igual para sempre.
#
# Na duvida a classificacao e RECUPERAVEL, e isso e deliberado: o custo de
# errar para esse lado e limitado (cinco tentativas espacadas e para), enquanto
# errar para o outro deixa um documento fora da base sem ninguem saber.
_DEFINITIVOS = (
    # Arquivo que nenhum extrator leu: senha, corrompido, imagem sem OCR.
    "nenhum extrator produziu texto",
    # Dimensao trocada: retentar produz o mesmo vetor errado. So muda com
    # decisao de configuracao.
    "dimensoes",
    "dimensions",
    # O provedor recusou a ENTRADA. 400 nao vira 200 esperando.
    "http 400",
    "invalid_request",
    # Arquivo maior que o teto: o teto nao muda sozinho.
    "passa do limite",
)


def classificar_erro(mensagem: str) -> str:
    """`recuperavel` ou `definitivo`, pela mensagem.

    Ver `_DEFINITIVOS` para por que a decisao e por texto e por que a duvida
    cai em recuperavel.
    """
    baixo = (mensagem or "").lower()
    return DEFINITIVO if any(t in baixo for t in _DEFINITIVOS) else RECUPERAVEL


def _registrar_falha(
    space_slug: str, filename: str, content_sha: str, mime: str, tamanho: int,
    raw_key: str, erro: str,
) -> int | None:
    """Grava (ou atualiza) o documento que falhou, com o plano de retentativa.

    ⚠ ISTO PRECISA ACONTECER PARA QUALQUER FALHA, e nao so para a de extracao.
    Antes, erro depois da extracao (provedor fora do ar, por exemplo) subia a
    excecao sem deixar linha nenhuma: o bruto ficava no object store, orfao, e
    nao havia de onde retentar -- nem como saber que aquele arquivo existiu.

    Procura a linha que ja falhou com o MESMO conteudo antes de inserir: a
    retentativa passa por aqui de novo quando falha de novo, e o que interessa e
    a contagem subir, nao uma linha nova por tentativa.

    Sem `ON CONFLICT` de proposito. Ele exigiria indice unico em
    `(space_slug, content_sha)`, e esse indice quebraria o reprocessamento, que
    cria a versao nova ANTES de apagar a antiga -- as duas com o mesmo conteudo,
    as duas ativas por um instante.
    """
    tipo = classificar_erro(erro)
    try:
        with conn() as connection, connection.cursor() as cur:
            cur.execute(
                """
                SELECT id, retry_count FROM document
                 WHERE space_slug = %s AND content_sha = %s AND active
                   AND status = 'failed'
                 ORDER BY id DESC LIMIT 1
                """,
                (space_slug, content_sha),
            )
            existente = cur.fetchone()

            if existente is None:
                espera = BACKOFF_MINUTOS[0] if tipo == RECUPERAVEL else None
                cur.execute(
                    """
                    INSERT INTO document
                        (space_slug, filename, title, content_sha, mime, size_bytes,
                         raw_key, status, error, error_kind, retry_count, next_retry_at)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,'failed',%s,%s,0,
                            CASE WHEN %s::int IS NULL THEN NULL
                                 ELSE now() + (%s || ' minutes')::interval END)
                    RETURNING id
                    """,
                    (space_slug, filename, filename, content_sha, mime, tamanho,
                     raw_key, erro[:500], tipo, espera, espera),
                )
            else:
                document_id, tentativas = existente
                proxima = tentativas + 1
                # Sem proxima espera quando o erro e definitivo ou quando as
                # tentativas acabaram: `next_retry_at` nulo e o que tira a linha
                # da fila do worker, e e tambem o que a tela le como "parou de
                # tentar".
                espera = (
                    BACKOFF_MINUTOS[proxima]
                    if tipo == RECUPERAVEL and proxima < MAX_TENTATIVAS
                    else None
                )
                cur.execute(
                    """
                    UPDATE document
                       SET status = 'failed', error = %s, error_kind = %s,
                           retry_count = %s,
                           next_retry_at = CASE WHEN %s::int IS NULL THEN NULL
                                                ELSE now() + (%s || ' minutes')::interval END
                     WHERE id = %s
                    RETURNING id
                    """,
                    (erro[:500], tipo, proxima, espera, espera, document_id),
                )
            linha = cur.fetchone()
            connection.commit()
        return linha[0] if linha else None
    except Exception as exc:  # noqa: BLE001
        log.warning("nao consegui registrar a falha de %s: %s", filename, exc)
        return None


def ensure_space(
    slug: str,
    label: str,
    description: str = "",
    grants: list[dict] | None = None,
    chunking: dict | None = None,
) -> dict:
    """Cria ou atualiza o Espaco, os vinculos de permissao e o motor de corte.

    `chunking=None` PRESERVA o que estava gravado, em vez de zerar. A ingestao
    chama esta funcao a cada rodada sem saber de chunking, e sobrescrever ali
    apagaria em silencio a configuracao escolhida na tela.

    Na CRIACAO, quem nao manda `chunking` recebe `CONFIGURACAO_PADRAO`. O
    `ON CONFLICT` nao toca nisso: base que ja existe mantem o que tem.
    """
    with conn() as connection:
        with connection.cursor() as cur:
            cur.execute(
                """
                INSERT INTO space (slug, label, description, chunking, representations)
                VALUES (%s,%s,%s,%s,%s)
                ON CONFLICT (slug) DO UPDATE
                   SET label = EXCLUDED.label,
                       description = EXCLUDED.description,
                       chunking = COALESCE(%s::jsonb, space.chunking),
                       active = TRUE
                RETURNING slug, label, description, chunking
                """,
                (
                    slug, label, description,
                    jsonb(chunking if chunking is not None else CONFIGURACAO_PADRAO),
                    jsonb(REPRESENTACOES_PADRAO),
                    jsonb(chunking) if chunking is not None else None,
                ),
            )
            row = cur.fetchone()

            for grant in grants or []:
                cur.execute(
                    """
                    INSERT INTO space_grant (space_slug, principal_type, principal_id, role)
                    VALUES (%s,%s,%s,%s)
                    ON CONFLICT (space_slug, principal_type, principal_id)
                      DO UPDATE SET role = EXCLUDED.role
                    """,
                    (
                        slug,
                        grant.get("principal_type", "group"),
                        (grant.get("principal_id") or "").strip(),
                        grant.get("role", "reader"),
                    ),
                )
        connection.commit()
    return {"slug": row[0], "label": row[1], "description": row[2], "chunking": row[3]}


def drop_space(slug: str) -> bool:
    """Remove o Espaco e todo o conteudo dele.

    Tres armazenamentos, tres limpezas -- e nenhum deles cascateia para o outro:

    * Postgres cascateia internamente (chunk e embedding somem com o documento);
    * o GRAFO e outro banco. O MERGE do Cypher e idempotente mas nao apaga, e
      sem esta limpeza um documento reingerido deixa o no antigo para tras e a
      travessia devolve titulo de documento que nao existe mais;
    * o OBJECT STORE nao sabe de nada. As chaves precisam ser coletadas ANTES do
      DELETE, senao ficam orfas para sempre -- e com PDF de 15 MB o desperdicio
      aparece rapido.
    """
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            "SELECT raw_key FROM document WHERE space_slug = %s AND raw_key <> ''", (slug,)
        )
        chaves = [linha[0] for linha in cur.fetchall()]
        cur.execute(
            "SELECT image_key FROM document_figure WHERE space_slug = %s AND image_key <> ''",
            (slug,),
        )
        chaves += [linha[0] for linha in cur.fetchall()]

    graph.drop_space(slug)
    with conn() as connection:
        with connection.cursor() as cur:
            cur.execute("DELETE FROM space WHERE slug = %s", (slug,))
            removed = cur.rowcount > 0
        connection.commit()

    if removed:
        orfaos = 0
        for chave in chaves:
            try:
                storage.delete(chave)
            except Exception:  # noqa: BLE001 - objeto orfao e barato; parar aqui, nao
                orfaos += 1
        if orfaos:
            log.warning("%s objeto(s) do Espaco %s nao foram removidos", orfaos, slug)
        log.info("Espaco %s removido com %s objeto(s) do bruto", slug, len(chaves) - orfaos)
    return removed


def space_stats(spaces: list[str] | None) -> list[dict]:
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            SELECT s.slug, s.label, s.description, s.chunking, s.representations,
                   count(DISTINCT d.id) FILTER (WHERE d.active AND d.status='indexed') AS documents,
                   count(DISTINCT d.id) FILTER (WHERE d.active AND d.status='failed') AS failed,
                   count(c.id) FILTER (WHERE c.parent_id IS NOT NULL) AS children,
                   s.icon
              FROM space s
              LEFT JOIN document d ON d.space_slug = s.slug
              LEFT JOIN chunk c ON c.document_id = d.id AND d.active
             WHERE s.active
               AND (%s::text[] IS NULL OR s.slug = ANY(%s::text[]))
             GROUP BY s.slug, s.label, s.description, s.chunking, s.representations, s.icon
             ORDER BY s.slug
            """,
            (spaces, spaces),
        )
        linhas = cur.fetchall()

    return [
        {
            "slug": row[0],
            "label": row[1],
            "description": row[2],
            "chunking": ChunkConfig.from_space(row[3]).to_dict(),
            "representations": representations.Ativacao.from_space(row[4]).to_dict(),
            "documents": row[5],
            "failed": row[6],
            "chunks": row[7],
            "icon": row[8] or "",
            # Os modelos EM VIGOR nesta base, e nao os ids escolhidos: quando o
            # provedor escolhido e apagado ou desativado, a base cai para o
            # padrao da instalacao, e a tela precisa mostrar o que de fato vai
            # ser usado. O `from_space` de cada um diz de onde a escolha veio.
            #
            # Fora do `with` de proposito: `providers.resolvido` abre a propria
            # conexao, e chama-lo com o cursor acima ainda aberto seguraria a
            # conexao do pool por toda a lista de Espacos.
            "ai": {
                "embedding": providers.resolvido("embedding", row[0]),
                "chat": providers.resolvido("chat", row[0]),
            },
        }
        for row in linhas
    ]


def _registrar_representacao(document_id: int, representacao: str, resultado: dict) -> None:
    """Estado do build por (documento, representacao).

    Fica em tabela propria, e nao numa coluna de `document`, porque a maquina de
    estados do pipeline e de DOIS niveis: o documento tem o seu, e cada
    representacao tem o dela -- e e por representacao que o reprocessamento
    acontece. Falha aqui nunca derruba a ingestao: o estado e para operar, nao
    para decidir.
    """
    try:
        with conn() as connection, connection.cursor() as cur:
            cur.execute(
                """
                INSERT INTO document_representation (document_id, representation, status, error)
                VALUES (%s,%s,%s,%s)
                ON CONFLICT (document_id, representation) DO UPDATE
                   SET status = EXCLUDED.status, error = EXCLUDED.error, updated_at = now()
                """,
                (
                    document_id,
                    representacao,
                    "ok" if resultado.get("status") == "ok" else "falha",
                    str(resultado.get("erro") or "")[:500],
                ),
            )
            connection.commit()
    except Exception as exc:  # noqa: BLE001
        log.warning("nao consegui registrar o estado da representacao: %s", exc)

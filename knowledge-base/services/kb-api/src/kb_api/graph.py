"""Grafo de entidades no Memgraph (ING-12).

Escopo desta v0, deliberadamente pequeno: o grafo registra a estrutura que o
indice nao expressa -- qual documento pertence a qual Espaco, e quais termos
significativos aparecem em quais documentos -- e oferece **travessia** como
metodo de acesso complementar (BUS-04): "que outros documentos falam do mesmo
assunto que este".

DUAS TECNICAS NO MESMO SLOT (FUN-03)

* **lexical** -- termos frequentes ligados a documentos. Barata, deterministica,
  sempre ligada. A "relacao" e co-ocorrencia: nao diz o que liga o que;
* **entidades por LLM** (ING-12, onda 2) -- entidades e relacoes TIPADAS
  extraidas dos chunks PAIS. E o que a especificacao chama de estrutura
  auxiliar: os nos apontam para chunks que ja existem e NAO criam conteudo novo.
  Desligada por padrao, e a spec e explicita sobre por que -- "o criterio para
  promover algo de onda 2 e sempre uma evidencia medida na onda 1, nunca
  antecipacao".

A segunda nao substitui a primeira: as duas convivem, e a travessia usa as duas
arestas com pesos diferentes.

DUAS ORIGENS DE ARESTA, E ELAS NAO VALEM O MESMO

`MENTIONS` liga documentos por termo compartilhado: e inferencia estatistica,
barata e util, mas um chute. `REFERENCES` vem dos links de um conceito OKF, onde
a relacao esta DECLARADA por quem escreveu o bundle. A travessia devolve as duas
com o campo `via` dizendo qual foi, e ordena a declarada na frente -- misturar
sem distinguir esconderia que uma e afirmacao e a outra e palpite.

O grafo e opcional: `MEMGRAPH_ENABLED=false` ou Memgraph fora do ar nao impede
ingestao nem busca. Ele e representacao AUXILIAR, e o codigo trata como tal.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from collections import Counter

from .config import settings
from .db import conn

log = logging.getLogger(__name__)

# Palavras que aparecem em tudo e nao distinguem documento nenhum.
STOPWORDS = {
    "a", "ao", "aos", "as", "com", "como", "da", "das", "de", "dela", "dele",
    "do", "dos", "e", "em", "entre", "essa", "esse", "esta", "este", "eu",
    "for", "isso", "ja", "la", "lhe", "mais", "mas", "me", "mesmo", "meu",
    "muito", "na", "nao", "nas", "nem", "no", "nos", "num", "numa", "o", "os",
    "ou", "para", "pela", "pelo", "per", "por", "qual", "quando", "que", "quem",
    "sao", "se", "sem", "ser", "seu", "sua", "so", "sobre", "tambem", "te", "tem", "ter", "teu", "um", "uma", "vai", "voce", "vos",
    "the", "and", "with", "this", "that", "from",
    "pagina", "paginas", "slide", "manual",
}

TERM_RE = re.compile(r"[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9_-]{3,}")


def _sem_acento(texto: str) -> str:
    """Minusculas e SEM acento, para a travessia casar em portugues.

    Sem isto a travessia devolve zero em quase toda pergunta, e em silencio: a
    entidade extraida pelo modelo vem acentuada ("Politica de Ferias" vira
    "Política de Férias") e a pergunta que alguem digita quase nunca vem. O
    `CONTAINS` do Cypher e literal, entao "ferias" nao acha "férias".

    Medido no e2e: com a comparacao acentuada, a travessia trouxe 0 candidatos
    para "Como solicitar ferias" numa base cujo grafo tinha justamente a
    entidade "Política de Férias".
    """
    return "".join(
        c for c in unicodedata.normalize("NFD", (texto or "").lower())
        if unicodedata.category(c) != "Mn"
    )


def _driver():
    """Driver Bolt. Import tardio: sem a lib, o grafo simplesmente nao existe."""
    if not settings.graph_enabled:
        return None
    try:
        from neo4j import GraphDatabase
    except Exception as exc:  # noqa: BLE001
        log.info("driver neo4j indisponivel (%s); grafo desligado", exc)
        return None
    try:
        return GraphDatabase.driver(
            f"bolt://{settings.graph_host}:{settings.graph_port}", auth=None
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("Memgraph inacessivel: %s", exc)
        return None


# Comentarios HTML que os extratores usam como marca de pagina: nao sao
# conteudo e virariam os termos mais frequentes do documento.
COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)

# Imagem em Markdown: sai INTEIRA. O canonico referencia cada figura como
# `![rotulo](/v1/documents/12/figures/fig-3/image)`, e sem esta limpeza
# "documents", "figures" e "image" viravam os termos mais frequentes de todo
# documento com figura -- ligando no grafo documentos que nao tem nada a ver
# um com o outro. O conteudo da figura entra pelo texto do OCR, logo abaixo.
IMAGE_RE = re.compile(r"!\[[^\]]*\]\([^)]*\)")

# Link comum perde a URL e mantem o texto, que e conteudo de verdade.
LINK_RE = re.compile(r"\[([^\]]*)\]\([^)]*\)")


def terms(text: str, limit: int = 12) -> list[str]:
    """Termos mais frequentes e distintivos do documento."""
    text = COMMENT_RE.sub(" ", text)
    text = IMAGE_RE.sub(" ", text)
    text = LINK_RE.sub(r"\1", text)
    counter = Counter(
        word.lower()
        for word in TERM_RE.findall(text)
        if word.lower() not in STOPWORDS
    )
    return [term for term, _ in counter.most_common(limit)]


def upsert_document(
    document_id: int,
    space_slug: str,
    title: str,
    keywords: list[str],
    okf_file: str = "",
    okf_links: list[str] | None = None,
) -> bool:
    """Grava documento, Espaco, termos e -- quando OKF -- os links declarados.

    O no `Concept` existe para resolver a ORDEM DE CHEGADA. Um bundle OKF entra
    arquivo por arquivo, e o conceito A quase sempre referencia um B que ainda
    nao foi ingerido. Ligando documento a documento, essa aresta se perderia, e
    so um reprocessamento do Espaco inteiro a traria de volta. Com o `Concept`
    como ponto de encontro -- A aponta para o conceito `b.md`, e B se declara
    `b.md` quando chegar -- a ligacao se fecha sozinha, venha quem vier primeiro.
    """
    driver = _driver()
    if driver is None:
        return False
    try:
        with driver.session() as session:
            session.run(
                """
                MERGE (s:Space {slug: $space})
                MERGE (d:Document {id: $doc})
                  SET d.title = $title, d.space = $space
                MERGE (d)-[:IN_SPACE]->(s)
                """,
                space=space_slug,
                doc=document_id,
                title=title,
            )
            if okf_file:
                session.run(
                    """
                    MERGE (c:Concept {space: $space, file: $file})
                    WITH c
                    MATCH (d:Document {id: $doc})
                    MERGE (d)-[:IS_CONCEPT]->(c)
                    """,
                    space=space_slug, file=okf_file, doc=document_id,
                )
            for alvo in okf_links or []:
                # Link quebrado NAO e erro: a especificacao do OKF proibe recusar
                # um bundle por causa dele. O no do conceito alvo e criado do
                # mesmo jeito, e fica pendurado sem documento -- inofensivo, e
                # pronto para ligar se o arquivo aparecer depois.
                session.run(
                    """
                    MERGE (c:Concept {space: $space, file: $file})
                    WITH c
                    MATCH (d:Document {id: $doc})
                    MERGE (d)-[:REFERENCES]->(c)
                    """,
                    space=space_slug, file=alvo, doc=document_id,
                )
            for term in keywords:
                session.run(
                    """
                    MERGE (t:Term {name: $term})
                      SET t.norm = $norm
                    WITH t
                    MATCH (d:Document {id: $doc})
                    MERGE (d)-[:MENTIONS]->(t)
                    """,
                    term=term,
                    # Mesmo `norm` da entidade, e pela mesma razao: o foco do
                    # desenho chega sem acento e o `CONTAINS` do Cypher e
                    # literal. Sem isto, focar "ferias" nao acha o termo
                    # "ferias" gravado de um texto que escrevia "Férias".
                    norm=_sem_acento(term),
                    doc=document_id,
                )
        return True
    except Exception as exc:  # noqa: BLE001 - grafo e auxiliar, nao bloqueia
        log.warning("falha ao gravar no grafo: %s", exc)
        return False
    finally:
        driver.close()


# Limpeza de no orfao, por GRAU e nao por predicado de padrao.
#
# A forma natural (`WHERE NOT (t)<-[:MENTIONS]-()`) o Memgraph 2.22 recusa com
# "Not yet implemented: atom expression". E a recusa era engolida pelo `except`
# desta funcao, entao a limpeza simplesmente nao acontecia -- termo e conceito
# orfaos ficavam para sempre, e a travessia continuava passando por documento
# que nao existe mais. Apareceu no log durante o e2e.
#
# `degree(n) = 0` diz a mesma coisa aqui: termo e conceito so tem arestas de
# entrada, entao grau zero e exatamente "ninguem aponta para ele".
#
# ⚠ O MEMGRAPH E COMPARTILHADO, E DELETE SEM DONO APAGA O DADO DOS OUTROS
#
# Em dev o `MEMGRAPH_HOST` aponta para a instancia compartilhada da plataforma,
# onde o agentic-sdlc grava `(:Project) (:WorkItem) (:Execution) (:File)
# (:Slice) (:Decision)` e -- isto e o que importa -- `(:Concept {name})`.
# O rotulo `:Concept` COLIDE com o nosso, e o overlay de GitOps afirma que nao
# ha colisao porque a lista dele foi escrita quando o knowledge-base ainda nao
# gravava conceito. Um `MATCH (c:Concept) WHERE degree(c) = 0 DELETE c` global
# apagaria conceito orfao do OUTRO servico, sem erro nenhum e sem rastro.
#
# Por isso toda limpeza casa so o que e NOSSO. O criterio e a propriedade que o
# knowledge-base sempre grava e o outro servico nao tem: `space` no conceito e
# no trecho, `norm` no termo (que `scripts/rebuild-graph.py` preenche no acervo
# antigo). Preferir deixar um orfao nosso para tras a apagar o dado de outro.
_LIMPA_TERMOS = "MATCH (t:Term) WHERE t.norm IS NOT NULL AND degree(t) = 0 DELETE t"
_LIMPA_CONCEITOS = "MATCH (c:Concept) WHERE c.space IS NOT NULL AND degree(c) = 0 DELETE c"
# O :Chunk e ponteiro puro: ele nao guarda texto, so o id da linha no Postgres.
# Sem entidade nenhuma apontando para ele, nao ha caminho que o alcance, e ele
# so restaria como numero solto no desenho.
_LIMPA_CHUNKS = "MATCH (c:Chunk) WHERE c.space IS NOT NULL AND degree(c) = 0 DELETE c"
# As entidades deste documento, colhidas ANTES de apaga-lo: depois do
# `DETACH DELETE` nao existe mais aresta para chegar ate elas.
_ENTIDADES_DO_DOCUMENTO = (
    "MATCH (:Document {id: $doc})-[:HAS_ENTITY]->(e:Entity) RETURN id(e) AS id"
)
# Quantos documentos reivindicam cada uma. Por agregacao, e nao por predicado de
# padrao no WHERE: `WHERE NOT (e)<-[:HAS_ENTITY]-()` o Memgraph 2.22.1 recusa com
# "Not yet implemented: atom expression", e o `except` daqui engoliria a recusa
# -- foi assim que a limpeza de termo orfao passou meses sem rodar.
_DONOS_DAS_ENTIDADES = """
MATCH (d:Document)-[:HAS_ENTITY]->(e:Entity)
WHERE id(e) IN $ids
RETURN id(e) AS id, count(DISTINCT d) AS donos
"""


def related(document_id: int, spaces: list[str] | None, limit: int = 5) -> list[dict]:
    """Documentos ligados a este, pelos links do OKF e pelos termos em comum.

    As duas travessias rodam separadas e sao unidas aqui, e nao num `UNION` do
    Cypher, por um motivo pratico: o link OKF vale mais que termo compartilhado
    e precisa vir na frente mesmo quando compartilha menos. Num `UNION` com
    `ORDER BY shared` o palpite estatistico de 8 termos passaria na frente da
    relacao que o autor do bundle escreveu a mao.

    O link conta nas DUAS direcoes. "Este conceito cita o runbook" e "o runbook
    cita este conceito" sao a mesma vizinhanca para quem esta lendo, e mostrar
    so uma delas esconde metade do bundle.
    """
    driver = _driver()
    if driver is None:
        return []
    try:
        with driver.session() as session:
            declarados = session.run(
                """
                MATCH (d:Document {id: $doc})-[:REFERENCES|IS_CONCEPT]->(c:Concept)
                MATCH (o:Document)-[:REFERENCES|IS_CONCEPT]->(c)
                WHERE o.id <> $doc
                  AND ($spaces IS NULL OR o.space IN $spaces)
                WITH o, count(DISTINCT c) AS shared
                RETURN o.id AS id, o.title AS title, o.space AS space, shared
                ORDER BY shared DESC
                LIMIT $limit
                """,
                doc=document_id, spaces=spaces, limit=limit,
            )
            saida = [dict(registro) | {"via": "okf"} for registro in declarados]
            vistos = {item["id"] for item in saida}

            if len(saida) < limit:
                por_termo = session.run(
                    """
                    MATCH (d:Document {id: $doc})-[:MENTIONS]->(t:Term)<-[:MENTIONS]-(o:Document)
                    WHERE o.id <> $doc
                      AND ($spaces IS NULL OR o.space IN $spaces)
                    WITH o, count(t) AS shared
                    RETURN o.id AS id, o.title AS title, o.space AS space, shared
                    ORDER BY shared DESC
                    LIMIT $limit
                    """,
                    doc=document_id, spaces=spaces, limit=limit,
                )
                for registro in por_termo:
                    item = dict(registro) | {"via": "termos"}
                    if item["id"] not in vistos:
                        saida.append(item)
            return saida[:limit]
    except Exception as exc:  # noqa: BLE001
        log.warning("falha na travessia do grafo: %s", exc)
        return []
    finally:
        driver.close()


def drop_space(space_slug: str) -> bool:
    """Apaga os documentos do Espaco no grafo, e os termos que ficaram orfaos.

    Chamado pelo drop_space da ingestao: sem isso o grafo acumula no de
    documento de versoes antigas, e a travessia devolve titulo de documento que
    nao existe mais no indice.
    """
    driver = _driver()
    if driver is None:
        return False
    try:
        with driver.session() as session:
            session.run(
                """
                MATCH (d:Document {space: $space})
                DETACH DELETE d
                """,
                space=space_slug,
            )
            # Entidade e trecho sao derivados do documento e morrem com ele.
            # Sem estas duas linhas o grafo guardava ponteiro para linha que o
            # Postgres ja tinha apagado: medido, o no do trecho 4657 sobreviveu
            # a um reprocessamento e "ver o trecho" respondia 404 -- um no que
            # existe no desenho e nao existe em lugar nenhum.
            session.run("MATCH (e:Entity {space: $space}) DETACH DELETE e", space=space_slug)
            session.run("MATCH (c:Chunk {space: $space}) DETACH DELETE c", space=space_slug)
            # Termo sem nenhum documento apontando para ele nao tem mais funcao.
            session.run(_LIMPA_TERMOS)
            session.run(_LIMPA_CONCEITOS)
        return True
    except Exception as exc:  # noqa: BLE001 - grafo e auxiliar
        log.warning("falha ao limpar o grafo: %s", exc)
        return False
    finally:
        driver.close()


def health() -> dict:
    driver = _driver()
    if driver is None:
        return {"enabled": settings.graph_enabled, "reachable": False}
    try:
        with driver.session() as session:
            counts = session.run(
                "MATCH (d:Document) RETURN count(d) AS documents"
            ).single()
        return {
            "enabled": True,
            "reachable": True,
            "documents": counts["documents"] if counts else 0,
        }
    except Exception as exc:  # noqa: BLE001
        return {"enabled": True, "reachable": False, "error": str(exc)[:120]}
    finally:
        driver.close()


def forget_document(document_id: int) -> bool:
    """Apaga o no do documento e o que ficou sem ninguem apontando.

    O termo orfao nao e detalhe de limpeza: `related` liga documentos por termo
    compartilhado, e termo que sobrou de um documento removido continuaria
    aparecendo como ponte para um documento que nao existe mais.
    """
    driver = _driver()
    if driver is None:
        return False
    try:
        with driver.session() as session:
            minhas = [linha["id"] for linha in session.run(
                _ENTIDADES_DO_DOCUMENTO, doc=document_id)]
            # So as que NAO sobraram para outro documento. Uma entidade citada
            # por dois documentos continua valendo quando um deles sai.
            sozinhas = [
                linha["id"] for linha in session.run(_DONOS_DAS_ENTIDADES, ids=minhas)
                if linha["donos"] <= 1
            ] if minhas else []
            session.run("MATCH (d:Document {id: $doc}) DETACH DELETE d", doc=document_id)
            if sozinhas:
                session.run("MATCH (e:Entity) WHERE id(e) IN $ids DETACH DELETE e", ids=sozinhas)
            session.run(_LIMPA_TERMOS)
            session.run(_LIMPA_CONCEITOS)
            # Depois das entidades: o trecho so fica orfao quando a ultima
            # entidade que o alcancava foi embora.
            session.run(_LIMPA_CHUNKS)
        return True
    except Exception as exc:  # noqa: BLE001
        log.warning("nao consegui remover o documento %s do grafo: %s", document_id, exc)
        return False
    finally:
        driver.close()


def stats() -> dict:
    """Tamanho do grafo por tipo de no e de aresta.

    Contagem por label, e nao um total: "1.847 nos" nao diz nada, enquanto
    "42 documentos e 1.805 termos" mostra a forma do grafo -- e revela na hora
    quando a ingestao gravou documento sem termo nenhum.
    """
    driver = _driver()
    if driver is None:
        return {"enabled": settings.graph_enabled, "reachable": False}
    try:
        with driver.session() as session:
            documentos = session.run("MATCH (d:Document) RETURN count(d) AS n").single()
            termos = session.run("MATCH (t:Term) RETURN count(t) AS n").single()
            arestas = session.run("MATCH ()-[r:MENTIONS]->() RETURN count(r) AS n").single()
            # `space IS NOT NULL` pela mesma razao das limpezas: o Memgraph e
            # compartilhado e o agentic-sdlc grava `(:Concept {name})` nele.
            # Sem o filtro, a tela de Stack somaria o conceito do outro servico
            # ao nosso e diria um numero que nao descreve esta base.
            conceitos = session.run(
                "MATCH (c:Concept) WHERE c.space IS NOT NULL RETURN count(c) AS n"
            ).single()
            links = session.run("MATCH ()-[r:REFERENCES]->() RETURN count(r) AS n").single()
            versao = None
            try:
                registro = session.run("SHOW VERSION").single()
                versao = str(list(registro.values())[0]) if registro else None
            except Exception:  # noqa: BLE001 - nem todo build expoe SHOW VERSION
                versao = None
        return {
            "enabled": True,
            "reachable": True,
            "documents": documentos["n"] if documentos else 0,
            "terms": termos["n"] if termos else 0,
            "edges": arestas["n"] if arestas else 0,
            "concepts": conceitos["n"] if conceitos else 0,
            "okf_links": links["n"] if links else 0,
            "version": versao,
        }
    except Exception as exc:  # noqa: BLE001
        return {"enabled": True, "reachable": False, "error": str(exc)[:160]}
    finally:
        driver.close()


# ── entidades e relacoes por LLM (ING-12, onda 2) ─────────────────────────
#
# O que distingue esta tecnica da lexical: ela produz RELACAO TIPADA. "A politica
# POL-004 e aprovada pelo RH e substitui a NORMA-99" vira duas arestas com nome,
# e nao dois termos que por acaso aparecem no mesmo documento. E e isso que torna
# a travessia capaz de responder pergunta de relacao e de multiplos saltos.
#
# ⚠ ESTRUTURA AUXILIAR, E NAO REPRESENTACAO. Os nos apontam para os chunks PAIS
# do indice -- unidades de entrega que ja existem. O grafo nao guarda texto
# proprio: a travessia acha o chunk, e quem entrega o conteudo e o indice. Por
# isso o grafo pode ser perdido inteiro sem custo de dado (ADR-0012).

# Teto de entidades por chunk pai. Sem ele, um modelo prolixo extrai trinta
# entidades de um paragrafo e o grafo vira ruido denso, onde tudo se liga a tudo
# e a travessia deixa de discriminar.
MAX_ENTIDADES = 8
MAX_RELACOES = 8

# Quantos chunks pais de um documento entram na extracao. O custo e por chamada,
# e os primeiros pais concentram a definicao do assunto -- e o mesmo motivo pelo
# qual a derivacao de conceito le so o comeco do canonico.
MAX_PAIS_POR_DOCUMENTO = 6

_INSTRUCAO_GRAFO = """Você extrai entidades e relações de um trecho de documento corporativo.

Responda APENAS com um objeto JSON:

{"entidades": [{"nome": "...", "tipo": "..."}],
 "relacoes": [{"de": "...", "tipo": "...", "para": "..."}]}

Regras:
- **entidade** é algo com identidade própria: política, norma, sistema, área, \
cargo, processo, documento com código. NÃO extraia conceitos genéricos \
("prazo", "documento", "empresa");
- **tipo** da entidade em uma palavra, em minúsculas (`politica`, `area`, \
`sistema`, `cargo`, `processo`, `norma`);
- **relação** usa o nome EXATO de duas entidades da lista, e o tipo é um verbo \
em maiúsculas com underscore (`APROVADA_POR`, `SUBSTITUI`, `PERTENCE_A`, \
`RESPONSAVEL_POR`);
- no máximo %(ent)d entidades e %(rel)d relações;
- use SOMENTE o que está no trecho. Não complete com conhecimento externo;
- se o trecho não tiver entidade nomeada, devolva listas vazias.

Responda em português do Brasil."""


def extrair(texto: str, space_slug: str = "") -> tuple[list[dict], list[dict], bool]:
    """Entidades e relacoes de um trecho. Devolve `(entidades, relacoes, respondeu)`.

    O terceiro valor separa duas coisas que a lista vazia confunde: **o modelo
    respondeu e nao achou entidade nomeada** (legitimo -- o proprio prompt manda
    devolver vazio nesse caso) e **o modelo nao respondeu** (falha). Sem essa
    distincao, `construir` reportava `status: ok, entidades: 0` nos dois casos, e
    uma extracao que nunca aconteceu passava por uma que nao tinha o que achar.
    """
    from . import llm

    resposta = llm.complete_json(
        _INSTRUCAO_GRAFO % {"ent": MAX_ENTIDADES, "rel": MAX_RELACOES},
        (texto or "")[:6000],
        operation="grafo-extrair",
        max_tokens=4000,
        space=space_slug,
    )
    if resposta is None:
        return [], [], False

    def limpo(valor: object, limite: int = 120) -> str:
        return str(valor or "").strip()[:limite]

    entidades: list[dict] = []
    vistos: set[str] = set()
    for item in (resposta.dados.get("entidades") or [])[:MAX_ENTIDADES]:
        if not isinstance(item, dict):
            continue
        nome = limpo(item.get("nome"))
        if nome and nome.casefold() not in vistos:
            vistos.add(nome.casefold())
            entidades.append({"nome": nome, "tipo": limpo(item.get("tipo"), 40).lower()})

    relacoes: list[dict] = []
    nomes = {e["nome"].casefold() for e in entidades}
    for item in (resposta.dados.get("relacoes") or [])[:MAX_RELACOES]:
        if not isinstance(item, dict):
            continue
        de, para = limpo(item.get("de")), limpo(item.get("para"))
        tipo = limpo(item.get("tipo"), 60).upper().replace(" ", "_")
        # Relacao que cita entidade fora da lista e alucinacao ou erro de
        # transcricao. Aceitar criaria no solto, que a travessia nunca alcanca e
        # que so engorda a contagem.
        if de.casefold() in nomes and para.casefold() in nomes and tipo and de != para:
            relacoes.append({"de": de, "tipo": tipo, "para": para})
    return entidades, relacoes, True


def construir(space_slug: str, document_id: int) -> dict:
    """Extrai entidades dos chunks PAIS deste documento e grava o grafo.

    Os nos de entidade ficam ligados ao chunk pai de onde sairam, e e esse
    vinculo que faz a travessia devolver conteudo que existe: o grafo nao guarda
    texto, ele guarda o caminho ate o texto.
    """
    driver = _driver()
    if driver is None:
        return {"status": "falha", "erro": "grafo desligado ou inacessível", "entidades": 0}

    try:
        with conn() as connection, connection.cursor() as cur:
            cur.execute(
                """
                SELECT id, content FROM chunk
                 WHERE document_id = %s AND parent_id IS NULL
                 ORDER BY ord LIMIT %s
                """,
                (document_id, MAX_PAIS_POR_DOCUMENTO),
            )
            pais = cur.fetchall()

        total_entidades = 0
        total_relacoes = 0
        sem_resposta = 0
        with driver.session() as session:
            for chunk_id, texto in pais:
                entidades, relacoes, respondeu = extrair(texto, space_slug)
                if not respondeu:
                    sem_resposta += 1
                    continue
                for entidade in entidades:
                    session.run(
                        """
                        MERGE (e:Entity {name: $nome, space: $space})
                          SET e.type = $tipo, e.norm = $norm
                        // O no do trecho e casado SOZINHO, e a aresta vem
                        // depois. Juntar os dois --
                        // `MERGE (e)-[:FROM_CHUNK]->(c:Chunk {id: $chunk})` --
                        // casa o CAMINHO inteiro: se aquela entidade ainda nao
                        // aponta para aquele trecho, o MERGE cria o caminho
                        // todo, **inclusive um :Chunk novo**, em vez de reusar o
                        // que ja existe. Medido: o trecho 4651 virou OITO nos,
                        // um por entidade, e a tela ficou salpicada de nos
                        // cinzas repetidos que pareciam trechos diferentes.
                        MERGE (c:Chunk {id: $chunk, space: $space})
                        WITH e, c
                        MATCH (d:Document {id: $doc})
                        MERGE (d)-[:HAS_ENTITY]->(e)
                        MERGE (e)-[:FROM_CHUNK]->(c)
                        """,
                        nome=entidade["nome"], tipo=entidade["tipo"],
                        norm=_sem_acento(entidade["nome"]), space=space_slug,
                        doc=document_id, chunk=chunk_id,
                    )
                    total_entidades += 1
                for relacao in relacoes:
                    # O tipo vai como PROPRIEDADE, e nao como label da aresta:
                    # Cypher nao aceita label parametrizado, e concatenar o tipo
                    # na string seria injecao com texto vindo de um modelo.
                    session.run(
                        """
                        MATCH (a:Entity {name: $de, space: $space})
                        MATCH (b:Entity {name: $para, space: $space})
                        MERGE (a)-[r:RELATES {type: $tipo}]->(b)
                        """,
                        de=relacao["de"], para=relacao["para"],
                        tipo=relacao["tipo"], space=space_slug,
                    )
                    total_relacoes += 1
        if pais and sem_resposta == len(pais):
            # NENHUM trecho teve resposta: o modelo nao respondeu, e isto e
            # falha. Reportar "ok" aqui faria a tela dizer que o grafo foi
            # construido quando ele nao foi -- e o operador so descobriria
            # olhando a travessia devolver nada.
            return {
                "status": "falha",
                "erro": "o modelo de chat nao respondeu em nenhum trecho",
                "entidades": 0, "relacoes": 0, "pais": len(pais),
            }
        return {
            "status": "ok",
            "entidades": total_entidades,
            "relacoes": total_relacoes,
            "pais": len(pais),
            # Zero entidades com resposta e legitimo: documento sem entidade
            # nomeada existe. O numero fica no retorno para a diferenca ser
            # visivel sem precisar do log.
            "sem_resposta": sem_resposta,
        }
    except Exception as exc:  # noqa: BLE001 - o grafo e auxiliar, nunca derruba
        log.warning("build do grafo falhou em %s/%s: %s", space_slug, document_id, exc)
        return {"status": "falha", "erro": str(exc)[:300], "entidades": 0}
    finally:
        driver.close()


def travessia(termos: list[str], spaces: list[str], limit: int) -> list[dict]:
    """Chunks pais alcançados por entidade que casa com a pergunta.

    Dois saltos: a entidade que casa e as entidades ligadas a ela. O segundo
    salto e o que a busca vetorial nao faz -- achar o documento que fala do que a
    pergunta NAO nomeou, mas que se liga ao que ela nomeou.

    Devolve ponteiro para chunk, nunca texto: o conteudo vem do indice, que e
    onde ele vive.
    """
    driver = _driver()
    if driver is None or not termos:
        return []
    try:
        with driver.session() as session:
            resultado = session.run(
                """
                MATCH (e:Entity)
                WHERE e.space IN $spaces
                  AND any(t IN $termos WHERE coalesce(e.norm, toLower(e.name)) CONTAINS t)
                OPTIONAL MATCH (e)-[:RELATES]-(vizinha:Entity)
                WITH collect(DISTINCT e) + collect(DISTINCT vizinha) AS todas
                UNWIND todas AS alvo
                MATCH (alvo)-[:FROM_CHUNK]->(c:Chunk)
                WHERE c.space IN $spaces
                RETURN c.id AS chunk_id, collect(DISTINCT alvo.name) AS entidades,
                       count(DISTINCT alvo) AS forca
                ORDER BY forca DESC
                LIMIT $limit
                """,
                termos=[_sem_acento(t) for t in termos if t],
                spaces=spaces,
                limit=limit,
            )
            return [dict(registro) for registro in resultado]
    except Exception as exc:  # noqa: BLE001
        log.warning("travessia falhou: %s", exc)
        return []
    finally:
        driver.close()


# ── visualizacao (WEB-02) ─────────────────────────────────────────────────
#
# "Navegacao de conteudo somente leitura por Espaco: documentos e
# representacoes; modo apresentacao e GRAFO INTERATIVO como exemplos."
#
# ⚠ O FILTRO DE ESPACO AQUI E FRONTEIRA DE SEGURANCA, nao conveniencia. Um
# grafo desenhado sem ele mostraria titulo de documento e nome de entidade de
# Espaco que o chamador nao alcanca -- vazamento por imagem, que nenhuma outra
# rota permitiria. E ele tem uma sutileza: `Term` NAO tem propriedade `space`
# (o no e compartilhado entre Espacos de proposito, e e isso que liga bases
# diferentes pelo mesmo assunto). Entao o termo so entra quando esta ligado a um
# documento que o chamador alcanca -- o escopo vem da ARESTA, nao do no.

# O termo alcancado por documento no escopo.
#
# O `:Term` NAO tem `space`: o no e compartilhado de proposito, e e isso que liga
# bases diferentes pelo mesmo assunto (`related` depende disso). A consequencia
# para o desenho e que `WHERE n.space IS NOT NULL` o exclui -- e com ele somem
# TODAS as arestas de uma base comum, porque no grafo lexical (o padrao de toda
# base) `Document -[:MENTIONS]-> Term` e a unica aresta que existe.
#
# Medido na carga dos 40 manuais do Lyceum: o esquema anunciava 209 termos e o
# desenho trazia 40 pontos soltos, zero arestas. A tela dizia que a base nao
# tinha ligacao nenhuma.
#
# O escopo do termo vem da ARESTA, nao do no: ele so entra se um documento
# alcancavel o menciona, e o grau conta so esses documentos. Assim o desenho nao
# revela que um Espaco proibido usa o mesmo termo.
_TERMOS_NO_ESCOPO = """
MATCH (d:Document)-[:MENTIONS]->(t:Term)
WHERE d.space IS NOT NULL{escopo}{filtro}
RETURN id(t) AS id, 'Term' AS label, '' AS space, t.name AS name,
       '' AS type, count(DISTINCT d) AS grau, null AS ref
ORDER BY grau DESC
LIMIT $limite
"""

# O no que tem `space` proprio: documento, entidade, trecho.
_NOS_COM_ESPACO = """
MATCH (n) WHERE n.space IS NOT NULL{escopo}{filtro}
RETURN id(n) AS id, labels(n)[0] AS label, n.space AS space,
       coalesce(n.name, n.title, '') AS name,
       coalesce(n.type, '') AS type, degree(n) AS grau,
       n.id AS ref
ORDER BY grau DESC
LIMIT $limite
"""

# Um salto a partir dos nos que casaram com o foco.
#
# Sem isto, focar "turma" nos 40 manuais do Lyceum devolvia DOIS nos e ZERO
# arestas: o filtro casava o nome e mais nada, enquanto a tela promete "focar
# numa entidade ou termo (e a vizinhanca dela)". Vizinhanca de um no sozinho
# nao e vizinhanca, e o campo parecia quebrado.
#
# ⚠ O ESCOPO E REAPLICADO NO VIZINHO, e isto nao e redundancia. A semente pode
# ser um `:Term`, que e compartilhado entre bases -- expandir dali sem filtrar
# traria documento de Espaco proibido para dentro do desenho, pelo caminho mais
# silencioso possivel. O vizinho sem `space` (outro termo) so chega por aresta de
# um no que ja esta no escopo.
_VIZINHOS = """
MATCH (a)-[r]-(b)
WHERE id(a) IN $ids{escopo}
RETURN DISTINCT id(b) AS id
LIMIT $limite
"""

# Teto de nos desenhados. Acima disto o navegador engasga e a figura deixa de
# informar: um emaranhado de mil nos nao mostra estrutura, mostra tinta. O corte
# vai no retorno (`truncated`), para a tela poder dizer que ha mais.
MAX_NOS = 600


def _clausula_de_espaco(spaces: list[str] | None, variavel: str) -> str:
    """Filtro de Espaco para um no que TEM a propriedade. Vazio = sem filtro."""
    return "" if spaces is None else f" AND {variavel}.space IN $spaces"


def esquema(spaces: list[str] | None) -> dict:
    """Rotulos e tipos de aresta com contagem: a visao de esquema do grafo.

    E a pergunta "que forma tem este grafo?", respondida sem trazer um no
    sequer. Serve de mapa antes de abrir a instancia, que e onde a contagem
    grande mora.
    """
    driver = _driver()
    if driver is None:
        return {"enabled": settings.graph_enabled, "reachable": False, "nodes": [], "edges": []}
    try:
        with driver.session() as session:
            # O `Term` nao tem `space`: ele so conta se algum documento
            # alcancavel o menciona. Por isso duas consultas e nao uma.
            nos = session.run(
                f"""
                MATCH (n) WHERE n.space IS NOT NULL{_clausula_de_espaco(spaces, "n")}
                RETURN labels(n)[0] AS label, count(*) AS total
                """,
                spaces=spaces,
            )
            rotulos = [dict(r) for r in nos]

            termos = session.run(
                f"""
                MATCH (d:Document)-[:MENTIONS]->(t:Term)
                WHERE 1=1{_clausula_de_espaco(spaces, "d")}
                RETURN count(DISTINCT t) AS total
                """,
                spaces=spaces,
            ).single()
            if termos and termos["total"]:
                rotulos.append({"label": "Term", "total": termos["total"]})

            arestas = session.run(
                f"""
                MATCH (a)-[r]->(b)
                WHERE a.space IS NOT NULL{_clausula_de_espaco(spaces, "a")}
                RETURN labels(a)[0] AS de, type(r) AS tipo, labels(b)[0] AS para,
                       count(*) AS total
                ORDER BY total DESC
                """,
                spaces=spaces,
            )
            ligacoes = [dict(r) for r in arestas]
        return {
            "enabled": True,
            "reachable": True,
            "nodes": sorted(rotulos, key=lambda x: -x["total"]),
            "edges": ligacoes,
        }
    except Exception as exc:  # noqa: BLE001
        return {"enabled": True, "reachable": False, "error": str(exc)[:200],
                "nodes": [], "edges": []}
    finally:
        driver.close()


def instancia(spaces: list[str] | None, limite: int = MAX_NOS, foco: str = "",
              rotulos: list[str] | None = None) -> dict:
    """O grafo de verdade: nos e arestas, para desenhar.

    DUAS CONSULTAS SIMPLES, E NAO UMA ESPERTA

    A primeira versao disto fazia tudo numa consulta so: `collect(n)` dos nos,
    `UNWIND` de volta, `OPTIONAL MATCH` das arestas entre eles, e projecao de
    mapa com `CASE WHEN r IS NULL`. Ela **derrubou o Memgraph com SIGSEGV**.
    Reproduzido duas vezes contra a 2.22.1: `Exit Code: 139` no container e o
    contador de reinicio subindo 1 -> 2, com a conexao morrendo no meio
    (`Failed to read from defunct connection`). Nao e Cypher invalido -- Cypher
    invalido o servidor recusa com erro, como se ve ao trocar uma chave de lugar.
    E um defeito do servidor, e a consulta apenas o encontrava.

    E o pior nao foi a queda: foi o `except` daqui engolir a queda e devolver
    "grafo vazio". A tela mostrou uma base sem grafo, e nao um erro -- por isso
    agora o retorno de falha traz `reachable: False`, que e coisa diferente de
    lista vazia.

    A forma abaixo e deliberadamente sem gracinha: uma consulta pega os nos,
    outra pega as arestas entre os ids que a primeira devolveu. Duas idas em vez
    de uma, e nenhum construto exotico. Num grafo de ate seiscentos nos a
    diferenca de latencia nao aparece, e a diferenca de robustez apareceu na
    primeira tentativa.

    DOIS IDENTIFICADORES, E CONFUNDI-LOS QUEBRA A NAVEGACAO

    `id` e o id interno do no no Memgraph: serve para casar no com aresta no
    desenho, e **nao significa nada fora deste retorno**. `ref` e o id de
    dominio gravado como propriedade -- o id do documento no Postgres num
    `:Document`, o id do chunk num `:Chunk`.

    A primeira versao nao trazia `ref`, e a tela usava `id` para abrir o
    documento. O no do documento 381 tinha `id(n) = 63`, entao "Abrir o
    documento" levava a `documento 63 nao encontrado` -- e, se 63 existisse em
    outro Espaco, levaria ao documento errado sem nenhum erro. Por isso `name`
    tambem parou de cair em `toString(id(n))`: um `:Chunk` aparecia rotulado com
    o id interno, um numero que nao existe em lugar nenhum do sistema.

    `foco` restringe a vizinhanca de um termo -- e o que torna a figura legivel
    numa base grande, onde o grafo inteiro e tinta. Sem foco, traz os nos de
    maior grau primeiro: sao os que dao a forma.

    `rotulos` restringe os TIPOS de no desenhados, e precisa ser aplicado aqui e
    nao na tela. O corte por grau acontece antes de a tela ver qualquer coisa:
    numa base de 2.889 nos em que 2.700 sao termo, filtrar no navegador depois de
    receber os 100 de maior grau deixaria uma dezena de documentos na figura.
    Filtrando no servidor, o teto e gasto no que foi pedido.
    """
    driver = _driver()
    if driver is None:
        return {"enabled": settings.graph_enabled, "reachable": False,
                "nodes": [], "edges": [], "truncated": False}
    limite = max(10, min(limite, MAX_NOS))
    alvo = _sem_acento(foco)
    try:
        with driver.session() as session:
            escopo_no = _clausula_de_espaco(spaces, "n")
            escopo_doc = _clausula_de_espaco(spaces, "d")
            # Lista vazia e None querem dizer a mesma coisa: desenhe tudo.
            # Tratar vazio como "nada" faria a tela apagar sozinha ao desmarcar
            # o ultimo rotulo, em vez de voltar ao completo.
            pedidos = [r for r in (rotulos or []) if r]
            escopo_no += " AND labels(n)[0] IN $rotulos" if pedidos else ""
            quer_termo = not pedidos or "Term" in pedidos

            def linhas(consulta: str, **kw) -> list[dict]:
                return [dict(linha) for linha in session.run(consulta, **kw)]

            def buscar(filtro_no: str, filtro_termo: str, **kw) -> list[dict]:
                """As duas fontes de no, com o mesmo filtro aplicado em cada uma.

                Duas consultas simples em vez de uma que juntasse tudo: a regra
                desta funcao depois do SIGSEGV e nao ser esperta.
                """
                achados = linhas(
                    _NOS_COM_ESPACO.format(escopo=escopo_no, filtro=filtro_no),
                    spaces=spaces, limite=limite, rotulos=pedidos, **kw,
                )
                if quer_termo:
                    achados += linhas(
                        _TERMOS_NO_ESCOPO.format(escopo=escopo_doc, filtro=filtro_termo),
                        spaces=spaces, limite=limite, **kw,
                    )
                return achados

            if alvo:
                # `CONTAINS` sobre o nome normalizado: o no vem acentuado do
                # modelo e quem digita, quase nunca. `coalesce` porque `norm` so
                # existe em entidade e termo -- documento cai no titulo em
                # minusculas.
                sementes = buscar(
                    " AND coalesce(n.norm, toLower(coalesce(n.name, n.title, ''))) CONTAINS $foco",
                    " AND coalesce(t.norm, toLower(t.name)) CONTAINS $foco",
                    foco=alvo,
                )
                ids_semente = [n["id"] for n in sementes]
                vizinhos = linhas(
                    _VIZINHOS.format(
                        escopo="" if spaces is None
                        else " AND (b.space IS NULL OR b.space IN $spaces)"
                    ),
                    ids=ids_semente, spaces=spaces, limite=limite,
                ) if ids_semente else []
                alcance = list({*ids_semente, *(v["id"] for v in vizinhos)})
                # Reconsulta por id em vez de reaproveitar as linhas do vizinho:
                # e assim que o grau do termo continua sendo o contado DENTRO do
                # escopo. `degree(b)` cru contaria documento de base proibida.
                nos = buscar(
                    " AND id(n) IN $alcance", " AND id(t) IN $alcance", alcance=alcance,
                ) if alcance else []
            else:
                nos = buscar("", "")

            # O teto vale para o desenho INTEIRO, e o corte e pelo grau: o
            # documento de grau 20 importa mais que o termo de grau 1, venha de
            # qual consulta vier.
            nos.sort(key=lambda n: n["grau"], reverse=True)
            nos = nos[:limite]
            ids = [n["id"] for n in nos]

            arestas: list[dict] = []
            if ids:
                # Só as arestas ENTRE os nós desenhados. Trazer as que saem para
                # fora do corte produziria aresta apontando para o nada, e o
                # desenho ficaria com pontas soltas sem explicação.
                ligacoes = session.run(
                    """
                    MATCH (a)-[r]->(b)
                    WHERE id(a) IN $ids AND id(b) IN $ids
                    RETURN id(a) AS source, id(b) AS target,
                           coalesce(r.type, type(r)) AS type
                    """,
                    ids=ids,
                )
                arestas = [dict(linha) for linha in ligacoes]

            total = session.run(
                f"""
                MATCH (n) WHERE n.space IS NOT NULL{escopo_no}
                RETURN count(n) AS total
                """,
                spaces=spaces, rotulos=pedidos,
            ).single()
            # O termo entra na conta pelo mesmo criterio com que entra no
            # desenho. Contar so os nos com `space` faria "40 de 40" numa base
            # com 249 nos desenhaveis, e o aviso de corte nunca apareceria.
            total_termos = session.run(
                f"""
                MATCH (d:Document)-[:MENTIONS]->(t:Term)
                WHERE d.space IS NOT NULL{escopo_doc}
                RETURN count(DISTINCT t) AS total
                """,
                spaces=spaces,
            ).single() if quer_termo else None
        no_total = (total["total"] if total else len(nos)) + (
            total_termos["total"] if total_termos else 0
        )
        return {
            "enabled": True,
            "reachable": True,
            "nodes": nos,
            "edges": arestas,
            "total": no_total,
            "truncated": bool(no_total > len(nos)),
        }
    except Exception as exc:  # noqa: BLE001
        # `reachable: False` e nao lista vazia: a tela precisa distinguir "o
        # grafo nao respondeu" de "nao ha nada aqui". Foi exatamente essa
        # confusao que escondeu o SIGSEGV da primeira versao.
        log.warning("nao consegui montar o grafo para desenho: %s", exc)
        return {"enabled": True, "reachable": False, "error": str(exc)[:200],
                "nodes": [], "edges": [], "truncated": False}
    finally:
        driver.close()

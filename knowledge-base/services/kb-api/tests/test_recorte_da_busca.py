"""O recorte da busca: `min_trust` e `as_of` viram cláusula, não etiqueta.

Dois blocos, pela mesma divisão do `test_migrate.py`:

* **montagem do recorte** -- roda em qualquer lugar. É onde moram as regras que
  quebram em silêncio: valor desconhecido recusado em vez de ignorado, a wiki
  saindo inteira quando se pede conteúdo revisado, e o fragmento de SQL saindo
  com os parâmetros na mesma ordem em que entram na consulta;
* **filtro contra Postgres de verdade** -- PULADO quando não há um. O que
  interessa aqui é a semântica do `WHERE`: comparação de data como texto,
  ausência de metadado tratada como `unverified`, e o `LIMIT` sendo aplicado
  DEPOIS do corte. Nada disso se verifica com dublê -- um dublê testaria a
  reimplementação do filtro em Python, que é exatamente o que a decisão recusou.

Para rodar o segundo bloco:

    docker run -d --name kb-pg -e POSTGRES_DB=knowledge_base \\
        -e POSTGRES_USER=knowledge_base -e POSTGRES_PASSWORD=knowledge_base \\
        -p 55432:5432 pgvector/pgvector:pg16
    POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=55432 pytest tests/test_recorte_da_busca.py
"""

from __future__ import annotations

import json
import os

import psycopg
import pytest

from kb_api import mcp, okf, retrieval

# ── montagem do recorte ───────────────────────────────────────────────────


def test_sem_parametro_nao_ha_recorte():
    # O default TEM de ser o comportamento de sempre: ligar o filtro por padrao
    # mudaria o resultado de toda instalacao existente, e o sintoma seria "a
    # busca parou de achar as coisas".
    filtros = retrieval.Filtros.de_parametros()
    assert filtros.ativo is False
    assert retrieval._onde_documento(filtros) == ("", ())


def test_min_trust_vira_lista_de_niveis_aceitos():
    filtros = retrieval.Filtros.de_parametros(min_trust="machine-confirmed")
    assert filtros.trust_aceitos == ("machine-confirmed", "human-reviewed")


def test_recorte_desconhecido_levanta_em_vez_de_ser_ignorado():
    with pytest.raises(ValueError, match="desconhecido"):
        retrieval.Filtros.de_parametros(min_trust="human_reviewed")
    with pytest.raises(ValueError, match="invalida"):
        retrieval.Filtros.de_parametros(as_of="04/03/2019")


def test_fragmento_de_sql_sai_com_os_parametros_na_mesma_ordem():
    # Fragmento e parametros saem JUNTOS de proposito: separados, quem
    # acrescentar um filtro depois teria de acertar duas listas na mesma ordem.
    sql, params = retrieval._onde_documento(
        retrieval.Filtros.de_parametros(min_trust="human-reviewed", as_of="2019-03-04")
    )
    assert sql.count("%s") == len(params) == 4
    assert params[0] == okf.TRUST_PADRAO
    assert params[1] == ["human-reviewed"]
    assert params[2:] == ("2019-03-04", "2019-03-04")
    assert "okf->>'trust'" in sql and "'vigencia'->>'ate'" in sql


def test_a_vigencia_da_wiki_le_o_frontmatter_da_pagina():
    sql, params = retrieval._onde_wiki(retrieval.Filtros.de_parametros(as_of="2019-03-04"))
    assert "p.frontmatter->'vigencia'" in sql
    assert params == ("2019-03-04", "2019-03-04")


def test_wiki_sai_inteira_quando_se_pede_conteudo_revisado():
    """Página destilada é texto gerado, e nenhuma passou por revisão humana.

    O curto-circuito não é economia: é o contrato do ADR-0018 aplicado. E, de
    quebra, poupa a chamada de embedding -- por isso este teste roda sem banco
    e sem provedor nenhum configurado.
    """
    filtros = retrieval.Filtros.de_parametros(min_trust="machine-confirmed")
    for metodo in ("paginas", "paginas_lexical"):
        candidatos, trace = retrieval.RECUPERADORES[metodo](
            "qualquer pergunta", ["um-espaco"], 10, filtros=filtros
        )
        assert candidatos == []
        assert "fora do recorte" in trace["estado"]


def test_pedir_unverified_nao_tira_a_wiki():
    # `unverified` e o nivel mais baixo: pedir "pelo menos isso" nao exclui
    # ninguem, e a wiki continua na busca.
    filtros = retrieval.Filtros.de_parametros(min_trust="unverified")
    assert filtros.exige_revisao is False


# ── a tool MCP oferece o recorte, e diz o que some ────────────────────────


def test_a_tool_de_busca_expoe_os_dois_parametros():
    propriedades = next(t for t in mcp.TOOLS if t["name"] == "search")["inputSchema"]["properties"]
    assert propriedades["min_trust"]["enum"] == list(okf.TRUST_ESCALA)
    assert "as_of" in propriedades


def test_a_descricao_diz_o_que_o_filtro_esconde():
    # A descricao e para o agente DECIDIR. Sem dizer o que some, um agente liga
    # "por precaucao" e le zero resultado como "o assunto nao existe".
    descricao = next(
        t for t in mcp.TOOLS if t["name"] == "search"
    )["inputSchema"]["properties"]["min_trust"]["description"]
    assert "wiki" in descricao and "unverified" in descricao


# ── a rota REST recusa recorte escrito errado ─────────────────────────────


def _rota_de_busca(payload: dict):
    """Chama `/v1/search` sem HTTP e sem banco.

    O principal irrestrito resolve o escopo como `None` (todos) sem consultar o
    Postgres, e a recusa acontece ANTES da busca -- que e justamente o que este
    teste quer travar: o erro tem de sair na validacao, nao virar uma busca
    completa que o chamador vai ler como recortada.
    """
    from fastapi import HTTPException

    from kb_api.auth import Principal
    from kb_api.main import post_search

    try:
        post_search(payload=payload, principal=Principal(unrestricted=True))
    except HTTPException as exc:
        return exc
    raise AssertionError("a rota aceitou um recorte invalido")


def test_a_rota_recusa_nivel_de_confianca_desconhecido():
    erro = _rota_de_busca({"query": "qualquer", "min_trust": "human_reviewed"})
    assert erro.status_code == 400
    assert "human_reviewed" in erro.detail


def test_a_rota_recusa_data_fora_do_formato():
    erro = _rota_de_busca({"query": "qualquer", "as_of": "04/03/2019"})
    assert erro.status_code == 400
    assert "AAAA-MM-DD" in erro.detail


# ── filtro contra Postgres de verdade ─────────────────────────────────────


def _postgres_disponivel() -> bool:
    from kb_api.config import settings

    try:
        with psycopg.connect(settings.pg_dsn, connect_timeout=3):
            return True
    except Exception:
        return False


pg = pytest.mark.skipif(
    not _postgres_disponivel(),
    reason=f"sem Postgres em {os.environ.get('POSTGRES_HOST', 'postgres')}",
)

# Um termo que so existe nos documentos deste teste, para a busca lexical nao
# depender de nada mais que esteja na base.
TERMO = "arrependimento"

# Os documentos do cenario: (marca, okf).
#
# A data do fato dos testes e 2019-03-04. `revogado` saiu de vigencia em 2015 e
# `futuro` so entrou em 2020: um de cada lado da data, porque um filtro que
# cortasse so um dos lados passaria por um cenario com apenas um deles.
CENARIO = {
    "revisado": {"type": "Norma", "trust": "human-reviewed"},
    "maquina": {"type": "Norma", "trust": "machine-confirmed"},
    "cru": {"type": "Norma", "trust": "unverified"},
    "sem_conceito": {},
    "revogado": {
        "type": "Norma",
        "trust": "human-reviewed",
        "vigencia": {"de": "1990-09-11", "ate": "2015-03-16"},
    },
    "futuro": {
        "type": "Norma",
        "trust": "human-reviewed",
        "vigencia": {"de": "2020-01-01", "ate": ""},
    },
    "vigente": {
        "type": "Norma",
        "trust": "human-reviewed",
        "vigencia": {"de": "1990-09-11", "ate": ""},
    },
    "armadilha": {
        "type": "Precedente",
        "trust": "human-reviewed",
        "armadilha": "tese defensiva a conhecer, nunca fundamento ofensivo",
    },
}


@pytest.fixture
def base():
    """Esquema aplicado pelas migrações de verdade, e o cenário carregado.

    As migrações, e não um DDL de teste: o filtro depende de índice e de coluna
    que elas criam, e um esquema escrito à mão aqui passaria a divergir do real
    no primeiro `ALTER TABLE` que alguém esquecesse de copiar.
    """
    from kb_api import migrate
    from kb_api.db import close_pool, conn

    with conn() as connection:
        with connection.cursor() as cur:
            cur.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        connection.commit()
    migrate.migrate()

    with conn() as connection:
        with connection.cursor() as cur:
            cur.execute(
                "INSERT INTO space (slug, label) VALUES ('recorte', 'Recorte') "
                "ON CONFLICT (slug) DO NOTHING"
            )
            for marca, conceito in CENARIO.items():
                cur.execute(
                    "INSERT INTO document (space_slug, filename, title, content_sha, okf, status)"
                    " VALUES ('recorte', %s, %s, %s, %s::jsonb, 'indexed') RETURNING id",
                    (f"{marca}.md", marca, marca, json.dumps(conceito)),
                )
                document_id = cur.fetchone()[0]
                texto = f"Direito de {TERMO} no caso {marca}."
                cur.execute(
                    "INSERT INTO chunk (document_id, space_slug, parent_id, ord, content, tsv)"
                    " VALUES (%s,'recorte',NULL,0,%s, to_tsvector('portuguese', unaccent(%s)))"
                    " RETURNING id",
                    (document_id, texto, texto),
                )
                pai = cur.fetchone()[0]
                cur.execute(
                    "INSERT INTO chunk (document_id, space_slug, parent_id, ord, content, tsv)"
                    " VALUES (%s,'recorte',%s,0,%s, to_tsvector('portuguese', unaccent(%s)))",
                    (document_id, pai, texto, texto),
                )
        connection.commit()
    yield
    with conn() as connection:
        with connection.cursor() as cur:
            cur.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        connection.commit()
    close_pool()


def achados(filtros: retrieval.Filtros | None = None, limit: int = 50) -> set[str]:
    """As marcas dos documentos que o braço lexical devolveu com este recorte."""
    candidatos, _ = retrieval.lexical(TERMO, ["recorte"], limit, filtros=filtros)
    return {c.content.rsplit(" ", 1)[-1].rstrip(".") for c in candidatos}


@pg
def test_sem_recorte_a_busca_devolve_tudo(base):
    assert achados() == set(CENARIO)


@pg
def test_min_trust_human_reviewed_nao_devolve_unverified(base):
    """Critério de pronto 1 do WP-02, contra o banco.

    `sem_conceito` é o caso que parece detalhe: documento que não é conceito OKF
    não tem `trust` nenhum, e ele NÃO passa. Não ter sido conferido não é o
    mesmo que ter sido conferido.
    """
    achado = achados(retrieval.Filtros.de_parametros(min_trust="human-reviewed"))
    assert "cru" not in achado
    assert "sem_conceito" not in achado
    assert "maquina" not in achado
    assert "revisado" in achado


@pg
def test_min_trust_intermediario_aceita_dele_para_cima(base):
    achado = achados(retrieval.Filtros.de_parametros(min_trust="machine-confirmed"))
    assert {"maquina", "revisado"} <= achado
    assert "cru" not in achado and "sem_conceito" not in achado


@pg
def test_data_do_fato_nao_devolve_dispositivo_revogado_antes_dela(base):
    """Critério de pronto 2 do WP-02, contra o banco.

    Os dois lados da data no mesmo teste: o que já tinha sido revogado sai, e o
    que ainda não tinha entrado em vigor sai também.
    """
    achado = achados(retrieval.Filtros.de_parametros(as_of="2019-03-04"))
    assert "revogado" not in achado
    assert "futuro" not in achado
    assert "vigente" in achado


@pg
def test_documento_sem_vigencia_continua_aparecendo(base):
    # A regra que nao pode ser invertida: ausencia de vigencia e "sempre
    # valido". Se fosse o contrario, ligar `as_of` esvaziaria a busca.
    achado = achados(retrieval.Filtros.de_parametros(as_of="2019-03-04"))
    assert {"cru", "sem_conceito", "revisado"} <= achado


@pg
def test_a_data_do_fato_pega_o_dia_exato_da_revogacao(base):
    # A comparacao e TEXTUAL sobre ISO-8601, e o limite inclusivo e o unico
    # ponto em que texto e data poderiam divergir sem ninguem notar.
    assert "revogado" in achados(retrieval.Filtros.de_parametros(as_of="2015-03-16"))
    assert "revogado" not in achados(retrieval.Filtros.de_parametros(as_of="2015-03-17"))


@pg
def test_os_dois_recortes_juntos_se_somam(base):
    achado = achados(
        retrieval.Filtros.de_parametros(min_trust="human-reviewed", as_of="2019-03-04")
    )
    assert achado == {"revisado", "vigente", "armadilha"}


@pg
def test_o_corte_acontece_antes_do_limit(base):
    """O motivo de o filtro estar no `WHERE`, e não sobre a lista devolvida.

    Com `limit=2` e filtro em Python, o banco devolveria dois candidatos
    quaisquer e o filtro poderia deixar zero -- e a busca reportaria "não achei
    nada" sobre um assunto que a base responde. No `WHERE`, o banco repõe.
    """
    achado = achados(retrieval.Filtros.de_parametros(min_trust="human-reviewed"), limit=2)
    assert len(achado) == 2
    assert not {"cru", "sem_conceito", "maquina"} & achado


@pytest.fixture
def vetor_falso(monkeypatch):
    """O braço vetorial sem provedor de embedding nenhum.

    O vetor é substituído, e **nada mais**: a consulta, o `JOIN`, o recorte e a
    expressão de distância continuam sendo os de verdade, contra o Postgres de
    verdade. O que se quer travar aqui é o SQL -- um fragmento de recorte
    colocado na posição errada da consulta não aparece em teste nenhum que não
    execute a consulta.
    """
    from kb_api import embedding

    resultado = embedding.EmbedResult(
        vectors=[[1.0] + [0.0] * 3071], tokens=0, latency_ms=0, model="modelo-de-mentira"
    )
    monkeypatch.setattr(retrieval, "_grupos_de_embedding", lambda spaces: [(1, list(spaces))])
    monkeypatch.setattr(retrieval, "vetor_da_pergunta", lambda *a, **k: (resultado, True))
    return resultado


@pg
def test_o_recorte_vale_no_braco_vetorial(base, vetor_falso):
    """O mesmo corte, na consulta com `ORDER BY` de distância e `LIMIT`.

    O braço vetorial é o que mais precisa do corte no `WHERE`: ele é ordenado
    por distância e cortado pelo `LIMIT`, então conteúdo revogado bem posicionado
    empurraria o vigente para fora do pool.
    """
    from kb_api.db import as_vector, conn

    with conn() as connection:
        with connection.cursor() as cur:
            cur.execute("SELECT id, space_slug FROM chunk WHERE parent_id IS NOT NULL")
            for chunk_id, space in cur.fetchall():
                cur.execute(
                    "INSERT INTO chunk_embedding (chunk_id, space_slug, model, embedding)"
                    " VALUES (%s,%s,'modelo-de-mentira',%s::vector)",
                    (chunk_id, space, as_vector([1.0] + [0.0] * 3071)),
                )
        connection.commit()

    def marcas(filtros=None) -> set[str]:
        candidatos, _ = retrieval.semantica(TERMO, ["recorte"], 50, filtros=filtros)
        return {c.content.rsplit(" ", 1)[-1].rstrip(".") for c in candidatos}

    assert marcas() == set(CENARIO)
    assert "cru" not in marcas(retrieval.Filtros.de_parametros(min_trust="human-reviewed"))
    assert "revogado" not in marcas(retrieval.Filtros.de_parametros(as_of="2019-03-04"))


@pg
def test_o_recorte_vale_na_travessia_do_grafo(base, monkeypatch):
    """O grafo alcança o chunk; quem decide se ele sai é o documento.

    Sem esta cláusula, a travessia seria a porta dos fundos do `min_trust`: o
    Memgraph não conhece nível de confiança nem vigência, e o caminho dele chega
    direto ao chunk.
    """
    from kb_api import graph
    from kb_api.db import conn

    with conn() as connection, connection.cursor() as cur:
        cur.execute("SELECT id FROM chunk WHERE parent_id IS NULL ORDER BY id")
        pais = [linha[0] for linha in cur.fetchall()]

    monkeypatch.setattr(graph, "terms", lambda *a, **k: [TERMO])
    monkeypatch.setattr(
        graph,
        "travessia",
        lambda *a, **k: [{"chunk_id": pai, "entidades": [TERMO], "forca": 1} for pai in pais],
    )

    def marcas(filtros=None) -> set[str]:
        candidatos, _ = retrieval.travessia(TERMO, ["recorte"], 50, filtros=filtros)
        return {c.content.rsplit(" ", 1)[-1].rstrip(".") for c in candidatos}

    assert marcas() == set(CENARIO)
    assert "cru" not in marcas(retrieval.Filtros.de_parametros(min_trust="human-reviewed"))
    assert "revogado" not in marcas(retrieval.Filtros.de_parametros(as_of="2019-03-04"))


@pg
def test_a_vigencia_da_pagina_de_wiki_e_respeitada(base, vetor_falso):
    """A wiki não está fora do filtro de data -- só do de confiança.

    E a ausência vale igual: página sem vigência declarada (que é toda página
    destilada hoje) continua aparecendo.
    """
    from kb_api.db import as_vector, conn

    paginas = {
        "pagina-viva": {"type": "Tese", "vigencia": {"de": "1990-09-11", "ate": ""}},
        "pagina-vencida": {"type": "Tese", "vigencia": {"de": "1990-09-11", "ate": "2015-03-16"}},
        "pagina-sem-data": {"type": "Tese"},
    }
    with conn() as connection:
        with connection.cursor() as cur:
            for caminho, frontmatter in paginas.items():
                texto = f"Direito de {TERMO} na página {caminho}."
                cur.execute(
                    "INSERT INTO wiki_page (space_slug, path, type, title, content,"
                    " frontmatter, tsv) VALUES ('recorte',%s,'Tese',%s,%s,%s::jsonb,"
                    " to_tsvector('portuguese', unaccent(%s))) RETURNING id",
                    (caminho, caminho, texto, json.dumps(frontmatter), texto),
                )
                page_id = cur.fetchone()[0]
                cur.execute(
                    "INSERT INTO wiki_page_vector (page_id, space_slug, section, embedding)"
                    " VALUES (%s,'recorte','seção',%s::vector)",
                    (page_id, as_vector([1.0] + [0.0] * 3071)),
                )
        connection.commit()

    recorte = retrieval.Filtros.de_parametros(as_of="2019-03-04")
    for metodo in ("paginas", "paginas_lexical"):
        candidatos, _ = retrieval.RECUPERADORES[metodo](TERMO, ["recorte"], 50, filtros=recorte)
        achado = {c.content.rsplit(" ", 1)[-1].rstrip(".") for c in candidatos}
        assert "pagina-vencida" not in achado, metodo
        assert {"pagina-viva", "pagina-sem-data"} <= achado, metodo


@pg
def test_o_aviso_de_armadilha_vem_colado_na_passagem(base):
    candidatos, _ = retrieval.lexical(TERMO, ["recorte"], 50)
    avisos = {c.armadilha for c in candidatos if c.armadilha}
    assert avisos == {"tese defensiva a conhecer, nunca fundamento ofensivo"}
    # E so o documento marcado carrega aviso: a marca nao vaza para os vizinhos.
    assert sum(1 for c in candidatos if c.armadilha) == 1

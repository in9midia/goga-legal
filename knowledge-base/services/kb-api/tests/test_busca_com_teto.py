"""Busca com teto: termo comum fora do OR lexical, e prazo por método.

O caso que motivou (ADR-0033): com 231 mil trechos, a pergunta "manifestação
sobre embargos em agravo em recurso especial no STJ" casava com 187 mil pelo OR
do lexical, o `ts_rank_cd` ranqueava a base inteira e a busca levava minutos sob
concorrência. O Studio desistia em 50 s.

Três blocos:

* **escolha de termos e tsquery** -- lógica pura, roda em qualquer lugar. As
  frequências são as medidas em produção (`pg_stats` de 2026-10-20);
* **prazo da busca** -- `search()` com métodos falsos, um que trava. Também sem
  banco: o que interessa é a busca não esperar o atrasado;
* **contra Postgres de verdade** -- PULADO quando não há um. Exercita o que só o
  banco diz: a tsquery com aspas, o `pg_stats` lido depois do ANALYZE e o
  `statement_timeout` local à transação, que não pode vazar para a conexão.

Para rodar o terceiro bloco, o mesmo Postgres do `test_recorte_da_busca.py`:

    docker run -d --name kb-pg -e POSTGRES_DB=knowledge_base \\
        -e POSTGRES_USER=knowledge_base -e POSTGRES_PASSWORD=knowledge_base \\
        -p 55432:5432 pgvector/pgvector:pg16
    POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=55432 pytest tests/test_busca_com_teto.py
"""

from __future__ import annotations

import dataclasses
import os
import threading
import time
from contextlib import contextmanager

import psycopg
import pytest

from kb_api import representations, retrieval, search
from kb_api.config import settings

# ── escolha de termos e tsquery ───────────────────────────────────────────

# Frequência (fração dos trechos) medida em produção.
PRODUCAO = {
    "direit": 0.9267,
    "sobr": 0.5720,
    "art": 0.5145,
    "lei": 0.3658,
    "processual": 0.3273,
    "recurs": 0.2068,
    "especial": 0.1573,
    "stj": 0.1395,
    "empres": 0.0629,
    "consum": 0.0552,
    "embarg": 0.0528,
    "agrav": 0.0522,
}
TODAS_AS_BASES = 231_307
PERGUNTA = [
    "agrav", "embarg", "empres", "especial", "manifestaca", "processual",
    "recurs", "regular", "representaca", "sobr", "stj",
]


def test_em_todas_as_bases_os_termos_comuns_saem_do_or():
    orcamento = settings.lexical_max_linhas
    mantidos, cortados = retrieval.escolher_termos(
        PERGUNTA, PRODUCAO, 0.0005, TODAS_AS_BASES, orcamento
    )
    # Os raros (fora da lista do pg_stats) ficam; o que casava com meia base sai.
    assert {"manifestaca", "regular", "representaca"} <= set(mantidos)
    assert {"sobr", "processual", "recurs", "especial", "stj"} <= set(cortados)
    estimado = sum(PRODUCAO.get(t, 0.0005) * TODAS_AS_BASES for t in mantidos)
    assert estimado <= orcamento


def test_numa_base_so_o_termo_do_assunto_continua():
    # "consumidor" esta em 5,5% da base inteira, mas numa busca so em `cdc`
    # (15 mil trechos) e o termo que decide. Cortar pela fracao global tiraria
    # justamente ele.
    mantidos, _ = retrieval.escolher_termos(["consum", "dan"], PRODUCAO, 0.0005, 15_000, 5000)
    assert "consum" in mantidos


def test_sem_estatistica_nada_e_cortado():
    # Base nova, nunca analisada: o comportamento de antes, OR de tudo.
    mantidos, cortados = retrieval.escolher_termos(PERGUNTA, {}, 0.0, TODAS_AS_BASES, 5000)
    assert sorted(mantidos) == sorted(PERGUNTA)
    assert cortados == []


def test_pergunta_so_de_termos_comuns_fica_sem_lexical():
    mantidos, cortados = retrieval.escolher_termos(
        ["direit", "sobr", "lei"], PRODUCAO, 0.0005, TODAS_AS_BASES, 5000
    )
    assert mantidos == []
    assert sorted(cortados) == ["direit", "lei", "sobr"]


def test_lexema_repetido_conta_uma_vez():
    mantidos, cortados = retrieval.escolher_termos(["agrav", "agrav"], {}, 0.0, 100, 5000)
    assert mantidos == ["agrav"] and cortados == []


def test_tsquery_poe_cada_lexema_entre_aspas():
    # Sem aspas, um lexema com `:` ou `&` viraria operador da tsquery.
    assert retrieval.como_tsquery(["agrav", "8.906:a", "d'agua"]) == (
        "'agrav' | '8.906:a' | 'd''agua'"
    )


# ── prazo da busca ────────────────────────────────────────────────────────


def _candidato(chave: str) -> retrieval.Candidato:
    return retrieval.Candidato(
        key=f"pagina:{chave}",
        document_id=0,
        space="a",
        content="texto",
        match="texto",
        page=None,
        score=1.0,
        representacao=representations.WIKI,
    )


@contextmanager
def _sem_banco():
    raise RuntimeError("sem banco neste teste")
    yield  # pragma: no cover


def test_metodo_que_passa_do_prazo_sai_e_a_busca_segue(monkeypatch):
    solto = threading.Event()

    def lento(query, spaces, limit, filtros=None):
        solto.wait(5)
        return [_candidato("lento")], {}

    def rapido(query, spaces, limit, filtros=None):
        return [_candidato("rapido")], {"tecnica": "falsa"}

    monkeypatch.setattr(search, "settings", dataclasses.replace(settings, metodo_timeout_ms=200))
    monkeypatch.setitem(retrieval.RECUPERADORES, "lexical", lento)
    monkeypatch.setitem(retrieval.RECUPERADORES, "paginas_lexical", rapido)
    monkeypatch.setattr(search, "_ativacoes", lambda spaces: {"a": object()})
    monkeypatch.setattr(
        representations,
        "agrupar_por_metodo",
        lambda ativacoes: {"lexical": ["a"], "paginas_lexical": ["a"]},
    )
    # Telemetria sem banco: a busca registra que nao conseguiu e segue.
    monkeypatch.setattr(search, "conn", _sem_banco)

    inicio = time.perf_counter()
    try:
        resultado = search.search("pergunta", ["a"])
    finally:
        solto.set()
    gasto = time.perf_counter() - inicio

    assert gasto < 2, f"a busca esperou o metodo atrasado ({gasto:.1f} s)"
    assert resultado.stages["lexical"] == {"estado": "tempo esgotado (200 ms)", "candidatos": 0}
    assert resultado.stages["paginas_lexical"]["candidatos"] == 1
    assert [p.match for p in resultado.passages] == ["texto"]


# ── contra Postgres de verdade ────────────────────────────────────────────


def _postgres_disponivel() -> bool:
    try:
        with psycopg.connect(settings.pg_dsn, connect_timeout=3):
            return True
    except Exception:
        return False


pg = pytest.mark.skipif(
    not _postgres_disponivel(),
    reason=f"sem Postgres em {os.environ.get('POSTGRES_HOST', 'postgres')}",
)


@pytest.fixture
def base():
    """Esquema das migrações e uma base onde "sobre" está em todo trecho."""
    from kb_api import migrate
    from kb_api.db import close_pool, conn

    with conn() as connection:
        with connection.cursor() as cur:
            cur.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        connection.commit()
    migrate.migrate()

    with conn() as connection:
        with connection.cursor() as cur:
            cur.execute("INSERT INTO space (slug, label) VALUES ('teto', 'Teto')")
            cur.execute(
                "INSERT INTO document (space_slug, filename, title, content_sha, status)"
                " VALUES ('teto', 'teto.md', 'teto', 'teto', 'indexed') RETURNING id"
            )
            document_id = cur.fetchone()[0]
            cur.execute(
                "INSERT INTO chunk (document_id, space_slug, parent_id, ord, content, tsv)"
                " VALUES (%s, 'teto', NULL, 0, 'pai', to_tsvector('portuguese', 'pai'))"
                " RETURNING id",
                (document_id,),
            )
            pai = cur.fetchone()[0]
            for i in range(400):
                texto = f"Comentario sobre o caso {i}." + (" Embargos de declaracao." if i == 7 else "")
                cur.execute(
                    "INSERT INTO chunk (document_id, space_slug, parent_id, ord, content, tsv)"
                    " VALUES (%s, 'teto', %s, %s, %s, to_tsvector('portuguese', unaccent(%s)))",
                    (document_id, pai, i + 1, texto, texto),
                )
        connection.commit()
        connection.autocommit = True
        with connection.cursor() as cur:
            cur.execute("ANALYZE chunk")
        connection.autocommit = False
    retrieval._estatisticas.clear()
    yield
    retrieval._estatisticas.clear()
    close_pool()


@pg
def test_lexical_corta_o_termo_que_esta_em_todo_trecho(base, monkeypatch):
    # Orcamento menor que a base: "sobre" (400 trechos) nao cabe, "embargos" (1) cabe.
    monkeypatch.setattr(retrieval, "settings", dataclasses.replace(settings, lexical_max_linhas=50))
    candidatos, trace = retrieval.lexical("embargos sobre o caso", ["teto"], 40)
    assert "sobr" in trace["termos_comuns_fora"]
    assert "embarg" in trace["termos"]
    assert len(candidatos) == 1 and "Embargos" in candidatos[0].content


@pg
def test_teto_de_tempo_nao_vaza_para_a_conexao(base):
    from kb_api.db import conn

    retrieval.lexical("embargos", ["teto"], 40)
    # Em sequencia, o pool devolve a mesma conexao ociosa que o metodo usou.
    with conn() as connection, connection.cursor() as cur:
        cur.execute("SHOW statement_timeout")
        assert cur.fetchone()[0] == "0"

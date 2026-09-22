"""Testes do runner de migracoes.

Divididos em dois blocos, de proposito:

* **Descoberta e leitura** dos arquivos -- roda em qualquer lugar, sem
  dependencia externa. E onde moram as regras que quebram silenciosamente:
  ordenacao, numeracao duplicada, marcador de transacao, checksum.
* **Aplicacao** -- exige Postgres e e PULADO quando nao ha um. As garantias que
  interessam aqui (atomicidade, lock entre replicas, ledger) sao propriedades do
  banco; simular com um duble testaria o duble, nao a migracao.

Para rodar o bloco de aplicacao:

    docker run -d --name kb-pg -e POSTGRES_DB=knowledge_base \\
        -e POSTGRES_USER=knowledge_base -e POSTGRES_PASSWORD=knowledge_base \\
        -p 55432:5432 pgvector/pgvector:pg16
    POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=55432 pytest tests/test_migrate.py
"""

from __future__ import annotations

import dataclasses
import os

import psycopg
import pytest

from kb_api import migrate as m


def com_settings(monkeypatch, **campos) -> None:
    """Troca o `settings` que o runner enxerga.

    `Settings` e um dataclass frozen, entao nao da para monkeypatchar um campo:
    o jeito e substituir a instancia inteira no modulo.
    """
    monkeypatch.setattr(m, "settings", dataclasses.replace(m.settings, **campos))


# ── descoberta e leitura ───────────────────────────────────────────────────


def escrever(pasta, nome: str, conteudo: str = "SELECT 1;\n") -> None:
    (pasta / nome).write_text(conteudo, encoding="utf-8")


@pytest.fixture
def pasta(tmp_path, monkeypatch):
    """Aponta o runner para um diretorio de migracoes descartavel."""
    monkeypatch.setattr(m, "MIGRATIONS_DIR", tmp_path)
    return tmp_path


def test_ordena_por_versao_e_nao_por_nome(pasta):
    # 0010 vem depois de 0009 mesmo com o nome em ordem alfabetica inversa.
    escrever(pasta, "0009_zzz.sql")
    escrever(pasta, "0010_aaa.sql")
    escrever(pasta, "0002_mmm.sql")
    assert [mig.version for mig in m.discover()] == [2, 9, 10]


def test_ignora_arquivo_que_nao_e_sql(pasta):
    escrever(pasta, "0001_inicial.sql")
    (pasta / "README.md").write_text("doc", encoding="utf-8")
    assert [mig.name for mig in m.discover()] == ["inicial"]


def test_nome_fora_do_padrao_e_erro(pasta):
    escrever(pasta, "0001_inicial.sql")
    escrever(pasta, "adiciona_coluna.sql")
    with pytest.raises(RuntimeError, match="fora do padrao"):
        m.discover()


def test_versao_duplicada_e_erro(pasta):
    # Duas branches numerando em paralelo. Escolher uma das duas aqui produziria
    # bancos diferentes em ambientes diferentes -- por isso e erro, nao aviso.
    escrever(pasta, "0002_de_uma_branch.sql")
    escrever(pasta, "0002_da_outra.sql")
    with pytest.raises(RuntimeError, match="duplicada"):
        m.discover()


def test_diretorio_vazio_e_erro(pasta):
    with pytest.raises(RuntimeError, match="nenhuma migracao"):
        m.discover()


def test_diretorio_ausente_menciona_package_data(tmp_path, monkeypatch):
    # O modo de falhar em producao e o package-data faltando no pyproject: a
    # mensagem precisa dizer isso, senao vira uma hora de investigacao.
    monkeypatch.setattr(m, "MIGRATIONS_DIR", tmp_path / "nao_existe")
    with pytest.raises(RuntimeError, match="package-data"):
        m.discover()


def test_marcador_tira_da_transacao(pasta):
    escrever(pasta, "0001_comum.sql", "ALTER TABLE t ADD COLUMN c TEXT;\n")
    escrever(
        pasta,
        "0002_concorrente.sql",
        f"{m.NO_TRANSACTION}\nCREATE INDEX CONCURRENTLY i ON t (c);\n",
    )
    comum, concorrente = m.discover()
    assert comum.in_transaction is True
    assert concorrente.in_transaction is False


def test_marcador_so_vale_em_linha_inteira(pasta):
    # Sem isso, mencionar o marcador num comentario em prosa (como o README faz)
    # tiraria a migracao da transacao sem ninguem perceber.
    escrever(pasta, "0001_x.sql", f"-- veja `{m.NO_TRANSACTION}` no README\nSELECT 1;\n")
    assert m.discover()[0].in_transaction is True


def test_checksum_muda_com_o_conteudo(pasta):
    escrever(pasta, "0001_x.sql", "SELECT 1;\n")
    antes = m.discover()[0].checksum
    escrever(pasta, "0001_x.sql", "SELECT 2;\n")
    assert m.discover()[0].checksum != antes


def test_dimensao_do_vetor_e_substituida_sem_mexer_no_checksum(pasta, monkeypatch):
    escrever(pasta, "0001_x.sql", "CREATE TABLE e (v vector(3072));\n")
    referencia = m.discover()[0]

    com_settings(monkeypatch, embedding_dim=1536)
    ajustada = m.discover()[0]

    assert "vector(1536)" in ajustada.sql()
    # O checksum e do arquivo em disco: trocar de modelo nao pode virar alarme
    # de "migracao editada depois de aplicada".
    assert ajustada.checksum == referencia.checksum


def test_label_tem_a_versao_com_quatro_digitos(pasta):
    escrever(pasta, "0007_alguma_coisa.sql")
    assert m.discover()[0].label == "0007_alguma_coisa"


# ── CLI: criacao de migracao ───────────────────────────────────────────────


def test_new_numera_a_partir_da_maior_existente(pasta, capsys):
    escrever(pasta, "0001_inicial.sql")
    escrever(pasta, "0009_outra.sql")
    assert m._cmd_new("indice de figura por pagina") == 0
    criado = capsys.readouterr().out.strip()
    assert criado.endswith("0010_indice_de_figura_por_pagina.sql")
    assert (pasta / "0010_indice_de_figura_por_pagina.sql").exists()


def test_new_gera_arquivo_que_o_discover_aceita(pasta):
    escrever(pasta, "0001_inicial.sql")
    m._cmd_new("Acentuacao, Espaco  e  Pontuacao!")
    # O scaffold nao pode gerar um nome que o proprio runner recusa depois.
    versoes = [mig.version for mig in m.discover()]
    assert versoes == [1, 2]


def test_new_recusa_nome_vazio(pasta):
    escrever(pasta, "0001_inicial.sql")
    assert m._cmd_new("  !!  ") == 2


# ── aplicacao (exige Postgres) ─────────────────────────────────────────────


def _postgres_disponivel() -> bool:
    try:
        with psycopg.connect(m.settings.pg_dsn, connect_timeout=3):
            return True
    except Exception:
        return False


pg = pytest.mark.skipif(
    not _postgres_disponivel(),
    reason=f"sem Postgres em {os.environ.get('POSTGRES_HOST', 'postgres')}",
)


@pytest.fixture
def banco():
    """Base limpa por teste, e o pool fechado no fim."""
    from kb_api.db import close_pool, conn

    def limpar():
        with conn() as connection:
            with connection.cursor() as cur:
                cur.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
            connection.commit()

    limpar()
    yield conn
    limpar()
    close_pool()


@pg
def test_aplica_uma_vez_e_registra(pasta, banco):
    escrever(pasta, "0001_cria.sql", "CREATE TABLE t (id INT);\n")

    assert [mig.label for mig in m.migrate()] == ["0001_cria"]
    # A segunda chamada e o caso normal: todo pod que sobe passa por aqui.
    assert m.migrate() == []

    with banco() as connection, connection.cursor() as cur:
        cur.execute("SELECT version, name FROM schema_migration")
        assert cur.fetchall() == [(1, "cria")]


@pg
def test_aplica_pendentes_em_ordem(pasta, banco):
    escrever(pasta, "0001_cria.sql", "CREATE TABLE t (id INT);\n")
    m.migrate()
    # A 0002 depende da 0001 ja existir: se a ordem furar, o ALTER quebra.
    escrever(pasta, "0002_altera.sql", "ALTER TABLE t ADD COLUMN nome TEXT;\n")
    assert [mig.label for mig in m.migrate()] == ["0002_altera"]


@pg
def test_migracao_pode_fazer_backfill(pasta, banco):
    # A razao de existir do runner: isto e o que o schema.sql idempotente nao
    # conseguia expressar, porque rodava de novo a cada subida.
    escrever(pasta, "0001_cria.sql", "CREATE TABLE t (id INT, n INT DEFAULT 0);\n")
    m.migrate()
    with banco() as connection:
        with connection.cursor() as cur:
            cur.execute("INSERT INTO t (id) VALUES (1), (2)")
        connection.commit()

    escrever(pasta, "0002_backfill.sql", "UPDATE t SET n = n + 1;\n")
    m.migrate()
    m.migrate()  # nao pode contar duas vezes

    with banco() as connection, connection.cursor() as cur:
        cur.execute("SELECT DISTINCT n FROM t")
        assert cur.fetchall() == [(1,)]


@pg
def test_falha_no_meio_nao_deixa_rastro(pasta, banco):
    escrever(
        pasta,
        "0001_quebra.sql",
        "CREATE TABLE bom (id INT);\nALTER TABLE inexistente ADD COLUMN x TEXT;\n",
    )
    with pytest.raises(psycopg.errors.UndefinedTable):
        m.migrate()

    with banco() as connection, connection.cursor() as cur:
        cur.execute("SELECT to_regclass('bom'), to_regclass('schema_migration')")
        tabela, ledger = cur.fetchone()
        # A tabela criada na primeira linha nao pode sobreviver...
        assert tabela is None
        # ...e o ledger existe (foi criado antes), mas sem registro da falha.
        assert ledger is not None
        cur.execute("SELECT count(*) FROM schema_migration")
        assert cur.fetchone()[0] == 0


@pg
def test_drift_avisa_por_padrao_e_recusa_no_estrito(pasta, banco, monkeypatch):
    escrever(pasta, "0001_x.sql", "CREATE TABLE t (id INT);\n")
    m.migrate()
    escrever(pasta, "0001_x.sql", "CREATE TABLE t (id INT);\n-- editado depois\n")

    # Permissivo: segue em frente (o pod sobe), so registra o erro no log.
    assert m.migrate() == []

    com_settings(monkeypatch, migrations_strict=True)
    with pytest.raises(RuntimeError, match="EDITADA"):
        m.migrate()


@pg
def test_status_e_summary_refletem_o_banco(pasta, banco):
    escrever(pasta, "0001_x.sql", "CREATE TABLE t (id INT);\n")
    m.migrate()
    escrever(pasta, "0002_y.sql", "CREATE TABLE u (id INT);\n")

    linhas = m.status()
    assert [(linha["version"], linha["applied"]) for linha in linhas] == [(1, True), (2, False)]

    resumo = m.summary()
    assert resumo["applied"] == 1
    assert resumo["pending"] == 1
    assert resumo["current"] == 1
    assert resumo["drifted"] == []


@pg
def test_status_denuncia_migracao_sem_arquivo(pasta, banco):
    # Deploy de imagem ANTIGA sobre banco ja migrado: um rollback que ninguem
    # anunciou. O sintoma na aplicacao e coluna que "sumiu".
    escrever(pasta, "0001_x.sql", "CREATE TABLE t (id INT);\n")
    escrever(pasta, "0002_y.sql", "CREATE TABLE u (id INT);\n")
    m.migrate()

    (pasta / "0002_y.sql").unlink()
    ausentes = [linha for linha in m.status() if linha.get("missing_file")]
    assert [linha["version"] for linha in ausentes] == [2]


# ── uma instrucao por vez, fora de transacao ──────────────────────────────


def test_separar_instrucoes_respeita_aspas_cifrao_e_comentario():
    """O corte ingênuo em `;` quebraria o script em pedaços inválidos."""
    from kb_api.migrate import separar_instrucoes

    sql = """
    -- um comentário com ; dentro, que não corta nada
    CREATE TABLE t (a text DEFAULT 'ponto ; e vírgula');
    /* bloco com ; dentro */
    CREATE FUNCTION f() RETURNS void AS $corpo$
      BEGIN
        PERFORM 1;
        PERFORM 2;
      END;
    $corpo$ LANGUAGE plpgsql;
    -- rabo do arquivo, que não é instrução
    """
    partes = separar_instrucoes(sql)
    assert len(partes) == 2, partes
    assert "ponto ; e vírgula" in partes[0]
    assert "PERFORM 2" in partes[1] and partes[1].rstrip().endswith("plpgsql")


def test_a_migracao_sem_transacao_manda_uma_instrucao_por_vez():
    """Regressão de uma falha real na subida.

    A 0008 traz dois `CREATE INDEX CONCURRENTLY`. Mandar o script inteiro numa
    chamada faz o Postgres abrir um bloco de transação implícito, e ele recusa:
    `CREATE INDEX CONCURRENTLY cannot run inside a transaction block` — mesmo com
    `autocommit = True` e com o marcador `-- kb:no-transaction` no lugar. O
    marcador estava sendo respeitado; faltava dividir.
    """
    import inspect

    from kb_api import migrate

    corpo = inspect.getsource(migrate._apply)
    assert "for instrucao in separar_instrucoes(sql):" in corpo
    # E a 0008 continua sendo o caso que motivou isto.
    zero_oito = next(m for m in migrate.discover() if m.version == 8)
    assert zero_oito.in_transaction is False
    assert len(migrate.separar_instrucoes(zero_oito.sql())) == 2


# ── migracao acessoria: falha dela nao derruba o servico ──────────────────


def test_a_migracao_do_indice_vetorial_e_acessoria():
    """Índice é otimização, e otimização não pode impedir o serviço de subir.

    `halfvec` exige pgvector >= 0.7. Num servidor mais velho a 0008 não roda — e
    derrubar a API por causa de um índice inverteria a lógica do projeto, que é a
    mesma do grafo e de um método de busca que falha: acessório degrada, não
    derruba. Sem o índice a busca continua correta, só volta a varrer.
    """
    from kb_api import migrate

    zero_oito = next(m for m in migrate.discover() if m.version == 8)
    assert zero_oito.opcional is True
    # As obrigatórias continuam obrigatórias: sem esquema não há serviço.
    assert all(m.opcional is False for m in migrate.discover() if m.version < 8)


@pg
def test_acessoria_que_falha_nao_derruba_nem_para_a_fila(pasta, banco):
    """O comportamento inteiro, contra Postgres de verdade.

    Três coisas de uma vez, e nenhuma delas dá para afirmar lendo o código: a
    acessória que falha NÃO derruba, NÃO entra no ledger, e NÃO impede a
    migração seguinte de rodar.
    """
    escrever(pasta, "0001_cria.sql", "CREATE TABLE t (id INT);\n")
    escrever(
        pasta,
        "0002_indice_impossivel.sql",
        "-- kb:opcional\nCREATE INDEX i ON tabela_que_nao_existe (x);\n",
    )
    escrever(pasta, "0003_depois.sql", "CREATE TABLE u (id INT);\n")

    feitas = m.migrate()  # nao levanta
    assert [x.label for x in feitas] == ["0001_cria", "0003_depois"]

    with banco() as connection, connection.cursor() as cur:
        cur.execute("SELECT version FROM schema_migration ORDER BY version")
        # A 2 nao esta aqui: e isso que faz a proxima subida tentar de novo, e o
        # indice aparecer sozinho no dia em que o servidor ganhar o recurso.
        assert [linha[0] for linha in cur.fetchall()] == [1, 3]
        cur.execute("SELECT to_regclass('public.u')")
        assert cur.fetchone()[0] is not None, "a falha da acessoria parou a fila"

    # Segunda subida: tenta de novo, falha de novo, e o servico sobe de novo.
    assert m.migrate() == []


@pg
def test_a_obrigatoria_que_falha_continua_derrubando(pasta, banco):
    """O contrapeso. Sem esquema nao ha servico, e subir sem ele e pior."""
    escrever(pasta, "0001_quebrada.sql", "CREATE INDEX i ON nao_existe (x);\n")
    with pytest.raises(psycopg.errors.UndefinedTable):
        m.migrate()

"""A retentativa automática, na parte que dá para testar sem a stack de pé.

O que fica de fora e é verificado à mão: a ingestão de verdade a partir do bruto
no object store, e o backoff atravessando reinício do pod.
"""
from __future__ import annotations

from datetime import UTC

# ── a rodada cede a vez para quem esta usando o sistema ────────────────────
#
# O docstring do modulo sempre prometeu que a retentativa "perde a disputa de
# proposito". Serial com pausa de 2 s nao cumpria isso: somava concorrencia.


def _fake_conn(monkeypatch, contagem):
    """`conn()` que responde `contagem` para o SELECT de ingestões rodando."""
    from kb_api import retry

    class _Cur:
        def execute(self, *a, **k): pass
        def fetchone(self): return (contagem,)
        def fetchall(self): return []
        def __enter__(self): return self
        def __exit__(self, *a): return False

    class _Conn:
        def cursor(self): return _Cur()
        def commit(self): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setattr(retry, "conn", lambda: _Conn())


def test_rodada_adia_quando_ha_ingestao_de_usuario(monkeypatch):
    from kb_api import retry

    _fake_conn(monkeypatch, 2)
    chamou = []
    monkeypatch.setattr(retry, "_da_vez", lambda: chamou.append(1) or [])

    r = retry.rodada()
    assert r["adiada"] is True
    assert r["ingestoes_em_andamento"] == 2
    assert not chamou, "nem chegou a consultar a fila"


def test_rodada_adiada_mantem_o_contrato_que_o_laco_le(monkeypatch):
    """`_laco` lê `tentados` na volta.

    Um retorno sem essa chave viraria KeyError, engolido pelo `except` do laço e
    logado como "rodada falhou" — mentira que esconderia o adiamento.
    """
    from kb_api import retry

    _fake_conn(monkeypatch, 1)
    r = retry.rodada()
    assert r["tentados"] == 0 and r["recuperados"] == 0


def test_rodada_roda_quando_so_a_propria_retentativa_esta_em_andamento(monkeypatch):
    """Sem excluir as execuções da própria thread, a rodada pararia no segundo
    documento vendo o primeiro que ela mesma iniciou."""
    from kb_api import retry

    _fake_conn(monkeypatch, 0)
    monkeypatch.setattr(retry, "_da_vez", lambda: [])
    r = retry.rodada()
    assert "adiada" not in r
    assert r["tentados"] == 0


def test_a_consulta_exclui_exatamente_o_rotulo_que_a_ingestao_grava(monkeypatch):
    """O acoplamento perigoso: `_carga_de_gente` exclui por `PRINCIPAL`, e
    `rodada` grava com `PRINCIPAL`. Se um lado passar a usar outro texto, a
    thread se enxerga como carga de usuário e não roda mais — em silêncio, que é
    o pior jeito de uma retentativa parar.

    Em vez de ler o código-fonte, este teste captura o parâmetro que a consulta
    usa e compara com o que a ingestão receberia.
    """
    from kb_api import retry

    capturado = {}

    class _Cur:
        def execute(self, sql, params=None):
            capturado["sql"] = sql
            capturado["params"] = params
        def fetchone(self): return (0,)
        def __enter__(self): return self
        def __exit__(self, *a): return False

    class _Conn:
        def cursor(self): return _Cur()
        def commit(self): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setattr(retry, "conn", lambda: _Conn())
    retry._carga_de_gente()

    from datetime import datetime

    rotulo, corte = capturado["params"]
    assert rotulo == retry.PRINCIPAL
    assert "status = 'running'" in capturado["sql"]
    # A janela também entra na consulta: sem ela, uma linha `running` órfã de um
    # pod morto adiaria a retentativa para sempre, em silêncio.
    assert "started_at" in capturado["sql"]
    idade = (datetime.now(UTC) - corte).total_seconds()
    assert abs(idade - retry.TETO_DA_BORDA_SEGUNDOS) < 5


def test_recuperacao_esquece_o_documento_antigo_no_grafo(monkeypatch):
    """O `DELETE` do Postgres leva trecho e figura na cascata, mas o Memgraph
    não tem cascata: o nó só some quando alguém manda.

    As duas rotas irmãs que apagam documento já chamavam `forget_document`; só
    este caminho não chamava. O resto seria um `:Document` apontando para linha
    inexistente, e a tela caindo em "documento não encontrado" ao navegar.
    """
    from kb_api import retry

    esquecidos = []
    monkeypatch.setattr(retry, "_carga_de_gente", lambda: 0)
    monkeypatch.setattr(retry, "_da_vez", lambda: [(7, "rh", "ferias.pdf", "raw/ferias.pdf")])
    monkeypatch.setattr(retry.storage, "get", lambda k: b"conteudo")
    monkeypatch.setattr(retry.graph, "forget_document", lambda i: esquecidos.append(i))
    monkeypatch.setattr(retry, "PAUSA_ENTRE_DOCUMENTOS", 0)

    class _Resultado:
        status = "indexed"
        document_id = 99  # id NOVO: a linha antiga precisa sair

    monkeypatch.setattr(retry.ingest, "ingest_document", lambda *a, **k: _Resultado())

    class _Cur:
        def execute(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False

    class _Conn:
        def cursor(self): return _Cur()
        def commit(self): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setattr(retry, "conn", lambda: _Conn())

    r = retry.rodada()
    assert r["recuperados"] == 1
    assert esquecidos == [7], "o nó do documento ANTIGO precisa ser esquecido"

"""Reaplicar o preço ao histórico: o que sai exato e o que sai estimado.

O ponto do módulo não é somar — é NÃO misturar número apurado com número
suposto, porque os dois somam igual e só um sustenta uma conversa de orçamento.
"""
from __future__ import annotations

import pytest

from kb_api import recalculo


class _Cur:
    """Cursor de mentira: devolve provedores, depois uso, e guarda os UPDATE."""

    def __init__(self, estado):
        self.estado = estado

    def execute(self, sql, params=None):
        if "FROM ai_provider" in sql:
            self.estado["saida"] = self.estado["provedores"]
        elif "FROM ai_usage_daily" in sql:
            self.estado["saida"] = self.estado["uso"]
        elif sql.strip().startswith("UPDATE"):
            self.estado["updates"].append(params)

    def fetchall(self):
        return self.estado["saida"]

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _conn(estado):
    class _Conn:
        def cursor(self):
            return _Cur(estado)

        def commit(self):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    return lambda: _Conn()


@pytest.fixture
def estado(monkeypatch):
    e = {"provedores": [], "uso": [], "updates": [], "saida": []}
    monkeypatch.setattr(recalculo, "conn", _conn(e))
    return e


# (id, nome, modelo, purpose, preco_entrada, preco_saida)
EMBEDDING = (1, "Azure", "text-embedding-3-large", "embedding", 0.13, None)
CHAT = (2, "Azure Chat", "gpt-5.6-luna", "chat", 0.2, 1.2)


def test_embedding_e_exato_porque_a_operacao_nao_tem_saida(estado):
    estado["provedores"] = [EMBEDDING]
    # (day, provider_id, provider, model, operation, tokens, tokens_in, tokens_out)
    estado["uso"] = [("2026-09-01", 1, "Azure", "text-embedding-3-large", "index", 1_000_000, 0, 0)]

    r = recalculo.recalcular()
    assert r["exatas"] == 1 and r["estimadas"] == 0
    assert r["tokens_estimados"] == 0
    # 1M tokens a US$ 0,13 por 1M.
    assert r["custo_usd"] == pytest.approx(0.13)
    entrada, saida, custo, estimados = estado["updates"][0][:4]
    assert (entrada, saida, estimados) == (1_000_000, 0, 0)


def test_chat_antigo_sai_estimado_e_fica_marcado(estado):
    """A linha só guarda o total; entrada e saída custam diferente. O que foi
    suposto precisa aparecer como suposto."""
    estado["provedores"] = [CHAT]
    estado["uso"] = [
        ("2026-09-01", 2, "Azure Chat", "gpt-5.6-luna", "grafo-extrair", 1_000_000, 0, 0)
    ]

    r = recalculo.recalcular()
    assert r["estimadas"] == 1 and r["exatas"] == 0
    assert r["tokens_estimados"] == 1_000_000
    # 900k entrada a 0,2 + 100k saída a 1,2.
    assert r["custo_usd"] == pytest.approx(0.9 * 0.2 + 0.1 * 1.2)


def test_linha_que_ja_tem_a_decomposicao_nao_vira_estimativa(estado):
    """Gravada depois da 0014: os números vieram do provedor, então aplicar o
    preço novo não introduz suposição nenhuma."""
    estado["provedores"] = [CHAT]
    estado["uso"] = [
        ("2026-09-01", 2, "Azure Chat", "gpt-5.6-luna", "grafo-extrair", 1000, 800, 200)
    ]

    r = recalculo.recalcular()
    assert r["exatas"] == 1 and r["tokens_estimados"] == 0
    entrada, saida = estado["updates"][0][:2]
    assert (entrada, saida) == (800, 200)


def test_provedor_sem_preco_nao_vira_custo_zero_disfarcado(estado):
    """Ele fica de fora e aparece no resumo: a ação ali é cadastrar o preço,
    não recalcular de novo."""
    estado["provedores"] = [(3, "Sem preço", "x", "chat", None, None)]
    estado["uso"] = [("2026-09-01", 3, "Sem preço", "x", "index", 500, 0, 0)]

    r = recalculo.recalcular()
    assert r["sem_preco"] == 1 and r["atualizadas"] == 0
    assert estado["updates"] == []


def test_alcanca_linha_de_provedor_apagado_pelo_nome(estado):
    """`ai_usage_daily` não tem FK para o cadastro, de propósito: apagar um
    provedor não apaga o gasto dele. Sem casar por (nome, modelo), essas linhas
    nunca seriam recalculadas — justo as de quem trocou de provedor."""
    estado["provedores"] = [EMBEDDING]
    estado["uso"] = [(None, None, "Azure", "text-embedding-3-large", "index", 1_000_000, 0, 0)]

    r = recalculo.recalcular()
    assert r["atualizadas"] == 1 and r["sem_provedor"] == 0


def test_provedor_que_nao_existe_mais_em_lugar_nenhum_e_pulado(estado):
    estado["provedores"] = [EMBEDDING]
    estado["uso"] = [("2026-09-01", 99, "Apagado", "modelo-sumido", "index", 10, 0, 0)]

    r = recalculo.recalcular()
    assert r["sem_provedor"] == 1 and r["atualizadas"] == 0


def test_fracao_fora_da_faixa_e_recusada(estado):
    for ruim in (-0.1, 1.5):
        with pytest.raises(ValueError):
            recalculo.recalcular(ruim)


def test_a_fracao_e_configuravel(estado):
    estado["provedores"] = [CHAT]
    estado["uso"] = [("2026-09-01", 2, "Azure Chat", "gpt-5.6-luna", "x", 1000, 0, 0)]

    recalculo.recalcular(0.5)
    entrada, saida = estado["updates"][0][:2]
    assert (entrada, saida) == (500, 500)

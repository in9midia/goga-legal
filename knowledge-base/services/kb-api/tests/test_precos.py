"""A busca de preço no catálogo.

Importa porque o número vai para a tela de custo, e porque as três respostas
possíveis pedem ações diferentes de quem está cadastrando.
"""
from __future__ import annotations

import pytest

from kb_api import precos


@pytest.fixture(autouse=True)
def _cache_limpo():
    """O cache é de processo e de 6h: sem limpar, o primeiro teste decide o
    resultado dos outros."""
    precos._cache.update({"fonte": "", "mapa": None, "quando": 0.0})
    yield
    precos._cache.update({"fonte": "", "mapa": None, "quando": 0.0})


CATALOGO = {
    "gpt-4o": {"input_cost_per_token": 0.0000025, "output_cost_per_token": 0.00001},
    "azure/gpt-4o": {"input_cost_per_token": 0.0000025, "output_cost_per_token": 0.00001},
    "text-embedding-3-large": {"input_cost_per_token": 0.00000013},
    "azure_ai/deepseek-v3-0324": {
        "input_cost_per_token": 0.00000114,
        "output_cost_per_token": 0.00000456,
    },
    "sem-preco": {"max_input_tokens": 128000},
}


def _com_catalogo(monkeypatch, mapa):
    monkeypatch.setattr(precos, "_baixar", lambda url: mapa)


def test_converte_custo_por_token_para_por_milhao(monkeypatch):
    # O catálogo guarda por TOKEN; a tela e o banco trabalham por 1M.
    _com_catalogo(monkeypatch, CATALOGO)
    r = precos.buscar("openai", "gpt-4o")
    assert r["fonte"] == "catalogo"
    assert r["price_input_per_1m"] == 2.5
    assert r["price_output_per_1m"] == 10.0


def test_azure_procura_com_o_prefixo_do_provedor(monkeypatch):
    _com_catalogo(monkeypatch, CATALOGO)
    r = precos.buscar("azure_openai", "gpt-4o")
    assert r["fonte"] == "catalogo" and r["chave"] == "azure/gpt-4o"


def test_foundry_procura_em_minusculo(monkeypatch):
    """O portal publica `DeepSeek-V3-0324`; o catálogo indexa minúsculo."""
    _com_catalogo(monkeypatch, CATALOGO)
    r = precos.buscar("azure_foundry", "DeepSeek-V3-0324")
    assert r["fonte"] == "catalogo" and r["price_input_per_1m"] == 1.14


def test_embedding_sem_preco_de_saida_devolve_none_e_nao_zero(monkeypatch):
    """Zero afirmaria que a saída é de graça. Embedding não TEM saída, e a
    diferença entre 'não tem' e 'custa nada' muda o que a tela mostra."""
    _com_catalogo(monkeypatch, CATALOGO)
    r = precos.buscar("openai", "text-embedding-3-large")
    assert r["price_input_per_1m"] == 0.13
    assert r["price_output_per_1m"] is None


def test_modelo_desconhecido_responde_nenhum(monkeypatch):
    """Deployment do Azure com nome próprio é o caso comum aqui, e a ação é
    preencher à mão — não é defeito."""
    _com_catalogo(monkeypatch, CATALOGO)
    r = precos.buscar("azure_openai", "gpt-5.6-luna")
    assert r["fonte"] == "nenhum"
    assert r["price_input_per_1m"] is None


def test_entrada_sem_nenhum_campo_de_custo_nao_conta_como_achado(monkeypatch):
    """O catálogo tem entradas só com contexto e limite. Aceitá-las devolveria
    'achei' com os dois preços vazios, e a tela diria que buscou com sucesso."""
    _com_catalogo(monkeypatch, CATALOGO)
    assert precos.buscar("openai", "sem-preco")["fonte"] == "nenhum"


def test_catalogo_ilegivel_responde_indisponivel(monkeypatch):
    """A distinção que importa: `nenhum` é 'o catálogo não conhece', e
    `indisponivel` é 'não deu para ler'. Juntá-las fazia a busca responder
    'não conheço' até para `gpt-4o` num cluster sem saída."""
    _com_catalogo(monkeypatch, None)
    r = precos.buscar("openai", "gpt-4o")
    assert r["fonte"] == "indisponivel"


def test_usa_o_gateway_como_fonte_quando_ha_um(monkeypatch):
    """A rota do gateway é interna e sem credencial: é o que faz a busca
    funcionar em cluster com egress fechado."""
    pedidas: list[str] = []

    def _falso(url: str):
        pedidas.append(url)
        return CATALOGO

    monkeypatch.setattr(precos, "_baixar", _falso)
    precos.buscar("openai", "gpt-4o", gateway="http://litellm:4000/")
    assert pedidas == ["http://litellm:4000/public/litellm_model_cost_map"]


def test_o_catalogo_e_lido_uma_vez_so_dentro_do_ttl(monkeypatch):
    """Sem o cache, uma tela de cadastro dependeria de uma ida à internet por
    clique."""
    idas: list[str] = []

    def _falso(url: str):
        idas.append(url)
        return CATALOGO

    monkeypatch.setattr(precos, "_baixar", _falso)
    precos.buscar("openai", "gpt-4o")
    precos.buscar("openai", "text-embedding-3-large")
    assert len(idas) == 1

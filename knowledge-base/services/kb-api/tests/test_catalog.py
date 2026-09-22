"""Listagem de modelos de uma conta: a URL de cada provedor, e o que ela promete.

O que este arquivo trava:

1. **a URL e o header de cada dialeto.** A listagem NAO usa a mesma rota da
   chamada: o Azure tem uma api-version propria para `GET /openai/deployments`,
   e pedi-la com a api-version do cadastro devolve 404 num recurso novo. O
   sintoma seria "a conta nao tem deployment", que e falso;
2. **o `source`.** `deployments`, `account` e `catalog` prometem coisas
   diferentes, e o fallback do Foundry precisa trocar a promessa junto com a
   rota. Devolver `deployments` para uma lista de catalogo faria a tela afirmar
   que um modelo esta publicado quando ele so poderia estar;
3. **a normalizacao do endpoint.** O caminho colado no cadastro (`/models`,
   `/chat/completions`) tem de cair antes de montar a URL do catalogo, que mora
   noutra rota do mesmo recurso.

Tudo com o `urlopen` trocado por um duble: o que se quer medir e como o pedido e
montado e como a resposta e lida, nao a conta de ninguem.
"""

from __future__ import annotations

import io
import json

import pytest


class _RespostaFalsa(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
        return False


def _responder(monkeypatch, rotas: dict[str, dict | int]):
    """Troca o `urlopen`. `rotas` casa por SUBSTRING da URL; int = status de erro."""
    import urllib.error

    from kb_api import catalog

    visto: list[dict] = []

    def falso(request, timeout=None):
        visto.append({"url": request.full_url, "headers": dict(request.headers)})
        for pedaco, resposta in rotas.items():
            if pedaco in request.full_url:
                if isinstance(resposta, int):
                    raise urllib.error.HTTPError(
                        request.full_url, resposta, "erro", {}, io.BytesIO(b"{}")
                    )
                return _RespostaFalsa(json.dumps(resposta).encode())
        raise AssertionError(f"URL inesperada: {request.full_url}")

    monkeypatch.setattr(catalog.urllib.request, "urlopen", falso)
    return visto


_AZURE = {
    "data": [
        {"id": "emb-large-v2", "model": "text-embedding-3-large"},
        {"id": "gpt-4o-prod", "model": "gpt-4o"},
    ]
}


# ── montagem do pedido ────────────────────────────────────────────────────


def test_azure_openai_usa_a_api_version_da_listagem(monkeypatch):
    """A api-version da listagem NAO e a do cadastro.

    Pedir `GET /openai/deployments` com a api-version nova devolve 404, e o
    operador leria "a conta nao tem deployment" -- que e falso.
    """
    from kb_api import catalog

    visto = _responder(monkeypatch, {"/openai/deployments": _AZURE})
    origem, modelos = catalog.azure_openai("https://recurso.openai.azure.com", "segredo")

    assert f"api-version={catalog.AZURE_LIST_API_VERSION}" in visto[0]["url"]
    assert visto[0]["headers"]["Api-key"] == "segredo"
    assert origem == "deployments"
    # Ordenado e sem repetidos; o `model` acompanha para dar para reconhecer o
    # deployment de nome proprio.
    assert [(m.id, m.model) for m in modelos] == [
        ("emb-large-v2", "text-embedding-3-large"),
        ("gpt-4o-prod", "gpt-4o"),
    ]


def test_openai_usa_bearer_e_a_rota_da_conta(monkeypatch):
    from kb_api import catalog

    visto = _responder(monkeypatch, {"api.openai.com": {"data": [{"id": "gpt-4o"}]}})
    origem, modelos = catalog.openai("", "segredo")

    assert visto[0]["url"] == catalog.OPENAI_MODELS_URL
    assert visto[0]["headers"]["Authorization"] == "Bearer segredo"
    assert origem == "account"
    assert [m.id for m in modelos] == ["gpt-4o"]


def test_litellm_anexa_o_v1_que_o_endpoint_nao_tem(monkeypatch):
    """O endpoint cadastrado e a RAIZ do gateway, por convencao herdada do agentic-sdlc."""
    from kb_api import catalog

    visto = _responder(monkeypatch, {"/v1/models": {"data": [{"id": "azure/gpt-4o"}]}})
    origem, modelos = catalog.litellm("https://gateway.interno", "virtual-key")

    assert visto[0]["url"] == "https://gateway.interno/v1/models"
    assert visto[0]["headers"]["Authorization"] == "Bearer virtual-key"
    # `account`, e nao `deployments`: o gateway devolve o que ESTA key alcanca.
    assert origem == "account"
    assert [m.id for m in modelos] == ["azure/gpt-4o"]


# ── normalizacao do endpoint ──────────────────────────────────────────────


@pytest.mark.parametrize(
    "colado",
    [
        "https://recurso.services.ai.azure.com",
        "https://recurso.services.ai.azure.com/",
        "https://recurso.services.ai.azure.com/models",
        "https://recurso.services.ai.azure.com/models/chat/completions?api-version=2024-05-01",
    ],
)
def test_o_caminho_colado_cai_antes_de_montar_a_url(monkeypatch, colado):
    """O catalogo mora noutra rota do MESMO recurso.

    Sem derrubar o caminho, a URL sairia
    `.../models/openai/deployments` e o recurso responderia 404.
    """
    from kb_api import catalog

    visto = _responder(monkeypatch, {"/openai/deployments": _AZURE})
    catalog.azure_foundry(colado, "segredo")
    assert visto[0]["url"].startswith("https://recurso.services.ai.azure.com/openai/deployments")


def test_endpoint_sem_esquema_e_recusado():
    from kb_api import catalog

    with pytest.raises(catalog.CatalogError):
        catalog.azure_openai("recurso.openai.azure.com", "segredo")


# ── o que a lista promete ─────────────────────────────────────────────────


def test_foundry_sem_rota_de_deployments_cai_para_o_catalogo(monkeypatch):
    """E a promessa muda junto com a rota.

    Devolver `deployments` para uma lista de catalogo faria a tela afirmar que um
    modelo esta publicado quando ele apenas poderia estar.
    """
    from kb_api import catalog

    _responder(
        monkeypatch,
        {"/openai/deployments": 404, "/openai/v1/models": {"data": [{"id": "DeepSeek-V3"}]}},
    )
    origem, modelos = catalog.azure_foundry("https://recurso.services.ai.azure.com", "segredo")

    assert origem == "catalog"
    assert [m.id for m in modelos] == ["DeepSeek-V3"]
    assert "poderia usar" in catalog.EXPLICACAO["catalog"]


def test_erro_que_nao_e_404_nao_vira_fallback(monkeypatch):
    """401 e credencial errada, nao ausencia de rota.

    Cair para o catalogo aqui esconderia o erro real e devolveria uma lista
    vazia como se a conta nao tivesse nada.
    """
    from kb_api import catalog

    _responder(monkeypatch, {"/openai/deployments": 401})
    with pytest.raises(catalog.CatalogError) as erro:
        catalog.azure_foundry("https://recurso.services.ai.azure.com", "segredo")
    assert erro.value.status == 401


def test_toda_origem_tem_explicacao():
    """A frase e propriedade da ROTA, nao da tela: outro cliente precisa da mesma."""
    from kb_api import catalog

    assert set(catalog.EXPLICACAO) == {"deployments", "account", "catalog"}
    assert all(texto.strip() for texto in catalog.EXPLICACAO.values())


# ── leitura da resposta ───────────────────────────────────────────────────


def test_itens_em_value_tambem_sao_lidos(monkeypatch):
    """Algumas rotas do Azure devolvem `value` no lugar de `data`."""
    from kb_api import catalog

    _responder(monkeypatch, {"/openai/deployments": {"value": [{"id": "um"}]}})
    _, modelos = catalog.azure_openai("https://r.openai.azure.com", "k")
    assert [m.id for m in modelos] == ["um"]


def test_repetido_sai_e_a_ordem_ignora_caixa(monkeypatch):
    """Sem `casefold`, todo `GPT-` viria antes de todo `gpt-` e o mesmo modelo
    apareceria em dois lugares da tela."""
    from kb_api import catalog

    _responder(
        monkeypatch,
        {
            "/openai/deployments": {
                "data": [
                    {"id": "gpt-4o"},
                    {"id": "Ada"},
                    {"id": "gpt-4o"},
                    {"id": "zeta"},
                    {"id": "Beta"},
                ]
            }
        },
    )
    _, modelos = catalog.azure_openai("https://r.openai.azure.com", "k")
    assert [m.id for m in modelos] == ["Ada", "Beta", "gpt-4o", "zeta"]


def test_deployment_sem_id_usa_o_modelo_base(monkeypatch):
    """Recurso antigo as vezes so traz `model`."""
    from kb_api import catalog

    _responder(monkeypatch, {"/openai/deployments": {"data": [{"model": "text-embedding-ada-002"}]}})
    _, modelos = catalog.azure_openai("https://r.openai.azure.com", "k")
    assert [m.id for m in modelos] == ["text-embedding-ada-002"]


def test_resposta_que_nao_e_json_vira_erro_claro(monkeypatch):
    from kb_api import catalog

    def falso(request, timeout=None):
        return _RespostaFalsa(b"<html>gateway</html>")

    monkeypatch.setattr(catalog.urllib.request, "urlopen", falso)
    with pytest.raises(catalog.CatalogError) as erro:
        catalog.openai("", "k")
    assert "JSON" in str(erro.value)


def test_falha_de_rede_vira_erro_com_status_zero(monkeypatch):
    """Status 0 distingue "nao cheguei no provedor" de "o provedor recusou" —
    e e o que faz a rota devolver 502 em vez de 401."""
    from kb_api import catalog

    def explode(request, timeout=None):
        raise OSError("connection refused")

    monkeypatch.setattr(catalog.urllib.request, "urlopen", explode)
    with pytest.raises(catalog.CatalogError) as erro:
        catalog.openai("", "k")
    assert erro.value.status == 0


def test_sem_credencial_nem_chega_a_rede():
    from kb_api import catalog

    with pytest.raises(catalog.CatalogError):
        catalog.listar("openai", "", "")


def test_tipo_desconhecido_e_recusado():
    from kb_api import catalog

    with pytest.raises(catalog.CatalogError):
        catalog.listar("bedrock", "https://x", "k")


def test_todo_dialeto_do_projeto_sabe_listar():
    """Acrescentar provedor sem listagem deixaria o botao quebrado so nele."""
    from kb_api import catalog, providers

    assert set(catalog.LISTAGEM) == set(providers.DIALETOS)

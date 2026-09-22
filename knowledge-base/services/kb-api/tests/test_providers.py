"""Provedores de IA: cifra da credencial, dialetos e contador de uso.

Estes testes NAO tocam banco nem rede. O que eles protegem:

1. que a credencial NUNCA seja gravada em claro (o motivo de a coluna existir
   cifrada foi inverter uma regra do projeto — vale ter guarda);
2. que cada dialeto monte a URL e o cabecalho certos — errar aqui devolve 404
   ou 401 do provedor, que manda investigar credencial quando o problema e a
   URL;
3. que o `registrar_uso` nunca levante: telemetria que derruba a busca e pior
   que telemetria ausente.
"""

from __future__ import annotations

import importlib

import pytest


@pytest.fixture
def prov(monkeypatch):
    monkeypatch.setenv("KB_SECRET_KEY", "chave-de-teste-nao-usar-em-producao")
    from kb_api import config as modulo_config

    importlib.reload(modulo_config)
    from kb_api import providers as modulo

    importlib.reload(modulo)
    return modulo


def test_cifra_ida_e_volta(prov):
    original = "sk-uma-credencial-secreta-123"
    cifrada = prov.cifrar(original)
    assert cifrada != original
    assert original not in cifrada
    assert prov.decifrar(cifrada) == original


def test_cifra_nao_e_deterministica(prov):
    # Fernet inclui IV e timestamp: dois textos iguais dao cifras diferentes.
    # Sem isso, dava para saber que dois provedores usam a MESMA chave so
    # olhando o banco.
    assert prov.cifrar("igual") != prov.cifrar("igual")


def test_decifrar_com_outra_chave_falha_claro(prov, monkeypatch):
    cifrada = prov.cifrar("segredo")
    monkeypatch.setenv("KB_SECRET_KEY", "outra-chave-completamente-diferente")
    from kb_api import config as modulo_config

    importlib.reload(modulo_config)
    importlib.reload(prov)
    with pytest.raises(prov.ProviderError, match="KB_SECRET_KEY"):
        prov.decifrar(cifrada)


def test_sem_chave_de_cifra_recusa_gravar(prov, monkeypatch):
    monkeypatch.delenv("KB_SECRET_KEY", raising=False)
    from kb_api import config as modulo_config

    importlib.reload(modulo_config)
    importlib.reload(prov)
    with pytest.raises(prov.ProviderError, match="KB_SECRET_KEY"):
        prov.cifrar("qualquer")


def test_decifrar_vazio_devolve_vazio(prov):
    assert prov.decifrar("") == ""


@pytest.mark.parametrize(
    "kind,esperado_url,esperado_header,modelo_no_corpo",
    [
        (
            "azure_openai",
            "https://r.openai.azure.com/openai/deployments/emb/embeddings?api-version=2024-10-21",
            "api-key",
            False,
        ),
        ("openai", "https://api.openai.com/v1/embeddings", "Authorization", True),
        (
            "azure_foundry",
            "https://r.services.ai.azure.com/models/embeddings?api-version=2024-05-01-preview",
            "api-key",
            True,
        ),
        # LiteLLM: a base e a RAIZ, sem /v1 — o cliente anexa. Mesma convencao
        # do cadastro do agentic-sdlc (ADR-0051).
        ("litellm", "http://litellm.litellm/v1/embeddings", "Authorization", True),
    ],
)
def test_dialetos(prov, kind, esperado_url, esperado_header, modelo_no_corpo):
    dialeto = prov.DIALETOS[kind]
    endpoints = {
        "azure_openai": "https://r.openai.azure.com",
        "openai": "https://api.openai.com/v1",
        "azure_foundry": "https://r.services.ai.azure.com",
        "litellm": "http://litellm.litellm",
    }
    url = dialeto.url_embedding.format(
        endpoint=endpoints[kind],
        model="emb",
        api_version=dialeto.api_version_padrao,
    )
    assert url == esperado_url
    assert dialeto.auth_header == esperado_header
    assert dialeto.modelo_no_corpo is modelo_no_corpo


def test_litellm_esta_registrado(prov):
    # O usuario pediu explicitamente; se sumir do mapa, a tela para de oferecer.
    assert "litellm" in prov.DIALETOS
    assert prov.DIALETOS["litellm"].rotulo.startswith("LiteLLM")


def test_registrar_uso_nunca_levanta(prov, monkeypatch):
    def explode(*_a, **_k):
        raise RuntimeError("banco fora do ar")

    monkeypatch.setattr(prov, "conn", explode)
    # Sem levantar: uma busca nao pode falhar porque a telemetria falhou.
    prov.registrar_uso(None, "search", tokens=10)


def test_padrao_sem_provedor_da_mensagem_acionavel(prov, monkeypatch):
    class CursorFalso:
        def execute(self, *_a, **_k):
            return None

        def fetchone(self):
            return None

        def __enter__(self):
            return self

        def __exit__(self, *_a):
            return False

    class ConexaoFalsa:
        def cursor(self):
            return CursorFalso()

        def __enter__(self):
            return self

        def __exit__(self, *_a):
            return False

    monkeypatch.setattr(prov, "conn", lambda: ConexaoFalsa())
    prov.invalidar()
    with pytest.raises(prov.ProviderError, match="Modelos de IA"):
        prov.padrao("embedding")

"""Por qual endereco o kb-api fala com o Identity.

Estes testes protegem uma falha que aconteceu em PROD (2026-09-17): o login do
conector MCP morria em `/oauth/callback` com "Identity inacessivel". A causa era
uma so funcao servindo a dois usos opostos.

Sao dois enderecos para o MESMO realm, e a escolha nao e estetica:

- o NAVEGADOR precisa do endereco publico -- e o que a pessoa vai seguir, e e o
  host que o Keycloak carimba no claim `iss`;
- o KB-API, de dentro do cluster, precisa do endereco interno -- o publico nao
  resolve ali, e a troca do codigo morre no nivel de rede (um `URLError`), nao
  com uma resposta do Identity.

Trocar um pelo outro quebra em silencio: o login so falha no ultimo passo, com
o codigo valido na mao, e a mensagem nao aponta para a configuracao.
"""

from __future__ import annotations

import base64
import importlib
import json

import pytest

# Fixture, nao configuracao: o host e de exemplo de proposito, para o teste nao
# depender de um Keycloak de pe. O nome do REALM acompanha o configurado
# (`goga-interno`) porque a assercao descreve o realm do produto, e uma fixture
# que nomeia um realm inexistente passa a documentar errado.
PUBLICO = "https://identity.exemplo/realms/goga-interno"
INTERNO = "http://keycloak.identity/realms/goga-interno"


def _carrega(monkeypatch, *, interno: str | None):
    monkeypatch.setenv("KB_SECRET_KEY", "chave-de-teste-nao-usar-em-producao")
    monkeypatch.setenv("KB_KEYCLOAK_ISSUER", PUBLICO)
    if interno is None:
        monkeypatch.delenv("KB_KEYCLOAK_INTERNAL_ISSUER", raising=False)
    else:
        monkeypatch.setenv("KB_KEYCLOAK_INTERNAL_ISSUER", interno)
    from kb_api import config as modulo_config

    importlib.reload(modulo_config)
    from kb_api import oauth as modulo

    importlib.reload(modulo)
    return modulo


@pytest.fixture
def oauth(monkeypatch):
    return _carrega(monkeypatch, interno=INTERNO)


def _token_falso() -> str:
    corpo = base64.urlsafe_b64encode(
        json.dumps({"sub": "s-1", "email": "alguem@exemplo.com"}).encode()
    ).decode().rstrip("=")
    return f"cabecalho.{corpo}.assinatura"


@pytest.fixture
def chamadas(oauth, monkeypatch):
    """Captura a URL chamada, sem deixar nada sair para a rede."""
    vistas: list[str] = []

    class _Resposta:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def read(self):
            return json.dumps({"access_token": _token_falso()}).encode()

    def _falso_urlopen(pedido, timeout=None):
        vistas.append(pedido.full_url)
        return _Resposta()

    monkeypatch.setattr(oauth.urllib.request, "urlopen", _falso_urlopen)
    return vistas


def test_troca_do_codigo_vai_para_o_endereco_interno(oauth, chamadas):
    """O passo que quebrou em PROD: quem chama e o kb-api, nao o navegador."""
    oauth.trocar_codigo_do_identity("um-codigo", "https://hub.exemplo.br/oauth/callback")

    assert chamadas == [f"{INTERNO}/protocol/openid-connect/token"]


def test_renovacao_tambem_vai_pelo_interno(oauth, chamadas):
    """Mesma chamada, mesmo caminho -- senao o refresh morre uma hora depois."""
    oauth.renovar_no_identity("um-refresh")

    assert chamadas == [f"{INTERNO}/protocol/openid-connect/token"]


def test_login_do_navegador_continua_no_endereco_publico(oauth):
    """O contraponto: mandar o navegador para `keycloak.identity` nao resolve.

    E este o teste que impede "consertar" o bug trocando a base nos dois usos.
    """
    url = oauth.identity_authorize_url("estado", "https://hub.exemplo.br/oauth/callback")

    assert url.startswith(f"{PUBLICO}/protocol/openid-connect/auth?")


def test_sem_endereco_interno_cai_no_publico(monkeypatch):
    """Ambiente que nao separa os dois (local, dev offline) segue funcionando."""
    oauth = _carrega(monkeypatch, interno=None)
    vistas: list[str] = []

    class _Resposta:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def read(self):
            return json.dumps({"access_token": _token_falso()}).encode()

    monkeypatch.setattr(
        oauth.urllib.request,
        "urlopen",
        lambda pedido, timeout=None: (vistas.append(pedido.full_url), _Resposta())[1],
    )

    oauth.trocar_codigo_do_identity("um-codigo", "https://hub.exemplo.br/oauth/callback")

    assert vistas == [f"{PUBLICO}/protocol/openid-connect/token"]

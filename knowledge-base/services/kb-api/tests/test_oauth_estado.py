"""O pedido em voo do OAuth: ida e volta pelo `state` assinado.

Estes testes NAO tocam banco nem rede. O que eles protegem e uma falha que ja
aconteceu em PROD (2026-09-16) e que nenhum teste pegava: o pedido vivia num
`dict` de processo, entao o `/authorize` numa replica e o `/callback` na outra
davam "Sessao de login expirada" com um codigo valido na mao.

O selo troca memoria por assinatura. Cada teste aqui e uma propriedade de que
isso depende:

1. o pedido volta INTEIRO -- perder `redirect_uri` ou `code_challenge` no meio
   quebra o PKCE no passo seguinte, longe daqui;
2. adulterar o `redirect_uri` NAO passa -- e o unico campo que um atacante
   quereria mexer, e sem a chave ele nao consegue;
3. o prazo vence -- um link velho parado num historico nao vale para sempre;
4. chave diferente nao abre -- e o que impede um ambiente de virar chave do
   outro.
"""

from __future__ import annotations

import base64
import dataclasses
import importlib
import json

import pytest


@pytest.fixture
def oauth(monkeypatch):
    monkeypatch.setenv("KB_SECRET_KEY", "chave-de-teste-nao-usar-em-producao")
    # Realm da organizacao anterior de proposito: identidade funcional so muda
    # no WP-37 (ver test_oauth_endereco_do_identity.py).
    monkeypatch.setenv("KB_KEYCLOAK_ISSUER", "https://identity.exemplo/realms/goga-interno")
    from kb_api import config as modulo_config

    importlib.reload(modulo_config)
    from kb_api import oauth as modulo

    importlib.reload(modulo)
    return modulo


def _pedido(oauth, **troca):
    campos = {
        "client_id": "kbc_abc123",
        "redirect_uri": "https://claude.ai/api/mcp/auth_callback",
        "state": "5UWQ_UCBsDttCv5N8YaSew3dn3DX-H_0",
        "code_challenge": "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        "resource": "https://hub.exemplo.br/knowledge-base/mcp",
    }
    campos.update(troca)
    return oauth.PedidoAutorizacao(**campos)


def test_pedido_volta_inteiro(oauth):
    original = _pedido(oauth)
    voltou = oauth.abrir_pedido(oauth.selar_pedido(original))
    assert voltou == original


def test_estado_cabe_numa_url(oauth):
    # O selo viaja como query param ate o Identity e de volta. Se crescer demais
    # o problema aparece como 414 no meio do login, longe daqui.
    assert len(oauth.selar_pedido(_pedido(oauth))) < 1024


def test_estado_nao_e_legivel_por_acidente(oauth):
    # Nao e segredo (o cliente MCP ja conhece tudo que vai ali), mas tambem nao
    # deve aparecer em claro num log de acesso.
    assert "claude.ai" not in oauth.selar_pedido(_pedido(oauth))


def test_redirect_adulterado_nao_passa(oauth):
    selado = oauth.selar_pedido(_pedido(oauth))
    carga, _, assinatura = selado.partition(".")
    dados = json.loads(base64.urlsafe_b64decode(carga + "=" * (-len(carga) % 4)))
    dados["u"] = "https://servidor-do-atacante/callback"
    forjada = (
        base64.urlsafe_b64encode(json.dumps(dados, separators=(",", ":"), sort_keys=True).encode())
        .rstrip(b"=")
        .decode()
    )
    assert oauth.abrir_pedido(f"{forjada}.{assinatura}") is None


@pytest.mark.parametrize(
    "estado",
    ["", "sem-ponto", "carga.assinatura-invalida", "!!!.!!!"],
)
def test_lixo_devolve_none_sem_levantar(oauth, estado):
    assert oauth.abrir_pedido(estado) is None


def test_prazo_vence(oauth, monkeypatch):
    selado = oauth.selar_pedido(_pedido(oauth))
    agora = __import__("time").time()
    monkeypatch.setattr(oauth.time, "time", lambda: agora + oauth._ESTADO_TTL_SECONDS + 1)
    assert oauth.abrir_pedido(selado) is None


def _com_chave(oauth, monkeypatch, chave: str) -> None:
    """Troca a KB_SECRET_KEY vista pelo modulo. `Settings` e frozen de proposito."""
    monkeypatch.setattr(oauth, "settings", dataclasses.replace(oauth.settings, secret_key=chave))


def test_chave_de_outro_ambiente_nao_abre(oauth, monkeypatch):
    selado = oauth.selar_pedido(_pedido(oauth))
    _com_chave(oauth, monkeypatch, "a-chave-do-OUTRO-ambiente")
    assert oauth.abrir_pedido(selado) is None


def test_sem_chave_recusa_com_erro_acionavel(oauth, monkeypatch):
    _com_chave(oauth, monkeypatch, "")
    with pytest.raises(oauth.OAuthError) as erro:
        oauth.selar_pedido(_pedido(oauth))
    assert "KB_SECRET_KEY" in erro.value.description
    assert erro.value.status == 500


# ── a prova de que duas replicas fecham o login ────────────────────────────


@pytest.fixture
def app_kb(oauth, monkeypatch):
    """O app de verdade, com o Identity e o banco trocados por dublê.

    Nada de mock no caminho do `state`: e justamente ele que esta sob teste.
    """
    from starlette.testclient import TestClient

    from kb_api import main

    importlib.reload(main)
    monkeypatch.setattr(
        main.oauth,
        "load_client",
        lambda cid: {
            "client_id": cid,
            "client_name": "editor",
            "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
        },
    )
    monkeypatch.setattr(
        main.oauth,
        "trocar_codigo_do_identity",
        lambda codigo, callback: {"subject": "s-1", "email": "alguem@exemplo.com"},
    )
    monkeypatch.setattr(main.oauth, "emitir_codigo", lambda pedido, ident: "kbcode-1")
    return TestClient(main.app, base_url="https://hub.exemplo.br")


def _authorize(app_kb):
    resposta = app_kb.get(
        "/oauth/authorize",
        params={
            "client_id": "kbc_abc123",
            "redirect_uri": "https://claude.ai/api/mcp/auth_callback",
            "response_type": "code",
            "code_challenge": "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            "code_challenge_method": "S256",
            "state": "o-state-do-cliente",
            "resource": "https://hub.exemplo.br/knowledge-base/mcp",
        },
        follow_redirects=False,
    )
    assert resposta.status_code == 302, resposta.text
    from urllib.parse import parse_qs, urlsplit

    destino = resposta.headers["location"]
    assert destino.startswith("https://identity.exemplo/realms/goga-interno/protocol/")
    return parse_qs(urlsplit(destino).query)["state"][0]


def test_callback_em_OUTRA_replica_fecha_o_login(app_kb):
    """A regressao de PROD (2026-09-16), reproduzida.

    O `/authorize` acontece neste app; o `/callback` acontece num app RECEM
    CARREGADO -- que e o que uma segunda replica e, do ponto de vista de memoria
    de processo. Com o `dict` antigo isto devolvia 400 "Sessao de login
    expirada"; com o `state` assinado, fecha.
    """
    from starlette.testclient import TestClient

    from kb_api import main

    estado = _authorize(app_kb)

    # A outra replica: o modulo nasce de novo, sem lembrar de nada. Os dubles
    # ficam de pe porque vivem em `kb_api.oauth`, que nao e recarregado aqui --
    # e o proposito: so a memoria do `main` e zerada.
    importlib.reload(main)
    outra = TestClient(main.app, base_url="https://hub.exemplo.br")

    resposta = outra.get(
        "/oauth/callback",
        params={"code": "codigo-do-identity", "state": estado},
        follow_redirects=False,
    )
    assert resposta.status_code == 302, resposta.text
    destino = resposta.headers["location"]
    assert destino.startswith("https://claude.ai/api/mcp/auth_callback?")
    assert "code=kbcode-1" in destino
    # O `state` DO CLIENTE volta para o cliente -- nao o nosso selo.
    assert "state=o-state-do-cliente" in destino
    assert estado not in destino, "o nosso selo nao vaza para o cliente"


def test_callback_com_state_forjado_continua_recusando(app_kb):
    resposta = app_kb.get(
        "/oauth/callback",
        params={"code": "codigo-do-identity", "state": "nao-fui-eu-que-emiti"},
        follow_redirects=False,
    )
    assert resposta.status_code == 400
    assert "expirada" in resposta.text

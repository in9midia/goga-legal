"""O kb-api como Authorization Server do próprio MCP, federando ao Identity.

POR QUE ISSO EXISTE

Conector de MCP moderno espera uma coisa só: **cole a URL e clique em Entrar**.
O cliente descobre o servidor de autorização, se registra sozinho e leva a
pessoa ao login. Ninguém cola token em conversa nem edita JSON.

A alternativa que existia aqui — token pessoal colado num arquivo — falhava por
três motivos concretos, e nenhum deles era teórico:

* o token vazava para o **histórico da conversa**, que pode ser sincronizado;
* o Claude Desktop **não consegue** editar o arquivo: ele executa comando em
  container isolado e efêmero, sem acesso à máquina de quem pediu;
* pedir caminho de arquivo a quem só quer usar a base é jogar para o usuário um
  problema que é nosso.

POR QUE O kb-api É O AUTHORIZATION SERVER, E NÃO O IDENTITY

Apontar o cliente MCP direto para o Identity exigiria habilitar *Dynamic Client
Registration* (RFC 7591) no realm **compartilhado** — decisão de infraestrutura
que afeta todo mundo que usa aquele realm.

Aqui o kb-api implementa a superfície OAuth e **federa o login**: a pessoa
autentica de verdade no Identity, com o client que já existe, e quem emite o
token do MCP somos nós. Nada muda no realm.

O QUE ISSO MELHORA EM RELAÇÃO AO TOKEN PESSOAL

O `kc_refresh` (refresh token do Identity) fica **só no servidor** e é usado a
cada renovação para reler a identidade. Consequência: os grupos deixam de ser
uma fotografia do dia do login — a cada hora eles voltam do Identity. Desativar
a pessoa lá corta o acesso na renovação seguinte.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import secrets
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from .config import settings
from .db import conn, jsonb

log = logging.getLogger(__name__)

# Prefixos reconhecíveis. Quem encontra a string sabe de onde é, e um scanner de
# segredo pode ter uma regra por prefixo.
ACCESS_PREFIX = "kba_"
REFRESH_PREFIX = "kbr_"

CODE_TTL_SECONDS = 300
ACCESS_TTL_SECONDS = 3600
REFRESH_TTL_DAYS = 30


def _sha(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _now() -> datetime:
    return datetime.now(UTC)


# ── metadados de descoberta ────────────────────────────────────────────────


def protected_resource_metadata(base: str) -> dict[str, Any]:
    """RFC 9728. É o que o cliente busca depois de tomar 401 do `/mcp`."""
    return {
        "resource": f"{base}/mcp",
        "authorization_servers": [base],
        "bearer_methods_supported": ["header"],
        "scopes_supported": ["kb.read"],
    }


def authorization_server_metadata(base: str) -> dict[str, Any]:
    """RFC 8414. Diz ao cliente onde registrar, autorizar e trocar o código."""
    return {
        "issuer": base,
        "authorization_endpoint": f"{base}/oauth/authorize",
        "token_endpoint": f"{base}/oauth/token",
        "registration_endpoint": f"{base}/oauth/register",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "token_endpoint_auth_methods_supported": ["none"],
        # S256 e nada mais. `plain` existe no padrão e não protege de nada: o
        # verifier viaja igual ao challenge.
        "code_challenge_methods_supported": ["S256"],
        "scopes_supported": ["kb.read"],
        "service_documentation": f"{base}/conectar",
    }


# ── registro dinâmico de cliente (RFC 7591) ────────────────────────────────


class OAuthError(RuntimeError):
    def __init__(self, code: str, description: str, status: int = 400):
        super().__init__(description)
        self.code = code
        self.description = description
        self.status = status


def _redirect_permitida(uri: str) -> bool:
    """Só loopback e HTTPS.

    Registro é aberto (o padrão do MCP conta com isso), então a validação de
    redirect é a defesa que sobra: sem ela, alguém registra um cliente com
    redirect para um servidor próprio e recebe o código de quem clicar no link.
    """
    try:
        partes = urllib.parse.urlsplit(uri)
    except ValueError:
        return False
    if partes.scheme == "https":
        return True
    if partes.scheme == "http" and partes.hostname in ("127.0.0.1", "localhost", "::1"):
        return True
    # Esquema próprio de aplicativo desktop (ex.: cursor://, claude://).
    return bool(partes.scheme) and partes.scheme not in ("http", "javascript", "data")


def register_client(payload: dict[str, Any]) -> dict[str, Any]:
    uris = [str(u) for u in (payload.get("redirect_uris") or []) if u]
    if not uris:
        raise OAuthError("invalid_redirect_uri", "informe ao menos um redirect_uri")
    invalidas = [u for u in uris if not _redirect_permitida(u)]
    if invalidas:
        raise OAuthError(
            "invalid_redirect_uri",
            f"redirect_uri nao permitida: {invalidas[0]} (use https ou loopback)",
        )

    client_id = "kbc_" + secrets.token_urlsafe(18)
    nome = str(payload.get("client_name") or "cliente MCP")[:120]
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            "INSERT INTO oauth_client (client_id, client_name, redirect_uris) VALUES (%s,%s,%s)",
            (client_id, nome, jsonb(uris)),
        )
        connection.commit()
    log.info("cliente OAuth registrado: %s (%s)", client_id, nome)
    return {
        "client_id": client_id,
        "client_name": nome,
        "redirect_uris": uris,
        # Cliente público: sem segredo. O que protege a troca é o PKCE.
        "token_endpoint_auth_method": "none",
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "client_id_issued_at": int(time.time()),
    }


def load_client(client_id: str) -> dict[str, Any] | None:
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            "SELECT client_id, client_name, redirect_uris FROM oauth_client WHERE client_id = %s",
            (client_id,),
        )
        linha = cur.fetchone()
    if linha is None:
        return None
    return {"client_id": linha[0], "client_name": linha[1], "redirect_uris": linha[2] or []}


# ── autorização: manda para o Identity e volta ─────────────────────────────


@dataclass
class PedidoAutorizacao:
    client_id: str
    redirect_uri: str
    state: str
    code_challenge: str
    resource: str


# ── o pedido em voo, do /authorize ate o /callback ─────────────────────────
#
# POR QUE ISTO E ASSINADO E NAO GUARDADO
#
# Entre o `/authorize` e o `/callback` ha um desvio pelo Identity: a pessoa sai
# daqui, loga la, e volta. Alguem precisa lembrar o que o cliente MCP tinha
# pedido (redirect_uri, o `state` DELE, o PKCE) enquanto isso acontece.
#
# A primeira versao lembrava num `dict` de processo. Isso funciona com UMA
# replica e falha com duas, de um jeito que parece intermitente e nao e: o
# `/authorize` cai numa replica, o `/callback` volta na outra, o dicionario de
# la nao tem a chave e a pessoa recebe "Sessao de login expirada" com um codigo
# perfeitamente valido na mao. Aconteceu em PROD (2026-09-16), onde o kb-api
# roda com duas replicas atras de round-robin sem afinidade nenhuma.
#
# A saida podia ser uma tabela, como o `oauth_code` ao lado. Nao e preciso: o
# proprio parametro `state` que mandamos ao Identity volta intacto, entao ele
# carrega o pedido inteiro, selado com HMAC. Nenhuma replica precisa lembrar de
# nada, nao ha linha para expirar nem job para limpar, e o numero de replicas
# deixa de ser uma condicao de corretude.
#
# O QUE O SELO GARANTE, E O QUE NAO GARANTE
#
# Garante INTEGRIDADE: sem a chave ninguem forja um `state` que aponte o
# redirect para outro lugar -- que e o unico campo que um atacante quereria
# mexer. Nao ha segredo no conteudo (o cliente MCP ja conhece tudo que vai
# ali), entao cifrar seria teatro; por isso assinado e nao cifrado.
#
# NAO garante uso unico -- o `dict.pop()` garantia de graca. Nao faz falta: o
# que se trocaria por token e o `code` do Identity, e esse ja e de uso unico
# DO LADO DE LA. Repetir o mesmo `state` com o mesmo `code` toma `invalid_grant`
# do Identity; repetir com `code` de outra pessoa exige ter esse codigo, e quem
# tem nao precisa do replay.

_ESTADO_TTL_SECONDS = 600


def _chave_do_estado() -> bytes:
    """Chave de assinatura derivada da KB_SECRET_KEY, com rotulo proprio.

    Rotulo (`kb-oauth-state`) para que esta chave NAO seja a mesma que cifra a
    credencial de provedor em `providers.py`, ainda que as duas nasçam do mesmo
    segredo do ambiente. Uma falha no uso de uma nao vira material para a outra.
    """
    if not settings.secret_key:
        raise OAuthError(
            "temporarily_unavailable",
            "KB_SECRET_KEY nao configurada. Ela assina o estado do login OAuth; "
            "sem ela nao ha como fechar o fluxo. Gere com: openssl rand -hex 32",
            status=500,
        )
    return hashlib.sha256(b"kb-oauth-state\x00" + settings.secret_key.encode()).digest()


def _b64u(bruto: bytes) -> bytes:
    return base64.urlsafe_b64encode(bruto).rstrip(b"=")


def _de_b64u(texto: str) -> bytes:
    return base64.urlsafe_b64decode(texto + "=" * (-len(texto) % 4))


def selar_pedido(pedido: PedidoAutorizacao) -> str:
    """O pedido inteiro como um `state` opaco, assinado e datado."""
    corpo = json.dumps(
        {
            "c": pedido.client_id,
            "u": pedido.redirect_uri,
            "s": pedido.state,
            "h": pedido.code_challenge,
            "r": pedido.resource,
            "t": int(time.time()),
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    carga = _b64u(corpo)
    assinatura = _b64u(hmac.new(_chave_do_estado(), carga, hashlib.sha256).digest())
    return (carga + b"." + assinatura).decode()


def abrir_pedido(estado: str) -> PedidoAutorizacao | None:
    """O pedido de volta, ou None se o selo nao confere ou o prazo venceu."""
    if not estado or "." not in estado:
        return None
    carga, _, assinatura = estado.partition(".")
    esperada = _b64u(hmac.new(_chave_do_estado(), carga.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(assinatura.encode(), esperada):
        return None
    try:
        dados = json.loads(_de_b64u(carga))
    except (ValueError, TypeError):
        return None
    # O prazo e do PEDIDO, nao da sessao do Identity: dez minutos e folga de
    # sobra para digitar senha e passar pelo MFA, e curto o bastante para que um
    # link velho parado num historico nao continue valendo.
    if int(time.time()) - int(dados.get("t", 0)) > _ESTADO_TTL_SECONDS:
        return None
    return PedidoAutorizacao(
        client_id=str(dados.get("c", "")),
        redirect_uri=str(dados.get("u", "")),
        state=str(dados.get("s", "")),
        code_challenge=str(dados.get("h", "")),
        resource=str(dados.get("r", "")),
    )


def _identity_base() -> str:
    """Base do realm no Identity para o NAVEGADOR.

    E o endereco publico, de proposito: o que sai daqui vira URL que a pessoa
    vai seguir no navegador, e e o host que o Keycloak carimba no claim `iss`.
    """
    return settings.oidc_issuer.rstrip("/")


def _identity_base_interno() -> str:
    """Base do realm para as chamadas que o PROPRIO kb-api faz.

    O token endpoint e chamado de dentro do cluster, nao pelo navegador. Ali o
    endereco publico do Identity pode nao resolver -- em PROD nao resolve, e a
    troca do codigo morria com `Identity inacessivel`. Mesmo criterio que a
    descoberta/JWKS em auth.py ja usava; cai no publico quando nao ha endereco
    interno configurado.
    """
    return settings.oidc_discovery_base


def identity_authorize_url(estado_interno: str, callback: str) -> str:
    """URL de login no Identity.

    `offline_access` é pedido de propósito: sem ele o refresh do Identity morre
    junto com a sessão SSO (30 min ociosos, por padrão), e um conector usado uma
    vez por semana pediria login toda vez. Se o realm não conceder, a renovação
    falha e a pessoa refaz o login — degrada, não quebra.
    """
    parametros = {
        "client_id": settings.oidc_client_id,
        "response_type": "code",
        "redirect_uri": callback,
        "scope": "openid profile email offline_access",
        "state": estado_interno,
    }
    return f"{_identity_base()}/protocol/openid-connect/auth?{urllib.parse.urlencode(parametros)}"


def _identity_token(dados: dict[str, str]) -> dict[str, Any]:
    corpo = urllib.parse.urlencode(dados).encode()
    pedido = urllib.request.Request(
        f"{_identity_base_interno()}/protocol/openid-connect/token",
        data=corpo,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(pedido, timeout=20) as resposta:
            return json.loads(resposta.read().decode())
    except urllib.error.HTTPError as exc:
        detalhe = exc.read().decode("utf-8", "replace")[:200]
        raise OAuthError("invalid_grant", f"o Identity recusou: {detalhe}") from None
    except Exception as exc:  # noqa: BLE001
        raise OAuthError("temporarily_unavailable", f"Identity inacessivel: {exc}") from None


def _claims_sem_verificar(token: str) -> dict[str, Any]:
    """Claims do token que o PRÓPRIO Identity acabou de nos entregar.

    A assinatura não é reconferida aqui de propósito: este token veio por TLS
    direto do token endpoint, numa troca que nós iniciamos e cujo código só nós
    tínhamos. Verificar de novo protegeria contra um atacante que já controla a
    conexão com o Identity — nesse cenário nada mais importa.

    O token que chega de FORA (o do navegador, em auth.py) continua verificado,
    porque lá a origem é o cliente.
    """
    corpo = token.split(".")[1]
    corpo += "=" * (-len(corpo) % 4)
    return json.loads(base64.urlsafe_b64decode(corpo))


def _identidade(tokens: dict[str, Any]) -> dict[str, Any]:
    from .auth import _groups_from_claims, _roles_from_claims  # import tardio: ciclo

    claims = _claims_sem_verificar(tokens["access_token"])
    return {
        "subject": str(claims.get("sub") or ""),
        "email": str(claims.get("email") or "").lower(),
        "entra_oid": str(claims.get("oid") or claims.get("entra_oid") or ""),
        "groups": _groups_from_claims(claims),
        "roles": _roles_from_claims(claims),
        "kc_refresh": str(tokens.get("refresh_token") or ""),
    }


def trocar_codigo_do_identity(codigo: str, callback: str) -> dict[str, Any]:
    tokens = _identity_token(
        {
            "grant_type": "authorization_code",
            "client_id": settings.oidc_client_id,
            "code": codigo,
            "redirect_uri": callback,
        }
    )
    return _identidade(tokens)


def renovar_no_identity(kc_refresh: str) -> dict[str, Any] | None:
    """Relê a identidade no Identity. None quando o refresh não vale mais.

    É este passo que faz os grupos deixarem de ser uma fotografia: a cada
    renovação (uma hora) eles voltam do Identity. Pessoa desativada lá perde o
    acesso aqui na renovação seguinte.
    """
    if not kc_refresh:
        return None
    try:
        tokens = _identity_token(
            {
                "grant_type": "refresh_token",
                "client_id": settings.oidc_client_id,
                "refresh_token": kc_refresh,
            }
        )
    except OAuthError as exc:
        log.info("refresh no Identity falhou (%s); mantendo a identidade anterior", exc.code)
        return None
    return _identidade(tokens)


# ── código de autorização nosso ────────────────────────────────────────────


def emitir_codigo(pedido: PedidoAutorizacao, identidade: dict[str, Any]) -> str:
    codigo = secrets.token_urlsafe(32)
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            INSERT INTO oauth_code
                (code_sha, client_id, redirect_uri, code_challenge, resource,
                 subject, email, entra_oid, groups, roles, kc_refresh, expires_at)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            """,
            (
                _sha(codigo), pedido.client_id, pedido.redirect_uri, pedido.code_challenge,
                pedido.resource, identidade["subject"], identidade["email"],
                identidade["entra_oid"], jsonb(identidade["groups"]),
                jsonb(identidade["roles"]), identidade["kc_refresh"],
                _now() + timedelta(seconds=CODE_TTL_SECONDS),
            ),
        )
        connection.commit()
    return codigo


def _consumir_codigo(codigo: str, client_id: str, redirect_uri: str, verifier: str) -> dict[str, Any]:
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            SELECT client_id, redirect_uri, code_challenge, subject, email, entra_oid,
                   groups, roles, kc_refresh, expires_at, used_at
              FROM oauth_code WHERE code_sha = %s
            """,
            (_sha(codigo),),
        )
        linha = cur.fetchone()
        if linha is None:
            raise OAuthError("invalid_grant", "codigo desconhecido")
        # Uso único, marcado na MESMA transação da leitura: dois resgates
        # simultâneos do mesmo código não podem virar duas sessões.
        if linha[10] is not None:
            raise OAuthError("invalid_grant", "este codigo ja foi usado")
        if linha[9] < _now():
            raise OAuthError("invalid_grant", "codigo expirado")
        if linha[0] != client_id:
            raise OAuthError("invalid_grant", "codigo emitido para outro cliente")
        if linha[1] != redirect_uri:
            raise OAuthError("invalid_grant", "redirect_uri diferente da autorizacao")

        # PKCE: S256 do verifier tem de bater com o challenge guardado.
        digest = hashlib.sha256(verifier.encode()).digest()
        calculado = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
        if not hmac.compare_digest(calculado, linha[2]):
            raise OAuthError("invalid_grant", "code_verifier nao confere")

        cur.execute("UPDATE oauth_code SET used_at = now() WHERE code_sha = %s", (_sha(codigo),))
        connection.commit()

    return {
        "subject": linha[3], "email": linha[4], "entra_oid": linha[5],
        "groups": linha[6] or [], "roles": linha[7] or [], "kc_refresh": linha[8],
    }


# ── emissão e renovação dos nossos tokens ──────────────────────────────────


def _gravar_par(grant_id: int | None, client_id: str, client_name: str,
                identidade: dict[str, Any]) -> dict[str, Any]:
    acesso = ACCESS_PREFIX + secrets.token_urlsafe(32)
    renovacao = REFRESH_PREFIX + secrets.token_urlsafe(32)
    expira_acesso = _now() + timedelta(seconds=ACCESS_TTL_SECONDS)
    expira_renovacao = _now() + timedelta(days=REFRESH_TTL_DAYS)

    with conn() as connection, connection.cursor() as cur:
        if grant_id is None:
            cur.execute(
                """
                INSERT INTO oauth_grant
                    (client_id, client_name, subject, email, entra_oid, groups, roles,
                     kc_refresh, access_sha, refresh_sha, access_expires_at, refresh_expires_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                (
                    client_id, client_name, identidade["subject"], identidade["email"],
                    identidade["entra_oid"], jsonb(identidade["groups"]),
                    jsonb(identidade["roles"]), identidade["kc_refresh"],
                    _sha(acesso), _sha(renovacao), expira_acesso, expira_renovacao,
                ),
            )
        else:
            cur.execute(
                """
                UPDATE oauth_grant
                   SET groups = %s, roles = %s, kc_refresh = %s,
                       access_sha = %s, refresh_sha = %s,
                       access_expires_at = %s, refresh_expires_at = %s, last_used_at = now()
                 WHERE id = %s
                """,
                (
                    jsonb(identidade["groups"]), jsonb(identidade["roles"]),
                    identidade["kc_refresh"], _sha(acesso), _sha(renovacao),
                    expira_acesso, expira_renovacao, grant_id,
                ),
            )
        connection.commit()

    return {
        "access_token": acesso,
        "token_type": "Bearer",
        "expires_in": ACCESS_TTL_SECONDS,
        # Rotação: o refresh antigo deixa de valer no mesmo instante. Um refresh
        # reutilizado é sinal de vazamento, e com rotação ele simplesmente falha.
        "refresh_token": renovacao,
        "scope": "kb.read",
    }


def trocar_codigo(codigo: str, client_id: str, redirect_uri: str, verifier: str) -> dict[str, Any]:
    cliente = load_client(client_id)
    if cliente is None:
        raise OAuthError("invalid_client", "cliente desconhecido")
    identidade = _consumir_codigo(codigo, client_id, redirect_uri, verifier)
    return _gravar_par(None, client_id, cliente["client_name"], identidade)


def renovar(refresh: str, client_id: str) -> dict[str, Any]:
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            SELECT id, client_id, client_name, subject, email, entra_oid, groups, roles,
                   kc_refresh, refresh_expires_at, revoked_at
              FROM oauth_grant WHERE refresh_sha = %s
            """,
            (_sha(refresh),),
        )
        linha = cur.fetchone()
    if linha is None:
        raise OAuthError("invalid_grant", "refresh token desconhecido ou ja rotacionado")
    if linha[10] is not None:
        raise OAuthError("invalid_grant", "esta conexao foi revogada")
    if linha[9] is not None and linha[9] < _now():
        raise OAuthError("invalid_grant", "refresh token expirado; entre de novo")
    if client_id and linha[1] != client_id:
        raise OAuthError("invalid_grant", "refresh token de outro cliente")

    anterior = {
        "subject": linha[3], "email": linha[4], "entra_oid": linha[5],
        "groups": linha[6] or [], "roles": linha[7] or [], "kc_refresh": linha[8],
    }
    # Relê a identidade no Identity. Falhando, segue com a anterior em vez de
    # derrubar a conexão: perder acesso por instabilidade de rede seria pior que
    # uma hora de grupo defasado -- e o refresh do Identity tem prazo próprio,
    # então isso não se estende para sempre.
    atual = renovar_no_identity(anterior["kc_refresh"]) or anterior
    return _gravar_par(linha[0], linha[1], linha[2], atual)


# ── verificação do access token nas requisições ────────────────────────────


def resolve_access(token: str) -> dict[str, Any] | None:
    """Identidade por trás de um access token nosso, ou None."""
    if not token.startswith(ACCESS_PREFIX):
        return None
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            SELECT id, subject, email, entra_oid, groups, roles,
                   access_expires_at, revoked_at, client_name
              FROM oauth_grant WHERE access_sha = %s
            """,
            (_sha(token),),
        )
        linha = cur.fetchone()
    if linha is None:
        return None
    if linha[7] is not None:
        raise OAuthError("invalid_token", "esta conexao foi revogada", status=401)
    if linha[6] is not None and linha[6] < _now():
        raise OAuthError("invalid_token", "access token expirado", status=401)

    try:
        with conn() as connection, connection.cursor() as cur:
            cur.execute("UPDATE oauth_grant SET last_used_at = now() WHERE id = %s", (linha[0],))
            connection.commit()
    except Exception:  # noqa: BLE001 - carimbo nunca recusa a requisicao
        pass

    return {
        "grant_id": linha[0], "subject": linha[1], "email": linha[2],
        "entra_oid": linha[3], "groups": linha[4] or [], "roles": linha[5] or [],
        "client_name": linha[8],
    }


# ── as conexões, para a pessoa ver e revogar ───────────────────────────────


def listar_conexoes(subject: str, email: str) -> list[dict[str, Any]]:
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            SELECT id, client_name, groups, created_at, last_used_at,
                   refresh_expires_at, revoked_at
              FROM oauth_grant
             WHERE (subject = %s AND subject <> '') OR (email = %s AND email <> '')
             ORDER BY created_at DESC
            """,
            (subject, email.lower()),
        )
        linhas = cur.fetchall()
    return [
        {
            "id": r[0], "client_name": r[1], "groups": r[2] or [],
            "created_at": r[3].isoformat() if r[3] else None,
            "last_used_at": r[4].isoformat() if r[4] else None,
            "expires_at": r[5].isoformat() if r[5] else None,
            "revoked": r[6] is not None,
        }
        for r in linhas
    ]


def revogar_conexao(grant_id: int, subject: str, email: str) -> bool:
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            UPDATE oauth_grant
               SET revoked_at = now(), access_sha = NULL, refresh_sha = NULL, kc_refresh = ''
             WHERE id = %s AND revoked_at IS NULL
               AND ((subject = %s AND subject <> '') OR (email = %s AND email <> ''))
            """,
            (grant_id, subject, email.lower()),
        )
        alterou = cur.rowcount > 0
        connection.commit()
    return alterou

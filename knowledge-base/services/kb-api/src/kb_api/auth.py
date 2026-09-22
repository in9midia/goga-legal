"""Autenticacao OIDC (Keycloak) e resolucao dos Espacos permitidos.

O requisito FUN-08 e explicito: **todo** acesso a conteudo e filtrado pelos
Espacos permitidos do chamador, aplicado no servidor, antes de qualquer metodo de
acesso, e nao contornavel por parametro. Aqui isso e uma unica funcao --
`principal.allowed_spaces()` -- e todo caminho de leitura passa por ela. O
parametro `spaces` da busca so consegue REDUZIR esse conjunto; nunca aumentar.

A ponte de identidade segue o agentic-sdlc: o JWT do Keycloak traz
- `groups`  -> grupos do realm, federados do EntraID
- `oid`     -> object id do EntraID (a ponte de conta)
- `email`   -> ultimo recurso de vinculo
e os tres sao consultados em `space_grant`. Assim uma pessoa pode ganhar acesso
por grupo (o caminho normal) ou nominalmente pelo object id, sem depender de
grupo novo no Identity.

A validacao do JWT usa a JWKS do issuer, com cache. Sem `KB_KEYCLOAK_ISSUER` a
auth fica desligada e tudo e permitido -- mesmo comportamento do agentic-sdlc em
dev offline, e o motivo pelo qual o ambiente local sobe sem Identity.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any

from . import oauth, tokens
from .config import settings
from .db import conn

log = logging.getLogger(__name__)

_jwks_cache: dict[str, Any] = {"fetched_at": 0.0, "keys": {}}
JWKS_TTL_SECONDS = 600


class AuthError(RuntimeError):
    def __init__(self, message: str, status: int = 401) -> None:
        super().__init__(message)
        self.status = status


# ── principal ──────────────────────────────────────────────────────────────


@dataclass
class Principal:
    subject: str = "anonymous"
    email: str = ""
    # object id do EntraID, quando o Keycloak federa a conta
    entra_oid: str = ""
    groups: list[str] = field(default_factory=list)
    # Roles do realm e do client. Ficam SEPARADAS dos grupos de proposito: num
    # realm corporativo os dois sao namespaces diferentes, e tratar role como
    # grupo faria um grant para o grupo `/goga/curadoria` ser satisfeito por
    # uma role chamada `goga/curadoria`. Grant de role existe, e explicito:
    # principal_type = 'role'.
    roles: list[str] = field(default_factory=list)
    # True quando a auth esta desligada (dev offline) ou o principal e admin
    unrestricted: bool = False
    source: str = "anonymous"

    def allowed_spaces(self) -> list[str] | None:
        """Slugs que este chamador alcanca. None = todos (sem restricao).

        Consulta todos os tipos de vinculo de uma vez: grupo, role, object id
        do EntraID e e-mail, mais os Espacos marcados como publicos.
        """
        if self.unrestricted:
            return None

        principals: list[tuple[str, str]] = [("public", "")]
        principals += [("group", group) for group in self.groups]
        principals += [("role", role) for role in self.roles]
        if self.entra_oid:
            principals.append(("entra_oid", self.entra_oid))
        if self.email:
            principals.append(("email", self.email.lower()))

        with conn() as connection, connection.cursor() as cur:
            cur.execute(
                """
                SELECT DISTINCT g.space_slug
                  FROM space_grant g
                  JOIN space s ON s.slug = g.space_slug AND s.active
                 WHERE (g.principal_type, g.principal_id) IN (
                       SELECT unnest(%s::text[]), unnest(%s::text[])
                 )
                """,
                (
                    [kind for kind, _ in principals],
                    [value for _, value in principals],
                ),
            )
            return sorted(row[0] for row in cur.fetchall())

    def describe(self) -> str:
        return f"{self.source}:{self.email or self.subject}"


# ── JWT ────────────────────────────────────────────────────────────────────


def _b64url(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def _internal_url(url: str) -> str:
    """Traz uma URL do discovery para o endereco interno do issuer.

    O Keycloak publica no discovery as URLs de FRENTE -- as que o navegador
    usa. Aqui dentro do cluster elas nao servem: `localhost:8890` e este proprio
    pod. Quando existe um endereco interno configurado, so o esquema e o host
    sao trocados; o caminho vem do discovery, para nao codificar o layout de
    rotas de um produto de identidade especifico.
    """
    if not settings.oidc_internal_issuer:
        return url
    internal = urllib.parse.urlsplit(settings.oidc_internal_issuer)
    return urllib.parse.urlsplit(url)._replace(
        scheme=internal.scheme, netloc=internal.netloc
    ).geturl()


def _fetch_jwks() -> dict[str, Any]:
    now = time.time()
    if _jwks_cache["keys"] and now - _jwks_cache["fetched_at"] < JWKS_TTL_SECONDS:
        return _jwks_cache["keys"]

    discovery = f"{settings.oidc_discovery_base}/.well-known/openid-configuration"
    with urllib.request.urlopen(discovery, timeout=15) as response:
        config = json.loads(response.read().decode())
    with urllib.request.urlopen(_internal_url(config["jwks_uri"]), timeout=15) as response:
        jwks = json.loads(response.read().decode())

    keys = {key["kid"]: key for key in jwks.get("keys", []) if key.get("kid")}
    _jwks_cache.update({"fetched_at": now, "keys": keys})
    return keys


def _verify_rs256(header: dict, signing_input: bytes, signature: bytes) -> None:
    """Verifica RS256 sem dependencia de biblioteca de cripto.

    PKCS#1 v1.5 com chave publica e exponenciacao modular mais comparacao do
    DigestInfo -- verificacao pura, sem dependencia de biblioteca de cripto
    alem do que a stdlib ja oferece.
    """
    keys = _fetch_jwks()
    key = keys.get(header.get("kid", ""))
    if key is None:
        # Chave nova no realm: invalida o cache e tenta de novo antes de recusar.
        _jwks_cache["keys"] = {}
        keys = _fetch_jwks()
        key = keys.get(header.get("kid", ""))
    if key is None:
        raise AuthError("o token foi assinado por uma chave que o issuer nao publica")

    modulus = int.from_bytes(_b64url(key["n"]), "big")
    exponent = int.from_bytes(_b64url(key["e"]), "big")
    size = (modulus.bit_length() + 7) // 8

    recovered = pow(int.from_bytes(signature, "big"), exponent, modulus).to_bytes(size, "big")
    digest = hashlib.sha256(signing_input).digest()
    # DigestInfo de SHA-256 em DER, prefixo fixo da especificacao.
    der = bytes.fromhex("3031300d060960864801650304020105000420") + digest
    expected = b"\x00\x01" + b"\xff" * (size - len(der) - 3) + b"\x00" + der
    if not hmac.compare_digest(recovered, expected):
        raise AuthError("assinatura do token invalida")


def _claims_from_jwt(token: str) -> dict[str, Any]:
    parts = token.split(".")
    if len(parts) != 3:
        raise AuthError("token nao e um JWT de tres partes")
    header = json.loads(_b64url(parts[0]))
    payload = json.loads(_b64url(parts[1]))

    algorithm = header.get("alg")
    if algorithm != "RS256":
        raise AuthError(f"algoritmo {algorithm} nao aceito; o realm deve usar RS256")

    _verify_rs256(header, f"{parts[0]}.{parts[1]}".encode(), _b64url(parts[2]))

    now = time.time()
    if payload.get("exp") and now > float(payload["exp"]) + 30:
        raise AuthError("token expirado")
    issuer = (payload.get("iss") or "").rstrip("/")
    if issuer != settings.oidc_issuer.rstrip("/"):
        raise AuthError(f"issuer inesperado: {issuer}")
    if settings.oidc_audience:
        audience = payload.get("aud")
        allowed = audience if isinstance(audience, list) else [audience]
        if settings.oidc_audience not in allowed:
            raise AuthError("audience do token nao corresponde ao configurado")
    return payload


# ── admins gravados na aplicacao ───────────────────────────────────────────

_admin_cache: dict[str, Any] = {"fetched_at": 0.0, "rules": []}
ADMIN_TTL_SECONDS = 30


def invalidate_admin_cache() -> None:
    """Chamado pelo caminho de escrita: promover alguem tem de valer agora.

    Sem isso, quem acabou de ganhar admin continuaria vendo 403 por meio minuto
    -- e a conclusao seria "a tela nao funciona", nao "o cache nao expirou".
    """
    _admin_cache["fetched_at"] = 0.0


def admin_rules() -> list[tuple[str, str]]:
    """Regras de admin gravadas em `kb_admin`, com cache curto.

    Cache porque isto e consultado em TODA requisicao autenticada e a tabela e
    minuscula e quase imutavel. TTL de 30s em vez de cache eterno porque a
    alternativa seria reiniciar o pod para uma mudanca de permissao valer.
    """
    now = time.time()
    if _admin_cache["rules"] and now - _admin_cache["fetched_at"] < ADMIN_TTL_SECONDS:
        return _admin_cache["rules"]
    try:
        with conn() as connection, connection.cursor() as cur:
            cur.execute("SELECT principal_type, principal_id FROM kb_admin")
            rules = [(row[0], row[1]) for row in cur.fetchall()]
    except Exception as exc:  # noqa: BLE001
        # Banco fora do ar nao pode virar "todo mundo e admin" nem derrubar a
        # autenticacao: cai para "nenhuma regra extra", que e o comportamento
        # anterior a esta tabela existir.
        log.warning("nao consegui ler kb_admin (%s); seguindo so com o grupo", exc)
        return []
    _admin_cache.update({"fetched_at": now, "rules": rules})
    return rules


def _as_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def _groups_from_claims(claims: dict[str, Any]) -> list[str]:
    """Grupos do token, no formato de caminho do Keycloak (`/goga/curadoria`).

    So o claim `groups` (e a variante singular) conta aqui. Role NAO entra:
    ver o comentario do campo `roles` em Principal.

    Se o claim vier vazio num realm que tem grupos, o mapper de group
    membership nao esta no client -- e sem ele o chamador chega sem grupo e
    nenhum Espaco e alcancavel. E o caso do client novo no Identity: ver
    infra/identity/configure-client.sh.
    """
    found = _as_list(claims.get("groups")) + _as_list(claims.get("group"))
    # O Keycloak manda o caminho completo com a barra; normaliza o resto para a
    # mesma forma, senao um grant escrito como `/RH` nao casaria com `RH`.
    return sorted({item if item.startswith("/") else f"/{item}" for item in found})


def _roles_from_claims(claims: dict[str, Any]) -> list[str]:
    """Roles do realm e de cada client, sem prefixo de caminho.

    As de client vem qualificadas (`realm-management:manage-users`) para duas
    roles homonimas de clients diferentes nao virarem a mesma coisa.
    """
    found = _as_list((claims.get("realm_access") or {}).get("roles"))
    found += _as_list(claims.get("roles"))
    resource = claims.get("resource_access")
    if isinstance(resource, dict):
        for client, payload in resource.items():
            if isinstance(payload, dict):
                found += [f"{client}:{role}" for role in _as_list(payload.get("roles"))]
    return sorted(set(found))


# ── entrada ────────────────────────────────────────────────────────────────


def principal_from_authorization(header: str | None) -> Principal:
    """Resolve o chamador a partir do header Authorization."""
    token = ""
    if header:
        parts = header.split(None, 1)
        token = parts[1].strip() if len(parts) == 2 and parts[0].lower() == "bearer" else header.strip()

    # 1. Token de servico: caminho dos harnesses de IA, que nao fazem OIDC.
    if settings.service_token and token and hmac.compare_digest(token, settings.service_token):
        groups = settings.service_token_groups
        return Principal(
            subject="service-token",
            groups=groups,
            unrestricted=settings.admin_group in groups,
            source="service-token",
        )

    # 2. Token do CONECTOR (OAuth): o caminho de quem clicou em "Entrar" no
    #    Claude, no Cursor ou na web. Prefixo proprio, resolvido no banco.
    if token and token.startswith(oauth.ACCESS_PREFIX):
        try:
            dono = oauth.resolve_access(token)
        except oauth.OAuthError as exc:
            raise AuthError(exc.description) from None
        if dono is None:
            raise AuthError("token de conexao desconhecido")
        grupos = [str(g) for g in dono["groups"]]
        papeis = [str(r) for r in dono["roles"]]
        return Principal(
            subject=dono["subject"],
            email=dono["email"],
            entra_oid=dono["entra_oid"],
            groups=grupos,
            roles=papeis,
            unrestricted=_is_admin(
                {"email": dono["email"], "oid": dono["entra_oid"]}, grupos, papeis
            ),
            source="conector",
        )

    # 3. Token PESSOAL: o caminho de quem prefere configurar na mao. Vem antes
    #    do JWT porque tem prefixo proprio e nao passaria pela validacao de
    #    assinatura.
    if token and tokens.looks_like_personal(token):
        try:
            dono = tokens.resolve(token)
        except (tokens.TokenRevoked, tokens.TokenExpired) as exc:
            raise AuthError(str(exc)) from None
        if dono is None:
            raise AuthError("token pessoal desconhecido")
        grupos = [str(g) for g in dono["groups"]]
        papeis = [str(r) for r in dono["roles"]]
        return Principal(
            subject=dono["subject"],
            email=dono["email"],
            entra_oid=dono["entra_oid"],
            groups=grupos,
            roles=papeis,
            # O mesmo criterio do JWT: o token nao AMPLIA nada, so carrega a
            # identidade de quem o emitiu.
            unrestricted=_is_admin(
                {"email": dono["email"], "oid": dono["entra_oid"]}, grupos, papeis
            ),
            source="token-pessoal",
        )

    # 4. Auth desligada: dev offline, tudo permitido.
    if not settings.auth_enabled:
        return Principal(subject="dev", unrestricted=True, source="auth-desligada")

    if not token:
        raise AuthError("falta o header Authorization: Bearer <token>")

    claims = _claims_from_jwt(token)
    groups = _groups_from_claims(claims)
    roles = _roles_from_claims(claims)
    return Principal(
        subject=str(claims.get("sub") or ""),
        email=str(claims.get("email") or ""),
        # `oid` e o claim do EntraID; o Keycloak repassa quando a conta e
        # federada. Alguns realms mapeiam para `entra_oid`.
        entra_oid=str(claims.get("oid") or claims.get("entra_oid") or ""),
        groups=groups,
        roles=roles,
        # Admin por GRUPO, nunca por role, a menos que se configure. A role de
        # administracao do proprio Keycloak (`realm-management:realm-admin`)
        # existe para operar o Identity, e nao deve implicar acesso ao conteudo
        # da base -- sao dois poderes diferentes.
        unrestricted=_is_admin(claims, groups, roles),
        source="keycloak",
    )


def _is_admin(claims: dict[str, Any], groups: list[str], roles: list[str]) -> bool:
    """Acesso total: pelo grupo do Identity, por role configurada, ou por regra
    gravada em `kb_admin`.

    O grupo vem primeiro e nunca depende do banco -- e o que garante que existe
    um caminho de administracao mesmo com a tabela vazia ou corrompida.
    """
    if settings.admin_group in groups:
        return True
    if settings.admin_role and settings.admin_role in roles:
        return True

    email = str(claims.get("email") or "").lower()
    oid = str(claims.get("oid") or claims.get("entra_oid") or "")
    for kind, value in admin_rules():
        if kind == "group" and value in groups:
            return True
        if kind == "role" and value in roles:
            return True
        if kind == "email" and email and value.lower() == email:
            return True
        if kind == "entra_oid" and oid and value == oid:
            return True
    return False


def narrow(allowed: list[str] | None, requested: list[str] | None) -> list[str] | None:
    """Interseccao entre o permitido e o pedido.

    O pedido so restringe. Se o chamador pedir um Espaco que nao alcanca, ele
    simplesmente nao entra no resultado -- e se pedir SO Espacos proibidos, a
    resposta e vazia, nao um erro que revelaria a existencia deles.
    """
    if not requested:
        return allowed
    wanted = {slug.strip() for slug in requested if slug.strip()}
    if allowed is None:
        return sorted(wanted)
    return sorted(wanted & set(allowed))

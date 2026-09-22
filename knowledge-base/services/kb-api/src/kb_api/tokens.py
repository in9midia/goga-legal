"""Token pessoal para os harnesses de IA (Claude Desktop, Cursor, Codex).

POR QUE EXISTE

Nenhuma das credenciais que já havia serve para o agente de uma pessoa:

* o **JWT do Identity** vive minutos e exige navegador — um editor que fica
  aberto a semana inteira não tem como renová-lo sozinho;
* o **token de serviço** não tem pessoa e carrega o escopo de administração:
  usá-lo no editor de alguém daria ao agente daquela pessoa acesso a tudo, e o
  log de auditoria registraria "service-token" em vez de quem perguntou.

O que se quer no editor é exatamente o contrário: *o agente alcança o que EU
alcanço, e nada mais*.

O QUE ELE É, E O QUE NÃO É

O valor em claro **nunca** é gravado: guardamos o SHA-256 do token inteiro e um
prefixo em claro que é só índice de busca. A API precisa VERIFICAR o token,
nunca usá-lo contra outro serviço — então não há motivo para ser reversível.

Um token pessoal **não emite outro token**. Se um vazasse, quem o tivesse não
deveria conseguir cunhar credenciais novas de vida longa.

A LIMITAÇÃO, DITA EM VOZ ALTA

Os grupos são uma fotografia do instante da emissão. Quem muda de área continua
alcançando a base antiga até o token expirar ou ser revogado. É o preço de não
depender do navegador — e é por isso que a tela mostra os grupos de cada token,
a data de emissão e o último uso: a defasagem fica visível em vez de silenciosa.

O outro lado é lido ao vivo: os `space_grant` são consultados a cada requisição,
então tirar o acesso de um grupo a uma base vale imediatamente, para todos os
tokens.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from .config import settings
from .db import conn, jsonb

log = logging.getLogger(__name__)

# Prefixo reconhecível no valor: quem encontra a string num arquivo de
# configuração sabe de onde ela é, e um scanner de segredo pode ter uma regra.
PREFIX = "kbp_"
# 32 bytes de aleatoriedade. `token_urlsafe(32)` dá ~43 caracteres.
ENTROPY_BYTES = 32
# Quantos caracteres do valor ficam em claro no banco. 12 é o suficiente para
# achar a linha sem que o pedaço em claro ajude a adivinhar o resto.
PREFIX_LEN = 12


@dataclass
class IssuedToken:
    id: int
    name: str
    # Só existe na resposta da emissão. Nunca é lido de volta.
    value: str
    prefix: str
    expires_at: datetime | None


def _sha(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def issue(
    *,
    name: str,
    subject: str,
    email: str,
    entra_oid: str,
    groups: list[str],
    roles: list[str],
    days: int | None = None,
) -> IssuedToken:
    """Cria um token para o chamador autenticado.

    A identidade vem do JWT de quem chamou, nunca do corpo da requisição — se
    viesse do corpo, qualquer pessoa emitiria token no nome de outra.
    """
    valor = PREFIX + secrets.token_urlsafe(ENTROPY_BYTES)
    validade = days if days and days > 0 else settings.personal_token_days
    expira = datetime.now(UTC) + timedelta(days=validade)

    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            INSERT INTO kb_token
                (name, token_sha, prefix, subject, email, entra_oid, groups, roles, expires_at)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
            RETURNING id
            """,
            (
                name[:120], _sha(valor), valor[:PREFIX_LEN], subject, email.lower(),
                entra_oid, jsonb(groups), jsonb(roles), expira,
            ),
        )
        token_id = cur.fetchone()[0]
        connection.commit()

    log.info("token pessoal %s emitido para %s (expira %s)", token_id, email or subject, expira)
    return IssuedToken(
        id=token_id, name=name, value=valor, prefix=valor[:PREFIX_LEN], expires_at=expira
    )


def looks_like_personal(token: str) -> bool:
    return token.startswith(PREFIX)


def resolve(token: str) -> dict[str, Any] | None:
    """Identidade por trás de um token pessoal, ou None se não vale.

    Busca pelo prefixo e confirma pelo hash com `compare_digest`: a comparação
    em tempo constante evita que o tempo de resposta vire um oráculo para
    adivinhar o hash byte a byte.
    """
    if not looks_like_personal(token):
        return None
    esperado = _sha(token)
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            SELECT id, token_sha, subject, email, entra_oid, groups, roles,
                   expires_at, revoked_at
              FROM kb_token
             WHERE prefix = %s
            """,
            (token[:PREFIX_LEN],),
        )
        linhas = cur.fetchall()

    agora = datetime.now(UTC)
    for linha in linhas:
        if not hmac.compare_digest(linha[1], esperado):
            continue
        if linha[8] is not None:
            raise TokenRevoked("este token foi revogado")
        if linha[7] is not None and linha[7] < agora:
            raise TokenExpired(f"este token expirou em {linha[7].date().isoformat()}")
        _marcar_uso(linha[0])
        return {
            "id": linha[0], "subject": linha[2], "email": linha[3],
            "entra_oid": linha[4], "groups": linha[5] or [], "roles": linha[6] or [],
        }
    return None


def _marcar_uso(token_id: int) -> None:
    """Carimba o último uso. Falha aqui nunca recusa a requisição.

    O carimbo é o que permite a alguém olhar a lista e ver que aquele token do
    notebook antigo não é usado há seis meses -- que é quando revogar deixa de
    ser incômodo e passa a ser óbvio.
    """
    try:
        with conn() as connection, connection.cursor() as cur:
            cur.execute("UPDATE kb_token SET last_used_at = now() WHERE id = %s", (token_id,))
            connection.commit()
    except Exception as exc:  # noqa: BLE001
        log.warning("nao consegui carimbar o uso do token %s: %s", token_id, exc)


def listar(subject: str, email: str) -> list[dict[str, Any]]:
    """Tokens do PRÓPRIO chamador. Ninguém lista token de terceiro por aqui."""
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            SELECT id, name, prefix, groups, created_at, expires_at, last_used_at, revoked_at
              FROM kb_token
             WHERE (subject = %s AND subject <> '') OR (email = %s AND email <> '')
             ORDER BY created_at DESC
            """,
            (subject, email.lower()),
        )
        linhas = cur.fetchall()
    agora = datetime.now(UTC)
    return [
        {
            "id": r[0], "name": r[1], "prefix": r[2], "groups": r[3] or [],
            "created_at": r[4].isoformat() if r[4] else None,
            "expires_at": r[5].isoformat() if r[5] else None,
            "last_used_at": r[6].isoformat() if r[6] else None,
            "revoked": r[7] is not None,
            "expired": bool(r[5] and r[5] < agora),
        }
        for r in linhas
    ]


def revogar(token_id: int, subject: str, email: str) -> bool:
    """Revoga um token do próprio chamador.

    O `WHERE` amarra ao dono de propósito: revogar token de terceiro não é ação
    deste caminho, mesmo para administrador. Quem precisa cortar o acesso de
    outra pessoa faz isso onde a permissão mora -- no grupo do Identity ou no
    vínculo da base -- e aí vale para todos os tokens dela de uma vez.
    """
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            UPDATE kb_token SET revoked_at = now()
             WHERE id = %s AND revoked_at IS NULL
               AND ((subject = %s AND subject <> '') OR (email = %s AND email <> ''))
            """,
            (token_id, subject, email.lower()),
        )
        alterou = cur.rowcount > 0
        connection.commit()
    return alterou


class TokenRevoked(RuntimeError):
    pass


class TokenExpired(RuntimeError):
    pass

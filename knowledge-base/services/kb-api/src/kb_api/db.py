"""Acesso ao Postgres com pgvector.

psycopg 3 com pool: o servico e I/O bound e as consultas sao curtas, entao um
pool pequeno cobre bem e evita o custo de handshake por request.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import psycopg
from psycopg_pool import ConnectionPool

from .config import settings

log = logging.getLogger(__name__)

_pool: ConnectionPool | None = None


def pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        _pool = ConnectionPool(
            settings.pg_dsn,
            min_size=1,
            max_size=8,
            # Sem isso, o primeiro request depois de um restart do Postgres
            # recebe uma conexao morta do pool.
            check=ConnectionPool.check_connection,
            open=True,
        )
    return _pool


@contextmanager
def conn() -> Iterator[psycopg.Connection]:
    with pool().connection() as connection:
        yield connection


def close_pool() -> None:
    """Fecha o pool. So para quem roda como COMANDO, nao como servidor.

    O pool sobe threads proprias e nao morre sozinho no fim do processo: sem
    isso, `python -m kb_api.migrate` fica 5s pendurado no exit e imprime
    "couldn't stop thread ... within 5.0 seconds" -- barulho que num
    init-container parece falha de migracao e nao e.
    """
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


def as_vector(values: list[float]) -> str:
    """Literal de vetor do pgvector. Passar lista Python direto nao funciona."""
    return "[" + ",".join(f"{v:.7g}" for v in values) + "]"


def jsonb(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)

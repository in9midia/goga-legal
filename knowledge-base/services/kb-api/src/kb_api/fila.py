"""Fila de ingestao: o upload enfileira, esta thread processa UM POR VEZ.

POR QUE EXISTE

A ingestao era sincrona: o POST so voltava com o documento indexado. Com dez
arquivos de 10 MB enviados de uma vez, eram dez conexoes de minutos
atravessando o ingress. Bastava um engasgo do pod para a conexao cair, o
cliente passar para o proximo arquivo e o servidor ficar com dois docling
rodando juntos -- OOMKilled, e tudo que estava no ar perdido com um "envie de
novo".

Agora o upload so guarda o bruto e abre a linha `queued` em `ingest_run`
(`ingest.enfileirar`). Esta thread pega a mais antiga, processa, e pega a
proxima. A concorrencia deixa de depender de quem envia: dez arquivos ou cem,
o pod processa um.

O ESTADO ESTA NO POSTGRES

A thread nao guarda nada que importe. A fila sao as linhas `queued`, e o bruto
de cada uma esta no object store. O pod que cai no meio devolve o `running`
para a fila na subida (`retomar_orfaos`), ate `MAX_TENTATIVAS` vezes -- um
arquivo que derruba o pod toda vez precisa parar de ser retomado, senao a fila
vira um laco de OOM.

`FOR UPDATE SKIP LOCKED` na hora de pegar: hoje ha uma replica e uma thread,
mas com duas nenhuma pega a mesma linha.
"""

from __future__ import annotations

import logging
import threading
from typing import Any

from . import ingest, progresso, storage
from .db import conn

log = logging.getLogger(__name__)

# Quantas vezes um arquivo pode ser pego pelo worker. Passou disso, o pod caiu
# com ele no ar todas as vezes: e o arquivo, nao o acaso.
MAX_TENTATIVAS = 2
# Sem aviso de upload novo, olha a fila neste intervalo. O aviso (`acordar`) e o
# caminho normal; o intervalo cobre linha enfileirada por outra replica.
INTERVALO_SEGUNDOS = 5.0

# O resultado completo das ultimas execucoes (representacoes, grafo...), que
# `ingest_run` nao guarda. So serve ao upload com `wait=true`, que responde com
# ele; limitado porque ninguem mais le.
_RESULTADOS_GUARDADOS = 50
_resultados: dict[int, dict[str, Any]] = {}
_trava = threading.Lock()

_acordar = threading.Event()
_parar = threading.Event()


def acordar() -> None:
    """Avisa que ha arquivo novo na fila, sem esperar o intervalo."""
    _acordar.set()


def retomar_orfaos() -> dict[str, int]:
    """Na subida: o que estava `running` morreu com o pod anterior.

    Com o bruto guardado, volta para a fila. Sem ele (execucao anterior a fila,
    ou reprocessamento sincrono), nao ha de onde retomar e a linha fecha como
    falha, como antes.
    """
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            UPDATE ingest_run SET status = 'queued', started_at = now(),
                   stage = 'fila', stage_detail = 'voltou para a fila após queda do serviço'
             WHERE status = 'running' AND raw_key <> '' AND attempts < %s
            RETURNING id
            """,
            (MAX_TENTATIVAS,),
        )
        ids = [linha[0] for linha in cur.fetchall()]
        retomadas = len(ids)
        for run_id in ids:
            cur.execute(
                "INSERT INTO ingest_event (run_id, stage, message) VALUES (%s, 'fila', %s)",
                (run_id, "o serviço reiniciou no meio; voltou para a fila"),
            )
        cur.execute(
            """
            UPDATE ingest_run
               SET status = 'failed', finished_at = now(),
                   error = 'o serviço caiu ' || attempts || ' vez(es) processando este arquivo '
                           '(provavelmente falta de memória). Ele não será retomado sozinho; '
                           'divida o PDF ou reprocesse quando o serviço estiver folgado.'
             WHERE status = 'running' AND raw_key <> '' AND attempts >= %s
            """,
            (MAX_TENTATIVAS,),
        )
        desistidas = cur.rowcount
        connection.commit()
    if retomadas or desistidas:
        log.warning("fila: %s ingestao(oes) retomada(s), %s desistida(s) apos queda do pod",
                    retomadas, desistidas)
    return {"retomadas": retomadas, "desistidas": desistidas}


def _pegar() -> tuple[int, str, str, str, str] | None:
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            UPDATE ingest_run
               SET status = 'running', started_at = now(), attempts = attempts + 1
             WHERE id = (
                   SELECT id FROM ingest_run
                    WHERE status = 'queued'
                    ORDER BY id
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1)
            RETURNING id, space_slug, filename, raw_key, principal, attempts
            """
        )
        linha = cur.fetchone()
        connection.commit()
    if linha is None:
        return None
    if linha[5] > 1:
        progresso.evento(linha[0], "iniciado", f"retomado após queda do serviço (tentativa {linha[5]})")
    return linha[:5]


def cancelar(run_id: int) -> bool:
    """Tira da fila um arquivo que ainda nao comecou. `False` se ja comecou ou nao existe.

    So `queued`: interromper um `running` no meio deixaria o docling ou o
    embedding rodando na thread sem dono, e a linha mentindo que parou.
    """
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            "UPDATE ingest_run SET status = 'cancelled', finished_at = now(),"
            "       stage = 'cancelado', stage_detail = 'retirado da fila'"
            " WHERE id = %s AND status = 'queued'",
            (run_id,),
        )
        ok = cur.rowcount == 1
        connection.commit()
    if ok:
        progresso.evento(run_id, "cancelado", "retirado da fila antes de começar")
    return ok


def _falhar(run_id: int, erro: str) -> None:
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            "UPDATE ingest_run SET status = 'failed', finished_at = now(), error = %s"
            " WHERE id = %s",
            (erro[:1000], run_id),
        )
        connection.commit()


def processar_um() -> bool:
    """Processa o proximo da fila. `False` quando a fila esta vazia."""
    linha = _pegar()
    if linha is None:
        return False
    run_id, space_slug, filename, raw_key, principal = linha
    try:
        dados = storage.get(raw_key)
    except Exception as exc:  # noqa: BLE001
        log.warning("fila: bruto de %s sumiu (%s): %s", filename, raw_key, exc)
        _falhar(run_id, "o arquivo original não está mais no object store; envie de novo")
        return True

    log.info("fila: processando %s (%s, execucao %s)", filename, space_slug, run_id)
    try:
        # `ingest_document` fecha a linha e, em falha, registra o documento para
        # a retentativa automatica. Aqui so resta nao deixar a excecao matar a
        # thread.
        resultado = ingest.ingest_document(
            space_slug, filename, dados, principal, run_id=run_id
        )
        with _trava:
            _resultados[run_id] = resultado.to_dict()
            while len(_resultados) > _RESULTADOS_GUARDADOS:
                _resultados.pop(next(iter(_resultados)))
    except Exception as exc:  # noqa: BLE001
        log.info("fila: %s falhou: %s", filename, str(exc)[:200])
    return True


def resultado(run_id: int) -> dict[str, Any] | None:
    with _trava:
        return _resultados.get(run_id)


def _laco() -> None:
    while not _parar.is_set():
        try:
            while not _parar.is_set() and processar_um():
                pass
        except Exception as exc:  # noqa: BLE001 - Postgres piscou; tenta de novo
            log.warning("fila: rodada falhou: %s", exc)
        _acordar.wait(INTERVALO_SEGUNDOS)
        _acordar.clear()


def iniciar() -> None:
    threading.Thread(target=_laco, name="fila-ingestao", daemon=True).start()
    log.info("fila de ingestao iniciada")


def parar() -> None:
    _parar.set()
    _acordar.set()

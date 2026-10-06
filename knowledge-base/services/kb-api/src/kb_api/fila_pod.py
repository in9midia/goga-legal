"""Fila de ingestao em modo pod: cada arquivo num Job do Kubernetes (ADR-0031).

POR QUE EXISTE

Na thread do kb-api (`fila.py`) a fila anda um arquivo por vez, e tem de ser
assim: dois docling no mesmo processo e o pod morre por memoria. Para uma carga
de centenas de PDFs isso e o gargalo inteiro, e o cluster tem nos sobrando.
Aqui cada arquivo ganha um pod proprio, com memoria propria, e o limite de
quantos rodam juntos (`KB_INGEST_POD_MAX`) passa a ser uma decisao de quem
dimensionou o cluster.

O QUE NAO MUDA

A fila e a mesma tabela, com o mesmo `FOR UPDATE SKIP LOCKED`, o mesmo limite
de tentativas e o mesmo processamento (`fila.processar`). O Job nao devolve
nada por rede: ele escreve no mesmo Postgres, object store e Memgraph que o
kb-api, e fecha a linha como a thread fecharia. "Voltar para a KB" e isso.

AS DUAS METADES

- o dispatcher, uma thread no kb-api: reconcilia os Jobs que terminaram e cria
  Job novo enquanto houver vaga e linha `queued`;
- o runner, `python -m kb_api.fila_pod <run_id> <worker>`, que e o comando do
  Job: processa UMA linha e sai.

QUANDO O POD MORRE

OOMKilled, prazo estourado ou Job apagado na mao terminam sem fechar a linha.
O reconciliador ve o Job terminado com a linha ainda `running` daquele worker e
faz o que `retomar_orfaos` faz na subida: devolve para a fila ate
`MAX_TENTATIVAS`, e depois desiste com o motivo que o Kubernetes deu. Por isso
o Job tem `backoffLimit: 0` -- a retentativa do proprio Job nao passaria pelo
contador de tentativas, e um PDF que estoura a memoria viraria laco.

UMA REPLICA

O reconciliador trata como orfao todo `running` de worker cujo Job nao existe.
Com duas replicas do kb-api, uma veria o Job recem-criado pela outra antes de
ele aparecer na listagem dela. O kb-api roda com uma replica (ver
`_fechar_trabalhos_orfaos` em `main.py`); se isso mudar, o dispatcher precisa de
eleicao de lider antes.
"""

from __future__ import annotations

import logging
import sys
import threading
from typing import Any

from . import fila, progresso
from .config import settings
from .db import close_pool, conn
from .kube import Kube, KubeError, namespace

log = logging.getLogger(__name__)

PREFIXO = "kb-ingest"
ROTULO = "app.kubernetes.io/name"
ROTULO_RUN = "goga.legal/ingest-run"

# O que a tela da fila mostra sobre o executor. `erro` e o ultimo problema do
# dispatcher (sem permissao no namespace, imagem nao configurada...), que de
# outro jeito so apareceria no log do pod.
estado: dict[str, Any] = {"ativos": 0, "erro": ""}


# ── o Job ───────────────────────────────────────────────────────────────────


def _env_from(itens: list[str]) -> list[dict[str, Any]]:
    fontes = []
    for item in itens:
        tipo, _, nome = item.partition(":")
        if tipo == "configmap" and nome:
            fontes.append({"configMapRef": {"name": nome}})
        elif tipo == "secret" and nome:
            fontes.append({"secretRef": {"name": nome}})
        else:
            raise ValueError(
                f"KB_INGEST_POD_ENV_FROM: '{item}' deveria ser configmap:<nome> ou secret:<nome>"
            )
    return fontes


def manifesto(run_id: int, worker: str) -> dict[str, Any]:
    s = settings
    rotulos = {ROTULO: PREFIXO, "app.kubernetes.io/part-of": "goga", ROTULO_RUN: str(run_id)}
    pod: dict[str, Any] = {
        "restartPolicy": "Never",
        "containers": [
            {
                "name": "ingest",
                "image": s.ingest_pod_image,
                "imagePullPolicy": s.ingest_pod_pull_policy,
                "command": ["python", "-m", "kb_api.fila_pod", str(run_id), worker],
                "envFrom": _env_from(s.ingest_pod_env_from),
                "resources": {
                    "requests": {
                        "cpu": s.ingest_pod_cpu_request,
                        "memory": s.ingest_pod_memory_request,
                    },
                    "limits": {"cpu": s.ingest_pod_cpu_limit, "memory": s.ingest_pod_memory_limit},
                },
            }
        ],
    }
    if s.ingest_pod_service_account:
        pod["serviceAccountName"] = s.ingest_pod_service_account
    else:
        # O runner nao fala com o Kubernetes; sem isto ele herdaria a service
        # account `default` montada a toa.
        pod["automountServiceAccountToken"] = False
    if s.ingest_pod_pull_secrets:
        pod["imagePullSecrets"] = [{"name": n} for n in s.ingest_pod_pull_secrets]
    if s.ingest_pod_node_selector:
        pod["nodeSelector"] = dict(
            par.split("=", 1) for par in s.ingest_pod_node_selector if "=" in par
        )
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {"name": worker, "labels": rotulos},
        "spec": {
            "backoffLimit": 0,
            "activeDeadlineSeconds": s.ingest_pod_deadline_seconds,
            # Rede de seguranca: quem apaga o Job e o reconciliador, logo que o
            # ve terminado. Isto so limpa o que sobrar se o kb-api ficar fora.
            "ttlSecondsAfterFinished": 3600,
            "template": {"metadata": {"labels": rotulos}, "spec": pod},
        },
    }


# ── reconciliacao ───────────────────────────────────────────────────────────


def _terminou(job: dict[str, Any]) -> bool:
    status = job.get("status") or {}
    if status.get("succeeded") or status.get("failed"):
        return True
    return any(
        c.get("type") in ("Complete", "Failed") and c.get("status") == "True"
        for c in status.get("conditions") or []
    )


def _motivo(kube: Kube, job: dict[str, Any]) -> str:
    """Por que o pod saiu sem fechar a linha, no vocabulario do Kubernetes."""
    nome = job["metadata"]["name"]
    for cond in (job.get("status") or {}).get("conditions") or []:
        if cond.get("type") == "Failed" and cond.get("reason") == "DeadlineExceeded":
            return (
                f"passou do prazo de {settings.ingest_pod_deadline_seconds} s "
                "(ou o cluster não teve vaga para agendar o pod)"
            )
    try:
        for pod in kube.list_pods(f"job-name={nome}"):
            for cs in (pod.get("status") or {}).get("containerStatuses") or []:
                fim = (cs.get("state") or {}).get("terminated") or {}
                if fim.get("reason") == "OOMKilled":
                    return (
                        f"o pod foi morto por falta de memória (limite "
                        f"{settings.ingest_pod_memory_limit})"
                    )
                if fim:
                    return f"o pod saiu com código {fim.get('exitCode')} ({fim.get('reason', '')})"
    except KubeError as exc:
        log.info("fila-pod: sem acesso aos pods de %s: %s", nome, exc)
    return "o pod terminou sem fechar a execução"


def _devolver_ou_desistir(run_id: int, worker: str, motivo: str) -> str:
    """Mesma regra de `fila.retomar_orfaos`, para uma linha so. O `worker` no
    WHERE e o que impede fechar uma linha que ja foi pega de novo."""
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            UPDATE ingest_run SET status = 'queued', started_at = now(), worker = '',
                   stage = 'fila', stage_detail = %s
             WHERE id = %s AND status = 'running' AND worker = %s AND attempts < %s
            """,
            (f"voltou para a fila: {motivo}", run_id, worker, fila.MAX_TENTATIVAS),
        )
        if cur.rowcount:
            connection.commit()
            progresso.evento(run_id, "fila", f"{worker}: {motivo}; voltou para a fila")
            return "retomada"
        cur.execute(
            """
            UPDATE ingest_run
               SET status = 'failed', finished_at = now(),
                   error = %s
             WHERE id = %s AND status = 'running' AND worker = %s
            """,
            (
                f"{motivo}. Aconteceu em todas as {fila.MAX_TENTATIVAS} tentativas; o arquivo "
                "não será retomado sozinho. Divida o PDF ou aumente o limite do pod.",
                run_id,
                worker,
            ),
        )
        fechou = cur.rowcount
        connection.commit()
    if fechou:
        progresso.evento(run_id, "falhou", f"{worker}: {motivo}; desistiu")
        return "desistida"
    return ""


def reconciliar(kube: Kube) -> int:
    """Fecha o que terminou e devolve quantos Jobs ainda ocupam vaga."""
    jobs = {j["metadata"]["name"]: j for j in kube.list_jobs(f"{ROTULO}={PREFIXO}")}
    terminados = {nome for nome, job in jobs.items() if _terminou(job)}
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            "SELECT id, worker FROM ingest_run WHERE status = 'running' AND worker LIKE %s",
            (f"{PREFIXO}-%",),
        )
        rodando = cur.fetchall()
    for run_id, worker in rodando:
        job = jobs.get(worker)
        if job is None:
            motivo = "o Job sumiu do cluster"
        elif worker in terminados:
            motivo = _motivo(kube, job)
        else:
            continue
        if _devolver_ou_desistir(run_id, worker, motivo):
            log.warning("fila-pod: execucao %s (%s): %s", run_id, worker, motivo)
    for nome in terminados:
        kube.delete_job(nome)
    return len(jobs) - len(terminados)


def _devolver_sem_contar(run_id: int, erro: str) -> None:
    """O Job nem chegou a ser criado: a tentativa nao conta."""
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            UPDATE ingest_run SET status = 'queued', worker = '',
                   attempts = greatest(attempts - 1, 0),
                   stage = 'fila', stage_detail = %s
             WHERE id = %s AND status = 'running'
            """,
            (f"aguardando: não consegui criar o pod ({erro[:200]})", run_id),
        )
        connection.commit()


def rodada(kube: Kube) -> dict[str, int]:
    """Uma passada: reconcilia e preenche as vagas. Devolve o que aconteceu."""
    if not settings.ingest_pod_image:
        raise RuntimeError("KB_INGEST_MODE=pod sem KB_INGEST_POD_IMAGE: não há o que rodar no pod")
    ativos = reconciliar(kube)
    criados = 0
    while ativos < settings.ingest_pod_max:
        linha = fila.pegar(PREFIXO)
        if linha is None:
            break
        run_id, _space, filename, _raw, _principal, _origem, worker = linha
        try:
            kube.create_job(manifesto(run_id, worker))
        except Exception as exc:  # noqa: BLE001
            # Sem permissao, cota do namespace cheia, API fora: a linha volta
            # e a proxima rodada tenta de novo. Parar aqui evita esvaziar a
            # fila inteira no mesmo erro.
            _devolver_sem_contar(run_id, str(exc))
            raise
        progresso.evento(run_id, "fila", f"enviado ao pod {worker}")
        log.info("fila-pod: %s -> %s", filename, worker)
        ativos += 1
        criados += 1
    estado["ativos"] = ativos
    return {"ativos": ativos, "criados": criados}


def _laco(acordar: threading.Event, parar: threading.Event) -> None:
    kube: Kube | None = None
    while not parar.is_set():
        try:
            kube = kube or Kube(namespace(settings.ingest_pod_namespace))
            rodada(kube)
            estado["erro"] = ""
        except Exception as exc:  # noqa: BLE001 - cluster ou Postgres piscou
            if estado["erro"] != str(exc):
                log.warning("fila-pod: rodada falhou: %s", exc)
            estado["erro"] = str(exc)[:300]
        acordar.wait(fila.INTERVALO_SEGUNDOS)
        acordar.clear()


def iniciar(acordar: threading.Event, parar: threading.Event) -> None:
    threading.Thread(
        target=_laco, args=(acordar, parar), name="fila-ingestao-pod", daemon=True
    ).start()
    log.info("fila de ingestao em modo pod (ate %s ao mesmo tempo)", settings.ingest_pod_max)


def resumo() -> dict[str, Any]:
    if not fila.modo_pod():
        return {"mode": "local", "max_parallel": 1}
    return {
        "mode": "pod",
        "max_parallel": settings.ingest_pod_max,
        "active_pods": estado["ativos"],
        "error": estado["erro"],
    }


# ── runner: o comando do Job ────────────────────────────────────────────────


def executar(run_id: int, worker: str) -> int:
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            SELECT space_slug, filename, raw_key, principal, sync_id, source_ref
              FROM ingest_run WHERE id = %s AND status = 'running' AND worker = %s
            """,
            (run_id, worker),
        )
        linha = cur.fetchone()
    if linha is None:
        # A linha foi devolvida ou cancelada enquanto o pod agendava. Processar
        # assim mesmo seria ingerir em paralelo com quem pegou de novo.
        log.warning("execucao %s nao pertence mais a %s; nada a fazer", run_id, worker)
        return 0
    space_slug, filename, raw_key, principal, sync_id, source_ref = linha
    origem = fila.ingest.Origem(sync_id, source_ref) if sync_id is not None else None
    progresso.evento(run_id, "iniciado", f"processando no pod {worker}")
    ok = fila.processar(run_id, space_slug, filename, raw_key, principal, origem)
    return 0 if ok else 1


def main(argv: list[str]) -> int:
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    if len(argv) != 2 or not argv[0].isdigit():
        print("uso: python -m kb_api.fila_pod <run_id> <worker>", file=sys.stderr)
        return 2
    try:
        return executar(int(argv[0]), argv[1])
    finally:
        close_pool()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

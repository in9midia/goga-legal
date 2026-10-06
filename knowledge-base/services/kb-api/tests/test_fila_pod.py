"""A fila em modo pod, sem cluster: o Job montado, a reconciliacao e o runner.

Fica de fora, verificado a mao no cluster: a permissao (Role) de verdade, o
agendamento sob falta de vaga e o OOMKilled real de um pod de ingestao.
"""

from __future__ import annotations

from dataclasses import replace

import pytest


class _Cur:
    def __init__(self, conn):
        self.conn = conn
        self.rowcount = 0

    def execute(self, sql, params=None):
        self.conn.sql.append((" ".join(sql.split()), params))
        self.rowcount = self.conn.rowcounts.pop(0) if self.conn.rowcounts else 0

    def fetchone(self):
        return self.conn.linhas.pop(0) if self.conn.linhas else None

    def fetchall(self):
        return self.conn.linhas

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _Conn:
    def __init__(self, linhas=None, rowcounts=None):
        self.sql = []
        self.linhas = list(linhas or [])
        self.rowcounts = list(rowcounts or [])

    def cursor(self):
        return _Cur(self)

    def commit(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _Kube:
    def __init__(self, jobs=(), pods=(), falha_ao_criar=None):
        self.jobs = list(jobs)
        self.pods = list(pods)
        self.criados = []
        self.apagados = []
        self.falha_ao_criar = falha_ao_criar

    def list_jobs(self, selector):
        return self.jobs

    def list_pods(self, selector):
        return self.pods

    def create_job(self, job):
        if self.falha_ao_criar:
            raise self.falha_ao_criar
        self.criados.append(job)
        return job

    def delete_job(self, name):
        self.apagados.append(name)


def _job(nome, **status):
    return {"metadata": {"name": nome}, "status": status}


@pytest.fixture
def pod(monkeypatch):
    from kb_api import fila, fila_pod

    cfg = replace(
        fila_pod.settings,
        ingest_mode="pod",
        ingest_pod_max=2,
        ingest_pod_image="repo/goga:kb-api-1.0.0",
        ingest_pod_env_from=["configmap:knowledge-base-config", "secret:storage-secret"],
        ingest_pod_pull_secrets=["ocir"],
        ingest_pod_memory_limit="4Gi",
    )
    monkeypatch.setattr(fila_pod, "settings", cfg)
    monkeypatch.setattr(fila, "settings", cfg)
    monkeypatch.setattr(fila_pod.progresso, "evento", lambda *a, **k: None)
    return fila_pod


# ── o Job ──────────────────────────────────────────────────────────────────


def test_job_nao_se_retenta_sozinho(pod):
    """A retentativa do proprio Job nao passaria por `attempts`: um PDF que
    estoura a memoria viraria laco de OOM."""
    job = pod.manifesto(7, "kb-ingest-7-1")
    assert job["spec"]["backoffLimit"] == 0
    assert job["metadata"]["name"] == "kb-ingest-7-1"
    c = job["spec"]["template"]["spec"]["containers"][0]
    assert c["command"] == ["python", "-m", "kb_api.fila_pod", "7", "kb-ingest-7-1"]
    assert c["envFrom"] == [
        {"configMapRef": {"name": "knowledge-base-config"}},
        {"secretRef": {"name": "storage-secret"}},
    ]
    assert c["resources"]["limits"]["memory"] == "4Gi"
    spec = job["spec"]["template"]["spec"]
    assert spec["restartPolicy"] == "Never"
    assert spec["imagePullSecrets"] == [{"name": "ocir"}]
    assert spec["automountServiceAccountToken"] is False


def test_env_from_mal_escrito_falha_com_o_nome_da_variavel(pod):
    with pytest.raises(ValueError, match="KB_INGEST_POD_ENV_FROM"):
        pod._env_from(["knowledge-base-config"])


def test_worker_do_modo_pod_e_montado_no_update_que_pega_a_linha(monkeypatch):
    """Gravado depois, o reconciliador podia ver um `running` sem dono."""
    from kb_api import fila

    c = _Conn(linhas=[(9, "cdc", "a.pdf", "k", "ana", 1, None, None, "kb-ingest-9-1")])
    monkeypatch.setattr(fila, "conn", lambda: c)
    linha = fila.pegar("kb-ingest")
    assert linha[-1] == "kb-ingest-9-1"
    sql, params = c.sql[0]
    assert "worker = CASE" in sql and params == ("kb-ingest", "kb-ingest")


# ── rodada e reconciliacao ─────────────────────────────────────────────────


def test_rodada_respeita_o_limite_de_pods(pod, monkeypatch):
    """Um Job ja rodando + limite 2: so uma vaga, mesmo com a fila cheia."""
    kube = _Kube(jobs=[_job("kb-ingest-1-1", active=1)])
    monkeypatch.setattr(pod, "conn", lambda: _Conn(linhas=[(1, "kb-ingest-1-1")]))
    fila_cheia = iter(
        [(n, "cdc", f"{n}.pdf", "k", "ana", None, f"kb-ingest-{n}-1") for n in (2, 3, 4)]
    )
    monkeypatch.setattr(pod.fila, "pegar", lambda prefixo: next(fila_cheia, None))
    assert pod.rodada(kube) == {"ativos": 2, "criados": 1}
    assert [j["metadata"]["name"] for j in kube.criados] == ["kb-ingest-2-1"]


def test_job_morto_com_a_linha_aberta_volta_para_a_fila(pod, monkeypatch):
    kube = _Kube(
        jobs=[_job("kb-ingest-5-1", failed=1), _job("kb-ingest-6-1", succeeded=1)],
        pods=[
            {
                "status": {
                    "containerStatuses": [
                        {"state": {"terminated": {"reason": "OOMKilled", "exitCode": 137}}}
                    ]
                }
            }
        ],
    )
    # So a 5 ainda esta `running`; a 6 terminou e fechou a propria linha.
    monkeypatch.setattr(pod, "conn", lambda: _Conn(linhas=[(5, "kb-ingest-5-1")]))
    devolvidas = []
    monkeypatch.setattr(
        pod,
        "_devolver_ou_desistir",
        lambda run_id, worker, motivo: devolvidas.append((run_id, motivo)) or "retomada",
    )
    assert pod.reconciliar(kube) == 0
    assert devolvidas == [(5, "o pod foi morto por falta de memória (limite 4Gi)")]
    assert sorted(kube.apagados) == ["kb-ingest-5-1", "kb-ingest-6-1"]


def test_linha_de_job_que_sumiu_tambem_e_orfa(pod, monkeypatch):
    monkeypatch.setattr(pod, "conn", lambda: _Conn(linhas=[(8, "kb-ingest-8-2")]))
    devolvidas = []
    monkeypatch.setattr(
        pod,
        "_devolver_ou_desistir",
        lambda run_id, worker, motivo: devolvidas.append(motivo) or "desistida",
    )
    pod.reconciliar(_Kube())
    assert devolvidas == ["o Job sumiu do cluster"]


def test_job_em_andamento_nao_e_tocado(pod, monkeypatch):
    kube = _Kube(jobs=[_job("kb-ingest-3-1", active=1)])
    monkeypatch.setattr(pod, "conn", lambda: _Conn(linhas=[(3, "kb-ingest-3-1")]))
    monkeypatch.setattr(pod, "_devolver_ou_desistir", lambda *a: pytest.fail("mexeu no vivo"))
    assert pod.reconciliar(kube) == 1
    assert kube.apagados == []


def test_ultima_tentativa_desiste_com_o_motivo(pod, monkeypatch):
    """O primeiro UPDATE (devolver) nao pega nada: `attempts` ja no limite."""
    c = _Conn(rowcounts=[0, 1])
    monkeypatch.setattr(pod, "conn", lambda: c)
    assert pod._devolver_ou_desistir(5, "kb-ingest-5-2", "o pod foi morto") == "desistida"
    sql, params = c.sql[1]
    assert "status = 'failed'" in sql
    assert params[0].startswith("o pod foi morto. Aconteceu em todas as 2 tentativas")
    assert params[1:] == (5, "kb-ingest-5-2")


def test_falha_ao_criar_o_job_devolve_sem_gastar_tentativa(pod, monkeypatch):
    kube = _Kube(falha_ao_criar=pod.KubeError(403, "jobs is forbidden"))
    c = _Conn()
    monkeypatch.setattr(pod, "conn", lambda: c)
    monkeypatch.setattr(
        pod.fila, "pegar", lambda prefixo: (4, "cdc", "4.pdf", "k", "ana", None, "kb-ingest-4-1")
    )
    with pytest.raises(pod.KubeError):
        pod.rodada(kube)
    devolveu = [s for s, _ in c.sql if "attempts = greatest(attempts - 1, 0)" in s]
    assert devolveu, c.sql


def test_modo_pod_sem_imagem_nao_pega_nada(pod, monkeypatch):
    monkeypatch.setattr(pod, "settings", replace(pod.settings, ingest_pod_image=""))
    monkeypatch.setattr(pod.fila, "pegar", lambda prefixo: pytest.fail("pegou sem imagem"))
    with pytest.raises(RuntimeError, match="KB_INGEST_POD_IMAGE"):
        pod.rodada(_Kube())


# ── subida do kb-api e runner ──────────────────────────────────────────────


def test_subida_em_modo_pod_nao_retoma_o_que_esta_num_job(pod, monkeypatch):
    """Retomar o `running` de um Job vivo ingeriria o arquivo duas vezes."""
    c = _Conn()
    monkeypatch.setattr(pod.fila, "conn", lambda: c)
    pod.fila.retomar_orfaos()
    assert all("worker = ''" in s for s, _ in c.sql if "WHERE status = 'running'" in s)


def test_subida_em_modo_local_trata_todo_running_como_orfao(monkeypatch):
    from kb_api import fila

    monkeypatch.setattr(fila, "settings", replace(fila.settings, ingest_mode="local"))
    assert fila.filtro_orfaos() == ""


def test_runner_nao_processa_linha_que_nao_e_mais_dele(pod, monkeypatch):
    monkeypatch.setattr(pod, "conn", lambda: _Conn(linhas=[]))
    monkeypatch.setattr(pod.fila, "processar", lambda *a: pytest.fail("processou"))
    assert pod.executar(5, "kb-ingest-5-1") == 0


def test_runner_processa_pelo_mesmo_caminho_da_thread(pod, monkeypatch):
    monkeypatch.setattr(
        pod, "conn", lambda: _Conn(linhas=[("cdc", "a.pdf", "cdc/k", "ana", 3, "drive:1")])
    )
    chamadas = []
    monkeypatch.setattr(pod.fila, "processar", lambda *a: chamadas.append(a) or False)
    assert pod.executar(5, "kb-ingest-5-1") == 1
    run_id, space, nome, raw, principal, origem = chamadas[0]
    assert (run_id, space, nome, raw, principal) == (5, "cdc", "a.pdf", "cdc/k", "ana")
    assert (origem.sync_id, origem.ref) == (3, "drive:1")

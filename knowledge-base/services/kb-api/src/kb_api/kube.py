"""Cliente minimo da API do Kubernetes, de dentro do cluster.

So o que a fila em modo `pod` precisa: criar, listar e apagar Job, e ler o
motivo com que o pod de um Job terminou. Fala REST direto com o `requests`, que
ja e dependencia, com o token e a CA que o kubelet monta em todo pod. O cliente
oficial (`kubernetes`) traz dezenas de MB de modelo gerado para usar quatro
chamadas.
"""

from __future__ import annotations

import os
from typing import Any

import requests

_SA = "/var/run/secrets/kubernetes.io/serviceaccount"


class KubeError(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(f"kubernetes {status}: {message}")
        self.status = status


def namespace(configurado: str = "") -> str:
    if configurado:
        return configurado
    try:
        with open(f"{_SA}/namespace", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return "default"


class Kube:
    def __init__(self, ns: str):
        host = os.environ.get("KUBERNETES_SERVICE_HOST")
        port = os.environ.get("KUBERNETES_SERVICE_PORT", "443")
        if not host:
            raise KubeError(0, "fora de um cluster: KUBERNETES_SERVICE_HOST ausente")
        # IPv6 do service precisa de colchete na URL.
        if ":" in host:
            host = f"[{host}]"
        self.base = f"https://{host}:{port}"
        self.ns = ns
        self.session = requests.Session()
        self.session.verify = f"{_SA}/ca.crt"

    def _token(self) -> str:
        # Relido a cada chamada: o token projetado e rotacionado pelo kubelet
        # (1 h). Guardado na subida, o dispatcher passaria a tomar 401 sozinho.
        with open(f"{_SA}/token", encoding="utf-8") as f:
            return f.read().strip()

    def _req(self, method: str, path: str, **kw: Any) -> dict[str, Any]:
        resp = self.session.request(
            method,
            self.base + path,
            timeout=15,
            headers={"Authorization": f"Bearer {self._token()}"},
            **kw,
        )
        if resp.status_code >= 400:
            try:
                msg = resp.json().get("message", resp.text)
            except ValueError:
                msg = resp.text
            raise KubeError(resp.status_code, str(msg)[:300])
        return resp.json() if resp.content else {}

    def create_job(self, job: dict[str, Any]) -> dict[str, Any]:
        return self._req("POST", f"/apis/batch/v1/namespaces/{self.ns}/jobs", json=job)

    def list_jobs(self, selector: str) -> list[dict[str, Any]]:
        dados = self._req(
            "GET",
            f"/apis/batch/v1/namespaces/{self.ns}/jobs",
            params={"labelSelector": selector},
        )
        return dados.get("items", [])

    def delete_job(self, name: str) -> None:
        # Background: sem `propagationPolicy` o Job sai e o pod fica orfao,
        # aparecendo como Completed no namespace ate alguem limpar na mao.
        try:
            self._req(
                "DELETE",
                f"/apis/batch/v1/namespaces/{self.ns}/jobs/{name}",
                json={"propagationPolicy": "Background"},
            )
        except KubeError as exc:
            if exc.status != 404:
                raise

    def list_pods(self, selector: str) -> list[dict[str, Any]]:
        dados = self._req(
            "GET",
            f"/api/v1/namespaces/{self.ns}/pods",
            params={"labelSelector": selector},
        )
        return dados.get("items", [])

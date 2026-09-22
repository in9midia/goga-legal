#!/usr/bin/env bash
# Remove a stack. Sem argumento, apaga o namespace e deixa o cluster de pe.
# --cluster apaga o cluster inteiro (destroi os PVCs: dados vao embora).
set -euo pipefail
CLUSTER="${CLUSTER:-knowledge-base}"
NS="${NS:-stack-knowledge-base}"

if [[ "${1:-}" == "--cluster" ]]; then
  echo "== apagando o cluster '$CLUSTER' (PVCs incluidos)"
  k3d cluster delete "$CLUSTER"
  exit 0
fi

echo "== removendo o namespace $NS (PVCs incluidos)"
kubectl delete ns "$NS" --ignore-not-found --timeout=180s

#!/usr/bin/env bash
# Constroi a imagem do kb-api e publica no registry local do cluster.
#
# Push no registry em vez de `k3d image import`: a imagem passa de 5 GB (docling
# + torch + modelos assados) e o import serializa o tar inteiro para dentro do
# no, o que leva minutos. O push aproveita camadas ja presentes.
set -euo pipefail

REG_PORT="${REG_PORT:-5112}"
TAG="${TAG:-dev}"
IMAGE="localhost:${REG_PORT}/ms-knowledge-base:${TAG}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
service_dir="$here/../../../services/kb-api"

if ! curl -fsS -m 5 "http://localhost:${REG_PORT}/v2/" >/dev/null 2>&1; then
  echo "!! registry local nao responde em localhost:${REG_PORT}"
  echo "   Rode ./00-cluster-up.sh primeiro."
  exit 1
fi

UI_IMAGE="localhost:${REG_PORT}/ui-knowledge-base:${TAG}"
ui_dir="$here/../../../services/kb-ui"

# Qual imagem construir: por padrao as duas. `--only api` / `--only ui` existe
# porque a imagem do kb-api leva minutos (torch + docling + modelos assados) e
# uma mudanca so no bundle nao deveria pagar esse preco.
ONLY="${1:-all}"
case "$ONLY" in
  --only) ONLY="${2:-all}" ;;
  api|ui|all) ;;
  "") ONLY="all" ;;
  *) echo "!! uso: $0 [--only api|ui]"; exit 2 ;;
esac

if [[ "$ONLY" == "all" || "$ONLY" == "api" ]]; then
  echo "== build $IMAGE"
  docker build -t "$IMAGE" "$service_dir"
  echo "== push $IMAGE"
  docker push "$IMAGE"
  echo "== pronto: $IMAGE"
fi

if [[ "$ONLY" == "all" || "$ONLY" == "ui" ]]; then
  echo "== build $UI_IMAGE"
  docker build -t "$UI_IMAGE" "$ui_dir"
  echo "== push $UI_IMAGE"
  docker push "$UI_IMAGE"
  echo "== pronto: $UI_IMAGE"
fi

#!/usr/bin/env bash
# Sobe (ou atualiza) o namespace stack-studio no cluster k3d da KB.
#
#   infra/k8s/local/studio/deploy.sh          build + push + apply + rollout
#   infra/k8s/local/studio/deploy.sh --no-build   so apply + rollout
#
# Pre-requisito: o cluster `knowledge-base` de pe (./start-k8s-local.sh da
# raiz faz as duas coisas na ordem certa).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$here/../../../.." && pwd)"
CONTEXT="k3d-${CLUSTER:-knowledge-base}"
NS=stack-studio
REG="localhost:${REG_PORT:-5112}"
TAG="${TAG:-dev}"

kubectl config get-contexts -o name | grep -qx "$CONTEXT" || { echo "!! contexto $CONTEXT nao existe: suba a KB antes"; exit 1; }
kubectl config use-context "$CONTEXT" >/dev/null

if [[ "${1:-}" != "--no-build" ]]; then
  echo "== build + push studio-api"
  docker build -f "$REPO/studio/api/Dockerfile" -t "$REG/studio-api:$TAG" "$REPO"
  docker push "$REG/studio-api:$TAG"
  echo "== build + push studio-ui"
  docker build -f "$REPO/studio/ui/Dockerfile" -t "$REG/studio-ui:$TAG" "$REPO/studio"
  docker push "$REG/studio-ui:$TAG"
fi

kubectl apply -f "$here/namespace.yaml" >/dev/null

# ── segredos ────────────────────────────────────────────────────────────────
# Lidos do .env da RAIZ do repo. STUDIO_SECRET_KEY e reaproveitada do Secret
# existente quando o .env nao traz uma: gerar outra a cada deploy tornaria
# ilegiveis as chaves de provedor ja cifradas no banco, sem erro ate o
# primeiro "Testar".
envfile="$REPO/.env"
[[ -f "$envfile" ]] && set -a && . "$envfile" && set +a
current() { kubectl -n "$NS" get secret studio-secrets -o "jsonpath={.data.$1}" 2>/dev/null | base64 -d 2>/dev/null || true; }
STUDIO_SECRET_KEY="${STUDIO_SECRET_KEY:-$(current STUDIO_SECRET_KEY)}"
STUDIO_SECRET_KEY="${STUDIO_SECRET_KEY:-$(openssl rand -hex 32)}"
STUDIO_SESSION_SECRET="${STUDIO_SESSION_SECRET:-$(current STUDIO_SESSION_SECRET)}"
STUDIO_SESSION_SECRET="${STUDIO_SESSION_SECRET:-$(openssl rand -hex 32)}"
STUDIO_ADMIN_EMAIL="${STUDIO_ADMIN_EMAIL:-admin@goga.local}"
STUDIO_ADMIN_PASSWORD="${STUDIO_ADMIN_PASSWORD:-$(current STUDIO_ADMIN_PASSWORD)}"
if [[ -z "$STUDIO_ADMIN_PASSWORD" ]]; then
  STUDIO_ADMIN_PASSWORD="$(openssl rand -base64 12)"
  echo "   senha inicial do admin gerada; leia com:"
  echo "   kubectl -n $NS get secret studio-secrets -o jsonpath='{.data.STUDIO_ADMIN_PASSWORD}' | base64 -d"
fi
kubectl -n "$NS" create secret generic studio-secrets \
  --from-literal=STUDIO_SECRET_KEY="$STUDIO_SECRET_KEY" \
  --from-literal=STUDIO_SESSION_SECRET="$STUDIO_SESSION_SECRET" \
  --from-literal=STUDIO_ADMIN_EMAIL="$STUDIO_ADMIN_EMAIL" \
  --from-literal=STUDIO_ADMIN_PASSWORD="$STUDIO_ADMIN_PASSWORD" \
  --from-literal=DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-}" \
  --from-literal=GEMINI_API_KEY="${GEMINI_API_KEY:-}" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

echo "== apply stack-studio"
kubectl apply -k "$here" >/dev/null
kubectl -n "$NS" rollout restart deploy/studio-api deploy/studio-ui >/dev/null 2>&1 || true
kubectl -n "$NS" rollout status deploy/studio-postgres --timeout=180s
kubectl -n "$NS" rollout status deploy/studio-api --timeout=300s
kubectl -n "$NS" rollout status deploy/studio-ui --timeout=120s
echo
echo "✅ Studio no ar: http://studio.localtest.me:${HOST_PORT:-8890}  (login: $STUDIO_ADMIN_EMAIL)"

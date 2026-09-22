#!/usr/bin/env bash
# Goga Legal (MVP) — sobe TUDO localmente: o cluster k3d da KB (com a KB em
# modo auth-desligada) e o namespace do Studio no mesmo cluster.
#
#   ./start-k8s-local.sh            KB + Studio
#   ./start-k8s-local.sh studio     so (re)deploy do Studio
#   ./start-k8s-local.sh populate   popula a KB (precisa de GEMINI_API_KEY e DEEPSEEK_API_KEY)
#   ./start-k8s-local.sh stop       pausa o cluster (dados preservados)
#
# As chaves e senhas vem do .env da raiz (veja .env.example). Nada disso entra
# no git.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$root/.env" ]] && set -a && . "$root/.env" && set +a

# Sem Keycloak no MVP: a KB sobe em `auth-desligada` e SO na rede local. O
# 20-deploy.sh da KB recusa o tunel ngrok nesse modo.
export KB_AUTH="${KB_AUTH:-off}"

case "${1:-}" in
  studio) exec "$root/infra/k8s/local/studio/deploy.sh" "${@:2}" ;;
  populate) exec "$root/knowledge-base/scripts/populate-kb.sh" "${@:2}" ;;
  stop|down) exec "$root/knowledge-base/start-k8s-local.sh" stop ;;
  "") ;;
  *) echo "uso: $0 [studio|populate|stop]"; exit 2 ;;
esac

"$root/knowledge-base/start-k8s-local.sh"
"$root/infra/k8s/local/studio/deploy.sh"
echo
echo "   KB      → http://localhost:${HOST_PORT:-8890}/"
echo "   Studio  → http://studio.localtest.me:${HOST_PORT:-8890}/"
echo "   popular a KB (depois de pôr as chaves no .env): ./start-k8s-local.sh populate"

#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# knowledge-base — sobe TODO o ambiente Kubernetes LOCAL (k3d) do zero.
#
# Ambiente LOCAL, no mesmo shape do agentic-sdlc: NAO e o deploy de producao
# (esse e GitOps). Serve para exercitar o que so funciona em k8s -- ingress
# unico, permissao por grupo do Identity, MCP autenticado.
#
# E IDEMPOTENTE: pode rodar quantas vezes quiser. Na 1a execucao:
#   instala k3d (se faltar) -> cria cluster + registry local -> builda/empurra
#   as imagens -> aplica o stack e espera os rollouts.
#
# Uso:
#   ./start-k8s-local.sh              # sobe tudo e mostra o consumo
#   ./start-k8s-local.sh sync ui      # dev loop: rebuild + rollout de um servico
#   ./start-k8s-local.sh status       # o que esta de pe, com consumo
#   ./start-k8s-local.sh logs api     # segue o log de um servico
#   ./start-k8s-local.sh ingest rh    # sobe uma area de _bases/ para a base
#   ./start-k8s-local.sh stop         # pausa o cluster (dados preservados)
#   ./start-k8s-local.sh destroy      # apaga o cluster + PVCs
#   ./start-k8s-local.sh prune        # devolve disco do Docker
#   ./start-k8s-local.sh help         # todas as possibilidades
#
# TRAVAS DE RECURSO (o ambiente roda numa VM de WSL2 compartilhada com o Windows):
#   K3D_NODE_MEMORY=8g  K3D_NODE_CPUS=6   teto de cgroup do container do no k3d
# Ver infra/k8s/local/limits.yaml para as camadas de teto.
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL="$root/infra/k8s/local"
REPO="$(cd "$root/.." && pwd)"
CLUSTER="${CLUSTER:-knowledge-base}"
NS="${NS:-stack-knowledge-base}"
CONTEXT="k3d-${CLUSTER}"
HOST_PORT="${HOST_PORT:-8890}"
export PATH="$HOME/.local/bin:$PATH"

azul()  { printf '\033[36m%s\033[0m\n' "$*"; }
falha() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; }

# ── help: TODAS as possibilidades, sem tocar no cluster ─────────────────────
# Fica no topo, antes dos pre-requisitos: pedir ajuda nao pode ser um verbo de
# escrita nem exigir Docker no ar.
if [[ "${1:-}" =~ ^(help|-h|--help)$ ]]; then
  cat <<USAGE
╭──────────────────────────────────────────────────╮
│  knowledge-base — Kubernetes LOCAL (k3d)         │
╰──────────────────────────────────────────────────╯

  uso: ./start-k8s-local.sh [subcomando] [args]

  SUBCOMANDOS
  ────────────────────────────────────────────────────────────────────────────
   (nenhum)          sobe o stack inteiro e espera os rollouts
   sync <svc>...     dev loop: rebuild + push + rollout (api | ui | all)
   status            o que esta de pe, com consumo de CPU e memoria
   logs <svc>        segue o log (api | ui | postgres | minio | memgraph)
   ingest <slug> <pasta>
                     carga em massa de uma pasta de documentos num Espaco
   stop | down       pausa o cluster (dados preservados; suba de novo sem args)
   destroy           APAGA o cluster + os PVCs (irreversivel)
   prune             devolve disco do Docker (cache de build + imagens)
   help              esta tela

  O QUE SOBE
  ────────────────────────────────────────────────────────────────────────────
   postgres    pgvector: indice vetorial e lexical na mesma transacao
   minio       o documento bruto, imutavel
   memgraph    grafo de termos (auxiliar; derivado, reconstruido na ingestao)
   kb-api      REST de gestao + servidor MCP
   kb-ui       React/Vite servido por nginx — a UNICA entrada da stack
   ngrok       tunel publico, OPCIONAL: so sobe com NGROK_AUTHTOKEN no .env
               da raiz. Sem ele, a base so e alcancavel nesta maquina

   NAO sobe Keycloak: a autenticacao e o Keycloak do Goga
   (http://kc.localtest.me:8481, realm goga-interno), no cluster k3d `goga`.

  ACESSO (tudo por uma porta so)
  ────────────────────────────────────────────────────────────────────────────
   UI     http://localhost:${HOST_PORT}/
   REST   http://localhost:${HOST_PORT}/v1/health
   MCP    http://localhost:${HOST_PORT}/mcp

  VARIAVEIS
  ────────────────────────────────────────────────────────────────────────────
   CLUSTER=${CLUSTER}          nome do cluster k3d
   HOST_PORT=${HOST_PORT}            porta do host mapeada no ingress
   K3D_NODE_MEMORY=8g     teto de memoria do container do no
   K3D_NODE_CPUS=6        teto de CPU do container do no
   TAG=dev                tag das imagens no registry local
USAGE
  exit 0
fi

# ── stop: pausa sem destruir ────────────────────────────────────────────────
if [[ "${1:-}" =~ ^(stop|down)$ ]]; then
  azul "== pausando o cluster ${CLUSTER} (dados preservados)"
  k3d cluster stop "$CLUSTER"
  echo "   suba de novo com: ./start-k8s-local.sh"
  exit 0
fi

# ── destroy: apaga tudo ─────────────────────────────────────────────────────
if [[ "${1:-}" == "destroy" ]]; then
  # Confirmacao por DIGITACAO do nome, nao por "s/n": isto apaga os PVCs, e com
  # eles a base inteira -- documentos, vetores e o bruto no MinIO. Reingerir a
  # base de RH com OCR leva perto de uma hora.
  echo "⚠  Isto APAGA o cluster ${CLUSTER} e os PVCs: Postgres, MinIO e o grafo."
  echo "   Reingerir a base de RH com OCR leva perto de uma hora."
  read -r -p "   Digite ${CLUSTER} para confirmar: " confirma
  [[ "$confirma" == "$CLUSTER" ]] || { echo "   (cancelado)"; exit 0; }
  bash "$LOCAL/down.sh" --purge 2>/dev/null || k3d cluster delete "$CLUSTER"
  exit 0
fi

# ── prune: devolve disco do Docker ──────────────────────────────────────────
if [[ "${1:-}" == "prune" ]]; then
  echo "== antes:"; docker system df; echo
  echo "== removendo cache do BuildKit (reconstruido sozinho no proximo build)…"
  docker builder prune -af
  echo "== removendo imagens dangling (sem tag)…"
  docker image prune -f
  echo; echo "== depois:"; docker system df
  echo
  echo "   dica: 'wsl --shutdown' + sparseVhd no .wslconfig e o que devolve o"
  echo "   espaco ao Windows — o .vhdx do WSL nao encolhe sozinho."
  exit 0
fi

# ── daqui para baixo, tudo precisa do Docker ────────────────────────────────
for bin in docker kubectl curl; do
  command -v "$bin" >/dev/null 2>&1 || { falha "falta '$bin' no PATH"; exit 1; }
done
docker info >/dev/null 2>&1 || { falha "docker nao esta acessivel (daemon no ar?)"; exit 1; }

# Fixa o contexto do kubectl no cluster LOCAL. Defesa contra mirar outro
# cluster por engano -- `kubectl delete` no cluster errado nao tem desfazer.
fixar_contexto() {
  kubectl config get-contexts -o name 2>/dev/null | grep -qx "$CONTEXT" || {
    falha "contexto kubectl '$CONTEXT' nao existe (o cluster subiu?)"
    echo "   suba com: ./start-k8s-local.sh" >&2
    exit 1
  }
  kubectl config use-context "$CONTEXT" >/dev/null
}

consumo() {
  echo
  azul "== consumo agora"
  docker stats --no-stream --format '   {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' \
    "k3d-${CLUSTER}-server-0" 2>/dev/null || true
  kubectl top pods -n "$NS" 2>/dev/null | sed 's/^/   /' || \
    echo "   (metrics-server ainda coletando)"
}

# ── status ──────────────────────────────────────────────────────────────────
if [[ "${1:-}" == "status" ]]; then
  fixar_contexto
  azul "== deployments"
  kubectl -n "$NS" get deploy -o wide | sed 's/^/   /'
  echo
  azul "== pods"
  kubectl -n "$NS" get pods | sed 's/^/   /'
  consumo
  exit 0
fi

# ── logs ────────────────────────────────────────────────────────────────────
if [[ "${1:-}" == "logs" ]]; then
  fixar_contexto
  case "${2:-api}" in
    api|kb-api)   alvo=kb-api ;;
    ui|kb-ui)     alvo=kb-ui ;;
    pg|postgres)  alvo=postgres ;;
    minio|s3)     alvo=minio ;;
    graph|memgraph) alvo=memgraph ;;
    *) falha "servico desconhecido: ${2}. Use api, ui, postgres, minio ou memgraph"; exit 1 ;;
  esac
  exec kubectl -n "$NS" logs -f "deploy/$alvo" --tail=100
fi

# ── sync: dev loop ──────────────────────────────────────────────────────────
if [[ "${1:-}" == "sync" ]]; then
  shift
  if [[ $# -eq 0 || "${1:-}" =~ ^(help|-h|--help)$ ]]; then
    cat <<'USAGE'
  dev loop: rebuild da imagem + push no registry local + rollout do deployment.
  Nao mexe em cluster, dependencias nem configmaps (isso e o start sem subcomando).

   ./start-k8s-local.sh sync ui     bundle React/Vite  (deploy kb-ui)
   ./start-k8s-local.sh sync api    FastAPI + MCP      (deploy kb-api)
   ./start-k8s-local.sh sync all    os dois

   A imagem do kb-api leva minutos (torch, Docling e os modelos assados nela).
   Mexeu so na UI? `sync ui` — e o que evita esperar um build que nao mudou.
USAGE
    exit 0
  fi
  fixar_contexto
  alvos=()
  for arg in "$@"; do
    case "$arg" in
      ui)  alvos+=(ui) ;;
      api) alvos+=(api) ;;
      all) alvos=(api ui) ;;
      *) falha "servico desconhecido: $arg. Use ui, api ou all"; exit 1 ;;
    esac
  done
  for alvo in "${alvos[@]}"; do
    azul "== build + push: $alvo"
    bash "$LOCAL/10-build-image.sh" --only "$alvo"
    deploy=$([[ "$alvo" == "api" ]] && echo kb-api || echo kb-ui)
    azul "== rollout: $deploy"
    kubectl -n "$NS" rollout restart "deploy/$deploy" >/dev/null
    kubectl -n "$NS" rollout status "deploy/$deploy" --timeout=600s
  done
  exit 0
fi

# ── ingest: carga em massa, pelo script do proprio repositorio ──────────────
if [[ "${1:-}" == "ingest" ]]; then
  slug="${2:-}"
  pasta="${3:-}"
  if [[ -z "$slug" || -z "$pasta" ]]; then
    falha "uso: ./start-k8s-local.sh ingest <slug> <pasta> [--group /Grupo]"
    exit 1
  fi
  shift 3
  exec "$REPO/scripts/ingest.sh" "$slug" "$pasta" "$@"
fi

if [[ -n "${1:-}" ]]; then
  falha "subcomando desconhecido: $1"
  echo "   veja as opcoes: ./start-k8s-local.sh help" >&2
  exit 1
fi

# ── subida completa ─────────────────────────────────────────────────────────
echo "╭──────────────────────────────────────────────────╮"
echo "│  knowledge-base — Kubernetes LOCAL (k3d)         │"
echo "╰──────────────────────────────────────────────────╯"

TOTAL=3
STEP=0
passo() { STEP=$((STEP + 1)); echo; azul "▶ [$STEP/$TOTAL] $*"; }

passo "cluster k3d + registry local + ingress"
bash "$LOCAL/00-cluster-up.sh"
fixar_contexto
echo "   contexto kubectl fixado em: $CONTEXT"

passo "build (se faltar) + push das imagens"
bash "$LOCAL/10-build-image.sh"

passo "aplica o stack + espera os rollouts"
bash "$LOCAL/20-deploy.sh"

echo
# O ✅ e uma AFIRMACAO, nao enfeite de fim de script: le o estado real (coluna
# READY = prontos/desejados) e so comemora se bater. Sem isso o script dizia
# "no ar" com o kb-api em CrashLoopBackOff.
NAO_PRONTOS="$(kubectl -n "$NS" get deploy --no-headers 2>/dev/null \
  | awk '{split($2,a,"/"); if (a[1]+0 < a[2]+0) printf "%s ", $1}' || true)"
if [[ -n "$NAO_PRONTOS" ]]; then
  echo "⚠  ambiente subiu PARCIALMENTE — sem estes deployments prontos: $NAO_PRONTOS"
  echo "   kubectl -n $NS get pods"
  echo "   ./start-k8s-local.sh logs api"
else
  echo "✅ ambiente no ar"
fi

echo
echo "   UI     → http://localhost:${HOST_PORT}/"
echo "   REST   → http://localhost:${HOST_PORT}/v1/health"
echo "   MCP    → http://localhost:${HOST_PORT}/mcp"
echo
echo "   login no Keycloak do Goga (realm goga-interno, client kb-ui)"
echo "   subir uma area:     ./start-k8s-local.sh ingest rh"
echo "   provar a permissao: ./start-k8s-local.sh verify rh"
echo "   dev loop da UI:     ./start-k8s-local.sh sync ui"
echo "   encerrar:           ./start-k8s-local.sh stop"

# Foto do consumo logo depois de subir: e o momento em que a pergunta "quanto
# isso esta comendo da minha maquina?" aparece, e o numero evita a suposicao.
consumo

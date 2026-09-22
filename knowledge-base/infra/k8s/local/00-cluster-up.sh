#!/usr/bin/env bash
# Sobe o cluster k8s LOCAL (k3d) da base de conhecimento + registry local.
#
# Espelha o 00-cluster-up.sh do agentic-sdlc: mesmo padrao de cluster, registry
# insegura local, traefik desabilitado e ingress-nginx instalado (className
# nginx, igual ao gitops). Cluster SEPARADO do `agentic` de proposito: sao dois
# produtos, e o isolamento evita que um derrube o outro.
#
# Pre-requisitos: docker + kubectl. k3d e instalado em ~/.local/bin se faltar.
set -euo pipefail

CLUSTER="${CLUSTER:-knowledge-base}"
REG_NAME="${REG_NAME:-k3d-registry-kb.localhost}"
REG_PORT="${REG_PORT:-5112}"
HOST_PORT="${HOST_PORT:-8890}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v k3d >/dev/null 2>&1; then
  echo "== k3d ausente → instalando em ~/.local/bin"
  mkdir -p "$HOME/.local/bin"
  curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh \
    | TAG=v5.7.4 K3D_INSTALL_DIR="$HOME/.local/bin" USE_SUDO=false bash
fi
export PATH="$HOME/.local/bin:$PATH"

if k3d cluster list "$CLUSTER" >/dev/null 2>&1; then
  # Religa apenas se houver no parado: `k3d cluster start` num cluster que ja
  # esta de pe pendura para sempre (k3d 5.7.4) esperando um log que nao reaparece.
  stopped=0
  for role in server agent loadbalancer; do
    n="$(docker ps -aq --filter "label=k3d.cluster=${CLUSTER}" \
      --filter "label=k3d.role=${role}" \
      --filter status=exited --filter status=created --filter status=paused \
      --filter status=dead 2>/dev/null | wc -l)"
    stopped=$((stopped + n))
  done
  reg_stopped="$(docker ps -aq --filter "label=k3d.cluster=${CLUSTER}" \
    --filter "label=k3d.role=registry" --filter status=exited \
    --filter status=created --filter status=dead 2>/dev/null)"
  [ -n "$reg_stopped" ] && docker start $reg_stopped >/dev/null 2>&1 || true
  if [ "$stopped" -gt 0 ]; then
    echo "== cluster '$CLUSTER' existe com $stopped container(es) parado(s) — religando"
    timeout 240 k3d cluster start "$CLUSTER" >/dev/null 2>&1 || true
  else
    echo "== cluster '$CLUSTER' ja esta rodando"
  fi
  k3d kubeconfig merge "$CLUSTER" --kubeconfig-merge-default >/dev/null 2>&1 || true
else
  echo "== criando o cluster '$CLUSTER' (registry :$REG_PORT, ingress :$HOST_PORT)"
  # defaultProxyTimeout: o load balancer do k3d e um proxy TCP com nginx, e o
  # default dele e 600s. A ingestao de um documento e SINCRONA: um PDF de 100
  # paginas com OCR passa de 10 minutos sem trafego nenhum na conexao, e o LB
  # fecha o socket no meio -- o cliente ve `RemoteDisconnected`, o nginx registra
  # 499, e a leitura obvia (errada) e culpar a rede. O servidor continua
  # trabalhando e grava o documento; quem perde a resposta e o cliente.
  k3d cluster create "$CLUSTER" \
    --registry-create "${REG_NAME}:0.0.0.0:${REG_PORT}" \
    --registry-config "$here/registries.yaml" \
    --agents 0 \
    --k3s-arg "--disable=traefik@server:*" \
    -p "${HOST_PORT}:80@loadbalancer" \
    --lb-config-override "settings.defaultProxyTimeout=${LB_PROXY_TIMEOUT:-3600}" \
    --wait --timeout 240s
fi

kubectl config use-context "k3d-${CLUSTER}" >/dev/null 2>&1 || true

# ── nao subir sozinho no boot do Docker/WSL ────────────────────────────────
# O k3d cria os containers com `--restart unless-stopped`, entao o Docker os
# religa em todo boot. Forcamos `restart=no`: o cluster sobe quando este script
# roda, nao quando a maquina liga.
docker update --restart no \
  $(docker ps -aq --filter "label=k3d.cluster=${CLUSTER}") >/dev/null 2>&1 || true

# ── teto de recurso do container do no (protege o WSL) ─────────────────────
# O no do k3d nasce sem limite: k3s + kubelet + todos os pods podem crescer ate
# o tamanho da VM do WSL. Quando a soma passa da RAM, o WSL cai em swap-thrash e
# a maquina inteira congela — nao e o OOM que trava, e o swap. `--memory-swap`
# igual ao `--memory` faz quem estourar morrer por OOM-kill, que e falha clara.
#
# 11g e nao 8g: o kb-api sozinho tem limite de 8Gi (o OCR precisa), e com o teto
# do NO em 8g a soma dos pods passava do container antes de qualquer pod
# estourar o proprio limite. Quem morre nesse caso e o no inteiro -- todos os
# pods de uma vez, incluindo o Postgres -- em vez de um pod so. O kubelet nao
# ajuda a perceber: ele reporta os ~19Gi da VM como alocaveis, sem enxergar o
# cgroup do container.
NODE_MEMORY="${K3D_NODE_MEMORY:-11g}"
NODE_CPUS="${K3D_NODE_CPUS:-6}"
for c in $(docker ps -q --filter "label=k3d.cluster=${CLUSTER}" --filter "label=k3d.role=server"); do
  docker update --memory "$NODE_MEMORY" --memory-swap "$NODE_MEMORY" \
    --cpus "$NODE_CPUS" "$c" >/dev/null 2>&1 \
    && echo "== teto do no: ${NODE_MEMORY} RAM / ${NODE_CPUS} CPU" || true
done

# ── ingress-nginx (className nginx, igual ao gitops) ───────────────────────
NGINX_VER="${NGINX_VER:-controller-v1.11.3}"
if ! kubectl get ns ingress-nginx >/dev/null 2>&1; then
  echo "== instalando ingress-nginx ($NGINX_VER)"
  kubectl apply -f "https://raw.githubusercontent.com/kubernetes/ingress-nginx/${NGINX_VER}/deploy/static/provider/cloud/deploy.yaml"
fi
# O manifesto upstream sobe o controller sem teto; fixa um modesto (idempotente).
kubectl -n ingress-nginx set resources deploy/ingress-nginx-controller \
  --limits=cpu=1,memory=320Mi --requests=cpu=50m,memory=96Mi >/dev/null 2>&1 || true

echo "== aguardando o controller ingress-nginx"
kubectl -n ingress-nginx rollout status deploy/ingress-nginx-controller --timeout=300s || true
# O admission webhook precisa estar pronto antes de criar Ingress.
kubectl -n ingress-nginx wait --for=condition=complete job/ingress-nginx-admission-create --timeout=180s 2>/dev/null || true
kubectl -n ingress-nginx wait --for=condition=complete job/ingress-nginx-admission-patch --timeout=180s 2>/dev/null || true

# ── gate: o registry precisa RESPONDER na porta do host ────────────────────
# Nao basta o container estar "Up": o que quebra o push e o mapeamento de porta.
# No docker+WSL o registry as vezes e recriado e PERDE o publish, enquanto um
# docker-proxy orfao segue escutando a porta apontando para o IP antigo — e o
# push morre com "connection reset by peer", sem pista do motivo.
if ! curl -fsS -m 5 "http://localhost:${REG_PORT}/v2/" >/dev/null 2>&1; then
  echo "!! o registry local nao responde em localhost:${REG_PORT}"
  echo "   Conserto: docker rm -f ${REG_NAME} && ./00-cluster-up.sh"
  exit 1
fi

echo "== cluster '$CLUSTER' pronto"
echo "   ingress:  http://localhost:${HOST_PORT}"
echo "   registry: localhost:${REG_PORT}"

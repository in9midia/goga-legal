#!/usr/bin/env bash
# Monta o kubeconfig da conta `goga-github-deployer` (deploy/k8s/github-deployer.yaml) e o
# escreve na saída padrão. O resultado é o secret KUBECONFIG_GOGA do repositório no GitHub:
#
#   deploy/k8s/github-deployer-kubeconfig.sh | base64 | pbcopy     # e cole em Settings > Secrets
#
# Endereço e CA vêm do contexto que você já usa (context-goga-cluster-c76n2d3iq3a); o token, do Secret que o controlador
# preencheu. Nada aqui é gravado em disco.
set -euo pipefail

CONTEXT="${KUBE_CONTEXT:-context-goga-cluster-c76n2d3iq3a}"
NAMESPACE=goga

cluster=$(kubectl config view --raw --minify --context "$CONTEXT" -o jsonpath='{.contexts[0].context.cluster}')
server=$(kubectl config view --raw --minify --context "$CONTEXT" -o jsonpath='{.clusters[0].cluster.server}')
ca=$(kubectl config view --raw --minify --context "$CONTEXT" -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')
token=$(kubectl --context "$CONTEXT" -n "$NAMESPACE" get secret goga-github-deployer-token -o jsonpath='{.data.token}' | base64 -d)

if [[ -z "$token" ]]; then
  echo "Token vazio: aplique deploy/k8s/github-deployer.yaml e espere o controlador preencher o Secret." >&2
  exit 1
fi

cat <<EOF
apiVersion: v1
kind: Config
clusters:
  - name: ${cluster}
    cluster:
      server: ${server}
      certificate-authority-data: ${ca}
users:
  - name: goga-github-deployer
    user:
      token: ${token}
contexts:
  - name: goga
    context:
      cluster: ${cluster}
      user: goga-github-deployer
      namespace: ${NAMESPACE}
current-context: goga
EOF

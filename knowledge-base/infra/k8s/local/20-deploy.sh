#!/usr/bin/env bash
# Aplica a stack no cluster e espera os rollouts.
#
# Espelha o 20-deploy.sh do agentic-sdlc: kustomize apply, segredos vindos de um
# .env fora do git, ConfigMap do Keycloak criado condicionalmente para ligar a
# auth, e espera explicita de cada deployment.
set -euo pipefail

NS="${NS:-stack-knowledge-base}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$here/../../.." && pwd)"

# O .env da RAIZ DESTE repositorio e a unica fonte de configuracao. Ele fica
# fora do git (carrega a chave do Azure); o .env.example ao lado diz o que
# preencher. Variavel ja exportada no ambiente vence o arquivo, que e o que
# permite CI e script chamarem sem escrever arquivo nenhum.
ENV_FILE="${ENV_FILE:-$REPO/.env}"

# Variavel ja exportada no ambiente vence o arquivo (`${!1}` e a indirecao do
# bash: env_val FOO le $FOO). E o que permite CI e script chamarem sem escrever
# arquivo nenhum, e sobrescrever um valor pontual sem editar o .env.
env_val() {
  local do_ambiente="${!1:-}"
  if [[ -n "$do_ambiente" ]]; then printf '%s' "$do_ambiente"; return; fi
  [[ -f "$ENV_FILE" ]] && grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- \
    | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//" || true
}

if [[ ! -f "$ENV_FILE" ]]; then
  echo "!! $ENV_FILE nao existe."
  echo "   cp $REPO/.env.example $REPO/.env  e preencha a credencial do modelo."
fi

echo "== kubectl apply -k"
kubectl apply -k "$here"

# ── segredos: chave de cifra + token de servico ────────────────────────────
#
# ENDPOINT E CHAVE DE IA NAO ESTAO MAIS AQUI. O provedor (Azure OpenAI, OpenAI,
# Azure AI Foundry, LiteLLM) e cadastrado na tela Administracao > Modelos de IA
# e guardado no banco, cifrado. O que o deploy precisa entregar e so a chave que
# CIFRA -- e ela e gerada uma vez e preservada, porque troca-la torna ilegiveis
# as credenciais ja cadastradas.
EXISTING_SECRET_KEY="$(kubectl -n "$NS" get secret knowledge-base-secret \
  -o jsonpath='{.data.KB_SECRET_KEY}' 2>/dev/null | base64 -d 2>/dev/null || true)"
SECRET_KEY="${EXISTING_SECRET_KEY:-$(env_val KB_SECRET_KEY)}"
SECRET_KEY="${SECRET_KEY:-$(openssl rand -hex 32)}"

# Token de servico: reaproveita o que ja existe para nao invalidar o que esta
# gravado no Claude Desktop / Cursor a cada deploy.
EXISTING_TOKEN="$(kubectl -n "$NS" get secret knowledge-base-secret \
  -o jsonpath='{.data.KB_SERVICE_TOKEN}' 2>/dev/null | base64 -d 2>/dev/null || true)"
SERVICE_TOKEN="${EXISTING_TOKEN:-kb_$(openssl rand -hex 24)}"

# Escopo do token de servico. Sai do MESMO valor que o kb-api usa como grupo de
# administracao: se os dois divergirem, o token de servico deixa de alcancar os
# Espacos sem nenhuma mensagem -- a busca simplesmente volta vazia.
#
# Hoje e um token so, com escopo de administrador. O desenho alvo e um token
# POR agente de runtime, somente-leitura nos Espacos da competencia dele
# (WP-11, `planning/05-IDENTIDADE-E-DADOS.md` §3); ate la, quem usa este token
# sao os harnesses de IA de quem desenvolve, nao um agente em producao.
ADMIN_GROUP="$(env_val KB_ADMIN_GROUP)"; ADMIN_GROUP="${ADMIN_GROUP:-/goga/curadoria}"

kubectl -n "$NS" create secret generic knowledge-base-secret \
  --from-literal=KB_SECRET_KEY="$SECRET_KEY" \
  --from-literal=KB_SERVICE_TOKEN="$SERVICE_TOKEN" \
  --from-literal=KB_SERVICE_TOKEN_GROUPS="$ADMIN_GROUP" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

echo "== IA: cadastre o provedor na tela (Administracao > Modelos de IA)"
echo "   Sem provedor a busca sobe e funciona, mas fica SO lexical."

# ── Identity: liga a auth apontando para o Keycloak do Goga ────────────────
#
# O issuer e o Keycloak do Goga (WP-04), que vive no cluster k3d `goga` e e
# publicado no host. Este cluster e OUTRO, de proposito: os dois tem ciclo de
# vida diferente, e recriar o do Goga nao pode derrubar o repertorio ja
# ingerido aqui.
#
# O navegador e o kb-api usam o MESMO endereco (`kc.localtest.me`), que e o
# ponto do ADR-0023: o `iss` do token tem de ser o mesmo string dos dois lados.
# Por isso KB_KEYCLOAK_INTERNAL_ISSUER fica vazio aqui. Ele continua existindo
# no kb-api para o ambiente em que os dois enderecos realmente divergem (PROD
# atras de ingress), e nao para remendar DNS de laboratorio.
KC_BASE="$(env_val KB_KEYCLOAK_URL)"; KC_BASE="${KC_BASE:-http://kc.localtest.me:8481}"
KC_REALM="$(env_val KB_KEYCLOAK_REALM)"; KC_REALM="${KC_REALM:-goga-interno}"
KC_CLIENT="$(env_val KB_KEYCLOAK_CLIENT_ID)"; KC_CLIENT="${KC_CLIENT:-kb-ui}"
KC_ISSUER="${KB_KEYCLOAK_ISSUER:-$KC_BASE/realms/$KC_REALM}"

# ── o nome do issuer resolvendo DE DENTRO do cluster ───────────────────────
#
# Este e o ponto que quebra em silencio. `kc.localtest.me` e um nome publico
# que resolve para 127.0.0.1/::1: no navegador do host isso e o Keycloak
# publicado, mas DENTRO de um pod e o proprio pod. O curl morre com
# "Could not connect", o kb-api nao consegue buscar a JWKS, e a UI mostra
# "sessao expirada" sem nenhum erro de configuracao.
#
# O cluster do Goga resolve isso com `--host-alias` na criacao do cluster. AQUI
# nao da para fazer o mesmo: `--host-alias` so vale em `k3d cluster create`, e
# este cluster ja existe com o repertorio ingerido nos PVCs do Postgres, do
# MinIO e do Memgraph. Recriar o cluster para mudar uma entrada de DNS destroi
# exatamente o que a separacao em dois clusters existia para proteger.
#
# Entao a entrada entra no `NodeHosts` do configmap `coredns`, que e de onde o
# CoreDNS le os nomes de no. Roda em todo deploy de proposito: e idempotente
# (reescreve a linha em vez de empilhar) e sobrevive a recriacao do cluster,
# porque o cluster recriado tambem passa por aqui. Fica neste script, e nao no
# 00-cluster-up.sh, porque o nome vem do issuer CONFIGURADO: quando o issuer
# mudar, o alias muda junto, sem ninguem lembrar de editar dois arquivos.
KC_HOST="$(printf '%s' "$KC_BASE" | sed -E 's#^[a-z]+://##; s#[:/].*$##')"
if [[ -n "$KC_HOST" && "$KC_HOST" != "localhost" ]]; then
  HOSTS_ATUAL="$(kubectl -n kube-system get cm coredns -o jsonpath='{.data.NodeHosts}' 2>/dev/null || true)"
  # O IP do gateway do Docker sai do proprio NodeHosts: o k3d ja gravou ali o
  # `host.k3d.internal` apontando para ele na criacao do cluster. Descobrir de
  # novo custaria subir um container so para rodar `getent`.
  GATEWAY="$(printf '%s\n' "$HOSTS_ATUAL" | awk '$2 == "host.k3d.internal" {print $1; exit}')"
  if [[ -z "$GATEWAY" ]]; then
    echo "!! nao achei host.k3d.internal no coredns; $KC_HOST nao vai resolver no pod"
  else
    # A comparacao e pela LINHA, nao pelo arquivo inteiro: o k3s reconstroi o
    # NodeHosts a partir de um map de Go, entao a ORDEM das linhas muda sozinha
    # entre reconciliacoes. Comparar o texto todo faria o CoreDNS reiniciar em
    # praticamente todo deploy, sem nada ter mudado.
    JA_TEM="$(printf '%s\n' "$HOSTS_ATUAL" | awk -v h="$KC_HOST" -v ip="$GATEWAY" '$2 == h && $1 == ip')"
    if [[ -z "$JA_TEM" ]]; then
      HOSTS_NOVO="$( { printf '%s\n' "$HOSTS_ATUAL" | awk -v h="$KC_HOST" '$2 != h && NF'
                       printf '%s %s\n' "$GATEWAY" "$KC_HOST"; } )"
      echo "== coredns: $KC_HOST → $GATEWAY (alias do issuer)"
      python3 -c 'import json,sys; print(json.dumps({"data": {"NodeHosts": sys.argv[1] + "\n"}}))' \
        "$HOSTS_NOVO" > "${TMPDIR:-/tmp}/kb-coredns-patch.json"
      kubectl -n kube-system patch cm coredns --type merge \
        --patch-file "${TMPDIR:-/tmp}/kb-coredns-patch.json" >/dev/null
      rm -f "${TMPDIR:-/tmp}/kb-coredns-patch.json"
      # O plugin `hosts` releria o arquivo em 15s, mas o kubelet leva ate um
      # minuto para propagar o configmap no volume. Reiniciar torna o proximo
      # passo (a verificacao de dentro do pod) deterministico em vez de uma
      # corrida que falha de vez em quando.
      kubectl -n kube-system rollout restart deploy/coredns >/dev/null
      kubectl -n kube-system rollout status deploy/coredns --timeout=120s >/dev/null
    fi
  fi
fi

if [[ -n "$KC_ISSUER" ]]; then
  echo "== identity: auth JWT LIGADA"
  echo "   issuer: $KC_ISSUER"
  echo "   client: $KC_CLIENT"
  echo "   admin:  $ADMIN_GROUP"
  # KB_ADMIN_GROUP entra AQUI, e nao so no config.yaml: os nomes de grupo sao
  # do realm, entao pertencem ao mesmo bloco de configuracao que o issuer.
  # Separa-los deixaria trocar de realm sem trocar o grupo, e o sintoma disso
  # e uma base que parece vazia para todo mundo.
  kubectl -n "$NS" create configmap keycloak-config \
    --from-literal=KB_KEYCLOAK_ISSUER="$KC_ISSUER" \
    --from-literal=KB_KEYCLOAK_INTERNAL_ISSUER="${KB_KEYCLOAK_INTERNAL_ISSUER:-}" \
    --from-literal=KB_ADMIN_GROUP="$ADMIN_GROUP" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null

  # Configuracao de RUNTIME da UI (env.js). Sai daqui e nao do build porque a
  # mesma imagem tem de servir local, dev e prod -- que tem issuers diferentes.
  kubectl -n "$NS" create configmap kb-ui-config \
    --from-literal=KEYCLOAK_URL="$KC_BASE" \
    --from-literal=KEYCLOAK_REALM="$KC_REALM" \
    --from-literal=KEYCLOAK_CLIENT_ID="$KC_CLIENT" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null

  # Falha cedo e com o motivo: sem alcancar o issuer, o kb-api sobe e recusa
  # TODO token com "issuer inesperado" -- diagnostico que custa meia hora.
  #
  # Sao DOIS testes, nao um. O do host prova o caminho do navegador; o de
  # dentro do pod prova o caminho do kb-api. Sao os dois lados do mesmo
  # string de `iss`, e ja aconteceu de um passar e o outro nao.
  if ! curl -fsS -m 15 "$KC_ISSUER/.well-known/openid-configuration" >/dev/null 2>&1; then
    echo "!! o issuer nao respondeu DO HOST: $KC_ISSUER/.well-known/openid-configuration"
    echo "   A stack sobe, mas nenhum login vai funcionar. O Keycloak do Goga esta de pe?"
  fi
  if ! kubectl -n "$NS" run verifica-issuer-$RANDOM \
      --rm -i --restart=Never --quiet --timeout=120s \
      --image=curlimages/curl:8.11.1 --command -- \
      curl -fsS -m 15 "$KC_ISSUER/.well-known/openid-configuration" >/dev/null 2>&1; then
    echo "!! o issuer nao respondeu DE DENTRO DO POD: $KC_ISSUER"
    echo "   O alias de $KC_HOST no coredns nao pegou (ADR-0023). O login da UI"
    echo "   comeca e morre na validacao do token, sem erro de configuracao."
  fi
else
  echo "== identity: sem issuer → auth desligada (dev offline)"
  kubectl -n "$NS" delete configmap keycloak-config --ignore-not-found >/dev/null 2>&1 || true
  kubectl -n "$NS" delete configmap kb-ui-config --ignore-not-found >/dev/null 2>&1 || true
fi

# ── ngrok: tunel publico, opcional ─────────────────────────────────────────
# `http://localhost:8890` so existe nesta maquina. Sem tunel, conectar o editor
# no MCP e uma demonstracao de uma pessoa so -- nao da para mostrar ao time nem
# deixar alguem testar da propria maquina.
#
# So sobe se houver authtoken: sem ele o pod ficaria em CrashLoopBackOff e o
# ambiente pareceria quebrado por causa de um recurso OPCIONAL.
NGROK_TOKEN="$(env_val NGROK_AUTHTOKEN)"
if [[ -n "$NGROK_TOKEN" ]]; then
  echo "== ngrok: tunel publico LIGADO"
  kubectl -n "$NS" create secret generic ngrok-secret \
    --from-literal=NGROK_AUTHTOKEN="$NGROK_TOKEN" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  kubectl apply -f "$here/ngrok.yaml" >/dev/null
else
  echo "== ngrok: sem NGROK_AUTHTOKEN → tunel desligado (opcional)"
  echo "   para ligar: preencha NGROK_AUTHTOKEN no .env e rode de novo"
  kubectl -n "$NS" delete deploy ngrok --ignore-not-found >/dev/null 2>&1 || true
  kubectl -n "$NS" delete svc ngrok --ignore-not-found >/dev/null 2>&1 || true
fi

# ── espera ─────────────────────────────────────────────────────────────────
_wait() {
  local deploy="$1" timeout="$2"
  echo "== aguardando $deploy"
  kubectl -n "$NS" rollout status "deploy/$deploy" --timeout="$timeout" || {
    echo "!! $deploy nao ficou pronto; ultimos eventos:"
    kubectl -n "$NS" get events --sort-by=.lastTimestamp | tail -8
    return 1
  }
}

_wait postgres 300s
_wait minio 300s
_wait memgraph 300s

# kb-api e kb-ui precisam reiniciar para pegar secret/configmap novos.
kubectl -n "$NS" rollout restart deploy/kb-api >/dev/null 2>&1 || true
kubectl -n "$NS" rollout restart deploy/kb-ui  >/dev/null 2>&1 || true
_wait kb-api 600s
_wait kb-ui 300s
if [[ -n "$NGROK_TOKEN" ]]; then
  # Nao fatal: pod Ready nao prova que o tunel registrou (conta free com outra
  # sessao devolve ERR_NGROK_334), e o ambiente funciona sem ele.
  _wait ngrok 120s || {
    echo "   !! o tunel nao subiu. Log do agente:"
    kubectl -n "$NS" logs deploy/ngrok --tail=8 2>&1 | sed 's/^/      /'
  }
fi

echo
echo "== stack no ar"
echo "   UI:       http://localhost:8890/"
echo "   API:      http://localhost:8890/v1/health"
echo "   MCP:      http://localhost:8890/mcp"
echo "   Identity: $KC_ISSUER (client $KC_CLIENT)"
if [[ -n "$NGROK_TOKEN" ]]; then
  PUBLICA="$(kubectl -n "$NS" exec deploy/ngrok -- \
    wget -qO- http://localhost:4040/api/tunnels 2>/dev/null |
    python3 -c 'import sys,json;print((json.load(sys.stdin).get("tunnels") or [{}])[0].get("public_url",""))' 2>/dev/null || true)"
  [[ -n "$PUBLICA" ]] && echo "   Publica:  $PUBLICA  (UI, API e MCP pela mesma URL)"
fi
echo "   token de servico: kubectl -n $NS get secret knowledge-base-secret -o jsonpath='{.data.KB_SERVICE_TOKEN}' | base64 -d"

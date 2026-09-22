#!/bin/sh
# Boot do container da UI: materializa o env.js do bundle e o default.conf do
# nginx a partir dos templates, depois entrega o processo ao nginx.
set -eu

# Endereco do `resolver` do nginx (ver o comentario no nginx.conf). Vem do
# resolv.conf do PROPRIO container, que e quem sabe a verdade em cada ambiente:
# no k8s o kubelet injeta o ClusterIP do CoreDNS, no docker o 127.0.0.11.
# Endereco IPv6 precisa de colchetes no nginx.
if [ -z "${NGINX_RESOLVER:-}" ]; then
  NGINX_RESOLVER=$(awk '/^nameserver/ { print ($2 ~ /:/) ? "["$2"]" : $2 }' /etc/resolv.conf | tr '\n' ' ')
fi
NGINX_RESOLVER=${NGINX_RESOLVER:-127.0.0.11}
export NGINX_RESOLVER

# Completa o host do upstream para FQDN.
#
# O resolver PROPRIO do nginx nao e a libc: ele consulta o nome exatamente como
# esta escrito e NAO aplica a lista `search` do resolv.conf. Um alvo curto como
# `kb-api.stack-knowledge-base` -- que so resolve porque a libc tenta
# `...svc.cluster.local` -- viraria `Host not found` e 502 em TODO o /v1.
fqdn_for() {
  host=$1
  case "$host" in
    *.)                          printf '%s' "${host%.}"; return ;;
    *:*)                         printf '%s' "$host"; return ;;
    [0-9]*.[0-9]*.[0-9]*.[0-9]*) printf '%s' "$host"; return ;;
  esac

  search=$(awk '/^search[ \t]/ { $1=""; print; exit }' /etc/resolv.conf)
  for domain in $search; do
    if getent hosts "$host.$domain" >/dev/null 2>&1; then
      printf '%s' "$host.$domain"; return
    fi
  done
  if getent hosts "$host" >/dev/null 2>&1; then
    printf '%s' "$host"; return
  fi

  # Nada resolveu AGORA, e isso nao pode virar erro: o ponto desta imagem e
  # subir mesmo com a API fora do ar. Completa pelo formato do nome.
  case "$host" in
    *.*.*) printf '%s' "$host" ;;
    *.*)   printf '%s' "$host.$(for d in $search; do case "$d" in svc.*) echo "$d"; break ;; esac; done)" ;;
    *)     printf '%s' "$host.$(printf '%s' "$search" | awk '{print $1}')" ;;
  esac
}

complete_target() {
  value=$1
  [ -n "$value" ] || { printf ''; return; }
  host=$(printf '%s' "$value" | sed -e 's|^[a-zA-Z][a-zA-Z0-9+.-]*://||' -e 's|[:/?].*$||')
  fqdn=$(fqdn_for "$host")
  if [ -n "$fqdn" ] && [ "$fqdn" != "$host" ]; then
    echo "entrypoint: upstream '$host' completado para '$fqdn'" >&2
    printf '%s' "$(printf '%s' "$value" | sed -e "s|//$host|//$fqdn|")"
  else
    printf '%s' "$value"
  fi
}

API_PROXY_TARGET=$(complete_target "${API_PROXY_TARGET:-http://kb-api}")
export API_PROXY_TARGET

envsubst < /usr/share/nginx/html/env.template.js > /usr/share/nginx/html/env.js
envsubst '$API_PROXY_TARGET $NGINX_RESOLVER' \
  < /etc/nginx/template/default.conf.template \
  > /etc/nginx/conf.d/default.conf

# Devolve o boot ao entrypoint da imagem oficial em vez de chamar o nginx
# direto: ele so roda os scripts de /docker-entrypoint.d/ quando o comando
# comeca com `nginx` -- e e la que mora o ajuste de worker_processes pela quota
# de CPU do cgroup.
exec /docker-entrypoint.sh nginx -g 'daemon off;'

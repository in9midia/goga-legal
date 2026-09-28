#!/usr/bin/env bash
# Restaura um backup feito por scripts/backup.sh.
#
#   ./scripts/restore.sh <pasta-do-backup> --verificar
#       NAO mexe em nada: restaura os dumps em bancos temporarios, compara a
#       contagem de linhas com os bancos atuais e confere os tar.gz. Rode de vez
#       em quando — backup que nunca foi restaurado nao e backup.
#
#   ./scripts/restore.sh <pasta-do-backup> [--codigo] [--dev]
#       SUBSTITUI os dados do cluster local pelos do backup:
#         1. confere os SHA256SUMS
#         2. repoe os .env que estiverem faltando (nunca sobrescreve)
#         3. sobe cluster + stacks se ainda nao existirem (./start-k8s-local.sh)
#         4. aplica os segredos do backup (chaves de cifra, token de servico)
#         5. para kb-api, studio-api e minio; recria os bancos; repoe os PVCs
#         6. religa tudo
#       --codigo  extrai tambem worktree.tar.gz (trabalho nao commitado) por cima
#                 do repositorio, sobrescrevendo esses arquivos.
#       --dev     restaura tambem o banco `studio` do container postgresvec.
#
# Maquina nova, do zero:
#   git clone <pasta-do-backup>/repo.bundle goga-legal   (ou clone do GitHub)
#   cd goga-legal && git checkout $(cat <pasta-do-backup>/repo.head)   (se precisar)
#   ./scripts/restore.sh <pasta-do-backup> --codigo
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CTX="${KUBE_CONTEXT:-k3d-knowledge-base}"
KB_NS="${KB_NS:-stack-knowledge-base}"
STUDIO_NS="${STUDIO_NS:-stack-studio}"
DEV_PG_CONTAINER="${DEV_PG_CONTAINER:-postgresvec}"

src="${1:-}"
[[ -n "$src" && -d "$src" ]] || { echo "uso: $0 <pasta-do-backup> [--verificar|--codigo|--dev]"; exit 2; }
src="$(cd "$src" && pwd)"
shift
verify=0; code=0; dev=0
for a in "$@"; do
  case "$a" in
    --verificar) verify=1 ;;
    --codigo) code=1 ;;
    --dev) dev=1 ;;
    *) echo "opcao desconhecida: $a"; exit 2 ;;
  esac
done

k() { kubectl --context "$CTX" "$@"; }
log() { printf '== %s\n' "$*"; }
die() { printf '!! %s\n' "$*" >&2; exit 1; }

[[ -e "$src/.incompleto" ]] && die "$src esta marcado como incompleto"

log "conferindo SHA256SUMS"
(cd "$src" && shasum -a 256 -c SHA256SUMS --quiet) || die "checksum nao bate — backup corrompido"

psql_pod() { # ns deploy user sql
  k -n "$1" exec "deploy/$2" -- psql -U "$3" -d postgres -v ON_ERROR_STOP=1 -qAtc "$4"
}

restore_db() { # ns deploy user db dump
  psql_pod "$1" "$2" "$3" "DROP DATABASE IF EXISTS \"$4\" WITH (FORCE)"
  psql_pod "$1" "$2" "$3" "CREATE DATABASE \"$4\" OWNER \"$3\""
  k -n "$1" exec -i "deploy/$2" -- pg_restore -U "$3" -d "$4" --no-owner --exit-on-error <"$src/$5"
}

# Contagem exata por tabela, para comparar original x restaurado.
counts() { # ns deploy user db
  k -n "$1" exec "deploy/$2" -- psql -U "$3" -d "$4" -qAt -c "
    select format('select %L || ''='' || count(*) from %I.%I;', schemaname||'.'||relname, schemaname, relname)
    from pg_stat_user_tables order by 1" \
  | k -n "$1" exec -i "deploy/$2" -- psql -U "$3" -d "$4" -qAt -v ON_ERROR_STOP=1
}

pvc_target() { # ns pvc -> "node path"
  local pv
  pv="$(k -n "$1" get pvc "$2" -o jsonpath='{.spec.volumeName}')"
  echo "$(k get pv "$pv" -o jsonpath='{.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values[0]}') $(k get pv "$pv" -o jsonpath='{.spec.local.path}{.spec.hostPath.path}')"
}

restore_pvc() { # ns pvc arquivo
  local node path
  read -r node path <<<"$(pvc_target "$1" "$2")"
  [[ -n "$node" && "$path" == /var/lib/rancher/k3s/storage/* ]] || die "PV de $1/$2 nao encontrado"
  docker exec "$node" sh -c "find '$path' -mindepth 1 -maxdepth 1 -exec rm -rf {} +"
  gzip -dc "$src/$3" | docker exec -i "$node" tar -C "$path" -xf -
}

# ── modo verificacao ────────────────────────────────────────────────────────
if [[ "$verify" -eq 1 ]]; then
  k get ns "$KB_NS" >/dev/null || die "cluster $CTX inacessivel"
  bad=0
  check_db() { # ns deploy user db dump
    local tmp="restore_check_$$"
    log "restaurando $5 em $1/$tmp"
    restore_db "$1" "$2" "$3" "$tmp" "$5"
    counts "$1" "$2" "$3" "$4" >"$src/.orig.txt"
    counts "$1" "$2" "$3" "$tmp" >"$src/.rest.txt"
    psql_pod "$1" "$2" "$3" "DROP DATABASE \"$tmp\" WITH (FORCE)"
    if [[ ! -s "$src/.rest.txt" ]]; then
      echo "   FALHOU: nenhuma tabela contada"; bad=1
    elif diff -q "$src/.orig.txt" "$src/.rest.txt" >/dev/null; then
      echo "   ok: $(wc -l <"$src/.rest.txt" | tr -d ' ') tabelas com a mesma contagem do banco atual"
    else
      echo "   diferencas (atual < | > backup) — normal se houve escrita depois do backup:"
      { diff "$src/.orig.txt" "$src/.rest.txt" || true; } | grep '^[<>]' | sed 's/^/     /' | awk 'NR<=20'
    fi
    rm -f "$src/.orig.txt" "$src/.rest.txt"
  }
  check_db "$KB_NS" postgres knowledge_base knowledge_base kb-postgres.dump
  check_db "$STUDIO_NS" studio-postgres studio studio studio-postgres.dump
  for f in kb-minio.tar.gz studio-files.tar.gz worktree.tar.gz; do
    n="$(gzip -dc "$src/$f" | tar -tf - | wc -l | tr -d ' ')" || { echo "   FALHOU: $f"; bad=1; continue; }
    echo "   ok: $f ($n entradas)"
  done
  git bundle verify "$src/repo.bundle" >/dev/null 2>&1 && echo "   ok: repo.bundle" || { echo "   FALHOU: repo.bundle"; bad=1; }
  exit "$bad"
fi

# ── restauracao ─────────────────────────────────────────────────────────────
log ".env"
for f in $(cd "$src/env" 2>/dev/null && find . -type f | sed 's|^\./||'); do
  if [[ -e "$root/$f" ]]; then
    cmp -s "$src/env/$f" "$root/$f" || echo "   $f ja existe e difere do backup — mantido (compare na mao)"
  else
    mkdir -p "$(dirname "$root/$f")"; cp "$src/env/$f" "$root/$f"; echo "   $f reposto"
  fi
done

if [[ "$code" -eq 1 ]]; then
  log "codigo nao commitado (worktree.tar.gz)"
  tar -C "$root" -xzf "$src/worktree.tar.gz"
fi

if ! k get deploy -n "$KB_NS" postgres >/dev/null 2>&1 || ! k get deploy -n "$STUDIO_NS" studio-postgres >/dev/null 2>&1; then
  log "stacks ausentes — subindo com ./start-k8s-local.sh"
  "$root/start-k8s-local.sh"
fi

echo
echo "   Isto SUBSTITUI os bancos e arquivos do cluster $CTX pelos de:"
echo "   $src ($(grep '^criado' "$src/MANIFEST" 2>/dev/null))"
read -r -p "   digite 'restaurar' para continuar: " ok
[[ "$ok" == "restaurar" ]] || die "cancelado"

log "segredos"
k apply -f "$src/k8s-secrets.yaml" >/dev/null

log "parando quem escreve"
k -n "$KB_NS" scale deploy/kb-api deploy/minio --replicas=0 >/dev/null
k -n "$STUDIO_NS" scale deploy/studio-api --replicas=0 >/dev/null
k -n "$KB_NS" wait --for=delete pod -l app=kb-api --timeout=180s >/dev/null 2>&1 || true
k -n "$KB_NS" wait --for=delete pod -l app=minio --timeout=180s >/dev/null 2>&1 || true
k -n "$STUDIO_NS" wait --for=delete pod -l app=studio-api --timeout=180s >/dev/null 2>&1 || true

log "banco da KB"
restore_db "$KB_NS" postgres knowledge_base knowledge_base kb-postgres.dump
log "banco do Studio"
restore_db "$STUDIO_NS" studio-postgres studio studio studio-postgres.dump
log "PVC minio-data"
restore_pvc "$KB_NS" minio-data kb-minio.tar.gz
log "PVC studio-files"
restore_pvc "$STUDIO_NS" studio-files studio-files.tar.gz

log "religando"
k -n "$KB_NS" scale deploy/minio deploy/kb-api --replicas=1 >/dev/null
k -n "$STUDIO_NS" scale deploy/studio-api --replicas=1 >/dev/null
k -n "$KB_NS" rollout status deploy/minio --timeout=180s
k -n "$KB_NS" rollout status deploy/kb-api --timeout=300s
k -n "$STUDIO_NS" rollout status deploy/studio-api --timeout=300s

if [[ "$dev" -eq 1 && -f "$src/dev-studio.dump" ]]; then
  log "banco de dev ($DEV_PG_CONTAINER/studio)"
  su="$(docker inspect "$DEV_PG_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_USER=//p')"
  su="${su:-postgres}"
  docker exec "$DEV_PG_CONTAINER" psql -U "$su" -d postgres -v ON_ERROR_STOP=1 -qc \
    "DO \$\$BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='studio') THEN CREATE ROLE studio LOGIN PASSWORD 'studio'; END IF; END\$\$"
  docker exec "$DEV_PG_CONTAINER" psql -U "$su" -d postgres -v ON_ERROR_STOP=1 -qc 'DROP DATABASE IF EXISTS studio WITH (FORCE)'
  docker exec "$DEV_PG_CONTAINER" psql -U "$su" -d postgres -v ON_ERROR_STOP=1 -qc 'CREATE DATABASE studio OWNER studio'
  docker exec -i "$DEV_PG_CONTAINER" pg_restore -U "$su" -d studio --role=studio --no-owner --exit-on-error <"$src/dev-studio.dump"
fi

echo
echo "✅ restaurado de $src"

#!/usr/bin/env bash
# Backup completo do ambiente local do Goga — o suficiente para reconstruir tudo
# numa maquina nova com scripts/restore.sh.
#
#   ./scripts/backup.sh                 grava em $GOGA_BACKUP_DIR (padrao ~/goga-backups)
#   ./scripts/backup.sh /Volumes/Disco  grava em outro destino (disco externo, iCloud...)
#
# O que entra (tudo lido a quente, sem parar nada):
#   kb-postgres.dump        banco da KB (pgvector) — pg_dump -Fc
#   kb-minio.tar.gz         PVC minio-data inteiro (originais dos documentos)
#   studio-postgres.dump    banco do Studio no k3d — pg_dump -Fc
#   studio-files.tar.gz     PVC studio-files (arquivos do studio-api)
#   dev-studio.dump         banco `studio` do container postgresvec (dev, se estiver de pe)
#   k8s-secrets.yaml        studio-secrets + knowledge-base-secret. CRITICO: STUDIO_SECRET_KEY
#                           e KB_SECRET_KEY cifram as credenciais de provedor gravadas nos
#                           bancos; sem eles o dump volta com as chaves ilegiveis.
#   env/                    .env da raiz, knowledge-base/.env, studio/api/.env
#   repo.bundle             git bundle --all (todos os commits e branches)
#   worktree.tar.gz         arquivos modificados e nao rastreados ainda nao commitados
#
# Fica de fora: Memgraph (sem volume, nao e usado) e imagens (o deploy reconstroi).
#
# O backup contem segredos: a pasta nasce com permissao 700. Copie-a para FORA
# desta maquina (disco externo, nuvem) — backup no mesmo disco nao protege de
# perda da maquina.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CTX="${KUBE_CONTEXT:-k3d-knowledge-base}"
KB_NS="${KB_NS:-stack-knowledge-base}"
STUDIO_NS="${STUDIO_NS:-stack-studio}"
DEV_PG_CONTAINER="${DEV_PG_CONTAINER:-postgresvec}"
KEEP="${GOGA_BACKUP_KEEP:-7}"
base="${1:-${GOGA_BACKUP_DIR:-$HOME/goga-backups}}"

# O contexto padrao do kubectl nesta maquina e um cluster remoto real: sempre
# explicito.
k() { kubectl --context "$CTX" "$@"; }

stamp="$(date +%Y%m%d-%H%M%S)"
out="$base/goga-$stamp"
mkdir -p "$base"
umask 077
mkdir "$out"
partial="$out/.incompleto"
touch "$partial"

log() { printf '== %s\n' "$*"; }
warn() { printf '!! %s\n' "$*" >&2; }
fail=0

# Falha de um item nao aborta os outros; o resumo final diz o que faltou.
step() {
  local name="$1"; shift
  log "$name"
  if ! "$@"; then warn "FALHOU: $name"; fail=1; fi
}

k get ns "$KB_NS" >/dev/null || { warn "cluster $CTX inacessivel — rode ./start-k8s-local.sh"; exit 1; }

pg_dump_pod() { # ns deploy db user arquivo
  k -n "$1" exec "deploy/$2" -- pg_dump -U "$4" -d "$3" -Fc >"$out/$5"
  [[ -s "$out/$5" ]]
}

# Le o PVC direto no no do k3d: a imagem do MinIO nao tem tar, e assim nao
# depende do que existe dentro do pod. O tar do no e busybox sem gzip: comprime
# aqui do lado de fora.
tar_pvc() { # ns pvc arquivo
  local pv path node
  pv="$(k -n "$1" get pvc "$2" -o jsonpath='{.spec.volumeName}')"
  path="$(k get pv "$pv" -o jsonpath='{.spec.local.path}{.spec.hostPath.path}')"
  node="$(k get pv "$pv" -o jsonpath='{.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values[0]}')"
  [[ -n "$path" && -n "$node" ]] || return 1
  docker exec "$node" tar -C "$path" -cf - . | gzip -c >"$out/$3"
  gzip -t "$out/$3"
}

dev_dump() {
  if ! docker ps --format '{{.Names}}' | grep -qx "$DEV_PG_CONTAINER"; then
    warn "container $DEV_PG_CONTAINER parado — pulando o banco de dev"
    return 0
  fi
  docker exec "$DEV_PG_CONTAINER" pg_dump -U studio -d studio -Fc >"$out/dev-studio.dump"
  [[ -s "$out/dev-studio.dump" ]]
}

secrets() {
  # Sem metadados de runtime, para aplicar limpo num cluster novo.
  k get secret -n "$STUDIO_NS" studio-secrets -o json >"$out/.s1.json"
  k get secret -n "$KB_NS" knowledge-base-secret -o json >"$out/.s2.json"
  python3 - "$out/.s1.json" "$out/.s2.json" >"$out/k8s-secrets.yaml" <<'PY'
import json, sys
for p in sys.argv[1:]:
    s = json.load(open(p))
    md = s["metadata"]
    s["metadata"] = {"name": md["name"], "namespace": md["namespace"]}
    print("---"); print(json.dumps(s))
PY
  rm -f "$out/.s1.json" "$out/.s2.json"
}

envs() {
  mkdir -p "$out/env"
  local f
  for f in .env knowledge-base/.env studio/api/.env; do
    [[ -f "$root/$f" ]] || continue
    mkdir -p "$out/env/$(dirname "$f")"
    cp "$root/$f" "$out/env/$f"
  done
}

repo() {
  git -C "$root" bundle create "$out/repo.bundle" --all >/dev/null 2>&1
  git -C "$root" rev-parse HEAD >"$out/repo.head"
  # Modificados + nao rastreados (respeitando .gitignore). Apagados nao entram.
  (cd "$root" && git ls-files -z -m -o --exclude-standard \
    | while IFS= read -r -d '' f; do if [[ -e "$f" ]]; then printf '%s\0' "$f"; fi; done \
    | tar --null -T - -czf "$out/worktree.tar.gz")
}

step "KB postgres (pgvector)"     pg_dump_pod "$KB_NS" postgres knowledge_base knowledge_base kb-postgres.dump
step "KB minio"                   tar_pvc "$KB_NS" minio-data kb-minio.tar.gz
step "Studio postgres (k3d)"      pg_dump_pod "$STUDIO_NS" studio-postgres studio studio studio-postgres.dump
step "Studio files"               tar_pvc "$STUDIO_NS" studio-files studio-files.tar.gz
step "Studio postgres (dev, $DEV_PG_CONTAINER)" dev_dump
step "segredos do cluster"        secrets
step ".env"                       envs
step "repositorio git"            repo

(cd "$out" && shasum -a 256 $(ls -A | grep -v '^\.incompleto$' | grep -v '^env$') > SHA256SUMS)
{
  echo "criado: $(date +%Y-%m-%dT%H:%M:%S%z)"
  echo "maquina: $(hostname)"
  echo "contexto: $CTX"
  echo "head: $(cat "$out/repo.head" 2>/dev/null)"
} >"$out/MANIFEST"

if [[ "$fail" -ne 0 ]]; then
  warn "backup INCOMPLETO em $out (marcado com .incompleto)"
  exit 1
fi
rm -f "$partial"

# Retencao: mantem os $KEEP mais recentes completos.
done_list=()
for d in "$base"/goga-*; do
  if [[ -d "$d" && ! -e "$d/.incompleto" ]]; then done_list+=("$d"); fi
done
excess=$(( ${#done_list[@]} - KEEP ))
for (( i = 0; i < excess; i++ )); do rm -rf "${done_list[$i]}"; done

du -sh "$out" | awk '{print "== pronto: " $2 " (" $1 ")"}'
echo "   copie para fora desta maquina, ex.: rsync -a \"$out\" /Volumes/<disco>/"

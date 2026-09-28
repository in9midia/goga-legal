#!/usr/bin/env bash
# Copia o bruto do MinIO do cluster para o bucket (AWS S3 ou OCI) descrito no .env.
#
#   ./30-migrar-storage.sh --dry-run        # so conta o que copiaria
#   ./30-migrar-storage.sh --verificar      # copia e compara origem x destino
#   ./30-migrar-storage.sh --so-verificar   # nao copia; so compara
#
# Roda como Job DENTRO do cluster, com a imagem do kb-api, e nao do host com
# port-forward: o port-forward do kubectl cai sozinho em transferencia longa, e
# 1 GB de bruto e exatamente o caso em que ele cai no meio.
#
# ORIGEM  o MinIO, pelo S3_* do configmap `knowledge-base-config`. O Job NAO
#         carrega o `storage-secret`: se carregasse, depois da virada a origem
#         passaria a ser o proprio destino.
# DESTINO o mesmo S3_* que o 20-deploy.sh usa para a virada (S3_BUCKET,
#         S3_REGION, S3_ACCESS_KEY...), lido do .env e entregue ao Job como
#         DEST_S3_*. Um lugar so para preencher: o bucket migrado e o bucket
#         que o kb-api vai usar.
#
# Nao apaga nada, em lado nenhum, e pode rodar quantas vezes quiser: o que ja
# esta no destino com o mesmo tamanho e pulado.
set -euo pipefail

NS="${NS:-stack-knowledge-base}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$here/../../.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO/.env}"
IMAGE="${IMAGE:-localhost:5112/ms-knowledge-base:dev}"
JOB="migrar-storage"

env_val() {
  local do_ambiente="${!1:-}"
  if [[ -n "$do_ambiente" ]]; then printf '%s' "$do_ambiente"; return; fi
  [[ -f "$ENV_FILE" ]] && grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- \
    | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//" || true
}

for chave in S3_BUCKET S3_REGION S3_ACCESS_KEY S3_SECRET_KEY; do
  if [[ -z "$(env_val "$chave")" ]]; then
    echo "!! $chave vazio no $ENV_FILE. Preencha o bloco de object storage (ver .env.example)."
    exit 1
  fi
done

# DEST_S3_PROVIDER vem do S3_PROVIDER do .env; vazio = aws, o padrao do destino.
args=()
for chave in S3_PROVIDER S3_NAMESPACE S3_BUCKET S3_REGION S3_ACCESS_KEY S3_SECRET_KEY \
             S3_SESSION_TOKEN S3_ENDPOINT S3_ADDRESSING S3_CREATE_BUCKET \
             S3_SSE S3_SSE_KMS_KEY_ID; do
  valor="$(env_val "$chave")"
  [[ -n "$valor" ]] && args+=("--from-literal=DEST_$chave=$valor")
done
kubectl -n "$NS" create secret generic storage-migracao-secret "${args[@]}" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

# Os argumentos viram lista JSON no manifesto; cada um entre aspas, escapado.
cmd='["python", "-m", "kb_api.migrar_storage"'
for arg in "$@"; do
  cmd+=", \"${arg//\"/\\\"}\""
done
cmd+=']'

kubectl -n "$NS" delete job "$JOB" --ignore-not-found >/dev/null 2>&1 || true
kubectl apply -f - >/dev/null <<YAML
apiVersion: batch/v1
kind: Job
metadata:
  name: $JOB
  namespace: $NS
spec:
  # Sem retentativa automatica: a copia ja e idempotente, e uma falha tem de
  # aparecer para quem roda, nao ser escondida por um segundo pod que passou.
  backoffLimit: 0
  ttlSecondsAfterFinished: 86400
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrar
          image: $IMAGE
          imagePullPolicy: Always
          command: $cmd
          envFrom:
            - configMapRef: { name: knowledge-base-config }
            - secretRef: { name: storage-migracao-secret }
          resources:
            # Cada copia segura o objeto inteiro na memoria; 8 em paralelo com
            # o maior upload aceito (KB_MAX_UPLOAD_MB=100) sao ~800 MB.
            requests: { cpu: "100m", memory: "256Mi" }
            limits: { cpu: "2", memory: "2Gi" }
YAML

echo "== job $JOB criado; acompanhando o log"
kubectl -n "$NS" wait --for=condition=Ready "pod" -l "job-name=$JOB" --timeout=300s >/dev/null 2>&1 || true
kubectl -n "$NS" logs -f "job/$JOB" || true

# O `logs -f` termina quando o container termina; o resultado vem do Job.
for _ in $(seq 1 30); do
  if [[ "$(kubectl -n "$NS" get job "$JOB" -o jsonpath='{.status.succeeded}')" == "1" ]]; then
    echo "== migracao OK"
    exit 0
  fi
  if [[ "$(kubectl -n "$NS" get job "$JOB" -o jsonpath='{.status.failed}')" == "1" ]]; then
    echo "!! migracao terminou com falha (ver log acima). Rodar de novo retoma de onde parou."
    exit 1
  fi
  sleep 2
done
echo "!! nao consegui ler o resultado do job; confira: kubectl -n $NS get job $JOB"
exit 1

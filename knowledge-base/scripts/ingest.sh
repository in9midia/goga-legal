#!/usr/bin/env bash
# Sobe uma pasta de documentos para um Espaco da base.
#
#   ./scripts/ingest.sh rh ../_bases/rh
#   ./scripts/ingest.sh juridico /caminho/dos/docs --label "Base Juridico"
#
# POR QUE EXISTE, se a UI ja tem "Enviar documentos": carga inicial e
# reprocessamento em massa. Subir 47 arquivos clicando e trabalho manual que
# nao deixa rastro; aqui o comando fica no historico e pode ir para um script.
#
# UM ARQUIVO POR VEZ, em serie. Em paralelo, cada arquivo carrega o pipeline de
# extracao no MESMO pod -- dois PDFs grandes ao mesmo tempo ja derrubaram o
# servico por falta de memoria. Lento de proposito.
set -euo pipefail

NS="${NS:-stack-knowledge-base}"
BASE_URL="${KB_URL:-http://localhost:8890}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$here/.." && pwd)"

vermelho() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
verde()    { printf '\033[32m%s\033[0m\n' "$*"; }
azul()     { printf '\033[36m%s\033[0m\n' "$*"; }

slug="${1:-}"
pasta="${2:-}"
shift 2 2>/dev/null || true

label=""
grupo=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --label) label="$2"; shift 2 ;;
    --group) grupo="$2"; shift 2 ;;
    *) vermelho "opcao desconhecida: $1"; exit 1 ;;
  esac
done

if [[ -z "$slug" || -z "$pasta" ]]; then
  cat <<USO
uso: ./scripts/ingest.sh <slug> <pasta> [--label "Nome"] [--group /Grupo]

  slug     identificador do Espaco (vira parte da URL e do escopo do MCP)
  pasta    diretorio com os documentos
  --label  nome exibido; padrao "Base <SLUG>"
  --group  grupo do Identity que ganha leitura. SEM ele o Espaco nasce
           alcancavel so por administradores -- de proposito: base nova com
           conteudo visivel por engano custa mais caro que base invisivel.
USO
  exit 1
fi

[[ -d "$pasta" ]] || { vermelho "pasta nao encontrada: $pasta"; exit 1; }
[[ -n "$label" ]] || label="Base $(printf '%s' "$slug" | tr '[:lower:]' '[:upper:]')"

# O token de servico vem do cluster. Nao pedimos que a pessoa cole token nenhum:
# quem consegue rodar kubectl aqui ja tem o acesso.
TOKEN="${KB_SERVICE_TOKEN:-$(kubectl -n "$NS" get secret knowledge-base-secret \
  -o jsonpath='{.data.KB_SERVICE_TOKEN}' 2>/dev/null | base64 -d 2>/dev/null || true)}"
if [[ -z "$TOKEN" ]]; then
  vermelho "sem token de servico. A stack esta de pe? ./start-k8s-local.sh status"
  exit 1
fi

curl -sf -o /dev/null "$BASE_URL/v1/health" || {
  vermelho "$BASE_URL nao responde. Suba com ./start-k8s-local.sh"
  exit 1
}

if [[ -n "$grupo" ]]; then
  grants="[{\"principal_type\":\"group\",\"principal_id\":\"$grupo\",\"role\":\"reader\"}]"
else
  grants="[]"
fi

azul "== Espaco $slug ($label)"
curl -sf -X POST "$BASE_URL/v1/spaces" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"slug\":\"$slug\",\"label\":\"$label\",\"grants\":$grants}" >/dev/null

# Extensoes que o pipeline sabe extrair. O resto e ignorado com aviso, em vez
# de virar um documento vazio que a busca devolveria como resultado valido.
EXTENSOES="pdf docx pptx xlsx xls txt md csv json html htm"
enviados=0; falhos=0; ignorados=0

while IFS= read -r -d '' arquivo; do
  ext="${arquivo##*.}"; ext="$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"
  if [[ " $EXTENSOES " != *" $ext "* ]]; then
    ignorados=$((ignorados + 1)); continue
  fi
  nome="$(basename "$arquivo")"
  printf '   %-58s ' "${nome:0:58}"
  # --max-time 3600: um PDF de 120 paginas com OCR ja levou 13,5 min. O padrao
  # do curl cortaria a conexao e o arquivo pareceria ter falhado -- quando na
  # verdade o servidor termina e grava normalmente.
  resposta="$(curl -s --max-time 3600 -X POST \
    "$BASE_URL/v1/spaces/$slug/documents" \
    -H "Authorization: Bearer $TOKEN" \
    -F "file=@$arquivo" 2>/dev/null || true)"
  # `grep -o | head -1`, e nao `sed` com `.*` na frente: a resposta tem MAIS DE
  # UM campo `status`. O do documento vem primeiro (`indexed`), e
  # `representations.grafo.status` vem depois (`ok`). Com `.*` guloso, o casamento
  # ia ate o ULTIMO e o script lia "ok" -- que nao e `indexed` e caia no ramo de
  # falha. Resultado: ingestao correta reportada como falha, com a resposta de
  # sucesso impressa em vermelho ao lado. Levou uma interrupcao de ingestao para
  # alguem desconfiar.
  estado="$(printf '%s' "$resposta" \
    | grep -o '"status"[[:space:]]*:[[:space:]]*"[a-z_]*"' \
    | head -1 | sed 's/.*"\([a-z_]*\)"$/\1/')"
  case "$estado" in
    indexed)
      # Mesmo cuidado do `status`: primeira ocorrencia, nao a ultima.
      filhos="$(printf '%s' "$resposta" \
        | grep -o '"children"[[:space:]]*:[[:space:]]*[0-9]*' \
        | head -1 | grep -o '[0-9]*$')"
      verde "ok (${filhos:-?} trechos)"; enviados=$((enviados + 1)) ;;
    *)
      vermelho "falhou: $(printf '%s' "$resposta" | head -c 160)"; falhos=$((falhos + 1)) ;;
  esac
done < <(find "$pasta" -type f -print0 | sort -z)

echo
verde "$enviados enviados"
[[ $falhos -gt 0 ]] && vermelho "$falhos com falha (reprocesse em Documentos, na UI)"
[[ $ignorados -gt 0 ]] && echo "$ignorados ignorados (extensao nao suportada)"
echo "veja em $BASE_URL/documentos?espaco=$slug"
exit 0

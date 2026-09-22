#!/usr/bin/env bash
# Popula a KB do MVP de ponta a ponta (planning/00-MVP-PLANO.md §5.4, fase F1).
#
#   GEMINI_API_KEY=... DEEPSEEK_API_KEY=... ./scripts/populate-kb.sh
#   SKIP_FETCH=1 ./scripts/populate-kb.sh     # usa content/legislacao como esta
#
# A ORDEM NAO E ESTETICA:
#
#   1. provedores  -- sem embedding padrao, todo upload falha no embedding e o
#                     documento fica `failed` (e o reprocesso e um por um);
#   2. Espacos     -- o upload direto na rota de documento nao cria Espaco;
#   3. auditoria, legislacao, modelos -- o conteudo;
#   4. Espacos DE NOVO -- o `ingest.sh` faz upsert do Espaco antes de subir e
#                     sobrescreve rotulo e descricao (a armadilha do
#                     content/README). Rodar o `apply-spaces.py` no fim
#                     reconverge sem duplicar nada;
#   5. export dos modelos para o seed do Studio.
#
# Tudo e idempotente: a ingestao reconhece conteudo ja indexado pelo sha256 e
# devolve `indexed` sem refazer, entao rodar de novo so gasta o download.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$here/.." && pwd)"
NS="${NS:-stack-knowledge-base}"
export KB_URL="${KB_URL:-http://localhost:8890}"

vermelho() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
verde()    { printf '\033[32m%s\033[0m\n' "$*"; }
azul()     { printf '\n\033[36m== %s\033[0m\n' "$*"; }

# ── 0. pre-condicoes ───────────────────────────────────────────────────────

faltam=()
[[ -n "${GEMINI_API_KEY:-}" ]]   || faltam+=("GEMINI_API_KEY")
[[ -n "${DEEPSEEK_API_KEY:-}" ]] || faltam+=("DEEPSEEK_API_KEY")
if [[ ${#faltam[@]} -gt 0 ]]; then
  vermelho "Faltam as chaves dos provedores de IA: ${faltam[*]}."
  vermelho "Exporte no terminal antes de rodar (nunca em arquivo versionado):"
  vermelho "  export GEMINI_API_KEY=...   # embedding (gemini-embedding-001)"
  vermelho "  export DEEPSEEK_API_KEY=... # chat, derivação de conceito OKF"
  vermelho "Sem elas nenhum documento é indexado: o upload falha no embedding."
  exit 1
fi

command -v uv >/dev/null || { vermelho "uv não encontrado (o apply-spaces roda no ambiente do kb-api)"; exit 1; }

curl -sf -o /dev/null "$KB_URL/v1/health" || {
  vermelho "A KB não responde em $KB_URL. Suba a stack com ./start-k8s-local.sh"
  exit 1
}

# Token: o do ambiente, o do secret do cluster, ou um marcador. A KB do MVP
# roda com auth desligada (§6 do plano), e nesse modo qualquer Bearer que nao
# seja o token de servico cai em `auth-desligada` com acesso total. O marcador
# existe porque `apply-spaces.py` e `ingest.sh` recusam rodar sem token, e
# essa recusa e correta quando a auth esta ligada -- nao queremos afrouxa-la la.
if [[ -z "${KB_SERVICE_TOKEN:-}" ]]; then
  KB_SERVICE_TOKEN="$(kubectl -n "$NS" get secret knowledge-base-secret \
    -o jsonpath='{.data.KB_SERVICE_TOKEN}' 2>/dev/null | base64 -d 2>/dev/null || true)"
fi
export KB_SERVICE_TOKEN="${KB_SERVICE_TOKEN:-auth-desligada}"

# Rotulo de um Espaco no spaces.yaml. O `ingest.sh` sem `--label` grava
# "Base <SLUG>" por cima do rotulo do arquivo.
rotulo() {
  (cd "$REPO/services/kb-api" && uv run --quiet -- python -c '
import sys, yaml
dados = yaml.safe_load(open("../../content/spaces.yaml", encoding="utf-8"))
print(next(e.get("label", e["slug"]) for e in dados["spaces"] if e["slug"] == sys.argv[1]))
' "$1")
}

ingerir_pastas() {
  local raiz="$1"
  for pasta in "$raiz"/*/; do
    [[ -d "$pasta" ]] || continue
    local slug; slug="$(basename "$pasta")"
    "$here/ingest.sh" "$slug" "$pasta" --label "$(rotulo "$slug")"
  done
}

# ── 1. provedores ──────────────────────────────────────────────────────────
azul "1/6 provedores de IA"
python3 "$here/register-providers.py"

# ── 2. Espacos e grants ────────────────────────────────────────────────────
azul "2/6 Espaços e permissões"
(cd "$REPO/services/kb-api" && uv run -- python ../../scripts/apply-spaces.py)

# ── 3. auditoria de citacoes ───────────────────────────────────────────────
azul "3/6 auditoria de citações"
ingerir_pastas "$REPO/content/auditoria-citacoes"

# ── 4. legislacao ──────────────────────────────────────────────────────────
azul "4/6 legislação primária"
if [[ "${SKIP_FETCH:-}" == "1" ]]; then
  python3 "$here/fetch-legislacao.py" --ingest-only
else
  python3 "$here/fetch-legislacao.py" --ingest
fi

# ── 5. modelos de documento ────────────────────────────────────────────────
azul "5/6 modelos de documento"
ingerir_pastas "$REPO/content/modelos"

# ── 6. reconvergencia e export ─────────────────────────────────────────────
azul "6/6 reconvergência dos Espaços e export dos templates do Studio"
(cd "$REPO/services/kb-api" && uv run -- python ../../scripts/apply-spaces.py)
(cd "$REPO/services/kb-api" && uv run -- python ../../scripts/export-templates.py)

verde ""
verde "KB populada. Confira em $KB_URL (Documentos) e rode a avaliação:"
verde "  cd services/kb-api && uv run -- python ../../scripts/load-evaluation.py"

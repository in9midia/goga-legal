#!/usr/bin/env bash
# Instala a skill goga-studio para o USUARIO (vale em qualquer pasta), como
# link simbolico para esta copia do repositorio: um `git pull` atualiza todas.
#
#   install.sh            Claude Code, Codex e Gemini CLI
#   install.sh claude     so um (claude | codex | gemini), pode repetir
#   install.sh --copy     copia em vez de linkar (ex.: repo em disco removivel)
#
# Dentro deste repositorio nao precisa instalar: Codex e Gemini leem
# .agents/skills/ e o Claude Code le .claude/skills/ (link para a mesma pasta).
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="$(basename "$SRC")"
MODE=link
TARGETS=()
for a in "$@"; do
  case "$a" in
    --copy) MODE=copy ;;
    claude|codex|gemini) TARGETS+=("$a") ;;
    *) echo "uso: $0 [claude|codex|gemini]... [--copy]" >&2; exit 2 ;;
  esac
done
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=(claude codex gemini)

install_to() {
  local dir="$1"
  mkdir -p "$dir"
  local dest="$dir/$NAME"
  if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$SRC" ]; then echo "  já instalado: $dest"; return; fi
  if [ -L "$dest" ] || [ -e "$dest" ]; then echo "  substituindo: $dest"; rm -rf "$dest"; fi
  if [ "$MODE" = copy ]; then cp -RL "$SRC" "$dest"; else ln -s "$SRC" "$dest"; fi
  echo "  ok: $dest"
}

for t in "${TARGETS[@]}"; do
  case "$t" in
    claude) echo "Claude Code"; install_to "$HOME/.claude/skills" ;;
    # ~/.agents/skills e lido pelo Codex e pelo Gemini CLI: um link so para os
    # dois (um segundo em ~/.gemini/skills faria o Gemini ver a skill duplicada).
    codex) echo "Codex"; install_to "$HOME/.agents/skills" ;;
    gemini) echo "Gemini CLI"; install_to "$HOME/.agents/skills" ;;
  esac
done

echo
echo "Próximo passo: crie um token em Studio → Agentes externos e rode"
echo "  node \"$SRC/scripts/goga.mjs\" configurar --url <url-do-studio> --token <goga_...>"

#!/usr/bin/env python3
"""Testes unitarios.

Chamado pelo pipeline como `uv run -- python -m scripts.test`.

O kb-api ainda nao tem suite unitaria: a verificacao real hoje e feita contra a
stack de pe (extracao, busca e permissao dependem de Postgres, MinIO e do
Identity, que nao cabem num teste unitario honesto). Enquanto for assim, este
script SAI COM SUCESSO quando nao ha teste -- e diz isso em voz alta, para a
ausencia aparecer no log em vez de virar um verde falso.
"""

from __future__ import annotations

import pathlib
import subprocess
import sys


def main() -> None:
    raiz = pathlib.Path(__file__).resolve().parent.parent
    testes = sorted((raiz / "tests").glob("test_*.py"))
    if not testes:
        print("⚠ nenhum teste unitario em tests/ — nada a rodar.")
        print("  Isto NAO e um teste que passou: e a ausencia de suite.")
        return

    print(f"▶ pytest ({len(testes)} arquivo(s))")
    resultado = subprocess.run(["uv", "run", "--", "pytest", "-q", "tests/"], cwd=raiz)
    if resultado.returncode != 0:
        sys.exit(resultado.returncode)
    print("✓ testes OK")


if __name__ == "__main__":
    main()

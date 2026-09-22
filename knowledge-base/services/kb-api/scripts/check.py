#!/usr/bin/env python3
"""Qualidade de codigo: lint e formatacao.

Chamado pelo pipeline como `uv run -- python -m scripts.check`.
"""

from __future__ import annotations

import subprocess
import sys


def rodar(comando: list[str], descricao: str) -> bool:
    print(f"\n▶ {descricao}")
    print(f"  $ uv run -- {' '.join(comando)}")
    resultado = subprocess.run(["uv", "run", "--", *comando], capture_output=True, text=True)
    if resultado.stdout.strip():
        print(resultado.stdout)
    if resultado.returncode != 0:
        if resultado.stderr.strip():
            print(resultado.stderr, file=sys.stderr)
        print(f"✗ {descricao} reprovou")
        return False
    print(f"✓ {descricao}")
    return True


def main() -> None:
    alvos = ["src/", "scripts/", "tests/"]
    etapas = [
        (["ruff", "check", *alvos], "ruff check"),
    ]

    # `ruff format --check` NAO entra ainda, de proposito.
    #
    # O codigo nasceu sem formatador e a primeira passada reescreve 13 dos 21
    # arquivos. Ligar isso junto com o pipeline misturaria duas coisas numa
    # entrega so: "o CI passou a rodar" e "todo o codigo mudou de forma" -- e o
    # segundo diff engoliria o primeiro em qualquer review.
    #
    # Para adotar, numa entrega separada e sozinha:
    #     uv run -- ruff format src/ scripts/ tests/
    # e entao acrescente aqui:
    #     (["ruff", "format", "--check", *alvos], "ruff format --check")
    if not all(rodar(comando, descricao) for comando, descricao in etapas):
        sys.exit(1)
    print("\nQualidade OK.")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Exporta `content/modelos/` para o seed de templates do Studio.

`planning/00-MVP-PLANO.md` §5.4 item 6: os modelos de documento sao repertorio
da KB (Espacos `extrajudicial` e `estilo-peca`) E os templates da skill
`gerar_documento` do Studio, que le `studio/api/seed/templates.json`.

POR QUE UM EXPORT, E NAO DOIS ARQUIVOS ESCRITOS A MAO

Duas copias do mesmo modelo escritas separadamente divergem na primeira
correcao: o advogado corrige a notificacao na KB, e o DOCX que o Studio gera
continua saindo com o texto antigo. Nada falha, e o usuario recebe o documento
que a curadoria ja tinha consertado. O Markdown OKF e a fonte; o JSON e gerado,
e `--check` (usado pelo teste do repertorio) recusa o JSON desatualizado.

O QUE VAI PARA O JSON

So a secao `## Modelo` do corpo. O resto do arquivo (quando usar, antes de
enviar) e orientacao para o agente, e dentro do DOCX do usuario viraria texto
dirigido a ele como se fosse parte da reclamacao.

USO

    cd services/kb-api
    uv run -- python ../../scripts/export-templates.py
    uv run -- python ../../scripts/export-templates.py --check
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

RAIZ = pathlib.Path(__file__).resolve().parent.parent
MODELOS = RAIZ / "content" / "modelos"
# O Studio mora no mesmo monorepo, um nivel acima deste repositorio.
SAIDA = RAIZ.parent / "studio" / "api" / "seed" / "templates.json"

_FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n(.*)\Z", re.S)
_PLACEHOLDER = re.compile(r"\{\{\s*([a-z0-9_]+)\s*\}\}")


class Falha(RuntimeError):
    pass


def ler_modelo(arquivo: pathlib.Path) -> dict:
    try:
        import yaml
    except ImportError:
        raise Falha("PyYAML nao encontrado. Rode de dentro de services/kb-api com `uv run`") from None
    achado = _FRONTMATTER.match(arquivo.read_text(encoding="utf-8"))
    if not achado:
        raise Falha(f"{arquivo}: sem frontmatter")
    meta = yaml.safe_load(achado.group(1)) or {}
    corpo = achado.group(2)
    if meta.get("type") != "Modelo":
        raise Falha(f"{arquivo}: type deveria ser Modelo")
    modelo = meta.get("modelo") or {}
    partes = corpo.split("\n## Modelo\n", 1)
    if len(partes) != 2:
        raise Falha(f"{arquivo}: falta a secao `## Modelo`")
    texto = partes[1].strip() + "\n"

    campos = [
        {"nome": c["nome"], "rotulo": c["rotulo"], "obrigatorio": bool(c.get("obrigatorio"))}
        for c in modelo.get("campos") or []
    ]
    declarados = {c["nome"] for c in campos}
    usados = set(_PLACEHOLDER.findall(texto))
    # Placeholder sem campo declarado sai no DOCX como `[NOME]` sem que a tela
    # tenha pedido o valor a ninguem; campo obrigatorio que o texto nao usa e
    # pergunta feita ao usuario para nada.
    if usados - declarados:
        raise Falha(f"{arquivo}: placeholder sem campo: {sorted(usados - declarados)}")
    obrigatorios_fora = {c["nome"] for c in campos if c["obrigatorio"]} - usados
    if obrigatorios_fora:
        raise Falha(f"{arquivo}: campo obrigatorio que o texto nao usa: {sorted(obrigatorios_fora)}")

    return {
        "slug": modelo.get("slug") or arquivo.stem,
        "titulo": meta.get("title", ""),
        "descricao": meta.get("description", ""),
        "campos": campos,
        "corpo_markdown": texto,
    }


def montar() -> list[dict]:
    por_slug: dict[str, tuple[pathlib.Path, dict]] = {}
    for arquivo in sorted(MODELOS.rglob("*.md")):
        entrada = ler_modelo(arquivo)
        anterior = por_slug.get(entrada["slug"])
        # O mesmo modelo mora em mais de um Espaco (a regra de alcance do
        # content/README). As copias tem de ser identicas, senao o JSON sairia
        # de uma delas por acaso de ordem alfabetica.
        if anterior and anterior[1] != entrada:
            raise Falha(f"copias divergentes de {entrada['slug']}: {anterior[0]} e {arquivo}")
        por_slug.setdefault(entrada["slug"], (arquivo, entrada))
    return [por_slug[s][1] for s in sorted(por_slug)]


def serializar(modelos: list[dict]) -> str:
    return json.dumps(modelos, ensure_ascii=False, indent=2) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description="Exporta content/modelos para o Studio")
    parser.add_argument("--check", action="store_true", help="falha se o JSON estiver desatualizado")
    args = parser.parse_args()
    try:
        texto = serializar(montar())
    except Falha as exc:
        print(f"✗ {exc}", file=sys.stderr)
        sys.exit(1)
    if args.check:
        atual = SAIDA.read_text(encoding="utf-8") if SAIDA.exists() else ""
        if atual != texto:
            print(f"✗ {SAIDA} desatualizado. Rode scripts/export-templates.py", file=sys.stderr)
            sys.exit(1)
        print("templates.json em dia")
        return
    SAIDA.parent.mkdir(parents=True, exist_ok=True)
    SAIDA.write_text(texto, encoding="utf-8")
    print(f"{len(json.loads(texto))} modelo(s) -> {SAIDA}")


if __name__ == "__main__":
    main()

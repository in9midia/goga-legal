#!/usr/bin/env python3
"""Aplica `content/spaces.yaml` contra uma KB de pe. Idempotente.

POR QUE ISTO NAO E "criar os Espacos na tela"

Permissao de leitura de repertorio e o que separa competencia exclusiva escrita
em prompt de competencia exclusiva que vale (`planning/02-BASE-CONHECIMENTO.md`
§2.2). Criada a mao, ela nao tem revisao nem historico: a pergunta "o `triagem`
alcanca `processual-civil`?" so se responde consultando o banco de producao.
Com o arquivo, ela se responde lendo o diff.

IDEMPOTENTE DE VERDADE, E NAO "roda duas vezes sem estourar"

As tres rotas usadas sao upsert (`POST /v1/spaces` e `POST /v1/grants` tem
`ON CONFLICT DO UPDATE`; `PUT .../representations` e atribuicao). Rodar de novo
converge para o arquivo em vez de acumular.

O QUE ELE NAO FAZ, DE PROPOSITO

* **nao remove grant que o arquivo nao descreve** sem `--prune`. Apagar sozinho
  faria uma rodada de rotina desfazer, em silencio, um acesso concedido a mao
  numa emergencia. Sem `--prune` a divergencia e RELATADA, que e o meio-termo
  que deixa a decisao com quem opera;
* **nao cadastra provedor de IA.** A credencial e do operador e nao entra em
  arquivo versionado (ADR-0009). Sem provedor o Espaco e criado mas nao ingere,
  e o script diz isso no fim em vez de deixar o Espaco vazio parecer pronto;
* **nao ingere documento.** Isso e o `scripts/ingest.sh`.

CREDENCIAL

`KB_SERVICE_TOKEN` do ambiente, ou o secret do cluster (mesmo caminho do
`ingest.sh`: quem consegue rodar kubectl ali ja tem o acesso). Nunca e impressa.

USO

    cd services/kb-api
    uv run -- python ../../scripts/apply-spaces.py --dry-run
    uv run -- python ../../scripts/apply-spaces.py
    uv run -- python ../../scripts/apply-spaces.py --onda 1
    uv run -- python ../../scripts/apply-spaces.py --prune
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys
import urllib.error
import urllib.request
from typing import Any

RAIZ = pathlib.Path(__file__).resolve().parent.parent
CONFIG = RAIZ / "content" / "spaces.yaml"
NAMESPACE = os.environ.get("NS", "stack-knowledge-base")
BASE_URL = os.environ.get("KB_URL", "http://localhost:8890").rstrip("/")

VERMELHO, VERDE, AZUL, AMARELO, NEUTRO = (
    "\033[31m", "\033[32m", "\033[36m", "\033[33m", "\033[0m",
)


def cor(texto: str, codigo: str) -> str:
    return f"{codigo}{texto}{NEUTRO}"


class Falha(RuntimeError):
    pass


# ── acesso a KB ────────────────────────────────────────────────────────────


def token_de_servico() -> str:
    """O token do ambiente, ou o do secret do cluster. Nunca impresso."""
    do_ambiente = os.environ.get("KB_SERVICE_TOKEN", "").strip()
    if do_ambiente:
        return do_ambiente
    try:
        saida = subprocess.run(
            ["kubectl", "-n", NAMESPACE, "get", "secret", "knowledge-base-secret",
             "-o", "jsonpath={.data.KB_SERVICE_TOKEN}"],
            capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise Falha(f"kubectl indisponivel ({exc}) e KB_SERVICE_TOKEN vazio") from None
    if saida.returncode != 0 or not saida.stdout.strip():
        raise Falha(
            "sem token de servico. A stack esta de pe? ./start-k8s-local.sh status"
        )
    import base64

    return base64.b64decode(saida.stdout.strip()).decode().strip()


def chamar(metodo: str, caminho: str, token: str, corpo: dict | None = None) -> Any:
    dados = json.dumps(corpo).encode() if corpo is not None else None
    pedido = urllib.request.Request(
        f"{BASE_URL}{caminho}", data=dados, method=metodo,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(pedido, timeout=120) as resposta:
            return json.loads(resposta.read() or b"{}")
    except urllib.error.HTTPError as exc:
        detalhe = exc.read().decode(errors="replace")[:300]
        raise Falha(f"{metodo} {caminho} -> HTTP {exc.code}: {detalhe}") from None
    except urllib.error.URLError as exc:
        raise Falha(f"{BASE_URL} nao responde ({exc.reason})") from None


# ── o arquivo ──────────────────────────────────────────────────────────────


def ler_config() -> dict:
    try:
        import yaml
    except ImportError:
        raise Falha(
            "PyYAML nao encontrado. Rode de dentro de services/kb-api: "
            "uv run -- python ../../scripts/apply-spaces.py"
        ) from None
    if not CONFIG.exists():
        raise Falha(f"configuracao nao encontrada: {CONFIG}")
    with CONFIG.open(encoding="utf-8") as arquivo:
        dados = yaml.safe_load(arquivo)
    if not isinstance(dados, dict) or not dados.get("spaces"):
        raise Falha(f"{CONFIG} nao descreve Espaco nenhum")
    return dados


def grants_desejados(config: dict) -> dict[str, list[dict]]:
    """Slug do Espaco -> lista de grants que o arquivo descreve.

    Grant de agente e sempre `reader`: §2.2 fala em "grant de leitura apenas nos
    Espacos da sua competencia", e um agente que escreve no repertorio poderia
    se auto-promover a fonte -- que e exatamente o que a derivacao do nivel de
    confianca existe para impedir.
    """
    todos = [espaco["slug"] for espaco in config["spaces"]]
    por_espaco: dict[str, list[dict]] = {slug: [] for slug in todos}

    for agente in config.get("agents", []):
        for slug in agente.get("spaces") or []:
            if slug not in por_espaco:
                raise Falha(
                    f"agente {agente['group']} aponta para Espaco inexistente: {slug}"
                )
            por_espaco[slug].append(
                {"principal_type": "group", "principal_id": agente["group"], "role": "reader"}
            )

    for grupo in config.get("groups", []):
        alvos = todos if grupo.get("spaces") == "todos" else (grupo.get("spaces") or [])
        for slug in alvos:
            por_espaco[slug].append(
                {"principal_type": "group", "principal_id": grupo["group"],
                 "role": grupo.get("role", "reader")}
            )
    return por_espaco


# ── aplicacao ──────────────────────────────────────────────────────────────


def aplicar(config: dict, token: str, onda: int | None, seco: bool, podar: bool) -> int:
    padrao_chunking = (config.get("defaults") or {}).get("chunking") or {}
    desejados = grants_desejados(config)

    existentes = {
        espaco["slug"]: espaco
        for espaco in chamar("GET", "/v1/spaces", token).get("spaces", [])
    }
    grants_atuais: dict[str, list[dict]] = {
        entrada["slug"]: entrada["grants"]
        for entrada in chamar("GET", "/v1/grants", token).get("spaces", [])
    }

    criados = atualizados = 0
    grants_aplicados = 0
    divergentes: list[str] = []

    for espaco in config["spaces"]:
        slug = espaco["slug"]
        if onda is not None and espaco.get("onda") != onda:
            continue
        chunking = {**padrao_chunking, **(espaco.get("chunking") or {})}
        grants = desejados[slug]
        novo = slug not in existentes

        rotulo = cor("criar", VERDE) if novo else cor("conferir", AZUL)
        print(f"  {rotulo:>22} {slug:<20} onda {espaco.get('onda', '?')}  "
              f"{len(grants)} grant(s)")

        if not seco:
            chamar("POST", "/v1/spaces", token, {
                "slug": slug,
                "label": espaco.get("label", slug),
                "description": " ".join((espaco.get("description") or "").split()),
                "chunking": chunking,
                "grants": grants,
            })
            chamar("PUT", f"/v1/spaces/{slug}/representations", token,
                   {"wiki": bool(espaco.get("wiki"))})
        criados, atualizados = (criados + 1, atualizados) if novo else (criados, atualizados + 1)
        grants_aplicados += len(grants)

        # Grant que existe na KB e nao esta no arquivo. Nao e ruido: e acesso a
        # repertorio que ninguem revisou, que e o caso que a §2.2 quer impedir.
        descritos = {(g["principal_type"], g["principal_id"]) for g in grants}
        for atual in grants_atuais.get(slug, []):
            chave = (atual["principal_type"], atual["principal_id"])
            if chave in descritos:
                continue
            divergentes.append(f"{slug}: {atual['principal_type']}={atual['principal_id']} "
                               f"({atual['role']})")
            if podar and not seco:
                chamar("DELETE", f"/v1/grants/{atual['id']}", token)

    print()
    print(f"  {criados} Espaco(s) criado(s), {atualizados} conferido(s), "
          f"{grants_aplicados} grant(s) no arquivo")
    if divergentes:
        print(cor(f"  {len(divergentes)} grant(s) na KB fora do arquivo"
                  f"{' — REMOVIDOS' if podar and not seco else ''}:", AMARELO))
        for linha in divergentes:
            print(f"    - {linha}")
        if not podar:
            print("    rode com --prune para remove-los")
    return criados


def avisar_provedor(token: str) -> None:
    """Diz em voz alta que Espaco sem provedor nao ingere.

    O `embedding_provider_id` e anulavel, entao o Espaco nasce sem provedor e cai
    no padrao da instalacao. Quando NAO HA padrao, o Espaco existe, aparece na
    tela, aceita grant -- e falha no primeiro upload, na hora de embedar. Sem
    este aviso a leitura obvia do "17 Espacos criados" e "pronto para ingerir".
    """
    provedores = chamar("GET", "/v1/ai/providers", token).get("providers", [])
    embedding = [p for p in provedores if p.get("purpose") == "embedding"]
    if embedding:
        print(cor(f"\n  provedor de embedding: {len(embedding)} cadastrado(s)", VERDE))
        return
    print(cor("\n  NAO HA PROVEDOR DE EMBEDDING CADASTRADO.", AMARELO))
    print("  Os Espacos existem e os grants valem, mas NENHUM documento entra:")
    print("  o upload falha no embedding. Cadastre em Administracao > Modelos de IA")
    print("  (a credencial e do operador e nao entra em arquivo versionado — ADR-0009).")


def main() -> None:
    parser = argparse.ArgumentParser(description="Aplica content/spaces.yaml na KB")
    parser.add_argument("--dry-run", action="store_true", help="mostra sem escrever")
    parser.add_argument("--onda", type=int, help="so os Espacos desta onda (§10)")
    parser.add_argument("--prune", action="store_true",
                        help="remove grant que a KB tem e o arquivo nao descreve")
    args = parser.parse_args()

    try:
        config = ler_config()
        token = token_de_servico()
        print(cor(f"== {CONFIG.relative_to(RAIZ)} -> {BASE_URL}", AZUL))
        if args.dry_run:
            print(cor("   (dry-run: nada e escrito)", AMARELO))
        aplicar(config, token, args.onda, args.dry_run, args.prune)
        if not args.dry_run:
            avisar_provedor(token)
    except Falha as exc:
        print(cor(f"\n✗ {exc}", VERMELHO), file=sys.stderr)
        sys.exit(1)
    print(cor("\nOK.", VERDE))


if __name__ == "__main__":
    main()

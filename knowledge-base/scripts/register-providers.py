#!/usr/bin/env python3
"""Cadastra na KB os provedores de IA do MVP. Idempotente.

`planning/00-MVP-PLANO.md` §5.4 item 1: Gemini para embedding e DeepSeek para
chat (a KB so usa chat para derivar conceito OKF e wiki na ingestao).

POR QUE SCRIPT, E NAO A TELA

A tela (Administracao > Modelos de IA) faz o mesmo, mas deixa a escolha de
modelo, dimensao e preco sem historico. O embedding e a escolha mais cara de
desfazer da instalacao inteira: `chunk_embedding.embedding` e `vector(3072)`, e
trocar de modelo depois obriga a reindexar tudo. Aqui a escolha fica no diff.

A CREDENCIAL NAO ESTA AQUI

As chaves vem SO do ambiente (`GEMINI_API_KEY`, `DEEPSEEK_API_KEY`) e nunca
sao impressas: a API as guarda cifradas e devolve os quatro ultimos caracteres
(ADR-0009), e este script segue a mesma regra na saida dele.

IDEMPOTENTE PELO NOME

O provedor e reconhecido por (`purpose`, `name`). Rodar de novo faz PUT no que
ja existe (inclusive regravando a chave, o que torna "girei a chave" um
comando so) em vez de criar um segundo provedor com o mesmo papel, que
disputaria o `is_default` e deixaria a tela com duas linhas quase iguais.

USO

    GEMINI_API_KEY=... DEEPSEEK_API_KEY=... python3 scripts/register-providers.py
    python3 scripts/register-providers.py --dry-run
    python3 scripts/register-providers.py --test     # chama o /test de cada um

So biblioteca padrao: roda fora do `uv` do kb-api, que e onde o
`populate-kb.sh` o chama.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any

BASE_URL = os.environ.get("KB_URL", "http://localhost:8890").rstrip("/")

VERMELHO, VERDE, AZUL, AMARELO, NEUTRO = (
    "\033[31m", "\033[32m", "\033[36m", "\033[33m", "\033[0m",
)


def cor(texto: str, codigo: str) -> str:
    return f"{codigo}{texto}{NEUTRO}"


class Falha(RuntimeError):
    pass


# ── os provedores ──────────────────────────────────────────────────────────
#
# PRECOS em dolar por 1M de tokens, conferidos em 2026-09-22:
#
# * gemini-embedding-001: US$ 0,15 de entrada, preco do anuncio de GA do
#   Google (developers.googleblog.com, "Gemini Embedding now generally
#   available"). A pagina de precos atual (ai.google.dev/gemini-api/docs/
#   pricing) ja NAO lista o 001, so o `gemini-embedding-2`; a pagina de
#   depreciacao marca o desligamento do 001 em 2028-05-14. Se o valor mudar,
#   o custo na tela fica errado sem erro nenhum, entao confira antes de
#   confiar no relatorio de custo.
#   Embedding nao tem saida: `price_output_per_1m` fica `None`, que a API le
#   como "nao se aplica/nao sei", e nao como zero.
#
# * DeepSeek: US$ 0,30 de entrada (cache miss) e US$ 1,20 de saida. Sao os
#   precos de HORARIO DE PICO do `deepseek-flash` (api-docs.deepseek.com,
#   quick_start/pricing); fora do pico e metade. O cadastro so aceita um valor,
#   e o de pico foi escolhido porque superestimar custo e o erro seguro: um
#   relatorio que subestima e o que faz alguem deixar um lote rodar.
#
# MODELO DO DEEPSEEK: o plano diz `deepseek-chat`, e esse nome PAROU DE
# RESOLVER em 2026-07-24 (changelog da DeepSeek): pedidos com ele devolvem
# erro. O id atual e `deepseek-flash` (V4.1 Flash, 2026-09-10). Fica
# sobrescrevivel por `DEEPSEEK_MODEL` porque a DeepSeek ja renomeou esse id
# duas vezes em 2026.
DEEPSEEK_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-flash").strip() or "deepseek-flash"

PROVEDORES: list[dict[str, Any]] = [
    {
        "env": "GEMINI_API_KEY",
        "payload": {
            "name": "Gemini embedding",
            "kind": "gemini",
            # O endpoint padrao do dialeto `gemini` (camada compativel com
            # OpenAI). Explicito aqui porque o POST grava o que vier, e vazio
            # gravaria um provedor que monta URL relativa.
            "endpoint": "https://generativelanguage.googleapis.com/v1beta/openai",
            "model": "gemini-embedding-001",
            # 3072 porque e a coluna `vector(3072)` do indice. O dialeto
            # `gemini` manda `dimensions` no corpo justamente para o modelo nao
            # truncar (Matryoshka) e o INSERT falhar no meio da ingestao.
            "dimensions": 3072,
            "purpose": "embedding",
            "price_input_per_1m": 0.15,
            "price_output_per_1m": None,
        },
    },
    {
        "env": "DEEPSEEK_API_KEY",
        "payload": {
            "name": "DeepSeek chat",
            # Dialeto `openai` com endpoint proprio: a API da DeepSeek e
            # compativel com a da OpenAI em `/chat/completions`, e um dialeto
            # novo so para ela seria uma linha identica a `openai`.
            "kind": "openai",
            "endpoint": "https://api.deepseek.com",
            "model": DEEPSEEK_MODEL,
            # `chat` e o unico outro proposito que a KB aceita (PROPOSITOS em
            # main.py). E ele que a derivacao de conceito OKF e a wiki pedem.
            "purpose": "chat",
            "price_input_per_1m": 0.30,
            "price_output_per_1m": 1.20,
        },
    },
]


# ── acesso a KB ────────────────────────────────────────────────────────────


def chamar(metodo: str, caminho: str, corpo: dict | None = None) -> Any:
    # A KB do MVP roda com auth desligada (00-MVP-PLANO §6). O token so vai no
    # pedido se existir no ambiente: com auth ligada ele e necessario, e com
    # auth desligada ele nao atrapalha.
    cabecalhos = {"Content-Type": "application/json"}
    token = os.environ.get("KB_SERVICE_TOKEN", "").strip()
    if token:
        cabecalhos["Authorization"] = f"Bearer {token}"
    dados = json.dumps(corpo).encode() if corpo is not None else None
    pedido = urllib.request.Request(
        f"{BASE_URL}{caminho}", data=dados, method=metodo, headers=cabecalhos
    )
    try:
        # 60s: o /test chama o provedor de verdade, e o Gemini ja levou mais de
        # 20s para responder o primeiro pedido de uma chave nova.
        with urllib.request.urlopen(pedido, timeout=60) as resposta:
            return json.loads(resposta.read() or b"{}")
    except urllib.error.HTTPError as exc:
        detalhe = exc.read().decode(errors="replace")[:300]
        raise Falha(f"{metodo} {caminho} -> HTTP {exc.code}: {detalhe}") from None
    except urllib.error.URLError as exc:
        raise Falha(f"{BASE_URL} nao responde ({exc.reason}). A KB esta de pe?") from None


def mascarar(chave: str) -> str:
    return f"…{chave[-4:]}" if len(chave) >= 8 else "(curta demais)"


# ── aplicacao ──────────────────────────────────────────────────────────────


def aplicar(seco: bool, testar: bool) -> None:
    faltando = [p["env"] for p in PROVEDORES if not os.environ.get(p["env"], "").strip()]
    if faltando and not seco:
        raise Falha(
            "faltam as variaveis " + ", ".join(faltando)
            + ". Exporte as chaves no ambiente (nunca em arquivo versionado)."
        )

    existentes: list[dict] = []
    if seco:
        try:
            existentes = chamar("GET", "/v1/ai/providers").get("providers", [])
        except Falha as exc:
            # Dry-run sem a KB de pe ainda mostra o que seria enviado: e o caso
            # de conferir o script antes de subir a stack.
            print(cor(f"  (KB inacessivel, mostrando so o plano: {exc})", AMARELO))
    else:
        existentes = chamar("GET", "/v1/ai/providers").get("providers", [])

    for item in PROVEDORES:
        corpo = dict(item["payload"])
        chave = os.environ.get(item["env"], "").strip()
        atual = next(
            (p for p in existentes
             if p.get("purpose") == corpo["purpose"] and p.get("name") == corpo["name"]),
            None,
        )
        acao = "atualizar" if atual else "criar"
        rotulo = cor(acao, AZUL if atual else VERDE)
        print(f"  {rotulo:>20} {corpo['purpose']:<10} {corpo['name']:<18} "
              f"{corpo['kind']}/{corpo['model']}  chave {mascarar(chave) if chave else cor('AUSENTE', AMARELO)}")
        if seco:
            continue

        corpo["api_key"] = chave
        if atual:
            # `kind` e `purpose` nao sao editaveis pelo PUT (a rota ignora).
            # Se divergirem, o PUT "funcionaria" e o provedor continuaria com o
            # dialeto velho; melhor parar e dizer.
            if atual.get("kind") != corpo["kind"]:
                raise Falha(
                    f"'{corpo['name']}' existe com tipo {atual.get('kind')}, e o PUT nao "
                    f"troca tipo. Apague na tela e rode de novo."
                )
            salvo = chamar("PUT", f"/v1/ai/providers/{atual['id']}", corpo)
        else:
            salvo = chamar("POST", "/v1/ai/providers", corpo)

        if not salvo.get("is_default"):
            chamar("POST", f"/v1/ai/providers/{salvo['id']}/default")
            print(f"  {'':>11} -> padrao da instalacao para `{corpo['purpose']}`")

        if testar:
            resultado = chamar("POST", f"/v1/ai/providers/{salvo['id']}/test")
            ok = bool(resultado.get("ok"))
            print(f"  {'':>11} -> teste: "
                  + (cor("ok", VERDE) if ok else cor(json.dumps(resultado)[:200], VERMELHO)))


def main() -> None:
    parser = argparse.ArgumentParser(description="Cadastra Gemini e DeepSeek na KB")
    parser.add_argument("--dry-run", action="store_true", help="mostra sem escrever")
    parser.add_argument("--test", action="store_true",
                        help="chama o teste de conexao de cada provedor (gasta tokens)")
    args = parser.parse_args()

    print(cor(f"== provedores de IA -> {BASE_URL}", AZUL))
    if args.dry_run:
        print(cor("   (dry-run: nada e escrito)", AMARELO))
    try:
        aplicar(args.dry_run, args.test)
    except Falha as exc:
        print(cor(f"\n✗ {exc}", VERMELHO), file=sys.stderr)
        sys.exit(1)
    print(cor("\nOK.", VERDE))


if __name__ == "__main__":
    main()

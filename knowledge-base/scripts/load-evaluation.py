#!/usr/bin/env python3
"""Carrega os conjuntos de `content/evaluation/` no dataset golden da KB.

O QUE ELE ESCREVE

Uma linha de `benchmark_question` por pergunta, via `POST
/v1/spaces/<slug>/benchmark/questions`. Origem `manual` e status `aprovada`:
pergunta escrita por quem cura ja passou pela selecao humana que a especificacao
pede, e mandar para `rascunho` criaria uma fila de aprovacao de algo que ninguem
mais vai reler.

A ESTRATEGIA VIAJA COM A PERGUNTA, E ISSO E O PONTO

O conjunto tem DUAS VOZES de proposito (§9 do plano): a de quem tem o problema e
a de quem conhece o vocabulario tecnico. As duas sao as duas estrategias que o
harness ja mede -- `dificil` e `direta`. Sem gravar a estrategia, as duas caem no
mesmo grupo e o relatorio por estrategia compara um conjunto consigo mesmo, que e
exatamente a cegueira que a migracao 0010 foi escrita para tirar.

IDEMPOTENTE POR TEXTO DA PERGUNTA

Nao ha chave natural em `benchmark_question`, entao a rodada le o que ja existe
no Espaco e pula pergunta com texto identico. Sem isso, rodar duas vezes daria um
dataset com tudo em duplicata e uma media calculada sobre o mesmo caso contado
duas vezes.

USO

    cd services/kb-api
    uv run -- python ../../scripts/load-evaluation.py --dry-run
    uv run -- python ../../scripts/load-evaluation.py
    uv run -- python ../../scripts/load-evaluation.py --space cdc
    uv run -- python ../../scripts/load-evaluation.py --reset   # regrava do zero
"""

from __future__ import annotations

import argparse
import pathlib
import sys

CAMINHO_SCRIPTS = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(CAMINHO_SCRIPTS))

# Reaproveita o acesso a KB do script irmao: mesmo endereco, mesmo token, mesma
# forma de errar. Duplicar isso daria dois jeitos de pegar o token de servico, e
# um deles ficaria para tras no dia em que o outro mudasse.
_aplicador = __import__("apply-spaces")
Falha = _aplicador.Falha
chamar = _aplicador.chamar
cor = _aplicador.cor
token_de_servico = _aplicador.token_de_servico
AMARELO, AZUL, VERDE, VERMELHO = (
    _aplicador.AMARELO, _aplicador.AZUL, _aplicador.VERDE, _aplicador.VERMELHO,
)

RAIZ = CAMINHO_SCRIPTS.parent
CONJUNTOS = RAIZ / "content" / "evaluation"


def ler_conjunto(arquivo: pathlib.Path) -> dict:
    import yaml

    with arquivo.open(encoding="utf-8") as aberto:
        dados = yaml.safe_load(aberto)
    if not isinstance(dados, dict) or not dados.get("space") or not dados.get("questions"):
        raise Falha(f"{arquivo.name} nao tem `space` e `questions`")
    return dados


def carregar(arquivo: pathlib.Path, token: str, seco: bool, zerar: bool) -> tuple[int, int]:
    conjunto = ler_conjunto(arquivo)
    slug = conjunto["space"]
    perguntas = conjunto["questions"]

    ja_gravadas = chamar(
        "GET", f"/v1/spaces/{slug}/benchmark/questions", token
    ).get("questions", [])

    # `--reset` existe por um caso concreto: a idempotencia e por TEXTO da
    # pergunta, entao uma linha gravada com a estrategia errada (servidor antigo,
    # que ignorava o campo) nunca seria corrigida por uma recarga -- o texto bate
    # e a pergunta e pulada. Sem uma forma de zerar, o conserto seria apagar 250
    # linhas a mao na tela.
    if zerar and not seco:
        for existente in ja_gravadas:
            chamar("DELETE", f"/v1/benchmark/questions/{existente['id']}", token)
        ja_gravadas = []

    existentes = {q["question"].strip() for q in ja_gravadas}

    novas = pulos = 0
    por_estrategia: dict[str, int] = {}
    ignorou_estrategia = False
    for pergunta in perguntas:
        texto = str(pergunta.get("question") or "").strip()
        if not texto:
            raise Falha(f"{arquivo.name}: pergunta sem texto")
        estrategia = str(pergunta.get("strategy") or "direta")
        por_estrategia[estrategia] = por_estrategia.get(estrategia, 0) + 1
        if texto in existentes:
            pulos += 1
            continue
        if not seco:
            resposta = chamar("POST", f"/v1/spaces/{slug}/benchmark/questions", token, {
                "question": texto,
                "reference": str(pergunta.get("reference") or ""),
                "strategy": estrategia,
                "kind": str(pergunta.get("kind") or ""),
            })
            # O servidor que NAO conhece `strategy` aceita o campo e o joga fora
            # em silencio, e a linha nasce `direta` pelo default da coluna. Como
            # nada falha, a divergencia so apareceria meses depois, num relatorio
            # em que os dois conjuntos tem o mesmo tamanho e a mesma nota.
            if resposta.get("strategy") != estrategia:
                ignorou_estrategia = True
        novas += 1

    resumo = ", ".join(f"{nome}={quantidade}" for nome, quantidade in sorted(por_estrategia.items()))
    print(f"  {slug:<20} {len(perguntas):>3} no arquivo ({resumo}) — "
          f"{novas} nova(s), {pulos} ja existia(m)")
    if ignorou_estrategia:
        print(cor("      ⚠ o servidor NAO gravou a estrategia enviada: a imagem em uso e", AMARELO))
        print("        anterior a `benchmark.classificar`. As linhas nasceram `direta`, e")
        print("        a comparacao entre as duas vozes NAO vale ate a imagem ser")
        print("        reconstruida e este conjunto recarregado.")
    return novas, pulos


def main() -> None:
    parser = argparse.ArgumentParser(description="Carrega content/evaluation/ na KB")
    parser.add_argument("--dry-run", action="store_true", help="mostra sem escrever")
    parser.add_argument("--space", help="so este Espaco")
    parser.add_argument("--reset", action="store_true",
                        help="apaga as perguntas do Espaco antes de carregar")
    args = parser.parse_args()

    arquivos = sorted(CONJUNTOS.glob("*.yaml"))
    if args.space:
        arquivos = [a for a in arquivos if a.stem == args.space]
    if not arquivos:
        print(cor(f"nenhum conjunto em {CONJUNTOS}", VERMELHO), file=sys.stderr)
        sys.exit(1)

    try:
        token = token_de_servico()
        print(cor(f"== {len(arquivos)} conjunto(s) -> {_aplicador.BASE_URL}", AZUL))
        if args.dry_run:
            print(cor("   (dry-run: nada e escrito)", AMARELO))
        total_novas = total_pulos = 0
        for arquivo in arquivos:
            novas, pulos = carregar(arquivo, token, args.dry_run, args.reset)
            total_novas += novas
            total_pulos += pulos
        print(f"\n  {total_novas} pergunta(s) nova(s), {total_pulos} ja existia(m)")
        print(cor("\n  Sem gabarito (`reference`) em nenhuma: `context_precision`,", AMARELO))
        print("  `context_recall` e `answer_correctness` NAO sao mediveis ate o")
        print("  responsavel tecnico preencher (etapa 4 do pipeline). `faithfulness`")
        print("  e `answer_relevancy` sao.")
    except Falha as exc:
        print(cor(f"\n✗ {exc}", VERMELHO), file=sys.stderr)
        sys.exit(1)
    print(cor("\nOK.", VERDE))


if __name__ == "__main__":
    main()

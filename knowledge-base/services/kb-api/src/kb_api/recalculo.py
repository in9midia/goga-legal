"""Aplica o preco de hoje ao uso que ja foi gravado sem preco.

POR QUE ISTO PRECISA EXISTIR

O custo e congelado na hora do uso, e isso e o comportamento certo: o dinheiro
de ontem saiu pelo preco de ontem, e um historico que se reescreve a cada
correcao de tabela nao se audita. O efeito colateral e que tudo o que rodou
ANTES de alguem cadastrar o preco ficou com custo zero -- e zero na tela parece
"nao gastou", quando sao milhoes de tokens sem preco aplicado.

Este modulo e a saida disso: uma acao EXPLICITA, disparada por quem administra,
que aplica o preco atual ao que ficou para tras. Explicita de proposito, porque
ela muda numero de historico. Ninguem deve descobrir depois que os valores
mudaram sozinhos.

O QUE E EXATO E O QUE NAO E

  * EMBEDDING e exato. A operacao nao tem saida: todo token e de entrada, por
    definicao da chamada, nao por suposicao;
  * linha que JA tem a decomposicao (gravada depois da 0014) e exata pelo mesmo
    motivo -- os numeros vieram do proprio provedor;
  * CHAT antigo NAO e. A linha so guarda o total, e entrada e saida custam
    diferente. Recalcular exige supor a proporcao, e o que for suposto fica
    contado em `tokens_estimados` para a tela nao somar estimativa com apurado
    como se fossem a mesma coisa.

O QUE ELE NAO FAZ

Nao inventa preco. Linha cujo provedor nao tem preco cadastrado continua com
custo zero e aparece no resumo como pulada -- porque a acao ali e cadastrar o
preco, nao recalcular de novo.
"""
from __future__ import annotations

import logging
from typing import Any

from .db import conn

log = logging.getLogger(__name__)

# Fracao do total que se supoe ser ENTRADA numa chamada de chat antiga.
#
# 0,9 vem da forma das nossas chamadas de chat, nao de um numero redondo: todas
# passam por `llm.complete_json`, que manda um documento inteiro (ou um trecho
# grande) no prompt e recebe de volta um JSON curto -- conceito OKF, entidades
# do grafo, uma pergunta de benchmark. O prompt domina com folga.
#
# E uma SUPOSICAO mesmo assim, e por isso o que sai dela fica marcado. Quem
# chama pode mandar outra proporcao.
FRACAO_ENTRADA_CHAT = 0.9


def _precos_por_linha() -> tuple[dict[int, tuple], dict[tuple[str, str], tuple]]:
    """Preco e proposito de cada provedor, indexados de duas formas.

    Por `id` e o caminho normal. Por `(nome, modelo)` existe porque
    `ai_usage_daily` NAO tem chave estrangeira para o cadastro, de proposito:
    apagar um provedor nao pode apagar o historico de gasto dele. O id daquelas
    linhas fica nulo, e sem o segundo indice elas nunca seriam recalculadas --
    justo as de um provedor que alguem trocou, que e quando isto mais serve.
    """
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            "SELECT id, name, model, purpose, price_input_per_1m, price_output_per_1m "
            "  FROM ai_provider"
        )
        linhas = cur.fetchall()
    por_id: dict[int, tuple] = {}
    por_nome: dict[tuple[str, str], tuple] = {}
    for pid, nome, modelo, purpose, entrada, saida in linhas:
        dados = (purpose, entrada, saida)
        por_id[pid] = dados
        por_nome[(nome, modelo)] = dados
    return por_id, por_nome


def recalcular(fracao_entrada: float = FRACAO_ENTRADA_CHAT) -> dict[str, Any]:
    """Reaplica o preco atual ao historico. Devolve o que fez, em detalhe."""
    if not 0.0 <= fracao_entrada <= 1.0:
        raise ValueError("a fração de entrada precisa ficar entre 0 e 1")

    por_id, por_nome = _precos_por_linha()
    resumo = {
        "linhas": 0, "atualizadas": 0, "exatas": 0, "estimadas": 0,
        "sem_preco": 0, "sem_provedor": 0,
        "tokens_exatos": 0, "tokens_estimados": 0, "custo_usd": 0.0,
        "fracao_entrada": fracao_entrada,
    }

    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            "SELECT day, provider_id, provider, model, operation, tokens, "
            "       tokens_in, tokens_out "
            "  FROM ai_usage_daily WHERE tokens > 0"
        )
        linhas = cur.fetchall()

        for dia, pid, nome, modelo, operacao, total, entrada, saida in linhas:
            resumo["linhas"] += 1
            dados = por_id.get(pid) if pid is not None else None
            if dados is None:
                dados = por_nome.get((nome, modelo))
            if dados is None:
                resumo["sem_provedor"] += 1
                continue

            purpose, preco_entrada, preco_saida = dados
            if preco_entrada is None and preco_saida is None:
                resumo["sem_preco"] += 1
                continue

            if entrada or saida:
                # Ja veio decomposto do provedor: exato, so falta o preco novo.
                nova_entrada, nova_saida, estimados = entrada, saida, 0
            elif purpose == "embedding":
                # Exato por definicao da operacao: embedding nao tem saida.
                nova_entrada, nova_saida, estimados = total, 0, 0
            else:
                nova_entrada = int(round(total * fracao_entrada))
                nova_saida = total - nova_entrada
                estimados = total

            custo = (
                float(preco_entrada or 0) * nova_entrada / 1_000_000
                + float(preco_saida or 0) * nova_saida / 1_000_000
            )
            cur.execute(
                """
                UPDATE ai_usage_daily
                   SET tokens_in = %s, tokens_out = %s,
                       cost_usd = %s, tokens_estimados = %s
                 WHERE day = %s AND provider_id IS NOT DISTINCT FROM %s
                   AND model = %s AND operation = %s
                """,
                (nova_entrada, nova_saida, round(custo, 6), estimados,
                 dia, pid, modelo, operacao),
            )
            resumo["atualizadas"] += 1
            resumo["custo_usd"] += custo
            if estimados:
                resumo["estimadas"] += 1
                resumo["tokens_estimados"] += estimados
            else:
                resumo["exatas"] += 1
                resumo["tokens_exatos"] += total
        connection.commit()

    resumo["custo_usd"] = round(resumo["custo_usd"], 6)
    log.info("custo recalculado: %s", resumo)
    return resumo

"""Etapa, percentual e log de cada ingestao, para a tela da fila.

POR QUE EXISTE

Um livro de 800 paginas leva dezenas de minutos entre extracao, embedding e
grafo. Com so o status `running`, a tela mostrava um relogio correndo e nada
mais: "travou?" e "falta muito?" nao tinham resposta. Aqui cada etapa do
pipeline diz onde esta, e o percentual sai do trabalho FEITO (lotes de pagina,
lotes de embedding, trechos do grafo), nao de uma estimativa por tempo.

COMO CHEGA AQUI SEM PASSAR `run_id` POR TODA A CADEIA

`ingest_document` abre o relator do run num `ContextVar`; `extract`, `embed` e
`graph.construir` so chamam `avancar(...)`. Fora de uma ingestao (busca,
benchmark, testes) nao ha relator e as chamadas nao fazem nada -- o embedding da
busca nao pode escrever no log de ingestao.

O QUE VAI PARA O BANCO, E QUANDO

- `ingest_run.stage/progress/stage_detail`: o estado atual. Atualizado no maximo
  uma vez por `INTERVALO_SEGUNDOS`, salvo troca de etapa -- o embedding de um
  livro faz centenas de lotes, e um UPDATE por lote seria carga a toa;
- `ingest_event`: o LOG. Uma linha por mudanca de etapa e por marco (cada lote
  de paginas do docling, cada 10% do embedding e do grafo). E o que a tela
  mostra quando se abre o documento.

Falha aqui NUNCA derruba a ingestao: progresso e janela, nao pipeline.
"""

from __future__ import annotations

import logging
import time
from contextvars import ContextVar
from dataclasses import dataclass, field

from .db import conn

log = logging.getLogger(__name__)

INTERVALO_SEGUNDOS = 1.0

# Faixa de percentual de cada etapa. Os pesos vem do tempo medido numa ingestao
# de PDF com OCR: a extracao domina, o embedding vem depois, o grafo (chamada de
# IA por trecho pai) e o terceiro. Sao faixas, nao previsao: o numero so anda
# quando o trabalho anda.
ETAPAS: dict[str, tuple[float, float, str]] = {
    "fila": (0, 0, "na fila"),
    "iniciado": (0, 1, "iniciado"),
    "extracao": (1, 45, "extraindo texto"),
    "corte": (45, 50, "cortando em trechos"),
    "embedding": (50, 75, "gerando embeddings"),
    "gravacao": (75, 80, "gravando no banco"),
    # Grafo e wiki cresceram com a fase 3 (livro inteiro, e nao so o comeco):
    # ate 40 chamadas de grafo e 8 destilacoes num livro, minutos de verdade.
    "grafo": (80, 92, "extraindo o grafo"),
    "wiki": (92, 99, "destilando a wiki"),
    "concluido": (100, 100, "concluído"),
    "falhou": (0, 0, "falhou"),
}


@dataclass
class _Relator:
    run_id: int
    etapa: str = ""
    percentual: float = 0.0
    ultimo_update: float = 0.0
    marcos: dict[str, int] = field(default_factory=dict)


_atual: ContextVar[_Relator | None] = ContextVar("kb_ingest_relator", default=None)


def evento(run_id: int, etapa: str, mensagem: str, percentual: float | None = None) -> None:
    """Uma linha no log do documento, fora de uma ingestao em curso (fila, retomada)."""
    try:
        with conn() as connection, connection.cursor() as cur:
            cur.execute(
                "INSERT INTO ingest_event (run_id, stage, progress, message) VALUES (%s,%s,%s,%s)",
                (run_id, etapa, percentual, mensagem[:1000]),
            )
            connection.commit()
    except Exception as exc:  # noqa: BLE001
        log.debug("progresso: evento de %s nao gravado: %s", run_id, exc)


def iniciar(run_id: int | None):
    """Liga o relator deste run no contexto atual. Devolve o token para `encerrar`."""
    if run_id is None:
        return None
    return _atual.set(_Relator(run_id=run_id))


def encerrar(token) -> None:
    if token is not None:
        _atual.reset(token)


def _gravar(r: _Relator, detalhe: str, com_evento: bool) -> None:
    try:
        with conn() as connection, connection.cursor() as cur:
            cur.execute(
                "UPDATE ingest_run SET stage = %s, progress = %s, stage_detail = %s WHERE id = %s",
                (r.etapa, round(r.percentual, 1), detalhe[:500], r.run_id),
            )
            if com_evento:
                cur.execute(
                    "INSERT INTO ingest_event (run_id, stage, progress, message)"
                    " VALUES (%s,%s,%s,%s)",
                    (r.run_id, r.etapa, round(r.percentual, 1), detalhe[:1000]),
                )
            connection.commit()
        r.ultimo_update = time.monotonic()
    except Exception as exc:  # noqa: BLE001
        log.debug("progresso de %s nao gravado: %s", r.run_id, exc)


def etapa(nome: str, detalhe: str = "") -> None:
    """Entrou numa etapa. Sempre grava e sempre vira linha no log."""
    r = _atual.get()
    if r is None:
        return
    inicio, _fim, rotulo = ETAPAS.get(nome, (r.percentual, r.percentual, nome))
    r.etapa = nome
    # Nunca volta: `falhou` guarda o percentual onde parou, que e o que diz ATE
    # ONDE o documento chegou.
    if nome != "falhou":
        r.percentual = max(r.percentual, inicio)
    _gravar(r, detalhe or rotulo, com_evento=True)


def nota(mensagem: str) -> None:
    """Uma linha no log do documento em curso, sem mexer no percentual.

    Para decisao que a tela precisa mostrar (a triagem do PDF, o sumario
    ancorado). Passar por `avancar` com o mesmo marco fazia a segunda mensagem
    virar so atualizacao do estado, e ela sumia do log.
    """
    r = _atual.get()
    if r is None:
        return
    _gravar(r, mensagem, com_evento=True)


def avancar(nome: str, feito: int, total: int, detalhe: str = "", marco_a_cada: float = 0.1) -> None:
    """Progresso DENTRO de uma etapa: `feito` de `total` unidades de trabalho.

    Vira linha no log a cada `marco_a_cada` da etapa (10% por padrao); com
    `marco_a_cada=0`, toda chamada vira linha (usado nos lotes do docling, que
    sao poucos e demorados).
    """
    r = _atual.get()
    if r is None or total <= 0:
        return
    if r.etapa != nome:
        etapa(nome)
    inicio, fim, _rotulo = ETAPAS.get(nome, (r.percentual, r.percentual, nome))
    fracao = min(1.0, max(0.0, feito / total))
    r.percentual = max(r.percentual, inicio + (fim - inicio) * fracao)

    marco = int(fracao / marco_a_cada) if marco_a_cada > 0 else feito
    novo_marco = marco != r.marcos.get(nome, -1)
    if novo_marco:
        r.marcos[nome] = marco
    agora = time.monotonic()
    if novo_marco or agora - r.ultimo_update >= INTERVALO_SEGUNDOS:
        _gravar(r, detalhe or f"{feito} de {total}", com_evento=novo_marco)

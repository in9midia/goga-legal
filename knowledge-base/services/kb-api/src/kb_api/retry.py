"""Retentativa automatica da ingestao que falhou por motivo passageiro.

POR QUE ISTO EXISTE

A ingestao depende de coisas que saem do ar sem aviso: o provedor de embedding
devolve 429, a rede pisca, o OCR estoura o tempo. Sem retentativa, o documento
fica `failed` e alguem precisa notar e reenviar. Numa carga de trezentos
arquivos "alguem precisa notar" nao acontece: o arquivo some no meio do log e a
base fica com um buraco que ninguem sabe que existe -- e um buraco na base nao
se anuncia, ele so faz a busca responder menos.

O QUE TORNA A RETENTATIVA POSSIVEL SEM O ARQUIVO DE VOLTA

O bruto vai para o object store ANTES da extracao, e a linha do documento guarda
o `raw_key`. A retentativa le de la e roda o pipeline de novo. Quem enviou nao
precisa estar por perto -- nem existir mais.

POR QUE UMA THREAD, E NAO UM CRONJOB DO KUBERNETES

Um CronJob subiria outro pod da MESMA imagem, que tem 6,4 GB (torch, docling,
modelos de layout) e leva minutos so para comecar -- para um trabalho que
normalmente nao tem nada a fazer. E ele precisaria das mesmas credenciais, do
mesmo pool e do mesmo acesso ao object store, tudo duplicado num segundo
manifesto, em outro repositorio.

A thread aqui dentro custa um timer. Ela morre com o pod e volta com ele, e o
estado que importa -- a fila -- esta no Postgres, nao na memoria. O dia em que
houver mais de uma replica, duas threads podem pegar o mesmo documento: o
conserto nesse dia e um `FOR UPDATE SKIP LOCKED` na selecao, nao um CronJob.
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import UTC, datetime, timedelta
from typing import Any

from . import graph, ingest, storage
from .config import settings
from .db import conn

log = logging.getLogger(__name__)

# Um documento por vez, e com pausa entre eles.
#
# A retentativa concorre com a ingestao de quem esta usando o sistema AGORA, e
# perde essa disputa de proposito: ela e trabalho de fundo sobre arquivo que ja
# falhou uma vez. Reprocessar cinquenta em paralelo tomaria o pool de conexoes e
# a cota do provedor de quem esta esperando na tela.
#
# Serial com pausa, porem, nao e perder disputa nenhuma: e ser lento enquanto
# SOMA uma concorrencia. Quem cumpre a promessa escrita acima e
# `_carga_de_gente`, que adia a rodada inteira enquanto houver ingestao de
# usuario em andamento.
POR_RODADA = 5
PAUSA_ENTRE_DOCUMENTOS = 2.0

# O `principal` gravado nas execucoes desta thread. Deixou de ser so um rotulo
# no log: e por ele que a rodada distingue a propria ingestao da de quem esta
# usando o sistema, e portanto ele NAO pode mudar sem mudar `_carga_de_gente`.
PRINCIPAL = "retentativa automatica"

# Acima disto uma execucao `running` nao pode ser upload vivo: e o
# `proxy-read-timeout` do ingress, entao a borda ja devolveu 504 e quem enviou
# ja foi embora. Vem da configuracao, nao de calibragem -- se o ingress mudar,
# este numero muda junto.
TETO_DA_BORDA_SEGUNDOS = 1800

_estado: dict[str, Any] = {"ultima": None, "retentados": 0, "recuperados": 0}
_trava = threading.Lock()
_parar = threading.Event()


def estado() -> dict[str, Any]:
    with _trava:
        return dict(_estado)


def pendentes() -> list[dict[str, Any]]:
    """O que esta na fila, para a tela mostrar. Nao muda nada."""
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            SELECT id, space_slug, filename, error, retry_count, next_retry_at,
                   error_kind
              FROM document
             WHERE active AND status = 'failed'
             ORDER BY next_retry_at NULLS LAST, id DESC
             LIMIT 200
            """
        )
        return [
            {"id": r[0], "space": r[1], "filename": r[2], "error": r[3],
             "retry_count": r[4],
             "next_retry_at": r[5].isoformat() if r[5] else None,
             "error_kind": r[6],
             "tentativas_restantes": max(0, ingest.MAX_TENTATIVAS - r[4])
             if r[6] == ingest.RECUPERAVEL else 0}
            for r in cur.fetchall()
        ]


def _da_vez() -> list[tuple[int, str, str, str]]:
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            SELECT id, space_slug, filename, raw_key
              FROM document
             WHERE active AND status = 'failed'
               AND error_kind = %s
               AND retry_count < %s
               AND next_retry_at IS NOT NULL AND next_retry_at <= now()
               AND raw_key <> ''
             ORDER BY next_retry_at
             LIMIT %s
            """,
            (ingest.RECUPERAVEL, ingest.MAX_TENTATIVAS, POR_RODADA),
        )
        return cur.fetchall()


def _carga_de_gente() -> int:
    """Quantas ingestoes de OUTREM estao rodando agora.

    O docstring deste modulo promete que a retentativa "perde a disputa de
    proposito", mas serial com pausa de 2 s nao e perder disputa nenhuma: e so
    ser lento enquanto SOMA uma concorrencia a mais.

    Isso importa porque o laco se fecha sobre si mesmo. Os documentos da fila
    falharam por motivo passageiro, e motivo passageiro numa carga e quase
    sempre o sistema ocupado. Retentar no meio da carga deixa a carga mais
    pesada, tem mais chance de falhar de novo, e cada falha dessas QUEIMA uma
    tentativa do backoff -- contra um sistema que estava ocupado, nao quebrado.
    Medido na carga real: com duas ingestoes simultaneas um documento passou de
    267 s para 1042 s. A terceira viria daqui.

    Exclui as execucoes da propria thread: sem isso a rodada pararia no segundo
    documento, vendo o primeiro que ela mesma iniciou.

    Ignora linha `running` velha demais para ser real. `_fechar_trabalhos_orfaos`
    limpa os orfaos no startup, mas depender SO disso deixaria a retentativa
    morta para sempre e em silencio se aquela limpeza falhasse uma vez: a fila
    nunca andaria e nada no log diria por que.

    O corte nao e um numero chutado. A ingestao e sincrona e quem segura a
    conexao e o nginx do ingress, com `proxy-read-timeout: 1800`. Passou disso,
    a borda ja desistiu e ninguem esta mais esperando aquela linha -- ela pode
    ate ter trabalho rodando atras, mas nao e mais carga de usuario para efeito
    de ceder a vez. Ver armadilha 28 da arquitetura.
    """
    with conn() as connection, connection.cursor() as cur:
        # O corte vai como timestamp pronto, e nao como `make_interval` na
        # consulta: um parametro de data e o mesmo em qualquer versao do
        # Postgres, e da para conferir num teste sem banco de pe.
        corte = datetime.now(UTC) - timedelta(seconds=TETO_DA_BORDA_SEGUNDOS)
        cur.execute(
            "SELECT count(*) FROM ingest_run "
            " WHERE status = 'running' AND coalesce(principal, '') <> %s"
            "   AND started_at > %s",
            (PRINCIPAL, corte),
        )
        return int(cur.fetchone()[0])


def rodada() -> dict[str, Any]:
    """Uma passada pela fila. Devolve o que aconteceu."""
    ocupado = _carga_de_gente()
    if ocupado:
        # Nao e falha e nao gasta tentativa: `next_retry_at` fica onde estava e
        # a proxima rodada pega os mesmos documentos. Esperar o intervalo custa
        # minutos num trabalho que ja esperou horas.
        log.info("rodada adiada: %s ingestao(oes) em andamento", ocupado)
        with _trava:
            _estado["ultima"] = time.time()
            _estado["adiada_por"] = ocupado
        # `tentados` e `recuperados` SEMPRE presentes: `_laco` le `tentados` na
        # volta, e um retorno sem essa chave viraria KeyError engolido pelo
        # `except` de la, logado como "rodada falhou" -- que seria mentira.
        return {"tentados": 0, "recuperados": 0,
                "adiada": True, "ingestoes_em_andamento": ocupado}

    alvos = _da_vez()
    recuperados = 0
    for document_id, space_slug, filename, raw_key in alvos:
        if _parar.is_set():
            break
        if _carga_de_gente():
            # Alguem comecou a enviar no meio da rodada. Solta a vez aqui em vez
            # de terminar os cinco: o resto da fila espera bem, quem esta na
            # tela nao.
            log.info("rodada interrompida: comecou uma ingestao de usuario")
            break
        try:
            dados = storage.get(raw_key)
        except Exception as exc:  # noqa: BLE001
            # Sem o bruto nao ha o que retentar. Isso nao e erro passageiro:
            # marcar como definitivo tira a linha da fila em vez de deixa-la
            # girando para sempre contra um objeto que nao existe.
            log.warning("bruto de %s sumiu do object store (%s): %s", filename, raw_key, exc)
            with conn() as connection, connection.cursor() as cur:
                cur.execute(
                    "UPDATE document SET error_kind = %s, next_retry_at = NULL, "
                    "error = %s WHERE id = %s",
                    (ingest.DEFINITIVO,
                     "o arquivo original não está mais no object store; envie de novo",
                     document_id),
                )
                connection.commit()
            continue

        log.info("retentando %s (%s)", filename, space_slug)
        try:
            # `force=True`: sem isso a deduplicacao por conteudo veria o mesmo
            # sha e devolveria "ja indexado" -- da linha que justamente FALHOU.
            resultado = ingest.ingest_document(
                space_slug, filename, dados, PRINCIPAL, force=True
            )
        except Exception as exc:  # noqa: BLE001
            # `ingest_document` ja registrou a falha e agendou a proxima espera.
            log.info("retentativa de %s falhou de novo: %s", filename, str(exc)[:200])
            time.sleep(PAUSA_ENTRE_DOCUMENTOS)
            continue

        if resultado.status == "indexed" and resultado.document_id != document_id:
            # A linha que falhou sai SO depois do sucesso. Mesma ordem do
            # reprocessamento: falhar no meio nao pode deixar a base sem o
            # documento nem com dois.
            with conn() as connection, connection.cursor() as cur:
                cur.execute("DELETE FROM document WHERE id = %s", (document_id,))
                connection.commit()
            # O GRAFO NAO SAI NA CASCATA. O `DELETE` acima leva junto trecho,
            # embedding e figura porque sao chave estrangeira no Postgres -- e
            # foi exatamente essa leitura que deixou o Memgraph de fora daqui
            # por engano: la nao existe cascata nenhuma, e o no so some quando
            # alguem manda.
            #
            # As duas rotas irmas que apagam documento (remocao e reprocesso)
            # ja chamavam isto; so este caminho nao chamava. O estrago seria um
            # `:Document` apontando para uma linha que nao existe mais, que e a
            # armadilha 24 da arquitetura: a tela navega pelo ponteiro e cai em
            # "documento nao encontrado".
            graph.forget_document(document_id)
            recuperados += 1
            log.info("recuperado por retentativa: %s", filename)
        time.sleep(PAUSA_ENTRE_DOCUMENTOS)

    with _trava:
        _estado["ultima"] = time.time()
        _estado["retentados"] += len(alvos)
        _estado["recuperados"] += recuperados
    return {"tentados": len(alvos), "recuperados": recuperados}


def _laco() -> None:
    # Primeira rodada nao sai imediatamente: no boot o pod ainda esta
    # verificando banco e object store, e disputar isso com o startup atrasa o
    # que importa -- ficar pronto para servir.
    _parar.wait(60)
    while not _parar.is_set():
        try:
            resultado = rodada()
            if resultado["tentados"]:
                log.info("retentativa: %s tentado(s), %s recuperado(s)",
                         resultado["tentados"], resultado["recuperados"])
        except Exception as exc:  # noqa: BLE001
            # O laco nunca morre por causa de uma rodada ruim: se o Postgres
            # piscar, a proxima rodada tenta de novo.
            log.warning("rodada de retentativa falhou: %s", exc)
        _parar.wait(settings.retry_interval_seconds)


def iniciar() -> None:
    if not settings.retry_enabled:
        log.info("retentativa automatica desligada (KB_RETRY=false)")
        return
    threading.Thread(target=_laco, name="retentativa", daemon=True).start()
    log.info("retentativa automatica a cada %ss", settings.retry_interval_seconds)


def parar() -> None:
    _parar.set()

"""Ponto de retomada da ingestao: o que ja foi feito nao se paga de novo.

POR QUE EXISTE

A falha mais comum da ingestao e no EMBEDDING, e quase nunca e do documento:
licenca do provedor expirada, cota estourada, chave revogada. Ate aqui a
retentativa rodava o pipeline inteiro de novo -- docling (minutos num PDF
longo), derivacao do conceito OKF (uma chamada de chat paga) e todos os lotes de
embedding desde o primeiro. Num livro de milhares de trechos que caiu no lote
280 de 300, a retentativa pagava de novo os 279 que ja tinham voltado.

Agora a ingestao guarda, no object store, ao lado do bruto:

* o PREPARO: extracao, conceito e plano de corte, logo depois do corte;
* cada LOTE de vetores, assim que o provedor devolve.

A proxima tentativa com o mesmo conteudo e a mesma configuracao de corte le o
preparo e os lotes, e o embedding recomeca do primeiro trecho sem vetor.

POR QUE NO OBJECT STORE, E NAO NO POSTGRES

E dado de trabalho, descartavel e grande (um livro chega a dezenas de MB de
vetores). No Postgres viraria tabela nova, migracao e WAL para algo que existe
por horas. O bruto ja mora no object store pelo mesmo motivo -- a retentativa
depende dele -- e o ponto de retomada so faz sentido junto com ele.

O QUE INVALIDA

* conteudo diferente: a chave e pelo sha do bruto;
* configuracao de corte diferente (`assinatura`): os trechos seriam outros;
* `VERSAO` diferente: o preparo e pickle de classes deste codigo, e uma
  mudanca nelas poderia desserializar objeto pela metade. Suba a versao ao
  mudar `Extracted`, `Concept` ou `ChunkPlan`;
* modelo de embedding diferente: vetor de um modelo nao se mistura com o de
  outro no mesmo documento (a busca degradaria sem erro nenhum). Quem confere e
  `embedding.embed`, porque e ele quem sabe qual provedor vai responder.

Cada lote carrega o `token` do preparo que o gerou. Sem isso um lote velho,
de uma tentativa com outro corte, seria lido como continuacao do plano novo --
o indice do trecho bateria, o texto nao.

Tudo aqui e MELHOR ESFORCO: falha ao gravar ou ler o ponto de retomada so custa
refazer trabalho, e nunca pode derrubar uma ingestao que ia dar certo.
"""

from __future__ import annotations

import hashlib
import json
import logging
import pickle
import uuid
from array import array
from dataclasses import dataclass
from typing import Any

from . import storage

log = logging.getLogger(__name__)

VERSAO = 1


@dataclass
class Preparo:
    token: str
    extracted: Any
    concept: Any
    chunk_plan: Any


def assinatura(config: dict) -> str:
    return hashlib.sha256(
        json.dumps({"versao": VERSAO, **config}, sort_keys=True, default=str).encode()
    ).hexdigest()[:16]


def _prefixo(space: str, sha: str) -> str:
    return f"{space}/{sha[:2]}/{sha}/retomada"


def _chave_lote(space: str, sha: str, inicio: int) -> str:
    return f"{_prefixo(space, sha)}/embedding/{inicio:07d}.bin"


def carregar(space: str, sha: str, assinatura_atual: str) -> Preparo | None:
    try:
        dados = pickle.loads(storage.get(f"{_prefixo(space, sha)}/preparo.pkl"))  # noqa: S301
    except Exception:  # noqa: BLE001 - ausente, corrompido ou de outra versao
        return None
    if not isinstance(dados, dict) or dados.get("assinatura") != assinatura_atual:
        return None
    return Preparo(dados["token"], dados["extracted"], dados["concept"], dados["chunk_plan"])


def guardar(
    space: str, sha: str, assinatura_atual: str, extracted: Any, concept: Any, chunk_plan: Any,
) -> str:
    """Grava o preparo e devolve o token que os lotes desta tentativa carregam."""
    token = uuid.uuid4().hex
    try:
        storage.put(
            f"{_prefixo(space, sha)}/preparo.pkl",
            pickle.dumps({"assinatura": assinatura_atual, "token": token,
                          "extracted": extracted, "concept": concept,
                          "chunk_plan": chunk_plan}),
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("nao guardei o ponto de retomada de %s: %s", sha[:12], exc)
    return token


def _serializar(token: str, modelo: str, vetores: list[list[float]]) -> bytes:
    dimensao = len(vetores[0]) if vetores else 0
    cabecalho = json.dumps(
        {"token": token, "model": modelo, "n": len(vetores), "dim": dimensao}
    ).encode()
    # float32 e o que o pgvector guarda: gravar float64 dobraria o tamanho para
    # guardar casas que o indice joga fora.
    corpo = array("f", [x for v in vetores for x in v]).tobytes()
    return cabecalho + b"\n" + corpo


def _desserializar(bruto: bytes) -> tuple[dict, list[list[float]]]:
    cabecalho, corpo = bruto.split(b"\n", 1)
    meta = json.loads(cabecalho)
    plano = array("f")
    plano.frombytes(corpo)
    dim = meta["dim"]
    vetores = [plano[i * dim:(i + 1) * dim].tolist() for i in range(meta["n"])]
    return meta, vetores


def gravar_lote(
    space: str, sha: str, token: str, modelo: str, inicio: int, vetores: list[list[float]],
) -> None:
    try:
        storage.put(_chave_lote(space, sha, inicio), _serializar(token, modelo, vetores))
    except Exception as exc:  # noqa: BLE001
        log.warning("nao guardei o lote %s de %s: %s", inicio, sha[:12], exc)


def vetores(space: str, sha: str, token: str, total: int) -> tuple[list[list[float]], str]:
    """Os vetores ja prontos desta tentativa, em ordem, e o modelo que os gerou.

    Para no primeiro buraco, no primeiro lote de outro preparo e na primeira
    troca de modelo: o que vem depois disso nao e continuacao confiavel.
    """
    prontos: list[list[float]] = []
    modelo = ""
    while len(prontos) < total:
        try:
            meta, lote = _desserializar(storage.get(_chave_lote(space, sha, len(prontos))))
        except Exception:  # noqa: BLE001 - ausente: acabou o que estava pronto
            break
        if meta.get("token") != token or (modelo and meta.get("model") != modelo) or not lote:
            break
        modelo = meta.get("model", "")
        prontos.extend(lote)
    return prontos[:total], modelo


def limpar(space: str, sha: str) -> None:
    """Remove o ponto de retomada. Chamado depois que a versao nova foi gravada."""
    inicio = 0
    while True:
        chave = _chave_lote(space, sha, inicio)
        try:
            meta, _ = _desserializar(storage.get(chave))
            storage.delete(chave)
        except Exception:  # noqa: BLE001
            break
        if not meta.get("n"):
            break
        inicio += meta["n"]
    try:
        storage.delete(f"{_prefixo(space, sha)}/preparo.pkl")
    except Exception as exc:  # noqa: BLE001
        log.warning("nao removi o ponto de retomada de %s: %s", sha[:12], exc)

"""Embedding, com lote, contagem de tokens e provedor configuravel (ING-09).

O provedor NAO vem mais do ambiente: vem da tabela `ai_provider`, editavel na
tela Administracao > Modelos de IA. Azure OpenAI, OpenAI, Azure AI Foundry e
LiteLLM sao dialetos de uma mesma chamada -- o que muda e a URL, o cabecalho de
autenticacao e se o nome do modelo vai no caminho ou no corpo. Ver
`providers.DIALETOS`.

A dimensao continua no DDL da tabela de embedding, e a API recusa tornar padrao
um provedor que devolva outra -- trocar de modelo e operacao consciente, nao
acidente silencioso.

Toda chamada soma no contador diario (`providers.registrar_uso`), inclusive as
que falham: gasto que nao aparece e gasto que ninguem controla.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass

import requests
import requests.adapters

from . import progresso, providers
from .config import settings

log = logging.getLogger(__name__)

def _estimar_tokens(texts: list[str]) -> int:
    """Estimativa grosseira, para quando o provedor nao reporta uso.

    Quatro caracteres por token e regra de bolso, nao medicao nossa: vale para
    texto latino e erra para mais em lexico juridico, que e denso em palavra
    longa. Por isso o numero NUNCA vai para a coluna `tokens` — vai para
    `tokens_estimados`, e a tela soma as duas separadas.

    A alternativa seria um tokenizador de verdade, que custaria uma dependencia
    por provedor para medir o que o provedor deveria ter dito.
    """
    return sum(len(t) for t in texts) // 4


# A API do Azure aceita lotes; 16 e conservador e cabe no limite de tokens por
# requisicao mesmo com chunk grande.
BATCH_SIZE = 16


@dataclass
class EmbedResult:
    vectors: list[list[float]]
    tokens: int
    latency_ms: int
    model: str


# Tres tentativas com espera de 2s, 4s, 6s. Tres porque a falha observada foi
# sempre de um segundo; mais que isso so atrasaria uma ingestao de 44 arquivos.
EMBED_ATTEMPTS = 3
EMBED_BACKOFF_SECONDS = 2
RETRIABLE_STATUS = {408, 429, 500, 502, 503, 504}

# 429 NA INGESTAO ESPERA A QUOTA VOLTAR. A quota do Gemini e por minuto, e um
# livro gera milhares de chunks: com 2 s + 4 s de espera a terceira tentativa
# ainda caia na mesma janela, e o documento inteiro era recusado. Na busca
# continua valendo `TENTATIVAS_POR_OPERACAO` -- ali quem espera e uma pessoa.
TENTATIVAS_429_INDEX = 8
ESPERA_429_MAX_SECONDS = 60

# QUEM ESPERA MUDA A POLITICA, e isto nao e ajuste fino.
#
# Na ingestao, um blip de rede custa o DOCUMENTO INTEIRO: ja aconteceu duas
# vezes neste projeto, e o arquivo ficou fora da base sem ninguem notar. Ali
# vale esperar 180 s e tentar tres vezes.
#
# Na busca quem espera e uma pessoa (ou um agente com o proprio teto), e a mesma
# politica vira 180 s x 3 = nove minutos de tela parada. E a degradacao existe e
# e boa: `EmbeddingError` tira aquele Espaco do braco vetorial e a busca segue
# pelo lexical, que e muito melhor que um erro depois de nove minutos.
#
# Medido: com o teto unico, a pior busca do benchmark levou 32,5 s enquanto a
# mediana era 1,07 s -- um engasgo do provedor virava uma tela travada.
TIMEOUT_POR_OPERACAO = {"search": 8}
TIMEOUT_PADRAO = 180
TENTATIVAS_POR_OPERACAO = {"search": 2}


# CONEXAO PERSISTENTE COM O PROVEDOR.
#
# `urllib.request.urlopen` abre uma conexao NOVA a cada chamada: DNS, TCP e
# handshake TLS por pergunta. Medido contra o provedor real, a ida e volta do
# embedding levava 1033 e 1119 ms enquanto a busca inteira levava ~1030 ms -- ou
# seja, o tempo da busca ERA a chamada, e boa parte dela e aperto de mao que nao
# precisava existir.
#
# Uma sessao no modulo reaproveita a conexao entre requisicoes. O pool cobre as
# threads da busca em paralelo (`MAX_PARALELO` em `search.py`) com folga.
#
# `max_retries=0` de proposito: a retentativa daqui e nossa, porque a politica
# depende da OPERACAO (ver abaixo) e precisa distinguir 429 de 400. Deixar o
# urllib3 tentar por fora multiplicaria as tentativas em silencio.
_sessao = requests.Session()
_sessao.mount(
    "https://",
    requests.adapters.HTTPAdapter(pool_connections=4, pool_maxsize=16, max_retries=0),
)
_sessao.mount(
    "http://",
    requests.adapters.HTTPAdapter(pool_connections=4, pool_maxsize=16, max_retries=0),
)


class EmbeddingError(RuntimeError):
    pass


def _post(
    texts: list[str], provedor: providers.Provedor, operation: str = "index"
) -> tuple[list[list[float]], int, int]:
    dialeto = provedor.dialeto
    endpoint = (provedor.endpoint or dialeto.endpoint_padrao).rstrip("/")
    if not endpoint:
        raise EmbeddingError(
            f"o provedor '{provedor.name}' esta sem endpoint. "
            f"Configure em Administracao > Modelos de IA."
        )

    url = dialeto.url_embedding.format(
        endpoint=endpoint,
        model=provedor.model,
        api_version=provedor.api_version or dialeto.api_version_padrao,
    )
    corpo: dict = {"input": texts}
    # No Azure OpenAI o deployment ja esta na URL; nos demais o modelo vai no
    # corpo. Mandar nos dois lugares faz o Azure recusar com 400.
    if dialeto.modelo_no_corpo:
        corpo["model"] = provedor.model
    # So quem precisa. Ver o comentario de `dimensoes_no_corpo` em providers.py:
    # modelo que aceita truncar o vetor responde 200 com vetor menor, e vetor
    # menor no indice degrada a busca sem erro nenhum.
    if dialeto.dimensoes_no_corpo and provedor.dimensions:
        corpo["dimensions"] = provedor.dimensions

    cabecalhos = {
        "Content-Type": "application/json",
        dialeto.auth_header: f"{dialeto.auth_prefixo}{provedor.api_key}",
    }
    # Retentativa com espera crescente. Nao e zelo: um `Connection refused`
    # passageiro na chamada ao Azure ja custou DOIS documentos em ingestoes
    # diferentes deste projeto -- o arquivo era recusado inteiro por um blip de
    # rede de um segundo, e a base ficava sem ele sem ninguem notar.
    #
    # Retenta so o que faz sentido retentar: erro de rede e as respostas 429 e
    # 5xx do servidor. Um 400 (texto invalido, deployment errado) e definitivo e
    # repetir tres vezes so atrasaria a falha.
    body = None
    ultimo: Exception | None = None
    espera = TIMEOUT_POR_OPERACAO.get(operation, TIMEOUT_PADRAO)
    tentativas = TENTATIVAS_POR_OPERACAO.get(operation, EMBED_ATTEMPTS)
    if operation != "search":
        tentativas = max(tentativas, TENTATIVAS_429_INDEX)
    pausa = 0.0
    for tentativa in range(1, tentativas + 1):
        pausa = EMBED_BACKOFF_SECONDS * tentativa
        try:
            resposta = _sessao.post(url, data=json.dumps(corpo).encode(),
                                    headers=cabecalhos, timeout=espera)
            if resposta.status_code >= 400:
                detalhe = resposta.text[:200]
                limite = tentativas if resposta.status_code == 429 else min(
                    tentativas, TENTATIVAS_POR_OPERACAO.get(operation, EMBED_ATTEMPTS)
                )
                if resposta.status_code not in RETRIABLE_STATUS or tentativa >= limite:
                    raise EmbeddingError(
                        f"{provedor.name} recusou o embedding: "
                        f"HTTP {resposta.status_code} {detalhe}"
                    )
                ultimo = EmbeddingError(f"HTTP {resposta.status_code}")
                if resposta.status_code == 429:
                    pausa = _espera_429(resposta, tentativa)
                log.warning(
                    "embedding HTTP %s (tentativa %s/%s): %s",
                    resposta.status_code, tentativa, tentativas, detalhe,
                )
            else:
                body = resposta.json()
                break
        except EmbeddingError:
            raise
        except Exception as exc:  # noqa: BLE001 - rede, DNS, timeout
            if tentativa >= min(tentativas, TENTATIVAS_POR_OPERACAO.get(operation, EMBED_ATTEMPTS)):
                raise EmbeddingError(f"falha de rede no embedding: {exc}") from None
            ultimo = exc
            log.warning(
                "falha de rede no embedding (tentativa %s/%s): %s",
                tentativa, tentativas, exc,
            )
        time.sleep(pausa)

    if body is None:  # defensivo: o laco acima ou preenche ou levanta
        raise EmbeddingError(f"embedding nao respondeu: {ultimo}")

    # A API nao garante a ordem; `index` e a fonte da verdade.
    data = sorted(body.get("data") or [], key=lambda item: item.get("index", 0))
    vectors = [item["embedding"] for item in data]

    # `usage` ausente NAO e zero. A camada compativel do Gemini nao devolve o
    # bloco (conferido contra a API), e gravar 0 como se fosse medido faria o
    # painel de custo por caso mostrar gasto zero para uma base inteira -- pior
    # que ausente, porque zero parece medicao.
    uso = body.get("usage") or {}
    if "total_tokens" in uso:
        return vectors, int(uso["total_tokens"]), 0
    return vectors, 0, _estimar_tokens(texts)


def _espera_429(resposta, tentativa: int) -> float:
    """Segundos ate a proxima tentativa apos um 429: `Retry-After` se vier, senao exponencial."""
    try:
        pedido = float(resposta.headers.get("Retry-After", ""))
    except ValueError:
        pedido = 0.0
    return min(ESPERA_429_MAX_SECONDS, max(pedido, 5.0 * 2 ** (tentativa - 1)))


def embed(texts: list[str], operation: str = "index", space: str = "") -> EmbedResult:
    """Vetoriza os textos com o provedor do Espaco, contando o gasto.

    `operation` diz de ONDE veio a chamada (`index`, `search`, `chunking`) e e
    o que permite o dashboard separar o custo da ingestao do custo das buscas.

    `space` decide QUAL provedor. Vazio cai no padrao da instalacao, que e o
    comportamento de antes e continua sendo o de toda base que nao escolheu.
    Passar o Espaco errado aqui nao daria erro nenhum: vetorizaria com o modelo
    de outra base e a busca so ficaria pior -- por isso todo chamador o informa
    explicitamente, em vez de existir um "Espaco corrente" implicito.
    """
    if not texts:
        return EmbedResult([], 0, 0, "")

    provedor = providers.padrao("embedding", space)
    started = time.perf_counter()
    vectors: list[list[float]] = []
    tokens = 0
    estimados = 0
    try:
        for start in range(0, len(texts), BATCH_SIZE):
            batch = texts[start : start + BATCH_SIZE]
            if operation == "index":
                progresso.avancar(
                    "embedding", start, len(texts), f"{start} de {len(texts)} trechos"
                )
            batch_vectors, batch_tokens, batch_estimados = _post(batch, provedor, operation)
            if len(batch_vectors) != len(batch):
                raise EmbeddingError(
                    f"o provedor devolveu {len(batch_vectors)} vetores para "
                    f"{len(batch)} textos"
                )
            vectors.extend(batch_vectors)
            tokens += batch_tokens
            estimados += batch_estimados

        if vectors and len(vectors[0]) != settings.embedding_dim:
            raise EmbeddingError(
                f"o modelo '{provedor.model}' devolveu {len(vectors[0])} dimensoes, "
                f"mas o indice espera {settings.embedding_dim}. Misturar dimensoes "
                f"no mesmo indice degrada a busca sem erro nenhum aparecer."
            )
    except Exception:
        # A falha tambem entra no contador. Gasto que nao aparece e gasto que
        # ninguem controla -- e uma sequencia de 429 e justamente o que se quer
        # ver no dashboard, nao so no log.
        providers.registrar_uso(
            provedor,
            operation,
            tokens=tokens,
            latency_ms=int((time.perf_counter() - started) * 1000),
            erro=True,
        )
        raise

    latency_ms = int((time.perf_counter() - started) * 1000)
    # Embedding so tem ENTRADA: nao ha texto gerado. Mandar o total como
    # `tokens_in` e o que faz o custo sair certo -- aplicar o preco de saida
    # aqui inflaria a conta em varias vezes.
    providers.registrar_uso(
        provedor,
        operation,
        tokens=tokens,
        tokens_in=tokens,
        tokens_estimados=estimados,
        latency_ms=latency_ms,
    )

    return EmbedResult(
        vectors=vectors,
        tokens=tokens,
        latency_ms=latency_ms,
        model=provedor.model,
    )

"""O Ragas falando com os provedores de IA desta casa.

POR QUE ESTE ARQUIVO EXISTE

O Ragas traz o proprio caminho de LLM: ele recebe um cliente do SDK oficial da
OpenAI e conversa por ele. O kb-api tem outro caminho -- `llm.py` e
`embedding.py` --, que fala os quatro dialetos da casa, decifra a credencial do
banco e registra o uso no contador. Os dois precisam conviver, e a ponte e aqui.

O QUE A PONTE PRECISA RESOLVER, E FOI MEDIDO

O modelo de chat em uso (`gpt-5.6-luna`, de raciocinio) RECUSA a familia de
parametros de amostragem que o Ragas envia. Medido contra o Azure, em sequencia:

    Unsupported parameter: 'max_tokens' is not supported with this model.
    Unsupported parameter: 'top_p' is not supported with this model.
    Unsupported value: 'temperature' does not support 0.01 ... Only the default

O `llm.py` ja resolve isso no caminho proprio, retentando com
`max_completion_tokens`. Mas o Ragas nao passa por ele e nao tem como saber.

TIRAR PREVENTIVAMENTE SERIA PIOR

A tentacao e remover a lista inteira de parametros antes de mandar. Isso quebra
o juiz num modelo que os aceita: `temperature=0` e o que faz a avaliacao ser
reproduzivel, e jogar fora o determinismo de um benchmark para agradar um modelo
que nem esta em uso e o pior dos dois mundos.

Por isso o transporte APRENDE: manda como veio, e so quando o servidor recusa e
que tira o parametro que a mensagem NOMEIA, e reenvia. A partir dai lembra, e o
custo extra some depois da primeira chamada.
"""
from __future__ import annotations

import json
import logging
import re

import httpx

from . import providers

log = logging.getLogger(__name__)

# As duas formas de recusa observadas. `parameter` quer dizer "nao existe";
# `value` quer dizer "so o default serve" -- e as duas se resolvem tirando.
_RECUSA = re.compile(r"[Uu]nsupported (?:parameter|value): '([^']+)'")

# Quando o parametro tem substituto, ele entra no lugar em vez de sumir: teto de
# tokens sem teto nenhum faria o juiz gastar o orcamento inteiro num caso so.
_SUBSTITUTO = {"max_tokens": "max_completion_tokens"}

# Teto de espera por chamada do juiz. Alto de proposito: uma metrica sozinha
# levou 53 s no `answer_relevancy` (ele gera perguntas a partir da resposta e
# embeda cada uma). Cortar em 30 s transformaria lentidao em falha.
TIMEOUT = 300.0

# Quantas vezes uma requisicao pode ser reenviada tirando parametro. Tres porque
# foram tres os recusados (`max_tokens`, `top_p`, `temperature`) e um teto solto
# transformaria um 400 teimoso em laco.
_MAX_ADAPTACOES = 6


class TransporteAdaptativo(httpx.AsyncBaseTransport):
    """Reenvia sem o parametro recusado, e lembra a recusa.

    O estado (`_proibidos`) e por instancia, e cada execucao de benchmark cria a
    sua: um modelo trocado na tela nao herda a lista do modelo anterior.
    """

    def __init__(self, interno: httpx.AsyncBaseTransport | None = None) -> None:
        self._interno = interno or httpx.AsyncHTTPTransport()
        self._proibidos: set[str] = set()

    @property
    def proibidos(self) -> set[str]:
        """O que este modelo recusou. Vai para o trace da execucao."""
        return set(self._proibidos)

    def _sem_proibidos(
        self, request: httpx.Request, original: bytes, proibidos: set[str]
    ) -> httpx.Request | None:
        corpo = json.loads(original or b"{}")
        mudou = False
        for parametro in list(corpo):
            if parametro not in proibidos:
                continue
            substituto = _SUBSTITUTO.get(parametro)
            if substituto and substituto not in corpo:
                corpo[substituto] = corpo[parametro]
            del corpo[parametro]
            mudou = True
        if not mudou:
            return None
        novo = json.dumps(corpo).encode()
        # Requisicao NOVA, e nao mutacao da antiga: em httpx o corpo que sai vem
        # do stream, e trocar so `_content` deixa o content-length novo com o
        # corpo velho. O sintoma e `APIConnectionError: Connection error`, que
        # parece rede caida e nao e.
        cabecalhos = {
            chave: valor
            for chave, valor in request.headers.items()
            if chave.lower() != "content-length"
        }
        cabecalhos["content-length"] = str(len(novo))
        return httpx.Request(request.method, request.url, headers=cabecalhos, content=novo)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        """Manda, e se recusarem, tira o parametro NOMEADO e manda de novo.

        ⚠ O CONTROLE DE LACO E LOCAL, E ISSO E O CONSERTO DE UM DEFEITO REAL.

        A primeira versao desistia quando o parametro recusado ja estava no
        conjunto compartilhado (`self._proibidos`), para nao entrar em laco
        infinito. Com uma pergunta por vez funcionava; com quatro em paralelo,
        nao: a requisicao B saia com o corpo montado ANTES de A aprender que
        `top_p` era proibido, e quando B levava a recusa o parametro ja estava
        no conjunto -- entao B desistia e devolvia o 400.

        Medido numa execucao de quatro perguntas: `context_precision` falhou em
        DUAS com "Unsupported parameter: 'top_p'", enquanto as outras duas
        passaram. Falha intermitente que so aparece com concorrencia, que e
        exatamente como o benchmark roda.

        Estar no conjunto compartilhado nao prova que ESTA requisicao foi
        adaptada. Quem prova e `tirados`, local a esta chamada.
        """
        original = request.content
        tirados: set[str] = set()
        tentativa = 0
        while True:
            tentativa += 1
            alvo = self._proibidos | tirados
            atual = request
            if alvo:
                adaptada = self._sem_proibidos(request, original, alvo)
                if adaptada is not None:
                    atual = adaptada

            resposta = await self._interno.handle_async_request(atual)
            if resposta.status_code != 400 or tentativa > _MAX_ADAPTACOES:
                return resposta

            await resposta.aread()
            achado = _RECUSA.search(resposta.text or "")
            if achado is None:
                # 400 por outro motivo (prompt invalido, deployment errado) e
                # definitivo: devolver para quem chamou ver a mensagem de verdade.
                return resposta

            parametro = achado.group(1)
            if parametro in tirados:
                # Ja tiramos NESTA chamada e ele recusou de novo: e definitivo.
                return resposta
            tirados.add(parametro)
            if parametro not in self._proibidos:
                self._proibidos.add(parametro)
                log.info("o modelo do juiz recusa `%s`; reenviando sem ele", parametro)
            await resposta.aclose()

    async def aclose(self) -> None:
        await self._interno.aclose()


def cliente(provedor: providers.Provedor, transporte: TransporteAdaptativo | None = None):
    """Cliente do SDK oficial a partir de um `Provedor` desta casa.

    A credencial vai do banco (decifrada) direto para o cliente, EM PROCESSO.
    Ela nao entra em log nem em mensagem de erro -- ver ADR-0009.
    """
    from openai import AsyncAzureOpenAI, AsyncOpenAI

    dialeto = provedor.dialeto
    endpoint = (provedor.endpoint or dialeto.endpoint_padrao).rstrip("/")
    if not endpoint:
        raise RuntimeError(
            f"o provedor '{provedor.name}' esta sem endpoint. "
            f"Configure em Administracao > Modelos de IA."
        )
    http = httpx.AsyncClient(transport=transporte or TransporteAdaptativo(), timeout=TIMEOUT)
    if provedor.kind in ("azure_openai", "azure_foundry"):
        return AsyncAzureOpenAI(
            azure_endpoint=endpoint,
            api_key=provedor.api_key,
            api_version=provedor.api_version or dialeto.api_version_padrao,
            http_client=http,
        )
    return AsyncOpenAI(base_url=endpoint, api_key=provedor.api_key, http_client=http)

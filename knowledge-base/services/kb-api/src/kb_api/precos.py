"""Preco de modelo, buscado num catalogo em vez de digitado de cabeca.

POR QUE ISTO EXISTE

O preco por 1M de tokens e um numero que ninguem sabe de cor e que muda sozinho
quando o provedor reajusta. Digitado a mao ele erra de duas formas caras: uma
virgula no lugar errado multiplica o custo por dez na tela, e um preco velho faz
o dashboard divergir da fatura sem nada indicar por que.

DE ONDE VEM O NUMERO

O mesmo catalogo que o agentic-sdlc usa: o `model_prices_and_context_window.json`
do LiteLLM, que e a tabela que o ecossistema mantem e que indexa modelo de todos
os provedores grandes. Duas fontes, nesta ordem:

  1. um gateway LiteLLM cadastrado aqui, em `/public/litellm_model_cost_map`.
     A rota e publica (sem credencial) e fica DENTRO da rede -- e o que faz a
     busca funcionar em cluster com egress fechado;
  2. a URL publica, quando nao ha gateway.

TRES RESPOSTAS, E ELAS NAO SAO A MESMA COISA

  * `catalogo`    -- achou, e o preco vai preenchido;
  * `nenhum`      -- o catalogo respondeu e NAO conhece este modelo. E o caso do
                     deployment do Azure com nome proprio (`gpt-5.6-luna`), e a
                     acao e preencher a mao;
  * `indisponivel`-- nao deu para LER o catalogo. Nada se sabe sobre este
                     modelo, e insistir nao ajuda ate a rede abrir.

Juntar `nenhum` e `indisponivel` numa resposta so foi um defeito real no
agentic-sdlc: num cluster sem saida, a busca respondia "nao conheco" ate para
`gpt-4o`, e quem visse isso concluiria que o modelo mais comum do mercado nao
tem preco.
"""
from __future__ import annotations

import json
import logging
import threading
import time
import urllib.error
import urllib.request
from typing import Any

from .config import settings

log = logging.getLogger(__name__)

# Seis horas. O catalogo muda quando um provedor reajusta -- semanas, nao
# minutos --, e reler a cada clique faria uma tela de cadastro depender de uma
# ida a internet para cada tecla no botao.
TTL_SEGUNDOS = 6 * 60 * 60

TIMEOUT = 12

_cache: dict[str, Any] = {"fonte": "", "mapa": None, "quando": 0.0}
_trava = threading.Lock()


def _baixar(url: str) -> dict | None:
    try:
        pedido = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(pedido, timeout=TIMEOUT) as resposta:  # noqa: S310
            if resposta.status != 200:
                log.info("catalogo de preco respondeu HTTP %s", resposta.status)
                return None
            dados = json.loads(resposta.read().decode("utf-8", errors="replace"))
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
        # Sem saida para a internet e o caso comum em cluster fechado, e nao e
        # erro do operador. Vira `indisponivel` na resposta, nao uma excecao.
        log.info("nao consegui ler o catalogo de preco (%s): %s", url, exc)
        return None
    return dados if isinstance(dados, dict) else None


def _mapa(gateway: str = "") -> dict | None:
    """O catalogo, memorizado por processo."""
    url = (
        f"{gateway.rstrip('/')}/public/litellm_model_cost_map"
        if gateway
        else settings.price_catalog_url
    )
    if not url:
        return None
    with _trava:
        if (
            _cache["mapa"] is not None
            and _cache["fonte"] == url
            and time.time() - _cache["quando"] < TTL_SEGUNDOS
        ):
            return _cache["mapa"]
    baixado = _baixar(url)
    if baixado is None:
        return None
    with _trava:
        _cache.update({"fonte": url, "mapa": baixado, "quando": time.time()})
    return baixado


def _por_1m(entrada: dict, campo: str) -> float | None:
    """O catalogo guarda custo POR TOKEN. Ausencia e `None`, nao zero.

    Zero afirmaria que o modelo e de graca, e um provedor que nao publica preco
    de saida viraria "so a entrada custa" no dashboard.
    """
    valor = entrada.get(campo)
    if valor is None:
        return None
    try:
        return round(float(valor) * 1_000_000, 6)
    except (TypeError, ValueError):
        return None


def _candidatos(kind: str, modelo: str) -> list[str]:
    """As chaves a tentar no catalogo, na ordem.

    O catalogo indexa por `<provider>/<modelo>` para alguns e pelo nome puro
    para outros, e quase sempre em minusculo. No Azure o que a gente guarda e o
    nome do DEPLOYMENT, que quem publicou pode ter chamado de qualquer coisa --
    por isso o nome puro entra na lista tambem, e por isso `nenhum` e uma
    resposta esperada aqui, nao um defeito.
    """
    nome = modelo.strip()
    baixo = nome.lower()
    if kind == "azure_openai":
        return [f"azure/{nome}", f"azure/{baixo}", nome, baixo]
    if kind == "azure_foundry":
        return [f"azure_ai/{baixo}", f"azure_ai/{nome}", nome, baixo]
    return [nome, baixo]


def buscar(kind: str, modelo: str, gateway: str = "") -> dict[str, Any]:
    """`{fonte, price_input_per_1m, price_output_per_1m}`. Nunca levanta."""
    mapa = _mapa(gateway)
    if mapa is None:
        return {"fonte": "indisponivel", "price_input_per_1m": None, "price_output_per_1m": None}

    for chave in _candidatos(kind, modelo):
        entrada = mapa.get(chave)
        if not isinstance(entrada, dict):
            continue
        entrada_1m = _por_1m(entrada, "input_cost_per_token")
        saida_1m = _por_1m(entrada, "output_cost_per_token")
        if entrada_1m is None and saida_1m is None:
            continue
        log.info("preco achado no catalogo: kind=%s chave=%s", kind, chave)
        return {
            "fonte": "catalogo",
            "chave": chave,
            "price_input_per_1m": entrada_1m,
            "price_output_per_1m": saida_1m,
        }

    log.info("catalogo nao conhece o modelo: kind=%s modelo=%s", kind, modelo)
    return {"fonte": "nenhum", "price_input_per_1m": None, "price_output_per_1m": None}

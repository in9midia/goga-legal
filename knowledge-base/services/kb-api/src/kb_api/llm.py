"""Chamada de chat que devolve JSON, com o mesmo provedor configuravel (ING-09).

Ate aqui este projeto so falava **embedding** com o modelo. A coluna `purpose`
de `ai_provider` ja previa outro proposito, mas nenhum existia -- e a decisao
de nao gerar texto era deliberada: o contrato da busca e devolver EVIDENCIA,
nunca resposta gerada (ADR-0006), e isso continua valendo.

O que mudou nao e esse contrato. Este modulo existe para a **derivacao de
conceito OKF na ingestao** (ADR-0015): transformar um PDF em algo que se
descreve -- tipo, titulo, descricao, tags -- porque documento corporativo chega
sem nada disso escrito, e sem isso o formato de entrada OKF so serviria para
bundle vindo de fora. O texto gerado aqui vira METADADO do documento, e nunca
resposta a uma pergunta de usuario.

TRES DECISOES QUE ESTE MODULO CARREGA

1. **`purpose="chat"` e um provedor separado do de embedding.** Sao modelos
   diferentes em quase toda instalacao, e forcar o mesmo cadastro obrigaria a
   escolher entre um bom embedding e um bom gerador;
2. **nunca levanta para quem chama.** `complete_json()` devolve `None` quando
   nao da. A ingestao nao pode morrer porque o provedor de chat esta fora do ar
   ou nem foi cadastrado -- ja aconteceu neste projeto de um provedor mal
   configurado custar os quatro documentos do Espaco `juridico`, e a licao
   ficou;
3. **timeout curto e UMA retentativa.** A ingestao ja e sincrona e o pior
   documento desta base leva 13,5 minutos. Uma derivacao teimosa somaria minutos
   por arquivo para produzir metadado auxiliar -- que e util, mas nao vale
   segurar a conexao.
"""

from __future__ import annotations

import json
import logging
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

from . import providers

log = logging.getLogger(__name__)

# Uma retentativa, nao tres como no embedding. A diferenca e de consequencia:
# embedding que falha deixa o trecho SEM VETOR, e o documento entra mudo para a
# busca vetorial; conceito que falha deixa o documento sem metadado auxiliar e
# ele continua perfeitamente buscavel.
TENTATIVAS = 2
ESPERA_SEGUNDOS = 2
RETENTAVEL = {408, 429, 500, 502, 503, 504}

# 60s por tentativa. Medido: a derivacao de conceito sobre 6000 caracteres
# responde em 2 a 5 s nos modelos em uso; 60 s e folga para um pico, sem virar
# dois minutos de espera no pior caso.
TIMEOUT_SEGUNDOS = 60


@dataclass
class Resposta:
    dados: dict
    tokens: int
    latency_ms: int
    model: str


# JSON dentro de cerca de codigo. Alguns modelos devolvem ```json ... ``` mesmo
# com `response_format` pedindo objeto, e recusar por causa da cerca seria
# jogar fora uma resposta correta por causa da embalagem.
_CERCA = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)


def _extrair_json(texto: str) -> dict | None:
    texto = (texto or "").strip()
    if not texto:
        return None
    cerca = _CERCA.search(texto)
    if cerca:
        texto = cerca.group(1).strip()
    try:
        dados = json.loads(texto)
    except Exception:  # noqa: BLE001
        # Ultimo recurso: o primeiro objeto balanceado do texto. Cobre o modelo
        # que antepoe uma frase ("Aqui esta o JSON:") apesar da instrucao.
        inicio = texto.find("{")
        fim = texto.rfind("}")
        if inicio < 0 or fim <= inicio:
            return None
        try:
            dados = json.loads(texto[inicio : fim + 1])
        except Exception:  # noqa: BLE001
            return None
    return dados if isinstance(dados, dict) else None


# Os modelos mais novos do Azure OpenAI e da OpenAI (familia `o*`, `gpt-5*`)
# recusam com 400 dois campos que todo o resto do catalogo aceita: `max_tokens`,
# que neles se chama `max_completion_tokens`, e `temperature` diferente de 1.
# Perguntar ao operador qual variante o deployment dele quer seria empurrar para
# a tela de cadastro uma diferenca que o proprio provedor ja informa na recusa
# -- e um cadastro correto apareceria quebrado ate alguem adivinhar. Entao o
# pedido se corrige pela mensagem de erro e repete.
#
# O laco nao corre risco de nao terminar: cada ajuste RETIRA do corpo o campo
# citado, e um campo ausente nunca volta a ser adaptado.
def _adaptar(corpo: dict, erro: str) -> str:
    """Ajusta `corpo` conforme a recusa do provedor. Devolve o que mudou, ou ""."""
    if "max_completion_tokens" in erro and "max_tokens" in corpo:
        corpo["max_completion_tokens"] = corpo.pop("max_tokens")
        return "max_tokens virou max_completion_tokens"
    if "temperature" in erro and "temperature" in corpo:
        # Sem temperatura explicita o modelo usa o default (1). Perde-se o zero
        # que garantia conceito igual para ingestao repetida -- mas metadado
        # instavel ainda e melhor que nenhum, e esses modelos nao dao escolha.
        del corpo["temperature"]
        return "temperature removido (o modelo so aceita o default)"
    return ""


@dataclass(frozen=True)
class Gasto:
    """Tokens de uma chamada, decompostos.

    Entrada e saida custam DIFERENTE -- na maioria dos provedores a saida sai de
    tres a cinco vezes mais cara. Guardar so o total obrigaria a tela de custo a
    escolher um preco para os dois, errando para mais no embedding (que so tem
    entrada) e para menos no chat.
    """

    total: int = 0
    entrada: int = 0
    saida: int = 0


def _post(
    provedor: providers.Provedor, mensagens: list[dict], max_tokens: int
) -> tuple[dict | None, Gasto, str]:
    """A chamada crua. Devolve `(json, gasto, erro)`.

    O texto do erro sai junto porque `complete_json` o descarta (ela nunca
    levanta) mas `testar` PRECISA dele: um teste de cadastro que diz so "nao
    deu" manda o operador adivinhar entre chave errada, deployment inexistente e
    modelo sem JSON mode.
    """
    dialeto = provedor.dialeto
    endpoint = (provedor.endpoint or dialeto.endpoint_padrao).rstrip("/")
    if not endpoint:
        log.warning("provedor de chat '%s' esta sem endpoint", provedor.name)
        return None, Gasto(), f"o provedor '{provedor.name}' esta sem endpoint"

    url = dialeto.url_chat.format(
        endpoint=endpoint,
        model=provedor.model,
        api_version=provedor.api_version or dialeto.api_version_padrao,
    )
    corpo: dict = {
        "messages": mensagens,
        # Zero de proposito: a mesma ingestao repetida tem de dar o mesmo
        # conceito. Metadado que muda a cada reprocessamento tornaria a
        # comparacao entre tecnicas (FUN-04) impossivel de ler.
        "temperature": 0,
        "max_tokens": max_tokens,
        "response_format": {"type": "json_object"},
    }
    # No Azure OpenAI o deployment ja esta na URL; nos demais o modelo vai no
    # corpo. Mandar nos dois lugares faz o Azure recusar com 400.
    if dialeto.modelo_no_corpo:
        corpo["model"] = provedor.model

    dados_brutos = json.dumps(corpo).encode()
    cabecalhos = {
        "Content-Type": "application/json",
        dialeto.auth_header: f"{dialeto.auth_prefixo}{provedor.api_key}",
    }

    tentativa = 1
    while tentativa <= TENTATIVAS:
        request = urllib.request.Request(url, data=dados_brutos, headers=cabecalhos, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_SEGUNDOS) as response:
                body = json.loads(response.read().decode())
            break
        except urllib.error.HTTPError as exc:
            recusa = exc.read().decode("utf-8", errors="replace")
            detalhe = recusa[:200]
            if exc.code == 400 and "response_format" in recusa:
                # Modelo ou versao de API sem JSON mode. Repetir nao ajuda, e o
                # aviso precisa dizer o que fazer -- senao vira "a derivacao nao
                # funciona" sem causa visivel.
                aviso = (
                    f"o modelo '{provedor.model}' nao aceita response_format=json_object; "
                    "use um modelo com JSON mode ou suba a api_version"
                )
                log.warning(aviso)
                return None, Gasto(), aviso
            mudanca = _adaptar(corpo, recusa) if exc.code == 400 else ""
            if mudanca:
                # Nao gasta tentativa nem espera: o pedido anterior nem chegou a
                # ser processado, so estava escrito no dialeto errado.
                dados_brutos = json.dumps(corpo).encode()
                log.info("%s recusou o corpo do chat; %s, repetindo", provedor.name, mudanca)
                continue
            if exc.code not in RETENTAVEL or tentativa == TENTATIVAS:
                log.warning("%s recusou o chat: HTTP %s %s", provedor.name, exc.code, detalhe)
                return None, Gasto(), f"{provedor.name} recusou o chat: HTTP {exc.code} {detalhe}"
            log.info("chat HTTP %s (tentativa %s/%s)", exc.code, tentativa, TENTATIVAS)
        except Exception as exc:  # noqa: BLE001 - rede, DNS, timeout
            if tentativa == TENTATIVAS:
                log.warning("falha de rede no chat: %s", exc)
                return None, Gasto(), f"falha de rede no chat: {exc}"
            log.info("falha de rede no chat (tentativa %s/%s): %s", tentativa, TENTATIVAS, exc)
        time.sleep(ESPERA_SEGUNDOS * tentativa)
        tentativa += 1
    else:  # pragma: no cover - o laco sempre sai por break ou return
        return None, Gasto(), "o provedor de chat nao respondeu"

    uso = body.get("usage") or {}
    entrada = int(uso.get("prompt_tokens") or 0)
    saida = int(uso.get("completion_tokens") or 0)
    # `total_tokens` e a fonte quando vem; a soma cobre o provedor que devolve a
    # decomposicao e omite o total. Se nenhum dos dois vier, fica zero, e o
    # dashboard mostra chamada sem token -- que e a verdade, nao um chute.
    total = int(uso.get("total_tokens") or (entrada + saida))
    gasto = Gasto(total=total, entrada=entrada, saida=saida)
    escolhas = body.get("choices") or []
    if not escolhas:
        log.warning("o provedor de chat devolveu resposta sem `choices`")
        return None, gasto, "o provedor devolveu resposta sem `choices`"
    conteudo = (escolhas[0].get("message") or {}).get("content") or ""
    dados = _extrair_json(conteudo)
    erro = "" if dados is not None else f"a resposta nao e um objeto JSON: {conteudo[:200]}"
    return dados, gasto, erro


def disponivel(space: str = "") -> bool:
    """Ha provedor de chat para este Espaco? Usado pela tela, nunca pelo pipeline.

    A tela precisa saber ANTES de deixar ligar a derivacao, para nao oferecer
    uma opcao que nao faria nada. O pipeline nao pergunta: ele tenta e degrada,
    porque entre a pergunta e a chamada o provedor pode ter sido desativado.
    """
    try:
        providers.padrao("chat", space)
        return True
    except Exception:  # noqa: BLE001
        return False


# Teto de tokens de saida. Generoso de proposito, e isso NAO custa: `max_tokens`
# e um teto, nao uma compra -- cobra-se o que o modelo de fato emite.
#
# O numero veio de uma falha real. Com 900, o `gpt-5.6-luna` devolvia conteudo
# VAZIO na extracao de grafo, enquanto a destilacao da wiki (que pedia 8000)
# funcionava no mesmo documento. A causa e que nos modelos de raciocinio o
# orcamento cobre raciocinio E resposta: um teto apertado nao trunca a resposta,
# ele consome o teto pensando e nao sobra nada para escrever. O sintoma e o pior
# possivel -- 200 OK com `content` vazio, que parece "o modelo nao achou nada".
TETO_PADRAO = 4000


def complete_json(
    instrucao: str, entrada: str, operation: str, max_tokens: int = TETO_PADRAO, space: str = ""
) -> Resposta | None:
    """Uma chamada de chat cuja resposta e um objeto JSON. `None` se nao der.

    NUNCA levanta. Todo modo de falha -- provedor ausente, rede fora, HTTP 400,
    modelo sem JSON mode, resposta que nao e JSON -- vira `None` com um aviso no
    log. Quem chama decide o que fazer sem tratamento de excecao, e nenhum deles
    pode derrubar a ingestao.

    `operation` diz de ONDE veio a chamada e e o que separa este custo do custo
    de embedding no dashboard de uso.
    """
    try:
        provedor = providers.padrao("chat", space)
    except Exception as exc:  # noqa: BLE001
        log.info("sem provedor de chat (%s); seguindo sem o texto gerado", exc)
        return None

    started = time.perf_counter()
    try:
        dados, gasto, _ = _post(
            provedor,
            [
                {"role": "system", "content": instrucao},
                {"role": "user", "content": entrada},
            ],
            max_tokens,
        )
    except Exception as exc:  # noqa: BLE001 - rede de seguranca; `_post` ja trata
        log.warning("chat levantou de forma inesperada: %s", exc)
        dados, gasto = None, Gasto()

    latency_ms = int((time.perf_counter() - started) * 1000)
    # A falha tambem entra no contador: gasto que nao aparece e gasto que
    # ninguem controla, e uma sequencia de 429 e justamente o que se quer ver no
    # dashboard, nao so no log.
    providers.registrar_uso(
        provedor,
        operation,
        tokens=gasto.total,
        tokens_in=gasto.entrada,
        tokens_out=gasto.saida,
        latency_ms=latency_ms,
        erro=dados is None,
    )
    if dados is None:
        return None
    return Resposta(dados=dados, tokens=gasto.total, latency_ms=latency_ms, model=provedor.model)


def testar(provedor: providers.Provedor) -> tuple[bool, str, int]:
    """Uma chamada minima ao provedor de chat. Devolve `(ok, erro, tokens)`.

    Serve a tela de cadastro, e nao ao pipeline: aqui o texto do erro E o
    produto. Um teste que responde so "nao deu" manda o operador adivinhar entre
    chave errada, deployment inexistente e modelo sem JSON mode -- e as tres
    mensagens do provedor dizem exatamente qual e.

    `max_tokens` baixo de proposito: o teste confirma que o modelo RESPONDE, nao
    que ele escreve bem, e gastar mil tokens para isso seria desperdicio em toda
    conferencia de cadastro.
    """
    try:
        dados, gasto, erro = _post(
            provedor,
            [
                {"role": "system", "content": "Responda apenas com um objeto JSON."},
                {"role": "user", "content": 'Responda exatamente {"ok": true}.'},
            ],
            32,
        )
    except Exception as exc:  # noqa: BLE001 - rede de seguranca
        return False, f"falha inesperada: {exc}", 0
    return dados is not None, erro, gasto.total

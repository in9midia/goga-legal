"""Catalogo de modelos de uma conta de IA, para a tela escolher em vez de digitar.

Um `GET` por chamada, sincrono, disparado pelo operador. Nada e persistido: a
resposta so preenche o campo do formulario.

POR QUE ISTO EXISTE

O nome do modelo e digitado a mao no cadastro, e errar uma letra nao da erro
ali: o cadastro salva, e a falha aparece depois, como um 404 do provedor no meio
de uma ingestao. Pior no Azure OpenAI, onde o que vai na URL nao e o nome do
modelo e sim o **deployment**, que quem publicou pode ter chamado de qualquer
coisa (`gpt-4o-prod`, `emb-large-v2`). Sem listar, a unica forma de saber e
abrir o portal.

O desenho e o mesmo do `LlmModelCatalogClient` do agentic-sdlc, de proposito:
quem opera os dois nao deve ter de aprender duas telas. As diferencas sao as
deste projeto -- aqui nao ha Anthropic, e o endpoint do Foundry ja e guardado
como raiz do recurso.

DE ONDE A LISTA VEIO IMPORTA

Os tres valores de `source` nao sao decoracao. Eles dizem o que a lista promete,
e prometer demais aqui custa uma investigacao:

* `deployments` -- o que esta PUBLICADO no recurso Azure. Modelo que nao aparece
  nao existe para aquela chave, ponto;
* `account` -- o que a CONTA pode chamar (OpenAI, gateway LiteLLM). A virtual
  key restrita a um subconjunto ve so esse subconjunto, que e exatamente o que o
  operador precisa conferir;
* `catalog` -- o que o recurso PODERIA usar, e nao o que esta publicado. E o
  fallback do Foundry, para recurso que nao expoe a rota de deployments. Um item
  daqui pode nao responder.

A CHAVE NUNCA E LOGADA, e o host sai do log de erro: um 401 com o nome do
recurso Azure no log ja e mais do que precisa estar la.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

log = logging.getLogger(__name__)

# A listagem de deployments do Azure vive NESTA api-version, independente da que
# o cadastro usa para chamar o modelo (que pode ser bem mais nova). E a versao
# que expoe `GET /openai/deployments`.
#
# Medido contra o recurso desta instalacao (openai-goga), com chave invalida
# de proposito para so exercitar a rota:
#
#   api-version=2023-03-15-preview  -> HTTP 401 (a rota existe)
#   api-version=2024-10-21          -> HTTP 404 (a rota NAO existe)
#
# 2024-10-21 e justamente a api-version gravada no cadastro. Usa-la aqui faria a
# tela dizer "a conta nao tem deployment nenhum", que e falso.
AZURE_LIST_API_VERSION = "2023-03-15-preview"

OPENAI_MODELS_URL = "https://api.openai.com/v1/models"

# 20s. A listagem e uma acao sincrona que alguem esta esperando na tela; mais do
# que isso e melhor devolver o erro do que continuar segurando o botao.
TIMEOUT_SEGUNDOS = 20


class CatalogError(RuntimeError):
    """Falha ao consultar o provedor. `status` e o codigo que ele devolveu (0 = rede)."""

    def __init__(self, mensagem: str, status: int = 0):
        super().__init__(mensagem)
        self.status = status


@dataclass
class Modelo:
    # O que vai na chamada. No Azure e o nome do DEPLOYMENT, que pode nao ter
    # relacao nenhuma com o nome do modelo.
    id: str
    # O modelo-base por tras, quando o provedor informa. E o que permite
    # reconhecer `emb-large-v2` como um `text-embedding-3-large`.
    model: str = ""
    label: str = ""

    def to_dict(self) -> dict:
        return {"id": self.id, "model": self.model, "label": self.label}


def _get(url: str, headers: dict[str, str]) -> dict:
    request = urllib.request.Request(url, headers={"Accept": "application/json", **headers})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SEGUNDOS) as response:
            corpo = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        detalhe = exc.read().decode("utf-8", "replace")[:300]
        # Host fora do log: um 401 nao precisa deixar o nome do recurso Azure
        # registrado. A chave, essa nunca aparece em lugar nenhum.
        log.warning("catalogo de modelos respondeu HTTP %s", exc.code)
        raise CatalogError(f"o provedor respondeu HTTP {exc.code}: {detalhe}", exc.code) from None
    except Exception as exc:  # noqa: BLE001 - rede, DNS, timeout
        raise CatalogError(f"falha de rede ao contatar o provedor: {exc}") from None
    try:
        dados = json.loads(corpo)
    except Exception:  # noqa: BLE001
        raise CatalogError("a resposta do provedor nao e JSON valido") from None
    return dados if isinstance(dados, dict) else {}


def _itens(raiz: dict) -> list[dict]:
    """O array de itens fica em `data` (OpenAI, Azure) ou `value` (algumas rotas)."""
    for chave in ("data", "value"):
        valor = raiz.get(chave)
        if isinstance(valor, list):
            return [item for item in valor if isinstance(item, dict)]
    return []


def _texto(item: dict, campo: str) -> str:
    valor = item.get(campo)
    return str(valor).strip() if valor not in (None, "") else ""


def _ordenar(modelos: list[Modelo]) -> list[Modelo]:
    """Sem repetidos e em ordem, ignorando caixa.

    A ordenacao sem `casefold` poe todo `GPT-...` antes de todo `gpt-...`, e a
    lista fica com o mesmo modelo aparecendo em dois lugares da tela.
    """
    unicos: dict[str, Modelo] = {}
    for modelo in modelos:
        if modelo.id:
            unicos.setdefault(modelo.id, modelo)
    return sorted(unicos.values(), key=lambda m: m.id.casefold())


def _raiz_do_recurso(endpoint: str) -> str:
    """Esquema e host do endpoint, sem caminho nenhum.

    O cadastro do Foundry guarda a base de inferencia, e ela pode ter sido colada
    com `/models` (ou ate com `/chat/completions`) no fim. O catalogo mora noutra
    rota do MESMO recurso, entao o caminho precisa cair antes de montar a URL.
    """
    partes = urllib.parse.urlsplit((endpoint or "").strip())
    if not partes.scheme or not partes.netloc:
        raise CatalogError("endpoint invalido: informe a URL completa do recurso")
    return f"{partes.scheme}://{partes.netloc}"


def _deployments_do_azure(raiz: str, api_key: str) -> list[Modelo]:
    dados = _get(
        f"{raiz}/openai/deployments?api-version={AZURE_LIST_API_VERSION}",
        {"api-key": api_key},
    )
    modelos = []
    for item in _itens(dados):
        # `id` e o nome do deployment (o que vai na URL da chamada); `model` e o
        # modelo-base. Recurso antigo as vezes so traz o `model`.
        base = _texto(item, "model")
        identificador = _texto(item, "id") or base
        if identificador:
            modelos.append(Modelo(id=identificador, model=base))
    return _ordenar(modelos)


def azure_openai(endpoint: str, api_key: str) -> tuple[str, list[Modelo]]:
    """Os deployments publicados no recurso Azure OpenAI."""
    return "deployments", _deployments_do_azure(_raiz_do_recurso(endpoint), api_key)


def azure_foundry(endpoint: str, api_key: str) -> tuple[str, list[Modelo]]:
    """Os modelos de um recurso Azure AI Foundry, com fallback para o catalogo.

    Recurso que nao expoe a rota de deployments responde 404, e ai vale a
    listagem do catalogo -- que diz o que o recurso PODERIA usar, nao o que esta
    publicado. A diferenca vai no `source`, para a tela nao prometer demais.
    """
    raiz = _raiz_do_recurso(endpoint)
    try:
        return "deployments", _deployments_do_azure(raiz, api_key)
    except CatalogError as exc:
        if exc.status != 404:
            raise
        log.info("Foundry sem rota de deployments; caindo para o catalogo do recurso")

    dados = _get(f"{raiz}/openai/v1/models", {"api-key": api_key})
    modelos = []
    for item in _itens(dados):
        base = _texto(item, "model")
        identificador = _texto(item, "id") or base
        if identificador:
            modelos.append(Modelo(id=identificador, model=base))
    return "catalog", _ordenar(modelos)


def openai(endpoint: str, api_key: str) -> tuple[str, list[Modelo]]:
    """Os modelos que ESTA conta OpenAI pode chamar.

    O endpoint e respeitado quando ha um: quem aponta a `kind=openai` para um
    proxy compativel quer listar o que o PROXY publica, nao o que a api.openai.com
    publica.
    """
    base = (endpoint or "").strip().rstrip("/") or "https://api.openai.com/v1"
    url = f"{base}/models" if base != "https://api.openai.com/v1" else OPENAI_MODELS_URL
    dados = _get(url, {"Authorization": f"Bearer {api_key}"})
    modelos = [Modelo(id=_texto(item, "id")) for item in _itens(dados) if _texto(item, "id")]
    return "account", _ordenar(modelos)


def litellm(endpoint: str, api_key: str) -> tuple[str, list[Modelo]]:
    """Os aliases que ESTA virtual key alcanca no gateway LiteLLM.

    `account`, e nao `deployments`, e a diferenca e util: o gateway devolve o que
    esta chave pode chamar. Uma key restrita a um subconjunto ve so esse
    subconjunto -- que e justamente o que o operador precisa conferir.

    O `/v1` e anexado aqui porque o endpoint cadastrado e a RAIZ do gateway, sem
    ele, pela convencao que este projeto herdou do agentic-sdlc.
    """
    base = (endpoint or "").strip().rstrip("/")
    if not base:
        raise CatalogError("informe o endpoint do gateway LiteLLM")
    dados = _get(f"{base}/v1/models", {"Authorization": f"Bearer {api_key}"})
    modelos = [Modelo(id=_texto(item, "id")) for item in _itens(dados) if _texto(item, "id")]
    return "account", _ordenar(modelos)


# O dialeto decide como listar, do mesmo jeito que decide como chamar. Tabela em
# vez de `if kind == ...` pelo mesmo motivo de `providers.DIALETOS`: acrescentar
# um provedor vira uma linha, nao uma caca a condicionais.
LISTAGEM = {
    "azure_openai": azure_openai,
    "azure_foundry": azure_foundry,
    "openai": openai,
    # A camada compativel do Gemini publica `/models` no mesmo formato da
    # OpenAI, entao a listagem e a mesma funcao.
    "gemini": openai,
    "litellm": litellm,
}

# O que cada origem promete. Fica aqui, e nao na tela, porque e propriedade da
# rota que produziu a lista -- e a tela de outro cliente (ou o proximo front)
# precisa da mesma frase sem reescrever.
EXPLICACAO = {
    "deployments": (
        "Estes são os deployments PUBLICADOS neste recurso. Se um modelo não aparece aqui, "
        "o recurso não tem esse deployment — publique no portal primeiro."
    ),
    "account": (
        "Estes são os modelos disponíveis para ESTA credencial. Se um modelo não aparece "
        "aqui, a conta não tem acesso a ele."
    ),
    "catalog": (
        "⚠ Este é o CATÁLOGO do recurso — tudo o que ele poderia usar, e não o que está "
        "publicado. Este recurso não expôs a rota de deployments, então confirme antes de "
        "confiar num item."
    ),
}


def listar(kind: str, endpoint: str, api_key: str) -> tuple[str, list[Modelo]]:
    """Lista os modelos de uma conta. Levanta `CatalogError` quando nao da."""
    funcao = LISTAGEM.get(kind)
    if funcao is None:
        raise CatalogError(f"tipo de provedor desconhecido: {kind}")
    if not api_key:
        raise CatalogError("informe a credencial para listar os modelos")
    return funcao(endpoint, api_key)

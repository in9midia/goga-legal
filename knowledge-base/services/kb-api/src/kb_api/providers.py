"""Provedores de IA geridos pela tela, e o contador diario de uso.

ANTES: `AZURE_OPENAI_ENDPOINT`/`AZURE_OPENAI_KEY` no ambiente do pod. Trocar de
modelo exigia PR de infraestrutura e um deploy, e comparar dois provedores lado
a lado era impossivel.

AGORA: linha em `ai_provider`, editavel por administrador. A credencial e
CIFRADA em repouso (Fernet, chave em `KB_SECRET_KEY`) e nunca sai da API em
texto puro -- as rotas devolvem so os quatro ultimos caracteres, o suficiente
para conferir QUAL chave esta configurada sem revela-la.

⚠ Isto inverte uma regra que o projeto tinha escrito ("configuracao por ENV
var, nunca em banco de aplicacao"). A inversao e deliberada: quem opera a base
precisa trocar de modelo sem abrir PR. A cifra em repouso e o que paga a
diferenca -- um dump do banco sozinho nao entrega credencial.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import threading
import time
from dataclasses import dataclass
from datetime import date

from .config import settings
from .db import conn

log = logging.getLogger(__name__)


class ProviderError(RuntimeError):
    pass


# ── dialetos ───────────────────────────────────────────────────────────────
#
# O que muda entre provedores nao e o conceito, e a forma: a URL, o cabecalho
# de autenticacao e se o nome do modelo vai no caminho ou no corpo. Deixar isso
# numa tabela (em vez de `if kind == ...` espalhado) e o que torna acrescentar
# um quarto provedor uma linha, nao uma caca a condicionais.


@dataclass(frozen=True)
class Dialeto:
    rotulo: str
    # Como montar a URL de embedding. `{endpoint}`, `{model}`, `{api_version}`.
    url_embedding: str
    # Como montar a URL de chat. Mesmos campos. Entrou com a derivacao de
    # conceito OKF (ADR-0015): ate ali o projeto so falava embedding, e o
    # `purpose` da tabela ja previa outro proposito sem que existisse um.
    url_chat: str
    # `api-key: <chave>` (Azure) ou `Authorization: Bearer <chave>` (OpenAI).
    auth_header: str
    auth_prefixo: str
    # O modelo vai no CORPO do pedido? (No Azure OpenAI ele ja esta na URL.)
    modelo_no_corpo: bool
    # Valor sugerido de api_version quando o campo vier vazio.
    api_version_padrao: str
    endpoint_padrao: str
    # O pedido de embedding leva `dimensions` no corpo?
    #
    # So o Gemini precisa. O `gemini-embedding-001` devolve 3072 por padrao mas
    # aceita truncar para 1536 ou 768 (Matryoshka), e truncado ele continua
    # respondendo 200 com um vetor menor.
    #
    # Isso NAO degrada a busca em silencio: a coluna e `vector(3072)` e o
    # pgvector recusa com `expected 3072 dimensions, not 1536` (conferido). O
    # problema e ONDE a recusa acontece -- no INSERT, no meio de uma ingestao
    # que ja pagou OCR e chunking, com uma mensagem que nao diz qual provedor
    # esta errado. Pedir a dimensao evita o truncamento; conferir o retorno em
    # `embedding.py` traz a falha para a borda, onde ela tem conserto obvio.
    #
    # Nos demais provedores o campo fica falso porque mandar `dimensions` para
    # uma api-version antiga do Azure e 400, e o ganho seria zero: o
    # text-embedding-3-large ja devolve 3072.
    dimensoes_no_corpo: bool = False


DIALETOS: dict[str, Dialeto] = {
    "azure_openai": Dialeto(
        rotulo="Azure OpenAI",
        url_embedding="{endpoint}/openai/deployments/{model}/embeddings?api-version={api_version}",
        url_chat="{endpoint}/openai/deployments/{model}/chat/completions?api-version={api_version}",
        auth_header="api-key",
        auth_prefixo="",
        modelo_no_corpo=False,
        api_version_padrao="2024-10-21",
        endpoint_padrao="",
    ),
    "openai": Dialeto(
        rotulo="OpenAI",
        url_embedding="{endpoint}/embeddings",
        url_chat="{endpoint}/chat/completions",
        auth_header="Authorization",
        auth_prefixo="Bearer ",
        modelo_no_corpo=True,
        api_version_padrao="",
        endpoint_padrao="https://api.openai.com/v1",
    ),
    "azure_foundry": Dialeto(
        rotulo="Azure AI Foundry",
        # A API de inferencia do Foundry e por modelo no corpo, endpoint unico.
        url_embedding="{endpoint}/models/embeddings?api-version={api_version}",
        url_chat="{endpoint}/models/chat/completions?api-version={api_version}",
        auth_header="api-key",
        auth_prefixo="",
        modelo_no_corpo=True,
        api_version_padrao="2024-05-01-preview",
        endpoint_padrao="",
    ),
    # LiteLLM: proxy OpenAI-compativel na frente de outros provedores. Mesma
    # decisao da ADR-0051 do agentic-sdlc -- entra como MAIS UM tipo, nao como
    # gateway obrigatorio. O ganho: acrescentar Bedrock, Vertex ou um modelo
    # local vira cadastro NO GATEWAY, nao codigo aqui.
    #
    # ⚠ O endpoint e a RAIZ do gateway, SEM `/v1` -- e o cliente que anexa.
    # Mesma convencao do cadastro do agentic-sdlc, para quem opera os dois nao
    # ter de lembrar de duas regras. A credencial e a *virtual key*.
    # Gemini pela camada COMPATIVEL COM OPENAI do Google
    # (`/v1beta/openai/`), e nao pela API nativa `:embedContent`.
    #
    # A nativa tem outro formato de corpo (`content.parts[].text`) e outro de
    # resposta (`embedding.values`), o que exigiria um ramo condicional dentro
    # de `embedding.py` -- exatamente o que a tabela de dialetos existe para
    # evitar. A camada compativel fala o mesmo `{"input": [...]}` e devolve o
    # mesmo `data[].embedding`, entao o provedor entra como MAIS UMA LINHA.
    #
    # O custo assumido: dependemos de uma camada de compatibilidade que o
    # Google pode mudar. O sinal de que mudou seria 400 ou um vetor de tamanho
    # inesperado, e os dois falham alto.
    "gemini": Dialeto(
        rotulo="Google Gemini",
        url_embedding="{endpoint}/embeddings",
        url_chat="{endpoint}/chat/completions",
        auth_header="Authorization",
        auth_prefixo="Bearer ",
        modelo_no_corpo=True,
        api_version_padrao="",
        endpoint_padrao="https://generativelanguage.googleapis.com/v1beta/openai",
        dimensoes_no_corpo=True,
    ),
    "litellm": Dialeto(
        rotulo="LiteLLM (gateway)",
        url_embedding="{endpoint}/v1/embeddings",
        url_chat="{endpoint}/v1/chat/completions",
        auth_header="Authorization",
        auth_prefixo="Bearer ",
        modelo_no_corpo=True,
        api_version_padrao="",
        endpoint_padrao="",
    ),
}


# ── cifra ──────────────────────────────────────────────────────────────────


def _fernet():
    """Fernet com a chave derivada de `KB_SECRET_KEY`.

    Import tardio de proposito: o `cryptography` so e necessario quando ha
    provedor com credencial, e assim quem roda os testes de outra coisa nao
    paga o import.
    """
    try:
        from cryptography.fernet import Fernet
    except ImportError:  # pragma: no cover - dependencia declarada no pyproject
        raise ProviderError(
            "pacote `cryptography` ausente: sem ele nao ha como cifrar a "
            "credencial do provedor em repouso."
        ) from None

    bruto = settings.secret_key
    if not bruto:
        raise ProviderError(
            "KB_SECRET_KEY nao configurada. Ela cifra a credencial dos "
            "provedores de IA em repouso; sem ela a API se recusa a gravar "
            "chave no banco. Gere com: openssl rand -hex 32"
        )
    # A chave do Fernet e 32 bytes em base64url. Derivar por SHA-256 aceita
    # qualquer texto como origem, sem exigir formato do operador.
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(bruto.encode()).digest()))


def cifrar(valor: str) -> str:
    return _fernet().encrypt(valor.encode()).decode()


def decifrar(valor: str) -> str:
    if not valor:
        return ""
    try:
        return _fernet().decrypt(valor.encode()).decode()
    except Exception:  # noqa: BLE001
        # Acontece quando a KB_SECRET_KEY muda: o que estava gravado deixa de
        # abrir. Dizer isso e melhor que devolver vazio e o embedding falhar
        # com "credencial invalida", que manda investigar o lugar errado.
        raise ProviderError(
            "nao consegui decifrar a credencial do provedor. A KB_SECRET_KEY "
            "mudou? As chaves gravadas com a anterior precisam ser regravadas."
        ) from None


# ── resolucao, com cache ───────────────────────────────────────────────────


@dataclass(frozen=True)
class Provedor:
    id: int
    name: str
    kind: str
    endpoint: str
    model: str
    api_version: str
    dimensions: int
    api_key: str
    # Preco por MILHAO de tokens, em dolar. `None` = nao cadastrado, que nao e
    # a mesma coisa que zero: sem preco a tela diz que nao sabe, em vez de
    # mostrar um gasto de zero que parece apurado.
    price_input_per_1m: float | None = None
    price_output_per_1m: float | None = None

    @property
    def dialeto(self) -> Dialeto:
        return DIALETOS[self.kind]


# O provedor e lido em TODA busca e em todo lote de embedding. Sem cache isso
# seria uma consulta por chamada -- barata, mas desnecessaria. 60s e curto o
# bastante para uma troca na tela valer sozinha, e o `invalidar()` faz valer na
# hora quando a troca passa por esta API.
#
# A chave e (proposito, Espaco) porque a escolha passou a ser por Espaco: com a
# chave so no proposito, a primeira base a consultar gravaria o provedor dela
# no cache e as outras usariam o modelo errado por ate um minuto -- e a busca
# nao daria erro nenhum, so devolveria resultado pior.
_CACHE_SEGUNDOS = 60
_cache: dict[tuple[str, str], tuple[float, Provedor | None]] = {}
_trava = threading.Lock()


def invalidar() -> None:
    with _trava:
        _cache.clear()


_COLUNAS = (
    "id, name, kind, endpoint, model, api_version, dimensions, api_key_enc, "
    "price_input_per_1m, price_output_per_1m"
)

# A coluna do Espaco que guarda a escolha, por proposito. Tabela em vez de `if`
# porque e o unico ponto onde os dois propositos divergem, e espalhar a
# condicional faria a proxima adicao (um `rerank`, por exemplo) tocar tres
# lugares em vez de um.
_COLUNA_DO_ESPACO = {
    "embedding": "embedding_provider_id",
    "chat": "chat_provider_id",
}


def padrao(purpose: str = "embedding", space: str = "") -> Provedor:
    """O provedor em uso para este proposito, neste Espaco.

    Duas camadas, nesta ordem: a escolha do Espaco, quando ha uma e o provedor
    dela continua ativo; senao o `is_default` da instalacao. Levanta quando nao
    sobra nenhum.

    A queda para o padrao **nao** e silenciosa por acidente, e sim a degradacao
    desejada: `ON DELETE SET NULL` na 0004 faz o Espaco voltar ao padrao quando
    o provedor escolhido e apagado, em vez de a base parar de indexar. Provedor
    desativado (e nao apagado) cai aqui pelo `active`, com o mesmo efeito.
    """
    agora = time.monotonic()
    chave = (purpose, space)
    with _trava:
        gravado = _cache.get(chave)
        if gravado and agora - gravado[0] < _CACHE_SEGUNDOS:
            if gravado[1] is None:
                raise ProviderError(_mensagem_sem_provedor(purpose))
            return gravado[1]

    linha = None
    coluna = _COLUNA_DO_ESPACO.get(purpose)
    with conn() as connection, connection.cursor() as cur:
        if space and coluna:
            cur.execute(
                f"""
                SELECT {_COLUNAS} FROM ai_provider
                 WHERE active AND purpose = %s
                   AND id = (SELECT {coluna} FROM space WHERE slug = %s AND active)
                """,
                (purpose, space),
            )
            linha = cur.fetchone()
        if linha is None:
            cur.execute(
                f"""
                SELECT {_COLUNAS} FROM ai_provider
                 WHERE is_default AND active AND purpose = %s
                """,
                (purpose,),
            )
            linha = cur.fetchone()

    if linha is None:
        with _trava:
            _cache[chave] = (agora, None)
        raise ProviderError(_mensagem_sem_provedor(purpose))

    provedor = Provedor(
        id=linha[0], name=linha[1], kind=linha[2], endpoint=linha[3],
        model=linha[4], api_version=linha[5], dimensions=linha[6],
        api_key=decifrar(linha[7]),
        price_input_per_1m=float(linha[8]) if linha[8] is not None else None,
        price_output_per_1m=float(linha[9]) if linha[9] is not None else None,
    )
    with _trava:
        _cache[chave] = (agora, provedor)
    return provedor


def resolvido(purpose: str, space: str = "") -> dict | None:
    """O provedor em vigor, para a TELA. Sem credencial, e sem levantar.

    Existe porque a tela precisa mostrar qual modelo esta em uso e de onde a
    escolha veio -- "padrao da instalacao" e "escolhido nesta base" sao estados
    diferentes, e mostrar so o nome esconderia qual dos dois e.
    """
    coluna = _COLUNA_DO_ESPACO.get(purpose)
    escolhido = None
    if space and coluna:
        try:
            with conn() as connection, connection.cursor() as cur:
                cur.execute(
                    f"SELECT {coluna} FROM space WHERE slug = %s AND active", (space,)
                )
                achado = cur.fetchone()
                escolhido = achado[0] if achado else None
        except Exception:  # noqa: BLE001 - a tela nao cai por causa disto
            escolhido = None
    try:
        provedor = padrao(purpose, space)
    except ProviderError:
        return None
    return {
        "id": provedor.id,
        "name": provedor.name,
        "model": provedor.model,
        "kind": provedor.kind,
        # `False` aqui significa "veio do padrao da instalacao", inclusive
        # quando a escolha do Espaco caiu por o provedor ter sido apagado ou
        # desativado -- que e exatamente o que a tela precisa deixar visivel.
        "from_space": escolhido is not None and escolhido == provedor.id,
    }


_SEM_PROVEDOR = (
    "nenhum provedor de IA configurado. Cadastre um em Administracao > "
    "Modelos de IA e marque-o como padrao. Sem embedding a busca fica so "
    "lexical: sem vetor nao ha similaridade semantica."
)

_SEM_PROVEDOR_CHAT = (
    "nenhum provedor de IA com proposito `chat` configurado. Cadastre um em "
    "Administracao > Modelos de IA. Ele so e usado onde a base pede texto "
    "gerado -- hoje, a derivacao de conceito OKF na ingestao."
)


def _mensagem_sem_provedor(purpose: str) -> str:
    """A falta de provedor de chat NAO e a mesma falha da falta de embedding.

    Sem embedding a busca degrada e o operador precisa saber agora. Sem chat,
    so a derivacao de conceito deixa de acontecer, e mandar o operador
    investigar a busca seria mandar para o lugar errado.
    """
    return _SEM_PROVEDOR_CHAT if purpose == "chat" else _SEM_PROVEDOR


# ── contador de uso ────────────────────────────────────────────────────────


def custo_usd(provedor: Provedor | None, tokens_in: int, tokens_out: int) -> float:
    """O que estes tokens custaram, pelo preco CADASTRADO neste provedor.

    Sem preco, devolve zero -- e a coluna `cost_usd` fica zerada junto. A tela
    nao pode ler esse zero como "nao gastou": ela compara com os tokens e diz
    "sem preco cadastrado", que e a verdade. Zero e ausencia parecem iguais numa
    soma, e e por isso que a tela olha os dois numeros.
    """
    if provedor is None:
        return 0.0
    entrada = (provedor.price_input_per_1m or 0.0) * max(tokens_in, 0) / 1_000_000
    saida = (provedor.price_output_per_1m or 0.0) * max(tokens_out, 0) / 1_000_000
    return entrada + saida


def registrar_uso(
    provedor: Provedor | None,
    operation: str,
    *,
    tokens: int = 0,
    tokens_in: int = 0,
    tokens_out: int = 0,
    tokens_estimados: int = 0,
    latency_ms: int = 0,
    erro: bool = False,
) -> None:
    """Soma uma chamada no contador do DIA.

    UM upsert por chamada de IA -- nao por texto do lote. A tela le dezenas de
    linhas em vez de varrer um historico de eventos, que e o que a torna barata
    com a base cheia.

    NUNCA levanta: telemetria que derruba a busca e pior que telemetria
    ausente. A falha vai para o log e a vida segue.
    """
    try:
        with conn() as connection, connection.cursor() as cur:
            cur.execute(
                """
                INSERT INTO ai_usage_daily
                    (day, provider_id, provider, model, operation,
                     calls, tokens, tokens_in, tokens_out, cost_usd,
                     latency_ms, errors, tokens_estimados)
                VALUES (%s,%s,%s,%s,%s,1,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (day, provider_id, model, operation) DO UPDATE
                   SET calls      = ai_usage_daily.calls + 1,
                       tokens     = ai_usage_daily.tokens + EXCLUDED.tokens,
                       tokens_in  = ai_usage_daily.tokens_in + EXCLUDED.tokens_in,
                       tokens_out = ai_usage_daily.tokens_out + EXCLUDED.tokens_out,
                       cost_usd   = ai_usage_daily.cost_usd + EXCLUDED.cost_usd,
                       latency_ms = ai_usage_daily.latency_ms + EXCLUDED.latency_ms,
                       errors     = ai_usage_daily.errors + EXCLUDED.errors,
                       tokens_estimados = ai_usage_daily.tokens_estimados
                                        + EXCLUDED.tokens_estimados,
                       provider   = EXCLUDED.provider
                """,
                (
                    date.today(),
                    provedor.id if provedor else None,
                    provedor.name if provedor else "(nao resolvido)",
                    provedor.model if provedor else "",
                    operation,
                    # `tokens` segue sendo o TOTAL. Quem chama pode mandar so
                    # ele (embedding antigo) ou a decomposicao; quando manda so
                    # a decomposicao, o total sai da soma -- e nao do zero que
                    # o parametro traria.
                    max(tokens or (tokens_in + tokens_out), 0),
                    max(tokens_in, 0),
                    max(tokens_out, 0),
                    # CONGELADO AGORA, pelo preco de agora. Trocar o preco
                    # amanha nao reescreve o gasto de hoje.
                    round(custo_usd(provedor, tokens_in, tokens_out), 6),
                    max(latency_ms, 0),
                    1 if erro else 0,
                    # Coluna separada de proposito: estimativa nunca soma com
                    # apurado. A tela precisa poder dizer "isto foi medido" e
                    # "isto foi estimado" sem que o operador tenha de saber
                    # qual provedor reporta uso e qual nao reporta.
                    max(tokens_estimados, 0),
                ),
            )
            connection.commit()
    except Exception as exc:  # noqa: BLE001
        log.warning("nao consegui registrar o uso de IA: %s", exc)

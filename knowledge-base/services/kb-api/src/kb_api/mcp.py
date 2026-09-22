"""Servidor MCP: streamable HTTP com as tools `search` e `fetch`.

Implementado a mao sobre JSON-RPC porque o transporte e simples e a dependencia
nao se paga: POST unico, corpo JSON-RPC 2.0, resposta JSON. E o que Claude
Desktop, Cursor, Claude Code e a Responses API da OpenAI falam.

As duas tools sao exatamente as que os requisitos pedem, e juntas cobrem o que
nenhuma das tres ferramentas de mercado entregou:

- **`search`** (BUS-01): evidencia com score por passagem, nunca resposta
  gerada. Cada passagem traz texto, origem, e os scores vetorial e lexical
  separados, mais a posicao em cada metodo -- a evidencia e auditavel. Quando o
  conteudo esta marcado como armadilha, o aviso vai NA PASSAGEM: o campo
  `armadilha` chega junto do texto, e nao numa chamada seguinte que o agente
  nao faria.
- **`fetch`** (BUS-07): documento canonico inteiro por id, com metadados e os
  relacionados pelo grafo.

O escopo e resolvido do token, no servidor (FUN-08). O argumento `spaces` da
tool so restringe.
"""

from __future__ import annotations

import io
import json
import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import graph, ingest, okf, search
from .auth import AuthError, Principal, narrow
from .config import settings

log = logging.getLogger(__name__)

# Mais nova PRIMEIRO. A `2025-11-25` entrou por causa do icone: e a revisao que
# criou o campo `icons` em `Implementation` (SEP-973), junto com o `description`.
# A `2025-06-18` fica porque cliente que so fala ela continua conectando -- o que
# este servidor faz (tools, e nada de resources, prompts, sampling ou tasks) e
# identico nas duas.
PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18")
PROTOCOL_VERSION = PROTOCOL_VERSIONS[0]

# Caminho do icone, RELATIVO a raiz publica. Absoluto so na hora de responder,
# porque a origem depende de onde o servidor esta publicado (local, DEV, PROD) --
# e a spec manda o cliente conferir que o icone vem da MESMA origem do servidor:
# icone de terceiro e um pixel de rastreio esperando acontecer.
ICONE = "/mcp/icon.png"

# O ARQUIVO e feito para ser trocado: quem tem a marca certa larga o PNG dele
# aqui e nao encosta em codigo nenhum.
ICONE_ARQUIVO = Path(__file__).with_name("assets") / "icon.png"

# Tipos que a spec do MCP garante que TODO cliente que desenha icone aceita. WebP
# e SVG ela so recomenda -- e SVG, pela mesma regra de `icons.py`, nao entra:
# e documento executavel indo para dentro da interface de terceiros.
FORMATOS = {"PNG": "image/png", "JPEG": "image/jpeg"}


def _carregar_icone() -> tuple[bytes, str, str]:
    """Bytes, tipo e dimensao do icone -- LIDOS DO ARQUIVO, nao fixos no codigo.

    A alternativa era declarar `image/png` e `512x512` em constantes. Parece
    inofensivo ate alguem trocar a imagem por uma de 256: o `serverInfo` passa a
    anunciar um tamanho que a imagem nao tem, e o cliente que escolhe icone pelo
    tamanho escolhe errado. Trocar o arquivo e a operacao ESPERADA aqui, entao o
    que se pode derivar do arquivo se deriva.

    Lido uma vez, no import: sao ~15 kB que nao mudam durante a vida do processo.

    Falhar aqui NAO derruba o servidor. Icone e enfeite; recusar a subir porque o
    logotipo sumiu seria trocar um conector feio por um conector fora do ar.
    """
    try:
        dados = ICONE_ARQUIVO.read_bytes()
    except OSError as exc:
        log.warning("icone do MCP indisponivel (%s); o servidor segue sem ele", exc)
        return b"", "", ""
    try:
        from PIL import Image

        with Image.open(io.BytesIO(dados)) as imagem:
            formato, (largura, altura) = imagem.format, imagem.size
    except Exception as exc:  # noqa: BLE001
        log.warning("icone do MCP nao e imagem legivel (%s); seguindo sem ele", exc)
        return b"", "", ""
    if formato not in FORMATOS:
        log.warning(
            "icone do MCP e %s; use PNG ou JPEG, que e o que a spec garante em "
            "todo cliente. Seguindo sem icone.", formato,
        )
        return b"", "", ""
    return dados, FORMATOS[formato], f"{largura}x{altura}"


ICONE_BYTES, ICONE_TIPO, ICONE_TAMANHO = _carregar_icone()

# O FAVICON e outra coisa que o icone acima, e por isso tem constante propria.
#
# Ele NAO entra em `serverInfo.icons`: `image/x-icon` nao esta entre os formatos
# que a spec garante em todo cliente, e anunciar um que o cliente nao desenha e
# pior que nao anunciar. Ele existe para o caminho de descoberta POR FAVICON --
# o cliente que procura o icone pelo endereco convencional, antes ou em vez de
# ler o protocolo. Servido na MESMA origem do `/mcp`, pela mesma razao do
# `icon.png`: icone em dominio de terceiro e pixel de rastreio.
FAVICON_ARQUIVO = Path(__file__).with_name("assets") / "favicon.ico"
FAVICON_TIPO = "image/x-icon"

# Assinatura de arquivo ICO: reservado (0x0000) + tipo 1 (icone). Conferir o
# CONTEUDO, e nao a extensao, e a mesma regra do `_carregar_icone` -- extensao
# mente, e um .ico que na verdade e PNG faz o cliente desenhar nada em silencio.
ICO_MAGICO = b"\x00\x00\x01\x00"


def _carregar_favicon() -> bytes:
    """Os bytes do favicon, ou vazio se ele nao estiver la.

    Mesma postura do icone do protocolo: falhar aqui NAO derruba o servidor.
    A rota passa a devolver 404 e o resto segue -- trocar um conector sem
    favicon por um conector fora do ar seria o negocio errado.
    """
    try:
        dados = FAVICON_ARQUIVO.read_bytes()
    except OSError as exc:
        log.warning("favicon do MCP indisponivel (%s); o servidor segue sem ele", exc)
        return b""
    if not dados.startswith(ICO_MAGICO):
        log.warning("favicon do MCP nao e um arquivo ICO; seguindo sem ele")
        return b""
    return dados


FAVICON_BYTES = _carregar_favicon()

SERVER_INFO = {
    "name": "knowledge-base",
    "version": "0.1.0",
    # `title` e `description` sao o que a lista de conectores mostra ao lado do
    # icone; `name` e identificador, nao rotulo. `description` entrou na mesma
    # revisao `2025-11-25`.
    "title": "Base de conhecimento Goga Legal",
    "description": (
        "Busca com evidencia nas bases de conhecimento do Goga Legal. "
        "Devolve passagens com score e o documento canonico inteiro por id."
    ),
}


def server_info(base: str) -> dict[str, Any]:
    """`SERVER_INFO` com o icone resolvido para a origem publica desta chamada.

    Sem `base` o icone sai de fora: `src` relativo nao tem significado definido
    na spec, e um cliente que tentasse resolver resolveria contra a origem DELE.
    Sem arquivo legivel tambem sai: anunciar `icons` apontando para uma rota que
    devolve 404 e pior que nao anunciar.
    """
    if not base or not ICONE_BYTES:
        return SERVER_INFO
    return {
        **SERVER_INFO,
        "icons": [
            {
                "src": f"{base.rstrip('/')}{ICONE}",
                "mimeType": ICONE_TIPO,
                "sizes": [ICONE_TAMANHO],
            }
        ],
    }


def negociar_protocolo(pedido: Any) -> str:
    """A versao que vamos falar: a pedida, se soubermos; senao a mais nova nossa.

    O servidor respondia uma constante e ignorava o pedido. Funcionava por sorte:
    todo cliente aceitava a resposta. A regra da spec e esta -- devolver a mesma
    versao quando ela e suportada, e uma que suportamos quando nao e.
    """
    return pedido if pedido in PROTOCOL_VERSIONS else PROTOCOL_VERSION

TOOLS: list[dict[str, Any]] = [
    {
        "name": "search",
        "description": (
            "Busca evidencia nas bases de conhecimento do Goga Legal. "
            "Devolve passagens com texto, documento de origem e scores "
            "(vetorial e lexical separados), ordenadas por fusao RRF. "
            "Passagem com o campo `armadilha` preenchido tem o sentido obvio "
            "invertido: leia o aviso ANTES de usar o trecho. "
            "NAO devolve resposta gerada: a sintese e do agente. "
            "Use `spaces` com o slug do Espaco para restringir a uma area "
            "(ex.: [\"rh\"]); sem isso a busca cobre todos os Espacos que o "
            "token alcanca. Cada passagem traz `document_id`, que serve para "
            "chamar a tool `fetch` e ler o documento inteiro."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "A pergunta ou os termos de busca."},
                "spaces": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Slugs dos Espacos a consultar. Vazio = todos os permitidos.",
                },
                "top_k": {
                    "type": "integer",
                    "description": f"Quantas passagens devolver (padrao {settings.default_top_k}).",
                },
                # ⚠ A DESCRICAO E PARA O AGENTE DECIDIR, e por isso ela traz o
                # numero. Sem o custo escrito, um agente liga "para garantir" e
                # paga nove segundos em toda chamada -- inclusive nas que a
                # pergunta ja estava no vocabulario da documentacao.
                "improve_query": {
                    "type": "boolean",
                    "description": (
                        "Reescreve a pergunta no vocabulario da documentacao e usa HyDE "
                        "antes de buscar. LIGUE apenas quando a busca crua voltou vazia ou "
                        "irrelevante, ou quando a pergunta usa termos do usuario final e nao "
                        "os do manual. Custa ~9s a mais (contra ~0,4s sem). Medido numa base "
                        "de 275 manuais: recupera 4 de cada 9 casos que a busca crua perdia. "
                        "Se voce ja reformulou a pergunta, deixe desligado."
                    ),
                },
                # ⚠ A DESCRICAO DIZ O QUE SOME, e nao so o que o parametro faz.
                # Um agente que le "filtra por confianca" liga por precaucao e
                # recebe zero resultado numa base sem conteudo revisado, sem ter
                # como saber que o filtro foi o motivo.
                "min_trust": {
                    "type": "string",
                    "enum": list(okf.TRUST_ESCALA),
                    "description": (
                        "Nivel MINIMO de confianca do conteudo recuperado. "
                        "`unverified` (padrao, sem filtro) traz tudo, inclusive o que "
                        "ninguem conferiu; `machine-confirmed` exige conferencia "
                        "automatizada registrada; `human-reviewed` exige revisao humana. "
                        "USE quando o que voce esta montando nao pode citar conteudo nao "
                        "revisado. Atencao ao que some: documento sem metadado de "
                        "conferencia conta como `unverified`, e paginas de wiki (texto "
                        "destilado por modelo) saem inteiras acima de `unverified`. "
                        "Resposta vazia com este filtro ligado significa que a base nao "
                        "tem conteudo conferido sobre o assunto, nao que o assunto nao "
                        "existe."
                    ),
                },
                "as_of": {
                    "type": "string",
                    "description": (
                        "Data (AAAA-MM-DD) em que o conteudo precisava estar VIGENTE. "
                        "Descarta o que ja tinha sido revogado ou substituido nessa data, "
                        "e o que so passou a valer depois dela. USE quando a pergunta e "
                        "sobre um fato datado e a regra mudou desde entao. Conteudo que "
                        "nao declara vigencia continua aparecendo: ausencia de vigencia e "
                        "tratada como sempre valida, nao como revogada."
                    ),
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "fetch",
        "description": (
            "Le um documento inteiro da base pelo id, no formato canonico "
            "(Markdown limpo, extraido do arquivo original). Use depois de "
            "`search`, quando a passagem nao bastar e for preciso o contexto "
            "completo. Devolve tambem os documentos relacionados pelo grafo de "
            "termos."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "document_id": {"type": "integer", "description": "O id devolvido por `search`."},
                "include_related": {
                    "type": "boolean",
                    "description": "Inclui documentos relacionados pelo grafo (padrao: true).",
                },
            },
            "required": ["document_id"],
        },
    },
    {
        "name": "list_spaces",
        "description": (
            "Lista os Espacos (areas de conhecimento) que este token alcanca, "
            "com a contagem de documentos de cada um. Use para descobrir o "
            "slug correto antes de restringir uma busca."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
]


class JsonRpcError(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


# ── tools ──────────────────────────────────────────────────────────────────


def _tool_search(principal: Principal, arguments: dict[str, Any]) -> dict[str, Any]:
    query = (arguments.get("query") or "").strip()
    if not query:
        raise JsonRpcError(-32602, "o argumento `query` e obrigatorio")

    spaces = narrow(principal.allowed_spaces(), arguments.get("spaces"))
    # UM booleano, e nao os dois slots separados. O agente nao tem como escolher
    # entre `rewrite` e `step_back` com informacao -- ele nao ve a base nem o
    # resultado da medicao. Expor as variantes aqui seria transferir uma decisao
    # de operacao para quem nao tem os dados: `step_back`, medido, PIORA nesta
    # base (7/16 -> 3/16). O que a tool oferece e o par que ganhou.
    melhorar = bool(arguments.get("improve_query"))
    try:
        outcome = search.search(
            query,
            spaces,
            top_k=arguments.get("top_k"),
            principal=principal.describe(),
            surface="mcp",
            reescrita="rewrite" if melhorar else "nenhuma",
            embedding_query="hyde" if melhorar else "crua",
            min_trust=str(arguments.get("min_trust") or ""),
            as_of=str(arguments.get("as_of") or ""),
        )
    except ValueError as exc:
        # Recorte escrito errado e erro de ARGUMENTO, e o agente precisa ver
        # isso: tratado como erro interno, ele tentaria de novo igual; tratado
        # como busca vazia, ele concluiria que a base nao sabe do assunto.
        raise JsonRpcError(-32602, str(exc)) from None
    return {
        "results": [passage.to_dict() for passage in outcome.passages],
        # Telemetria devolvida NA CHAMADA (FUN-06): o agente ve o custo e as
        # tecnicas aplicadas sem precisar de um segundo endpoint.
        "telemetry": {
            "run_id": outcome.run_id,
            "total_ms": outcome.total_ms,
            "embed_tokens": outcome.embed_tokens,
            "stages": outcome.stages,
        },
    }


def _tool_fetch(principal: Principal, arguments: dict[str, Any]) -> dict[str, Any]:
    raw_id = arguments.get("document_id")
    try:
        document_id = int(raw_id)
    except (TypeError, ValueError):
        raise JsonRpcError(-32602, "o argumento `document_id` deve ser inteiro") from None

    spaces = principal.allowed_spaces()
    document = search.fetch_document(document_id, spaces)
    if document is None:
        # Mesma resposta para "nao existe" e "nao permitido": distinguir os dois
        # revelaria a existencia de documento em Espaco proibido.
        raise JsonRpcError(-32602, f"documento {document_id} nao encontrado")

    if arguments.get("include_related", True):
        document["related"] = graph.related(document_id, spaces)
    return document


def _tool_list_spaces(principal: Principal, arguments: dict[str, Any]) -> dict[str, Any]:
    return {"spaces": ingest.space_stats(principal.allowed_spaces())}


HANDLERS: dict[str, Callable[[Principal, dict], dict]] = {
    "search": _tool_search,
    "fetch": _tool_fetch,
    "list_spaces": _tool_list_spaces,
}


# ── JSON-RPC ───────────────────────────────────────────────────────────────


def handle(
    message: dict[str, Any], principal: Principal, base: str = ""
) -> dict[str, Any] | None:
    """Trata uma mensagem JSON-RPC. Devolve None para notificacao.

    `base` e a origem publica desta chamada (`https://host/prefixo`), usada para
    montar o `src` do icone. Vazio serve: o `initialize` responde sem `icons`.
    """
    method = message.get("method") or ""
    request_id = message.get("id")
    params = message.get("params") or {}

    def ok(result: Any) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": request_id, "result": result}

    # Notificacoes nao tem resposta.
    if request_id is None:
        if method not in {"notifications/initialized", "notifications/cancelled"}:
            log.info("notificacao MCP ignorada: %s", method)
        return None

    try:
        if method == "initialize":
            return ok(
                {
                    "protocolVersion": negociar_protocolo(params.get("protocolVersion")),
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": server_info(base),
                    "instructions": (
                        "Base de conhecimento do Goga Legal. Use `search` "
                        "para achar evidencia e `fetch` para ler o documento "
                        "inteiro. A busca devolve trechos com score, nunca "
                        "resposta pronta."
                    ),
                }
            )

        if method == "ping":
            return ok({})

        if method == "tools/list":
            return ok({"tools": TOOLS})

        if method == "resources/list":
            # Sem resources: os Espacos sao descobertos pela tool `list_spaces`,
            # que respeita o escopo do token. Responder lista vazia e mais
            # honesto que "method not found" -- o servidor conhece o metodo.
            return ok({"resources": []})

        if method == "prompts/list":
            return ok({"prompts": []})

        if method == "tools/call":
            name = params.get("name") or ""
            handler = HANDLERS.get(name)
            if handler is None:
                raise JsonRpcError(-32602, f"tool desconhecida: {name}")
            payload = handler(principal, params.get("arguments") or {})
            text = json.dumps(payload, ensure_ascii=False)
            # content[] e o contrato do MCP; structuredContent poupa o cliente
            # de reparsear o JSON.
            return ok(
                {
                    "content": [{"type": "text", "text": text}],
                    "structuredContent": payload,
                    "isError": False,
                }
            )

        raise JsonRpcError(-32601, f"metodo nao suportado: {method}")

    except JsonRpcError as exc:
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": exc.code, "message": exc.message},
        }
    except AuthError as exc:
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32001, "message": str(exc)},
        }
    except Exception as exc:  # noqa: BLE001 - erro interno vira erro JSON-RPC
        log.exception("erro tratando %s", method)
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32603, "message": f"erro interno: {exc}"},
        }

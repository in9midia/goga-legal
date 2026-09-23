"""kb-api: REST de gestao/ingestao + servidor MCP para agentes de IA.

Uma unica aplicacao expondo as duas superficies (FUN-11), como o desenho do
projeto pede. FastAPI porque o pipeline e Python (Docling, LlamaIndex) e porque
o agent-runner do agentic-sdlc ja e Python -- a casa tem a stack.
"""

from __future__ import annotations

import asyncio
import html
import json
import logging
import platform
import subprocess
import threading
import time
import unicodedata
import urllib.request
from datetime import UTC, datetime
from importlib import metadata
from typing import Any
from urllib.parse import quote, urlencode

from fastapi import Body, Depends, FastAPI, Header, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from . import (
    benchmark,
    catalog,
    chunking,
    embedding,
    fila,
    graph,
    icons,
    ingest,
    llm,
    mcp,
    oauth,
    okf,
    precos,
    providers,
    recalculo,
    representations,
    retry,
    search,
    storage,
    tokens,
    wiki,
)
from . import migrate as migrations
from . import query as query_slot
from .auth import (
    AuthError,
    Principal,
    invalidate_admin_cache,
    narrow,
    principal_from_authorization,
)
from .config import settings
from .db import conn, jsonb

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
)
log = logging.getLogger("kb_api")

# O docling chama `tesseract --psm 0 -l osd` para detectar orientacao ANTES de
# cada OCR, e registra `OSD failed ... Too few characters` em nivel ERROR sempre
# que a regiao tem pouco texto -- o que e a regra, nao a excecao, em documento
# com icone e print pequeno. Um PDF de 100 paginas produzia centenas dessas
# linhas, e o efeito pratico era esconder as falhas de verdade no meio do ruido.
#
# A condicao nao e acionavel (o OCR segue e o texto sai), entao o nivel esta
# errado na origem. Silenciar SO este logger, e nao o pacote inteiro, mantem
# visivel qualquer outro erro do docling.
logging.getLogger("docling.models.stages.ocr.tesseract_ocr_cli_model").setLevel(
    logging.CRITICAL
)

app = FastAPI(
    title="knowledge-base",
    version="0.1.0",
    description="Base de conhecimento corporativa: REST de gestao + MCP para agentes.",
)

# CORS existe SO para o dev-server do Vite, que serve a UI de outra origem
# (localhost:3010) enquanto se desenvolve. Em pe, no cluster, a UI e a API saem
# pelo mesmo host -- o nginx do kb-ui encaminha /v1 -- e nenhuma requisicao e
# cross-origin. Por isso a lista e explicita e nao "*": um "*" aqui viraria
# permissao permanente que ninguem lembra de ter dado.
_dev_origins = [o for o in settings.cors_origins if o]
if _dev_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_dev_origins,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    log.info("CORS liberado para %s", ", ".join(_dev_origins))

_ready = {"db": False, "storage": False, "error": ""}
# Instante de subida do processo, para o uptime da tela tecnica.
_started_at = datetime.now(UTC)


@app.on_event("startup")
def startup() -> None:
    log.info("kb-api subindo (env=%s, auth=%s)", settings.env,
             "keycloak" if settings.auth_enabled else "desligada")
    # A migracao roda no startup: o ambiente local sobe sem passo manual, e as
    # pendentes sao aplicadas sob advisory lock, entao subir varias replicas
    # juntas e seguro. Falha aqui deixa o pod NotReady, que e o certo -- servir
    # busca sobre esquema desatualizado erra em silencio.
    for attempt in range(30):
        try:
            migrations.migrate()
            _ready["db"] = True
            break
        except Exception as exc:  # noqa: BLE001 - Postgres ainda subindo
            _ready["error"] = str(exc)[:300]
            log.warning("Postgres indisponivel (tentativa %s): %s", attempt + 1, exc)
            time.sleep(2)

    try:
        storage.ensure_bucket()
        _ready["storage"] = True
    except Exception as exc:  # noqa: BLE001
        _ready["error"] = str(exc)[:300]
        log.warning("object store indisponivel: %s", exc)

    # Ordem importa: a fila retoma primeiro o `running` que tem bruto guardado;
    # o que sobrar `running` nao tem de onde retomar e e fechado como antes.
    try:
        fila.retomar_orfaos()
    except Exception as exc:  # noqa: BLE001
        log.warning("nao consegui retomar a fila de ingestao: %s", exc)
    _fechar_trabalhos_orfaos()
    retry.iniciar()
    fila.iniciar()


def _fechar_trabalhos_orfaos() -> None:
    """Fecha o que morreu junto com o pod anterior.

    O PROBLEMA, E POR QUE ELE NAO SE RESOLVE SOZINHO
    ---
    A ingestao e sincrona e pode levar minutos (medido: 26 s de mediana, 84 s no
    pior). Uma subida de versao no meio de uma carga mata o processo no meio do
    arquivo. O documento em si nao fica pela metade -- ele e gravado numa
    transacao so, que simplesmente nao commita --, mas a LINHA DO LOG ja foi
    aberta como `running`, e nao ha ninguem para fecha-la.

    O efeito e visivel e nao passa: a tela de processamento mostra "em
    andamento" para sempre e fica consultando de tres em tres segundos, e o
    cartao da base diz "processando" um arquivo que morreu ontem. Pior no
    benchmark: a rota RECUSA iniciar execucao nova enquanto houver uma
    `running`, entao um deploy no meio de uma execucao TRAVA o recurso ate
    alguem mexer no banco.

    POR QUE E SEGURO DIZER QUE TODO `running` AQUI E ORFAO
    ---
    O deployment roda com UMA replica e estrategia `Recreate` (declarado no
    overlay de GitOps, com a justificativa de que ingestao sincrona nao deve
    ficar dividida entre duas versoes). Quando este codigo executa, nao existe
    outro pod servindo -- o anterior ja foi derrubado.

    Se algum dia isto virar mais de uma replica, esta funcao passa a estar
    errada: ela fecharia o trabalho em andamento do vizinho. O lugar de
    resolver, nesse dia, e um heartbeat na linha -- nao um timeout chutado.
    """
    try:
        with conn() as connection, connection.cursor() as cur:
            cur.execute(
                """
                UPDATE ingest_run
                   SET status = 'failed', finished_at = now(),
                       error = 'interrompida: o serviço foi reiniciado durante o '
                               'processamento. O documento não foi gravado; envie de novo.'
                 WHERE status = 'running'
                """
            )
            ingestoes = cur.rowcount
            cur.execute(
                """
                UPDATE benchmark_run
                   SET status = 'failed', finished_at = now(),
                       error = 'interrompida: o serviço foi reiniciado durante a execução. '
                               'As perguntas já avaliadas ficaram gravadas.'
                 WHERE status = 'running'
                """
            )
            execucoes = cur.rowcount
            connection.commit()
        if ingestoes or execucoes:
            log.warning(
                "fechadas %s ingestao(oes) e %s execucao(oes) de benchmark que morreram "
                "com o pod anterior", ingestoes, execucoes,
            )
    except Exception as exc:  # noqa: BLE001
        # Nao pode impedir a subida: sem isto o servico funciona, so com uma
        # linha de log mentindo.
        log.warning("nao consegui fechar trabalhos orfaos: %s", exc)


# ── autenticacao ───────────────────────────────────────────────────────────


def current_principal(authorization: str | None = Header(default=None)) -> Principal:
    try:
        return principal_from_authorization(authorization)
    except AuthError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from None


def require_write(principal: Principal = Depends(current_principal)) -> Principal:
    """Escrita exige o grupo de admin quando a auth esta ligada."""
    if settings.auth_enabled and not principal.unrestricted:
        raise HTTPException(
            status_code=403,
            detail=(
                f"escrita exige o grupo {settings.admin_group}; "
                f"o token tem {principal.groups or 'nenhum grupo'}"
            ),
        )
    return principal


# ── saude ──────────────────────────────────────────────────────────────────


def _migrations_summary() -> dict[str, Any]:
    """Resumo do esquema, tolerante a banco fora do ar.

    O /v1/health precisa RESPONDER quando o Postgres cai -- e justamente aí que
    alguem o consulta. Erro aqui vira um campo, nao uma excecao.
    """
    if not _ready["db"]:
        return {"error": "banco indisponivel"}
    try:
        return migrations.summary()
    except Exception as exc:  # noqa: BLE001 - saude nao pode derrubar por isso
        return {"error": str(exc)[:200]}



def _modelo_de_embedding() -> str:
    """Modelo do provedor padrao, ou o motivo de nao haver um.

    Nao levanta: esta funcao alimenta a tela de saude e a de stack, e uma
    instalacao SEM provedor cadastrado e um estado valido -- a busca funciona,
    so fica lexical. Derrubar o /v1/health por isso transformaria uma
    configuracao pendente em pod morto.
    """
    try:
        return providers.padrao("embedding").model
    except Exception:  # noqa: BLE001
        return "(nenhum provedor configurado)"


@app.get("/v1/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok" if _ready["db"] else "degraded",
        "env": settings.env,
        "auth": "keycloak" if settings.auth_enabled else "desligada",
        "postgres": _ready["db"],
        "object_store": _ready["storage"],
        "graph": graph.health(),
        "embedding_model": _modelo_de_embedding(),
        # Em que versao de esquema ESTE pod esta. Durante um rollout as replicas
        # convivem, e sem isso "o comportamento muda a cada F5" nao tem como
        # virar "metade dos pods esta na imagem antiga".
        "migrations": _migrations_summary(),
        "error": _ready["error"],
    }


@app.get("/v1/live")
def live() -> dict[str, str]:
    """Liveness: responde na hora, sem tocar em banco, storage ou grafo.

    Separado do /v1/health de proposito. O health consulta o grafo e o estado do
    banco, o que pode demorar sob carga; se a liveness dependesse dele, uma
    dependencia lenta viraria reinicio do pod -- justamente quando o servico
    esta ocupado e mais precisa continuar de pe.
    """
    return {"status": "alive"}


@app.get("/v1/ready")
def ready() -> JSONResponse:
    # O readiness so depende do Postgres: sem object store da para buscar no que
    # ja foi indexado, e sem grafo tambem. Amarrar os tres deixaria o pod fora
    # do balanceador por causa de dependencia auxiliar.
    if not _ready["db"]:
        return JSONResponse({"ready": False, "error": _ready["error"]}, status_code=503)
    return JSONResponse({"ready": True})


# ── URL publica (tunel ngrok) ──────────────────────────────────────────────


@app.get("/v1/public-url")
def public_url(principal: Principal = Depends(current_principal)) -> dict[str, Any]:
    """A URL publica do tunel, quando existe.

    `http://localhost:8890` so existe na maquina de quem subiu o cluster. Sem
    tunel, conectar o editor no MCP e uma demonstracao de uma pessoa so -- nao
    da para mostrar ao time nem deixar alguem testar da propria maquina.

    A resposta e sempre 200, com `url` vazia quando nao ha tunel: ausencia de
    tunel e uma configuracao valida, nao um erro, e um 404 aqui faria a tela
    mostrar erro vermelho num ambiente que esta perfeitamente bem.
    """
    if not settings.ngrok_api:
        return {"url": "", "reason": "tunel nao configurado"}
    try:
        with urllib.request.urlopen(
            f"{settings.ngrok_api.rstrip('/')}/api/tunnels", timeout=5
        ) as resposta:
            dados = json.loads(resposta.read().decode())
    except Exception as exc:  # noqa: BLE001 - sem tunel e o caso normal
        return {"url": "", "reason": f"agente ngrok inacessivel: {str(exc)[:120]}"}

    # Prefere HTTPS: os harnesses recusam MCP remoto em http:// que nao seja
    # localhost, e o ngrok publica os dois esquemas para o mesmo tunel.
    tuneis = dados.get("tunnels") or []
    https = [t for t in tuneis if str(t.get("public_url", "")).startswith("https://")]
    escolhido = (https or tuneis or [{}])[0]
    return {
        "url": escolhido.get("public_url", ""),
        "reason": "" if escolhido.get("public_url") else "o agente respondeu sem tunel ativo",
    }


# ── OAuth: conectar pelo proprio harness, sem colar token ──────────────────
#
# O fluxo inteiro, do ponto de vista de quem usa: cola a URL do conector, clica
# em "Entrar", loga no Identity, pronto. Nada de token em conversa, nada de
# editar JSON.
#
# Do ponto de vista do protocolo: 401 com WWW-Authenticate -> o cliente busca os
# metadados -> registra-se sozinho -> manda a pessoa ao /oauth/authorize -> nos
# mandamos ao Identity -> volta no /oauth/callback -> emitimos um codigo -> o
# cliente troca por token no /oauth/token.
#
# Nenhum passo guarda estado em memoria de processo: o pedido em voo viaja
# assinado no proprio `state` (ver `selar_pedido` em `oauth.py`) e o resto mora
# no Postgres (`oauth_client`, `oauth_code`, `oauth_grant`). E o que deixa este
# fluxo atravessar qualquer numero de replicas.


def _base_publica(request: Request) -> str:
    """O endereco por onde ESTE servico e alcancado, do lado de quem chama.

    Atras de ingress e de tunel o servidor nao sabe o proprio endereco publico:
    ele escuta em :8080 dentro de um container. Quem sabe e o cliente, e o
    ingress conta no `Host` / `X-Forwarded-*`. Uma configuracao explicita
    (KB_PUBLIC_BASE_URL) ganha de tudo, para o caso de um proxy que nao propaga.
    """
    if settings.public_base_url:
        return settings.public_base_url.rstrip("/")
    esquema = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("x-forwarded-host") or request.headers.get("host")
    if not host:
        return str(request.base_url).rstrip("/")
    return f"{esquema}://{host}"


@app.get("/.well-known/oauth-protected-resource")
@app.get("/.well-known/oauth-protected-resource/mcp")
def oauth_prm(request: Request) -> dict[str, Any]:
    return oauth.protected_resource_metadata(_base_publica(request))


@app.get("/.well-known/oauth-authorization-server")
@app.get("/.well-known/openid-configuration")
def oauth_as_metadata(request: Request) -> dict[str, Any]:
    return oauth.authorization_server_metadata(_base_publica(request))


@app.post("/oauth/register")
def oauth_register(payload: dict = Body(default={})) -> JSONResponse:
    try:
        return JSONResponse(oauth.register_client(payload), status_code=201)
    except oauth.OAuthError as exc:
        return JSONResponse(
            {"error": exc.code, "error_description": exc.description}, status_code=exc.status
        )


@app.get("/oauth/authorize")
def oauth_authorize(
    request: Request,
    client_id: str = Query(...),
    redirect_uri: str = Query(...),
    response_type: str = Query(default="code"),
    code_challenge: str = Query(default=""),
    code_challenge_method: str = Query(default=""),
    state: str = Query(default=""),
    resource: str = Query(default=""),
):
    """Recebe o cliente MCP e manda a pessoa para o login de verdade."""
    from fastapi.responses import RedirectResponse

    cliente = oauth.load_client(client_id)
    # Erro de client_id ou de redirect_uri NAO volta pelo redirect: se voltasse,
    # seria um redirecionador aberto -- e e exatamente o parametro sob suspeita.
    if cliente is None:
        raise HTTPException(status_code=400, detail="client_id desconhecido")
    if redirect_uri not in cliente["redirect_uris"]:
        raise HTTPException(status_code=400, detail="redirect_uri nao registrada para este cliente")

    def recusar(codigo: str, descricao: str):
        destino = redirect_uri + ("&" if "?" in redirect_uri else "?") + urlencode(
            {"error": codigo, "error_description": descricao, "state": state}
        )
        return RedirectResponse(destino, status_code=302)

    if response_type != "code":
        return recusar("unsupported_response_type", "so `code` e suportado")
    # PKCE obrigatorio, e so S256. Sem ele, um codigo interceptado no
    # redirect e trocavel por qualquer um -- e cliente publico nao tem segredo
    # para compensar.
    if not code_challenge or code_challenge_method != "S256":
        return recusar("invalid_request", "PKCE com code_challenge_method=S256 e obrigatorio")

    pedido = oauth.PedidoAutorizacao(
        client_id=client_id, redirect_uri=redirect_uri, state=state,
        code_challenge=code_challenge, resource=resource,
    )
    # O pedido viaja SELADO dentro do proprio `state` que vai ao Identity e
    # volta intacto -- nenhuma replica precisa lembrar dele. Ver o bloco
    # "o pedido em voo" em `oauth.py` para o porque.
    try:
        estado = oauth.selar_pedido(pedido)
    except oauth.OAuthError as exc:
        return recusar(exc.code, exc.description)
    return RedirectResponse(
        oauth.identity_authorize_url(estado, f"{_base_publica(request)}/oauth/callback"),
        status_code=302,
    )


@app.get("/oauth/callback")
def oauth_callback(
    request: Request,
    code: str = Query(default=""),
    state: str = Query(default=""),
    error: str = Query(default=""),
):
    """Volta do Identity: emite o nosso codigo e devolve ao cliente MCP."""
    from fastapi.responses import HTMLResponse, RedirectResponse

    try:
        pedido = oauth.abrir_pedido(state)
    except oauth.OAuthError as exc:
        return HTMLResponse(
            f"<h3>O login falhou</h3><p>{html.escape(exc.description)}</p>",
            status_code=500,
        )
    if pedido is None:
        return HTMLResponse(
            "<h3>Sessao de login expirada</h3>"
            "<p>Tente conectar de novo pelo seu editor.</p>",
            status_code=400,
        )

    if error or not code:
        destino = pedido.redirect_uri + ("&" if "?" in pedido.redirect_uri else "?") + urlencode(
            {"error": error or "access_denied", "state": pedido.state}
        )
        return RedirectResponse(destino, status_code=302)

    try:
        identidade = oauth.trocar_codigo_do_identity(
            code, f"{_base_publica(request)}/oauth/callback"
        )
    except oauth.OAuthError as exc:
        return HTMLResponse(
            f"<h3>O login falhou</h3><p>{html.escape(exc.description)}</p>",
            status_code=400,
        )

    nosso = oauth.emitir_codigo(pedido, identidade)
    destino = pedido.redirect_uri + ("&" if "?" in pedido.redirect_uri else "?") + urlencode(
        {"code": nosso, "state": pedido.state}
    )
    log.info(
        "conexao autorizada para %s (cliente %s)",
        identidade["email"] or identidade["subject"], pedido.client_id,
    )
    return RedirectResponse(destino, status_code=302)


@app.post("/oauth/token")
async def oauth_token(request: Request) -> JSONResponse:
    formulario = await request.form()
    dados = {k: str(v) for k, v in formulario.items()}
    tipo = dados.get("grant_type", "")
    try:
        if tipo == "authorization_code":
            corpo = oauth.trocar_codigo(
                dados.get("code", ""), dados.get("client_id", ""),
                dados.get("redirect_uri", ""), dados.get("code_verifier", ""),
            )
        elif tipo == "refresh_token":
            corpo = oauth.renovar(dados.get("refresh_token", ""), dados.get("client_id", ""))
        else:
            raise oauth.OAuthError("unsupported_grant_type", f"grant_type invalido: {tipo}")
    except oauth.OAuthError as exc:
        return JSONResponse(
            {"error": exc.code, "error_description": exc.description}, status_code=exc.status
        )
    # Token nunca em cache, em nenhum ponto do caminho.
    return JSONResponse(corpo, headers={"Cache-Control": "no-store", "Pragma": "no-cache"})


@app.get("/v1/connections")
def list_connections(principal: Principal = Depends(current_principal)) -> dict[str, Any]:
    """As conexoes de conector do PROPRIO chamador."""
    return {"connections": oauth.listar_conexoes(principal.subject, principal.email)}


@app.delete("/v1/connections/{grant_id}")
def revoke_connection(
    grant_id: int,
    principal: Principal = Depends(current_principal),
) -> dict[str, Any]:
    if not oauth.revogar_conexao(grant_id, principal.subject, principal.email):
        raise HTTPException(status_code=404, detail="conexao nao encontrada entre as suas")
    return {"revoked": grant_id}


# ── token pessoal para os harnesses de IA ──────────────────────────────────


@app.get("/v1/tokens")
def list_tokens(principal: Principal = Depends(current_principal)) -> dict[str, Any]:
    """Os tokens do PRÓPRIO chamador."""
    return {
        "tokens": tokens.listar(principal.subject, principal.email),
        "default_days": settings.personal_token_days,
    }


@app.post("/v1/tokens")
def create_token(
    payload: dict = Body(default={}),
    principal: Principal = Depends(current_principal),
) -> dict[str, Any]:
    """Emite um token pessoal. O valor em claro aparece UMA vez.

    Exige login de pessoa: um token pessoal NAO emite outro token, e o token de
    serviço também não. Se um vazasse, quem o tivesse não deveria conseguir
    cunhar credenciais novas de vida longa a partir dele.
    """
    if principal.source not in ("keycloak",):
        raise HTTPException(
            status_code=403,
            detail=(
                "só um login de pessoa emite token pessoal "
                f"(este acesso é '{principal.source}'). Entre pela interface."
            ),
        )
    if not principal.subject and not principal.email:
        raise HTTPException(
            status_code=403, detail="o token do login não traz identidade (sub nem email)"
        )

    emitido = tokens.issue(
        name=str(payload.get("name") or "").strip() or "sem nome",
        subject=principal.subject,
        email=principal.email,
        entra_oid=principal.entra_oid,
        groups=principal.groups,
        roles=principal.roles,
        days=int(payload.get("days") or 0) or None,
    )
    return {
        "id": emitido.id,
        "name": emitido.name,
        # A ÚNICA vez que o valor em claro sai daqui.
        "token": emitido.value,
        "prefix": emitido.prefix,
        "expires_at": emitido.expires_at.isoformat() if emitido.expires_at else None,
        "groups": principal.groups,
    }


@app.delete("/v1/tokens/{token_id}")
def revoke_token(
    token_id: int,
    principal: Principal = Depends(current_principal),
) -> dict[str, Any]:
    if not tokens.revogar(token_id, principal.subject, principal.email):
        raise HTTPException(
            status_code=404, detail="token não encontrado entre os seus, ou já revogado"
        )
    return {"revoked": token_id}


# ── retrato tecnico da instalacao ──────────────────────────────────────────


# Cada linha responde "onde isto entra". Uma lista de versoes solta nao ajuda
# ninguem a entender a arquitetura -- a pergunta util nao e "que versao do
# docling", e "o que quebra se o docling sair". `dist` e o nome no PyPI (vazio
# quando nao e pacote Python, como o tesseract).
_BIBLIOTECAS: tuple[dict[str, str], ...] = (
    {"dist": "fastapi", "layer": "API",
     "role": "expõe as DUAS superfícies na mesma app: o REST desta tela e o MCP dos agentes",
     "module": "kb_api/main.py"},
    {"dist": "uvicorn", "layer": "API",
     "role": "servidor ASGI que roda a app no pod",
     "module": "Dockerfile (CMD)"},
    {"dist": "python-multipart", "layer": "API",
     "role": "recebe o upload do documento (multipart) sem carregar tudo em memória de uma vez",
     "module": "kb_api/main.py"},
    {"dist": "psycopg", "layer": "Armazenamento",
     "role": "único caminho até o Postgres: vetor e texto gravados na MESMA transação",
     "module": "kb_api/db.py"},
    {"dist": "docling", "layer": "Ingestão",
     "role": "extrator primário: lê o layout, preserva tabela em Markdown e separa as imagens",
     "module": "kb_api/extract.py"},
    {"dist": "docling-core", "layer": "Ingestão",
     "role": "o documento intermediário do docling; é dele que sai o Markdown página a página",
     "module": "kb_api/extract.py"},
    {"dist": "transformers", "layer": "Ingestão",
     "role": "carrega o modelo de layout do docling. Preso em <5: com a 5.x todo PDF cai no fallback, em silêncio",
     "module": "dependência do docling"},
    {"dist": "torch", "layer": "Ingestão",
     "role": "inferência do modelo de layout e de tabela, em CPU (a variante CUDA não entra na imagem)",
     "module": "Dockerfile (índice CPU do PyTorch)"},
    {"dist": "", "name": "tesseract", "layer": "Ingestão",
     "role": "OCR das imagens extraídas; o texto lido entra no canônico ao lado do link da imagem",
     "module": "kb_api/extract.py (CLI)"},
    {"dist": "pymupdf", "layer": "Ingestão",
     "role": "fallback de PDF quando o docling falha, e render da página para o OCR",
     "module": "kb_api/extract.py"},
    {"dist": "python-docx", "layer": "Ingestão", "role": "extrator de .docx",
     "module": "kb_api/extract.py"},
    {"dist": "python-pptx", "layer": "Ingestão", "role": "extrator de .pptx",
     "module": "kb_api/extract.py"},
    {"dist": "openpyxl", "layer": "Ingestão", "role": "extrator de .xlsx",
     "module": "kb_api/extract.py"},
    {"dist": "llama-index-core", "layer": "Chunking",
     "role": "os motores de corte escolhidos por Espaço: MarkdownNodeParser, SentenceSplitter e SemanticSplitterNodeParser",
     "module": "kb_api/chunking.py"},
    {"dist": "pyyaml", "layer": "Ingestão",
     "role": "lê o frontmatter dos conceitos no formato de entrada OKF",
     "module": "kb_api/okf.py"},
    {"dist": "neo4j", "layer": "Grafo",
     "role": "driver Bolt do Memgraph — termos compartilhados e links declarados do OKF, que alimentam os documentos relacionados",
     "module": "kb_api/graph.py"},
)


def _bibliotecas() -> list[dict[str, str]]:
    """Versao instalada de cada peca, com a camada e o arquivo onde ela e usada."""
    saida: list[dict[str, str]] = [
        {
            "name": "python", "version": platform.python_version(), "layer": "API",
            "role": "runtime de todo o serviço — a mesma stack do agent-runner do agentic-sdlc",
            "module": "services/kb-api",
        }
    ]
    for item in _BIBLIOTECAS:
        nome = item.get("name") or item["dist"]
        if item["dist"]:
            try:
                versao = metadata.version(item["dist"])
            except Exception:  # noqa: BLE001
                versao = "ausente"
        else:
            versao = _versao_tesseract() if nome == "tesseract" else "ausente"
        saida.append(
            {"name": nome, "version": versao, "layer": item["layer"],
             "role": item["role"], "module": item["module"]}
        )
    return saida


def _versao_tesseract() -> str:
    try:
        primeira = subprocess.run(
            ["tesseract", "--version"], capture_output=True, timeout=10
        ).stdout.decode("utf-8", "replace").splitlines()
        # `tesseract --version` devolve "tesseract 5.5.0"; guardar so o numero
        # evita a etiqueta "tesseract tesseract 5.5.0" na tela.
        return primeira[0].strip().removeprefix("tesseract ") if primeira else "ausente"
    except Exception:  # noqa: BLE001
        return "ausente"


# ── Modelos de IA ──────────────────────────────────────────────────────────
#
# O provedor saiu da variavel de ambiente e virou linha de banco, editavel aqui.
# A credencial NUNCA volta em texto puro: as leituras devolvem so os quatro
# ultimos caracteres, o suficiente para conferir QUAL chave esta la.


def _provedor_para_tela(linha: tuple, usado_por: dict[int, list[str]] | None = None) -> dict[str, Any]:
    return {
        "id": linha[0],
        "name": linha[1],
        "kind": linha[2],
        "kind_label": providers.DIALETOS[linha[2]].rotulo if linha[2] in providers.DIALETOS else linha[2],
        "endpoint": linha[3],
        "model": linha[4],
        "api_version": linha[5],
        "dimensions": linha[6],
        "purpose": linha[7],
        "active": linha[8],
        "is_default": linha[9],
        # So o rabo da chave. Ver o comentario do bloco.
        "api_key_tail": linha[10],
        "has_key": bool(linha[10]),
        "updated_at": linha[11].isoformat() if linha[11] else None,
        "updated_by": linha[12],
        # `null` = preco NAO cadastrado, e nao "de graca". A tela mostra os dois
        # estados diferente: sem preco ela diz que nao sabe o custo, em vez de
        # somar zero e parecer apurada.
        "price_input_per_1m": float(linha[13]) if linha[13] is not None else None,
        "price_output_per_1m": float(linha[14]) if linha[14] is not None else None,
        # Quais bases escolheram ESTE provedor explicitamente. Existe porque
        # apagar um provedor em uso nao da erro: o `ON DELETE SET NULL` da 0004
        # faz cada base cair para o padrao da instalacao, em silencio. Sem isto
        # na tela, o operador so descobriria pela busca piorando.
        "spaces": (usado_por or {}).get(linha[0], []),
    }


_COLUNAS_PROVEDOR = (
    "id, name, kind, endpoint, model, api_version, dimensions, purpose, "
    "active, is_default, api_key_tail, updated_at, updated_by, "
    "price_input_per_1m, price_output_per_1m"
)


@app.get("/v1/ai/kinds")
def ai_kinds(principal: Principal = Depends(current_principal)) -> dict[str, Any]:
    """Os tipos de provedor suportados, com o que cada campo significa."""
    return {
        "kinds": [
            {
                "id": chave,
                "label": dialeto.rotulo,
                "endpoint_default": dialeto.endpoint_padrao,
                "api_version_default": dialeto.api_version_padrao,
                "needs_api_version": bool(dialeto.api_version_padrao),
                "model_label": (
                    "Deployment" if chave == "azure_openai" else "Modelo"
                ),
                "endpoint_hint": _DICA_ENDPOINT.get(chave, ""),
            }
            for chave, dialeto in providers.DIALETOS.items()
        ],
        # Os propositos existem aqui e nao numa constante da tela porque o
        # `purpose` e a chave do `is_default`: a lista precisa vir de quem
        # valida, senao um nome novo no servidor nao aparece para escolher e um
        # nome errado na tela e recusado sem explicacao.
        "purposes": [
            {
                "id": chave,
                "label": rotulo,
                "description": descricao,
                # Só o embedding precisa casar com a dimensão do índice. Pedir
                # dimensão de um modelo de chat seria pedir um número que não
                # significa nada e que a API ia validar contra o índice errado.
                "needs_dimensions": chave == "embedding",
            }
            for chave, (rotulo, descricao) in PROPOSITOS.items()
        ],
        "schema_dimensions": settings.embedding_dim,
    }


_DICA_ENDPOINT = {
    "azure_openai": "https://<recurso>.openai.azure.com",
    "openai": "deixe vazio para usar https://api.openai.com/v1",
    "azure_foundry": "https://<recurso>.services.ai.azure.com",
    "gemini": "deixe vazio para usar a camada compativel do Google",
    # Mesma convencao do cadastro do agentic-sdlc (ADR-0051): a RAIZ do
    # gateway, sem /v1 -- e o cliente que anexa.
    "litellm": "raiz do gateway, SEM /v1 (ex.: http://litellm.litellm)",
}


@app.post("/v1/ai/models")
def list_ai_models(
    payload: dict = Body(...), principal: Principal = Depends(require_write)
) -> dict[str, Any]:
    """Os modelos que esta conta expoe, para a tela escolher em vez de digitar.

    Nao persiste nada: a resposta so preenche o campo do formulario. Existe
    porque errar o nome do modelo nao da erro no cadastro -- ele salva, e a
    falha aparece depois como um 404 do provedor no meio de uma ingestao. No
    Azure e pior: o que vai na URL e o nome do DEPLOYMENT, que quem publicou
    pode ter chamado de qualquer coisa.

    A credencial vem de um de dois lugares:

    * `api_key` no corpo, quando o formulario ainda nao foi salvo;
    * `provider_id` de um cadastro existente, e ai a chave gravada e decifrada
      aqui dentro -- a tela nunca a reexibe (ADR-0009).

    ⚠ Usar a chave gravada EXIGE que o endpoint informado seja o do proprio
    cadastro. Sem essa amarra, um administrador poderia apontar uma credencial
    que ele nao tem permissao de ler para um endpoint qualquer e le-la na outra
    ponta -- transformando esta rota num vazador da chave que o ADR-0009 existe
    para proteger.
    """
    kind = str(payload.get("kind") or "").strip()
    if kind not in providers.DIALETOS:
        raise HTTPException(
            status_code=400,
            detail=f"tipo desconhecido: {kind}. Use {', '.join(providers.DIALETOS)}",
        )
    endpoint = str(payload.get("endpoint") or "").strip().rstrip("/")
    api_key = str(payload.get("api_key") or "").strip()

    provider_id = payload.get("provider_id")
    if not api_key and provider_id not in (None, "", 0):
        with conn() as connection, connection.cursor() as cur:
            cur.execute(
                "SELECT kind, endpoint, api_key_enc FROM ai_provider WHERE id = %s",
                (int(provider_id),),
            )
            linha = cur.fetchone()
        if linha is None:
            raise HTTPException(status_code=404, detail=f"provedor {provider_id} não encontrado")
        gravado_kind, gravado_endpoint, gravado_key = linha
        if gravado_kind != kind:
            raise HTTPException(
                status_code=400, detail="o tipo informado não corresponde ao do provedor salvo"
            )
        if endpoint and endpoint != (gravado_endpoint or "").rstrip("/"):
            raise HTTPException(
                status_code=400,
                detail="o endpoint precisa ser o do provedor salvo para usar a credencial dele",
            )
        endpoint = endpoint or (gravado_endpoint or "")
        try:
            api_key = providers.decifrar(gravado_key)
        except providers.ProviderError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None

    if not api_key:
        raise HTTPException(
            status_code=400,
            detail=(
                "informe a credencial para listar os modelos, ou o `provider_id` de um "
                "cadastro existente para usar a que já está gravada"
            ),
        )
    if not endpoint and kind != "openai":
        raise HTTPException(
            status_code=400,
            detail=(
                "informe o endpoint do gateway LiteLLM"
                if kind == "litellm"
                else "informe o endpoint do recurso Azure"
            ),
        )

    try:
        origem, modelos = catalog.listar(kind, endpoint, api_key)
    except catalog.CatalogError as exc:
        # O status do provedor decide o nosso: 401/403 e credencial, 400 e
        # pedido, o resto e problema do outro lado (502). Devolver 500 para
        # tudo mandaria o operador investigar esta API quando o erro e la.
        status = {401: 401, 403: 401, 400: 400}.get(exc.status, 502)
        raise HTTPException(status_code=status, detail=str(exc)) from None

    log.info(
        "catalogo de modelos consultado: kind=%s origem=%s itens=%s (por %s)",
        kind, origem, len(modelos), principal.describe(),
    )
    return {
        "source": origem,
        "note": catalog.EXPLICACAO.get(origem, ""),
        "models": [modelo.to_dict() for modelo in modelos],
    }


@app.post("/v1/ai/price-lookup")
def price_lookup(
    payload: dict = Body(...), principal: Principal = Depends(require_write)
) -> dict[str, Any]:
    """O preco deste modelo, buscado no catalogo. Para a tela preencher o campo.

    Existe porque preco por 1M de tokens e um numero que ninguem sabe de cor e
    que muda quando o provedor reajusta. Digitado a mao ele erra de duas formas
    caras: uma virgula fora de lugar multiplica o custo por dez na tela, e um
    preco velho faz o dashboard divergir da fatura sem nada dizer por que.

    A resposta distingue TRES situacoes, porque a acao de cada uma e diferente:
    `catalogo` (achou), `nenhum` (o catalogo respondeu e nao conhece este
    modelo -- deployment com nome proprio, preencha a mao) e `indisponivel`
    (nao deu para ler o catalogo). Juntar as duas ultimas foi um defeito real no
    agentic-sdlc: sem saida para a internet, a busca respondia "nao conheco" ate
    para `gpt-4o`.

    NAO grava nada. Quem decide se aceita o numero e quem esta no formulario.
    """
    kind = (payload.get("kind") or "").strip()
    modelo = (payload.get("model") or "").strip()
    endpoint = (payload.get("endpoint") or "").strip()

    # `provider_id` completa o que o formulario nao mandou, para a busca
    # funcionar tambem a partir da lista -- onde o modelo ja esta gravado e
    # ninguem redigitou nada.
    if payload.get("provider_id"):
        with conn() as connection, connection.cursor() as cur:
            cur.execute(
                "SELECT kind, model, endpoint FROM ai_provider WHERE id = %s",
                (payload["provider_id"],),
            )
            linha = cur.fetchone()
        if linha:
            kind = kind or linha[0]
            modelo = modelo or linha[1]
            endpoint = endpoint or linha[2]

    if not modelo:
        raise HTTPException(
            status_code=400,
            detail="informe o modelo para buscar o preço (ou o provedor que já o tem)",
        )

    # Um gateway LiteLLM cadastrado serve de FONTE do catalogo mesmo quando nao
    # e ele que esta sendo consultado: a rota dele e interna, e e o que faz a
    # busca funcionar numa instalacao sem saida para a internet.
    gateway = endpoint if kind == "litellm" else _gateway_litellm()
    return precos.buscar(kind, modelo, gateway)


def _gateway_litellm() -> str:
    """O endpoint de algum LiteLLM ativo, ou vazio."""
    try:
        with conn() as connection, connection.cursor() as cur:
            cur.execute(
                "SELECT endpoint FROM ai_provider "
                " WHERE kind = 'litellm' AND active AND endpoint <> '' LIMIT 1"
            )
            linha = cur.fetchone()
        return linha[0] if linha else ""
    except Exception as exc:  # noqa: BLE001 - a busca de preco nunca derruba a tela
        log.info("nao consegui procurar um gateway litellm: %s", exc)
        return ""


@app.get("/v1/ai/providers")
def list_ai_providers(principal: Principal = Depends(require_write)) -> dict[str, Any]:
    with conn() as connection, connection.cursor() as cur:
        cur.execute(f"SELECT {_COLUNAS_PROVEDOR} FROM ai_provider ORDER BY purpose, name")
        linhas = cur.fetchall()
        # Uma consulta para os dois vinculos, e nao uma por provedor: com dez
        # provedores cadastrados a versao ingenua faria vinte consultas para
        # montar uma tela.
        cur.execute(
            """
            SELECT embedding_provider_id, slug FROM space
             WHERE active AND embedding_provider_id IS NOT NULL
            UNION ALL
            SELECT chat_provider_id, slug FROM space
             WHERE active AND chat_provider_id IS NOT NULL
            """
        )
        usado_por: dict[int, list[str]] = {}
        for provider_id, slug in cur.fetchall():
            usado_por.setdefault(provider_id, []).append(slug)
    return {"providers": [_provedor_para_tela(linha, usado_por) for linha in linhas]}


# Para que a base usa um modelo. `embedding` e o original; `chat` entrou com a
# derivacao de conceito OKF (ADR-0015) e e o UNICO lugar onde este projeto pede
# texto gerado -- a busca continua devolvendo evidencia, nunca resposta
# (ADR-0006). Validar contra a lista existe porque `purpose` e a chave do
# `is_default`: um "chatt" digitado errado cria um proposito paralelo que nunca
# e consultado, e o sintoma e "a derivacao nao funciona" sem nada no log.
PROPOSITOS = {
    "embedding": ("Embedding", "vetoriza o texto para a busca semântica, na ingestão e em cada pergunta"),
    "chat": ("Chat", "gera texto onde a base precisa — hoje só para derivar o conceito OKF na ingestão"),
}


def _validar_provedor(payload: dict, criando: bool) -> dict[str, Any]:
    nome = (payload.get("name") or "").strip()
    kind = (payload.get("kind") or "").strip()
    if criando and not nome:
        raise HTTPException(status_code=400, detail="informe o nome do provedor")
    if criando and kind not in providers.DIALETOS:
        raise HTTPException(
            status_code=400,
            detail=f"tipo desconhecido: {kind}. Use {', '.join(providers.DIALETOS)}",
        )
    purpose = (payload.get("purpose") or "embedding").strip()
    if purpose not in PROPOSITOS:
        raise HTTPException(
            status_code=400,
            detail=f"propósito desconhecido: {purpose}. Use {', '.join(PROPOSITOS)}",
        )
    dimensoes = payload.get("dimensions")
    if dimensoes is not None:
        try:
            dimensoes = int(dimensoes)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="`dimensions` deve ser numero") from None
        if not 1 <= dimensoes <= 16384:
            raise HTTPException(status_code=400, detail="`dimensions` fora da faixa")
    precos: dict[str, Any] = {}
    for campo in ("price_input_per_1m", "price_output_per_1m"):
        if campo not in payload:
            continue
        bruto = payload[campo]
        # String vazia e `null` querem dizer a MESMA coisa: apagar o preco. A
        # tela manda vazio quando o operador limpa o campo, e tratar isso como
        # zero gravaria "custa nada" no lugar de "nao sei quanto custa".
        if bruto in (None, ""):
            precos[campo] = None
            continue
        try:
            valor = float(bruto)
        except (TypeError, ValueError):
            raise HTTPException(
                status_code=400, detail=f"`{campo}` deve ser um número em dólar por 1M de tokens"
            ) from None
        if valor < 0:
            raise HTTPException(status_code=400, detail=f"`{campo}` não pode ser negativo")
        # Teto de sanidade: 10 mil dolares por milhao de tokens e ordens de
        # grandeza acima de qualquer modelo. Numero absurdo aqui vira um custo
        # absurdo na tela, e alguem vai acreditar nele.
        if valor > 10_000:
            raise HTTPException(
                status_code=400,
                detail=f"`{campo}` = {valor} parece um engano. O preço é por 1M de tokens",
            )
        precos[campo] = valor

    return {
        "name": nome,
        "kind": kind,
        **precos,
        "endpoint": (payload.get("endpoint") or "").strip().rstrip("/"),
        "model": (payload.get("model") or "").strip(),
        "api_version": (payload.get("api_version") or "").strip(),
        "dimensions": dimensoes,
        "purpose": purpose,
        "active": payload.get("active"),
    }


@app.post("/v1/ai/providers")
def create_ai_provider(
    payload: dict = Body(...), principal: Principal = Depends(require_write)
) -> dict[str, Any]:
    dados = _validar_provedor(payload, criando=True)
    chave = (payload.get("api_key") or "").strip()
    if not chave:
        raise HTTPException(status_code=400, detail="informe a credencial do provedor")
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            f"""
            INSERT INTO ai_provider
                (name, kind, endpoint, api_key_enc, api_key_tail, model,
                 api_version, dimensions, purpose, updated_by,
                 price_input_per_1m, price_output_per_1m)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            RETURNING {_COLUNAS_PROVEDOR}
            """,
            (
                dados["name"], dados["kind"], dados["endpoint"],
                providers.cifrar(chave), chave[-4:],
                dados["model"], dados["api_version"],
                dados["dimensions"] or settings.embedding_dim,
                dados["purpose"], principal.describe(),
                dados.get("price_input_per_1m"), dados.get("price_output_per_1m"),
            ),
        )
        linha = cur.fetchone()
        connection.commit()
    providers.invalidar()
    log.info("provedor de IA criado: %s (por %s)", dados["name"], principal.describe())
    return _provedor_para_tela(linha)


@app.put("/v1/ai/providers/{provider_id}")
def update_ai_provider(
    provider_id: int, payload: dict = Body(...), principal: Principal = Depends(require_write)
) -> dict[str, Any]:
    dados = _validar_provedor(payload, criando=False)
    chave = (payload.get("api_key") or "").strip()

    campos: list[str] = []
    valores: list[Any] = []
    for coluna in ("name", "endpoint", "model", "api_version", "dimensions", "active"):
        if dados.get(coluna) not in (None, ""):
            campos.append(f"{coluna} = %s")
            valores.append(dados[coluna])
    # O PRECO segue outra regra: `None` aqui e um valor, nao "nao mandou". O
    # laco acima trata `None` como ausencia, e usa-lo para o preco tornaria
    # impossivel APAGAR um preco cadastrado por engano. O que diz se o campo
    # veio e a presenca da chave no payload.
    for coluna in ("price_input_per_1m", "price_output_per_1m"):
        if coluna in dados:
            campos.append(f"{coluna} = %s")
            valores.append(dados[coluna])
    # Chave vazia = "nao mexa na que ja esta la". E o que permite editar o
    # endpoint sem ter de redigitar a credencial (que a tela nem mostra).
    if chave:
        campos.append("api_key_enc = %s")
        valores.append(providers.cifrar(chave))
        campos.append("api_key_tail = %s")
        valores.append(chave[-4:])
    if not campos:
        raise HTTPException(status_code=400, detail="nada para atualizar")
    campos.append("updated_at = now()")
    campos.append("updated_by = %s")
    valores.append(principal.describe())
    valores.append(provider_id)

    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            f"UPDATE ai_provider SET {', '.join(campos)} WHERE id = %s "
            f"RETURNING {_COLUNAS_PROVEDOR}",
            tuple(valores),
        )
        linha = cur.fetchone()
        if linha is None:
            raise HTTPException(status_code=404, detail="provedor nao encontrado")
        connection.commit()
    providers.invalidar()
    return _provedor_para_tela(linha)


@app.post("/v1/ai/providers/{provider_id}/default")
def set_default_ai_provider(
    provider_id: int, principal: Principal = Depends(require_write)
) -> dict[str, Any]:
    """Marca o provedor como o EM USO para o proposito dele."""
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            "SELECT purpose, dimensions, active, name FROM ai_provider WHERE id = %s",
            (provider_id,),
        )
        alvo = cur.fetchone()
        if alvo is None:
            raise HTTPException(status_code=404, detail="provedor nao encontrado")
        purpose, dimensoes, ativo, nome = alvo
        if not ativo:
            raise HTTPException(status_code=400, detail="provedor inativo nao pode ser o padrao")
        # Dimensao divergente e um defeito SILENCIOSO: a gravacao ate funciona
        # para o vetor novo, e a busca passa a comparar vetores de espacos
        # diferentes -- o resultado piora sem erro nenhum aparecer. Por isso a
        # recusa e aqui, e nao um aviso na tela.
        if purpose == "embedding" and dimensoes != settings.embedding_dim:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"'{nome}' devolve {dimensoes} dimensoes e o indice tem "
                    f"{settings.embedding_dim}. Misturar dimensoes degrada a busca "
                    f"sem erro aparente. Para trocar, reindexe a base com o modelo novo."
                ),
            )
        # As duas escritas na MESMA transacao: entre limpar e marcar, uma leitura
        # concorrente veria a instalacao sem provedor nenhum.
        cur.execute("UPDATE ai_provider SET is_default = FALSE WHERE purpose = %s", (purpose,))
        cur.execute(
            f"UPDATE ai_provider SET is_default = TRUE, updated_at = now(), updated_by = %s "
            f"WHERE id = %s RETURNING {_COLUNAS_PROVEDOR}",
            (principal.describe(), provider_id),
        )
        linha = cur.fetchone()
        connection.commit()
    providers.invalidar()
    log.info("provedor padrao de %s -> %s (por %s)", purpose, nome, principal.describe())
    return _provedor_para_tela(linha)


@app.delete("/v1/ai/providers/{provider_id}")
def delete_ai_provider(
    provider_id: int, principal: Principal = Depends(require_write)
) -> dict[str, Any]:
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            "DELETE FROM ai_provider WHERE id = %s RETURNING name, is_default", (provider_id,)
        )
        linha = cur.fetchone()
        if linha is None:
            raise HTTPException(status_code=404, detail="provedor nao encontrado")
        connection.commit()
    providers.invalidar()
    log.info("provedor de IA removido: %s (por %s)", linha[0], principal.describe())
    # O historico de uso NAO some junto: `ai_usage_daily` nao tem FK para ca,
    # de proposito. Apagar o cadastro nao pode apagar o gasto ja realizado.
    return {"removed": linha[0], "was_default": linha[1]}


@app.post("/v1/ai/providers/{provider_id}/test")
def test_ai_provider(
    provider_id: int, principal: Principal = Depends(require_write)
) -> dict[str, Any]:
    """Faz UMA chamada real ao provedor e diz o que voltou.

    Existe para a falha aparecer no cadastro, e nao no meio de uma ingestao de
    uma hora. Conta no dashboard como qualquer outra chamada -- inclusive se
    falhar, que e o ponto.
    """
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            "SELECT id, name, kind, endpoint, model, api_version, dimensions, api_key_enc, purpose "
            "FROM ai_provider WHERE id = %s",
            (provider_id,),
        )
        linha = cur.fetchone()
    if linha is None:
        raise HTTPException(status_code=404, detail="provedor nao encontrado")

    provedor = providers.Provedor(
        id=linha[0], name=linha[1], kind=linha[2], endpoint=linha[3],
        model=linha[4], api_version=linha[5], dimensions=linha[6],
        api_key=providers.decifrar(linha[7]),
    )
    purpose = linha[8]
    inicio = time.perf_counter()

    # O teste tem de exercitar o que aquele provedor FAZ. Mandar um embedding
    # para um modelo de chat devolve `OperationNotSupported` do proprio Azure --
    # um erro verdadeiro sobre uma pergunta que ninguem fez, e que fazia um
    # cadastro correto parecer quebrado na tela.
    if purpose == "chat":
        ok, erro, tokens = llm.testar(provedor)
        ms = int((time.perf_counter() - inicio) * 1000)
        providers.registrar_uso(provedor, "test", tokens=tokens, latency_ms=ms, erro=not ok)
        if not ok:
            return {"ok": False, "error": (erro or "o modelo nao respondeu")[:400]}
        return {"ok": True, "purpose": purpose, "latency_ms": ms, "tokens": tokens}

    try:
        vetores, tokens = embedding._post(["teste de conexao"], provedor)
    except Exception as exc:  # noqa: BLE001
        providers.registrar_uso(
            provedor, "test", latency_ms=int((time.perf_counter() - inicio) * 1000), erro=True
        )
        return {"ok": False, "error": str(exc)[:400]}

    ms = int((time.perf_counter() - inicio) * 1000)
    providers.registrar_uso(provedor, "test", tokens=tokens, latency_ms=ms)
    dimensoes = len(vetores[0]) if vetores else 0
    return {
        "ok": True,
        "purpose": purpose,
        "latency_ms": ms,
        "tokens": tokens,
        "dimensions": dimensoes,
        # A divergencia e reportada como AVISO no teste (e como recusa ao
        # marcar padrao): aqui a pessoa esta descobrindo, nao decidindo.
        "dimension_mismatch": bool(dimensoes and dimensoes != settings.embedding_dim),
        "schema_dimensions": settings.embedding_dim,
    }


@app.get("/v1/ai/usage")
def ai_usage(
    days: int = Query(default=30, ge=1, le=365),
    principal: Principal = Depends(require_write),
) -> dict[str, Any]:
    """Gasto de IA por dia.

    Le a tabela de ROLLUP (`ai_usage_daily`), nao um historico de chamadas: sao
    algumas dezenas de linhas por mes, entao a tela custa o mesmo com a base
    vazia e com ela cheia. Agregar na leitura seria um seq scan de milhoes de
    linhas exatamente quando o numero comeca a importar.
    """
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            SELECT day, provider, model, operation, calls, tokens, latency_ms,
                   errors, tokens_in, tokens_out, cost_usd, tokens_estimados
              FROM ai_usage_daily
             WHERE day >= CURRENT_DATE - %s::int
             ORDER BY day DESC, tokens DESC
            """,
            (days,),
        )
        linhas = cur.fetchall()

    CONTADORES = ("calls", "tokens", "tokens_in", "tokens_out", "errors",
                  "cost_usd", "sem_preco", "tokens_estimados")

    def vazio(**extra: Any) -> dict[str, Any]:
        return {**dict.fromkeys(CONTADORES, 0), "cost_usd": 0.0, **extra}

    def somar(item: dict[str, Any], parcela: dict[str, Any]) -> None:
        for nome in CONTADORES:
            item[nome] += parcela[nome]

    dias: dict[str, dict[str, Any]] = {}
    por_operacao: dict[str, dict[str, Any]] = {}
    por_provedor: dict[str, dict[str, Any]] = {}
    totais = vazio(latency_ms=0)

    for linha in linhas:
        (dia, provedor, modelo, operacao, chamadas, gastos, ms,
         erros, entrada, saida, custo, estimados) = linha
        custo = float(custo or 0)
        # TOKEN CONTADO E CUSTO ZERO quer dizer "preco nao cadastrado", e nao
        # "saiu de graca". A tela precisa distinguir os dois, senao uma conta
        # que ninguem precificou aparece como economia. Este contador e o que
        # permite ela dizer "faltam preços" em vez de somar zero calada.
        #
        # Vale tambem para o passado: as linhas anteriores a 0014 nao tem
        # decomposicao nem custo, e cairiam aqui pelo mesmo caminho.
        sem_preco = gastos if (gastos and custo <= 0) else 0

        parcela = {"calls": chamadas, "tokens": gastos, "tokens_in": entrada,
                   "tokens_out": saida, "errors": erros, "cost_usd": custo,
                   "sem_preco": sem_preco, "tokens_estimados": estimados or 0}
        chave = dia.isoformat()
        somar(dias.setdefault(chave, vazio(day=chave)), parcela)
        somar(por_operacao.setdefault(operacao, vazio()), parcela)
        somar(por_provedor.setdefault(f"{provedor} · {modelo}", vazio()), parcela)
        somar(totais, parcela)
        totais["latency_ms"] += ms

    def arredondar(item: dict[str, Any]) -> dict[str, Any]:
        # Seis casas: com preco de centavos por milhao de tokens, duas casas
        # transformariam um dia inteiro de uso em "0,00".
        return {**item, "cost_usd": round(item["cost_usd"], 6)}

    return {
        "days": days,
        "total": arredondar({
            **totais,
            # Media por chamada; sem isso o numero de latencia nao diz nada.
            "avg_latency_ms": round(totais["latency_ms"] / totais["calls"]) if totais["calls"] else 0,
        }),
        # Ordem crescente para o grafico: a tela desenha da esquerda para a direita.
        "daily": [arredondar(d) for d in sorted(dias.values(), key=lambda item: item["day"])],
        "by_operation": [arredondar({"name": k, **v}) for k, v in sorted(por_operacao.items())],
        "by_provider": [arredondar({"name": k, **v}) for k, v in sorted(por_provedor.items())],
    }


@app.post("/v1/ai/usage/recalculate")
def recalculate_usage(
    payload: dict = Body(default={}), principal: Principal = Depends(require_write)
) -> dict[str, Any]:
    """Reaplica o preco ATUAL ao uso que ja foi gravado. Acao explicita.

    Existe porque o custo e congelado na hora do uso, e quem cadastra o preco
    depois de rodar fica com um historico inteiro em zero -- que na tela parece
    "nao gastou" em vez de "ninguem tinha dito quanto custava".

    E um POST, e nao um recalculo automatico na leitura, porque ela MUDA numero
    de historico. Ninguem deve descobrir depois que os valores de ontem
    mudaram sozinhos; quem dispara sabe o que disparou.

    Embedding sai exato (a operacao nao tem saida). Chat antigo sai ESTIMADO: a
    linha so guarda o total e a decomposicao nunca foi gravada. O que for
    suposto volta contado em `tokens_estimados`, e a tela mostra separado --
    estimativa somada com apurado sem distincao e pior que numero ausente.
    """
    bruto = payload.get("fracao_entrada", recalculo.FRACAO_ENTRADA_CHAT)
    try:
        fracao = float(bruto)
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=400, detail="`fracao_entrada` deve ser um número entre 0 e 1"
        ) from None
    try:
        resumo = recalculo.recalcular(fracao)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    log.info("custo do historico recalculado por %s", principal.describe())
    return resumo


@app.get("/v1/stack")
def stack(principal: Principal = Depends(current_principal)) -> dict[str, Any]:
    """O que esta rodando e quanto tem dentro, medido agora.

    Isto nao e o /v1/health. O health responde "esta de pe?" e serve a sonda do
    kubelet -- por isso e barato e nao conta nada. Esta rota responde "o que
    exatamente esta rodando aqui, com quantos vetores, quantos arquivos e que
    tamanho de grafo", que e a pergunta de quem vai mostrar o sistema para
    alguem ou decidir se ele aguenta a proxima base.
    """
    dados: dict[str, Any] = {
        "env": settings.env,
        "auth": {
            "mode": "keycloak" if settings.auth_enabled else "desligada",
            "issuer": settings.oidc_issuer,
            "admin_group": settings.admin_group,
            "admin_role": settings.admin_role,
        },
        "pipeline": {
            "extractors": ["docling", "pymupdf", "python-docx", "python-pptx", "openpyxl", "texto"],
            "ocr": {
                "enabled": settings.ocr_enabled,
                "engine": "tesseract (CLI)",
                "languages": settings.ocr_languages,
                "force_full_page": settings.ocr_force_full_page,
                "psm": settings.ocr_psm,
            },
            "figures": {
                "enabled": settings.figures_enabled,
                "scale": settings.figure_scale,
                "max_per_document": settings.max_figures_per_document,
            },
            "chunking": {
                "technique": "pai/filho, com motor por Espaço",
                "default_engine": chunking.MOTOR_PADRAO,
                "engines": list(chunking.MOTORES),
                # O slot de ENRIQUECIMENTO e o conjunto de REPRESENTACOES
                # aparecem aqui para o diagnostico mostrar que existem mesmo
                # quando nenhum Espaco saiu do padrao.
                "enrichments": list(chunking.ENRIQUECIMENTOS),
                "default_enrichment": chunking.ENRIQUECIMENTO_PADRAO,
                "representations": list(representations.REPRESENTACOES),
                "auxiliaries": list(representations.AUXILIARES),
                # Sem provedor de chat a variante `conceito` so reconhece
                # frontmatter ja escrito e nao deriva nada, e a wiki nao e
                # destilada. Isso precisa aparecer no diagnostico, senao vira
                # "liguei e nao fez nada" sem causa visivel.
                "okf_chat_provider": llm.disponivel(),
                "child_chars": settings.child_chunk_chars,
                "child_overlap": settings.child_overlap_chars,
                "parent_chars": settings.parent_chunk_chars,
            },
        },
        "search": {
            "vector": f"pgvector cosseno / {_modelo_de_embedding()}",
            "lexical": "postgres full-text (portuguese, unaccent, OR) + ts_rank_cd",
            "fusion": f"RRF k={settings.rrf_k}",
            "candidate_pool": settings.candidate_pool,
            "default_top_k": settings.default_top_k,
            "embedding_dim": settings.embedding_dim,
        },
    }

    # --- Postgres: versoes, contagens e tamanho em disco ---
    postgres: dict[str, Any] = {"reachable": False}
    try:
        with conn() as connection, connection.cursor() as cur:
            cur.execute("SELECT version()")
            bruto = cur.fetchone()[0]
            # `version()` devolve a linha inteira com plataforma e compilador; o
            # que interessa na tela e "PostgreSQL 16.x".
            postgres["version"] = " ".join(bruto.split()[:2])
            cur.execute("SELECT extname, extversion FROM pg_extension ORDER BY extname")
            postgres["extensions"] = {row[0]: row[1] for row in cur.fetchall()}

            cur.execute(
                """
                SELECT
                  (SELECT count(*) FROM space WHERE active),
                  (SELECT count(*) FROM document WHERE active),
                  (SELECT count(*) FROM document WHERE active AND status = 'failed'),
                  (SELECT count(*) FROM chunk WHERE parent_id IS NULL),
                  (SELECT count(*) FROM chunk WHERE parent_id IS NOT NULL),
                  (SELECT count(*) FROM chunk_embedding),
                  (SELECT count(*) FROM document_figure),
                  (SELECT count(*) FROM document_figure WHERE ocr_text <> ''),
                  (SELECT count(*) FROM search_run),
                  (SELECT count(*) FROM space_grant),
                  (SELECT coalesce(sum(pages), 0) FROM document WHERE active)
                """
            )
            row = cur.fetchone()
            postgres["counts"] = {
                "spaces": row[0], "documents": row[1], "failed_documents": row[2],
                "parent_chunks": row[3], "child_chunks": row[4], "embeddings": row[5],
                "figures": row[6], "figures_with_ocr": row[7], "search_runs": row[8],
                "grants": row[9], "pages": row[10],
            }

            # Cobertura da atribuicao de pagina: e o numero que diz se o "ir ao
            # trecho no original" funciona ou cai na pagina 1 sem avisar.
            cur.execute(
                """
                SELECT count(*) FILTER (WHERE c.page IS NOT NULL), count(*)
                  FROM chunk c JOIN document d ON d.id = c.document_id
                 WHERE d.active AND d.pages > 0 AND c.parent_id IS NOT NULL
                """
            )
            com_pagina, total_pagina = cur.fetchone()
            postgres["page_coverage"] = {
                "with_page": com_pagina, "total": total_pagina,
                "pct": round(100.0 * com_pagina / total_pagina, 1) if total_pagina else None,
            }

            # Modelos de embedding presentes no indice. Mais de um significa
            # indice misto -- resultado de troca de modelo sem reindexar tudo,
            # e a busca fica comparando vetores de espacos diferentes.
            cur.execute(
                "SELECT model, count(*) FROM chunk_embedding GROUP BY model ORDER BY 2 DESC"
            )
            postgres["embedding_models"] = {row[0]: row[1] for row in cur.fetchall()}

            cur.execute(
                """
                SELECT relname, pg_total_relation_size(c.oid)
                  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' AND c.relkind = 'r'
                 ORDER BY 2 DESC LIMIT 12
                """
            )
            postgres["table_bytes"] = {row[0]: row[1] for row in cur.fetchall()}
            cur.execute("SELECT pg_database_size(current_database())")
            postgres["database_bytes"] = cur.fetchone()[0]
            postgres["reachable"] = True
    except Exception as exc:  # noqa: BLE001
        postgres["error"] = str(exc)[:200]
    dados["postgres"] = postgres

    # --- MinIO ---
    try:
        dados["object_store"] = {"reachable": True, "endpoint": settings.s3_endpoint, **storage.stats()}
    except Exception as exc:  # noqa: BLE001
        dados["object_store"] = {
            "reachable": False, "endpoint": settings.s3_endpoint, "error": str(exc)[:200]
        }

    # --- Memgraph ---
    dados["graph"] = {"host": f"{settings.graph_host}:{settings.graph_port}", **graph.stats()}

    # --- bibliotecas: versao instalada + ONDE cada uma entra ---
    dados["libraries"] = _bibliotecas()
    dados["versions"] = {item["name"]: item["version"] for item in dados["libraries"]}

    dados["service"] = {
        "started_at": _started_at.isoformat(),
        "uptime_seconds": int((datetime.now(UTC) - _started_at).total_seconds()),
    }
    # Quem nao e admin ve os numeros mas nao o issuer nem o grupo de admin: sao
    # detalhes de configuracao de seguranca, nao metrica de operacao.
    if not principal.unrestricted:
        dados["auth"] = {"mode": dados["auth"]["mode"]}
    return dados


# ── Espacos ────────────────────────────────────────────────────────────────


@app.get("/v1/spaces")
def list_spaces(principal: Principal = Depends(current_principal)) -> dict[str, Any]:
    allowed = principal.allowed_spaces()
    return {
        "spaces": ingest.space_stats(allowed),
        "principal": {
            "source": principal.source,
            "email": principal.email,
            "groups": principal.groups,
            "roles": principal.roles,
            "entra_oid": principal.entra_oid,
            "unrestricted": principal.unrestricted,
        },
    }


@app.post("/v1/spaces")
def create_space(
    payload: dict = Body(...),
    principal: Principal = Depends(require_write),
) -> dict[str, Any]:
    slug = (payload.get("slug") or "").strip()
    if not slug:
        raise HTTPException(status_code=400, detail="`slug` e obrigatorio")
    return ingest.ensure_space(
        slug=slug,
        label=(payload.get("label") or slug).strip(),
        description=(payload.get("description") or "").strip(),
        grants=payload.get("grants") or [],
        chunking=_validar_chunking(payload.get("chunking")),
    )


def _validar_chunking(bruto: Any) -> dict | None:
    """Valida a configuracao de corte. `None` preserva a que ja existe."""
    if bruto is None:
        return None
    if not isinstance(bruto, dict):
        raise HTTPException(status_code=400, detail="`chunking` deve ser um objeto")
    engine = str(bruto.get("engine") or chunking.MOTOR_PADRAO)
    if engine not in chunking.MOTORES:
        raise HTTPException(
            status_code=400,
            detail=f"motor desconhecido: {engine}. Use {', '.join(chunking.MOTORES)}",
        )

    def inteiro(nome: str, minimo: int, maximo: int) -> int | None:
        valor = bruto.get(nome)
        if valor in (None, ""):
            return None
        try:
            numero = int(valor)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"`{nome}` deve ser numero") from None
        if not minimo <= numero <= maximo:
            raise HTTPException(
                status_code=400, detail=f"`{nome}` fora da faixa ({minimo}-{maximo})"
            )
        return numero

    config: dict[str, Any] = {"engine": engine}
    for nome, minimo, maximo in (
        ("child_chars", 200, 8000),
        ("child_overlap", 0, 2000),
        ("parent_chars", 500, 40000),
        ("breakpoint_percentile", 50, 99),
    ):
        valor = inteiro(nome, minimo, maximo)
        if valor is not None:
            config[nome] = valor

    # Enriquecimento de chunk: slot PROPRIO, ao lado do de chunking, e nao um
    # valor do mesmo enum do motor. O motor diz onde cortar a prosa; o
    # enriquecimento diz o que e prependado a cada trecho antes do embedding.
    # Junta-los obrigaria a escolher entre enriquecer e cortar por estrutura,
    # que sao coisas que se somam.
    enriquecimento = str(bruto.get("enrichment") or chunking.ENRIQUECIMENTO_PADRAO).strip()
    if enriquecimento not in chunking.ENRIQUECIMENTOS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"enriquecimento desconhecido: {enriquecimento}. "
                f"Use {', '.join(chunking.ENRIQUECIMENTOS)}"
            ),
        )
    config["enrichment"] = enriquecimento

    # Vocabulario de tipos do modo `okf`. Lista vazia NAO e erro: significa "use
    # o padrao da casa", e exigir oito tipos preenchidos so para escolher o modo
    # seria atrito sem ganho.
    tipos = bruto.get("okf_types")
    if tipos is not None:
        if not isinstance(tipos, list):
            raise HTTPException(status_code=400, detail="`okf_types` deve ser uma lista")
        limpos: list[str] = []
        for valor in tipos:
            texto = str(valor or "").strip()[:60]
            if texto and texto not in limpos:
                limpos.append(texto)
        if len(limpos) > 20:
            # O vocabulario inteiro vai no pedido de CADA documento. Vinte ja e
            # generoso; cem tipos custariam tokens em toda ingestao para o
            # modelo escolher entre opcoes que ninguem consegue distinguir.
            raise HTTPException(
                status_code=400,
                detail="no máximo 20 tipos: a lista inteira vai no pedido de cada documento",
            )
        config["okf_types"] = limpos

    # Filho maior que o pai nao e configuracao, e engano: o filho sairia igual
    # ao pai e a expansao pai/filho perderia o sentido.
    if config.get("child_chars", 0) and config.get("parent_chars", 0):
        if config["child_chars"] >= config["parent_chars"]:
            raise HTTPException(
                status_code=400,
                detail="o filho precisa ser menor que o pai; senão a expansão não entrega contexto",
            )
    return config


@app.put("/v1/spaces/{slug}/chunking")
def set_chunking(
    slug: str,
    payload: dict = Body(...),
    principal: Principal = Depends(require_write),
) -> dict[str, Any]:
    """Troca o motor de corte do Espaco.

    Vale para o que for ingerido DEPOIS. O que ja esta indexado continua com o
    corte antigo ate ser reprocessado -- e a tela diz isso, porque a alternativa
    (reprocessar sozinho) levaria uma hora sem ninguem pedir.
    """
    config = _validar_chunking(payload)
    if config is None:
        raise HTTPException(status_code=400, detail="informe a configuracao de chunking")
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            "UPDATE space SET chunking = %s WHERE slug = %s AND active RETURNING slug",
            (jsonb(config), slug),
        )
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail=f"Espaco {slug} nao encontrado")
        connection.commit()
    log.info("motor de chunking de %s -> %s (por %s)", slug, config, principal.describe())
    return {"space": slug, "chunking": chunking.ChunkConfig.from_space(config).to_dict()}


@app.put("/v1/spaces/{slug}/ai")
def set_space_providers(
    slug: str, payload: dict = Body(...), principal: Principal = Depends(require_write)
) -> dict[str, Any]:
    """Escolhe os modelos DESTA base: um de embedding, um de chat.

    `null` em qualquer um dos dois volta a base para o padrao da instalacao, que
    e o estado de todo Espaco que nunca escolheu. Nao e o mesmo que "nenhum": e
    a escolha de nao escolher, e continua sendo o caso da maioria.

    A troca do embedding NAO reindexa nada, pela mesma razao da troca do motor
    de corte: o que ja esta indexado continua com os vetores do modelo anterior
    ate ser reprocessado. A tela diz isso; reprocessar sozinho levaria horas sem
    ninguem pedir.
    """
    escolhas: dict[str, int | None] = {}
    for campo, purpose in (("embedding_provider_id", "embedding"), ("chat_provider_id", "chat")):
        if campo not in payload:
            continue
        escolhas[campo] = _validar_provedor_do_espaco(payload.get(campo), purpose)
    if not escolhas:
        raise HTTPException(
            status_code=400,
            detail="informe `embedding_provider_id` e/ou `chat_provider_id` (null = padrão)",
        )

    atribuicoes = ", ".join(f"{campo} = %s" for campo in escolhas)
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            f"UPDATE space SET {atribuicoes} WHERE slug = %s AND active RETURNING slug",
            (*escolhas.values(), slug),
        )
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail=f"Espaço {slug} não encontrado")
        connection.commit()

    # O cache de provedor e por (proposito, Espaco) e dura 60s. Sem invalidar,
    # a escolha que a tela acabou de gravar demoraria ate um minuto para valer,
    # e quem testasse na hora veria o modelo antigo sem entender por que.
    providers.invalidar()
    log.info("modelos de IA de %s -> %s (por %s)", slug, escolhas, principal.describe())
    return {"space": slug, "ai": _ai_do_espaco(slug)}


def _validar_provedor_do_espaco(bruto: Any, purpose: str) -> int | None:
    """O id do provedor escolhido, ja conferido. `None` = padrao da instalacao."""
    if bruto in (None, "", 0):
        return None
    try:
        provider_id = int(bruto)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="o provedor deve ser um id numérico") from None

    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            "SELECT purpose, dimensions, active, name FROM ai_provider WHERE id = %s",
            (provider_id,),
        )
        linha = cur.fetchone()
    if linha is None:
        raise HTTPException(status_code=404, detail=f"provedor {provider_id} não encontrado")
    achado, dimensoes, ativo, nome = linha
    if achado != purpose:
        raise HTTPException(
            status_code=400,
            detail=f"o provedor '{nome}' é de {achado}, não de {purpose}",
        )
    if not ativo:
        raise HTTPException(status_code=400, detail=f"o provedor '{nome}' está inativo")
    # A MESMA guarda do `is_default`, e pelo mesmo motivo: `chunk_embedding` tem
    # `vector(N)` fixo no DDL, e um modelo de outra dimensao nao entra no indice.
    # Sem esta checagem a troca seria aceita e a ingestao passaria a falhar em
    # todo documento daquela base.
    if purpose == "embedding" and dimensoes != settings.embedding_dim:
        raise HTTPException(
            status_code=400,
            detail=(
                f"o provedor '{nome}' devolve {dimensoes} dimensões e o índice espera "
                f"{settings.embedding_dim}. Misturar dimensões degrada a busca sem erro aparecer."
            ),
        )
    return provider_id


def _ai_do_espaco(slug: str) -> dict[str, Any]:
    """Os modelos em vigor nesta base, para a tela.

    Devolve o que ESTA VALENDO, nao o que foi escolhido: quando o provedor
    escolhido e apagado ou desativado, a base cai para o padrao da instalacao, e
    e esse que precisa aparecer -- com `from_space=false` dizendo de onde veio.
    """
    return {
        "embedding": providers.resolvido("embedding", slug),
        "chat": providers.resolvido("chat", slug),
    }


@app.put("/v1/spaces/{slug}/representations")
def set_space_representations(
    slug: str, payload: dict = Body(...), principal: Principal = Depends(require_write)
) -> dict[str, Any]:
    """Liga e desliga as REPRESENTACOES desta base.

    O `indice` nao entra: ele e a representacao de base e existe em todo Espaco
    (conceptual-model §2). Aceitar um payload que o desligue seria aceitar
    quebrar a base em silencio -- ela pararia de responder qualquer coisa, sem
    erro nenhum.

    Ligar uma representacao NAO a constroi para o que ja esta indexado: o
    fan-out da ingestao so acontece na entrada do documento. Reprocessar e o que
    fecha essa diferenca, e a tela diz isso.
    """
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="informe um objeto")

    conhecidas = set(representations.REPRESENTACOES) | set(representations.AUXILIARES)
    desconhecidas = set(payload) - conhecidas
    if desconhecidas:
        raise HTTPException(
            status_code=400,
            detail=(
                f"desconhecido: {', '.join(sorted(desconhecidas))}. "
                f"Use {', '.join(sorted(conhecidas))}"
            ),
        )

    with conn() as connection, connection.cursor() as cur:
        cur.execute("SELECT representations FROM space WHERE slug = %s AND active", (slug,))
        linha = cur.fetchone()
        if linha is None:
            raise HTTPException(status_code=404, detail=f"Espaço {slug} não encontrado")

        ativacao = representations.Ativacao.from_space(linha[0])
        for nome, ligada in payload.items():
            if not isinstance(ligada, bool):
                raise HTTPException(
                    status_code=400, detail=f"`{nome}` deve ser true ou false"
                )
            if nome in representations.AUXILIARES:
                if ligada:
                    ativacao.auxiliares.add(nome)
                else:
                    ativacao.auxiliares.discard(nome)
                continue
            if not representations.CATALOGO[nome].opcional:
                # Silencioso seria pior: o operador desmarcaria e a tela voltaria
                # marcada, sem dizer por que.
                if not ligada:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"a representação '{nome}' existe em todo Espaço e não pode ser "
                            "desligada: sem ela a base não responde nada"
                        ),
                    )
                continue
            if ligada:
                ativacao.ativas.add(nome)
            else:
                ativacao.ativas.discard(nome)

        cur.execute(
            "UPDATE space SET representations = %s WHERE slug = %s AND active",
            (jsonb(ativacao.to_dict()), slug),
        )
        connection.commit()

    log.info(
        "representacoes de %s -> %s (auxiliares: %s) (por %s)",
        slug, sorted(ativacao.ativas), sorted(ativacao.auxiliares), principal.describe(),
    )
    return {"space": slug, "representations": ativacao.to_dict()}


@app.put("/v1/spaces/{slug}/icon")
def set_space_icon(
    slug: str, payload: dict = Body(...), principal: Principal = Depends(require_write)
) -> dict[str, Any]:
    """A marca da base, para distinguir uma lista longa de relance.

    Tres formas, e a coluna guarda as tres como texto: vazio (a tela cai para a
    inicial do rotulo), `lucide:<Nome>` para um icone da biblioteca da
    interface, ou `data:image/...;base64,` para uma imagem enviada.

    A IMAGEM E REPROCESSADA AQUI, mesmo a tela ja reduzindo antes de enviar. O
    downscale do navegador evita subir 4 MB pela rede; ele nao e controle, e
    quem chama a API nao e obrigado a ser a nossa tela. Sem reduzir de novo, um
    `curl` com um PNG de 8000x8000 entraria na coluna e voltaria em TODA leitura
    de `/v1/spaces` -- a lista de bases passaria a custar megabytes, sem erro
    nenhum. Ver `icons.py` para o resto do porque.
    """
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="informe um objeto com `icon`")
    bruto = payload.get("icon", "")
    if not isinstance(bruto, str):
        raise HTTPException(status_code=400, detail='`icon` deve ser texto (use "" para tirar)')
    try:
        icone = icons.normalizar(bruto)
    except icons.IconeInvalido as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None

    with conn() as connection, connection.cursor() as cur:
        cur.execute("UPDATE space SET icon = %s WHERE slug = %s AND active", (icone, slug))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail=f"Espaço {slug} não encontrado")
        connection.commit()

    # O icone NAO vai para o log: uma imagem em base64 encheria a linha inteira
    # e o que interessa e quem mudou o que, nao os bytes.
    log.info("icone de %s -> %s (por %s)", slug,
             "imagem" if icone.startswith("data:") else repr(icone), principal.describe())
    return {"space": slug, "icon": icone}


@app.get("/v1/chunking-engines")
def chunking_engines(principal: Principal = Depends(current_principal)) -> dict[str, Any]:
    """Os motores de corte e os modos de ingestao, que sao outro eixo.

    Os dois vem na MESMA rota porque a tela e uma so, mas em chaves separadas: o
    motor decide onde cortar a prosa, o modo decide o que o pipeline faz com o
    documento antes disso. Ver `chunking.py` para por que nao viraram um enum
    unico.
    """
    return {
        "default": chunking.MOTOR_PADRAO,
        "default_enrichment": chunking.ENRIQUECIMENTO_PADRAO,
        # As REPRESENTACOES que um Espaco pode ativar. Conjunto, nao enum: a
        # especificacao (conceptual-model §2) diz que elas sao plugaveis e que
        # ligar ou desligar uma nao afeta as demais -- `indice + wiki` e o
        # conjunto com as duas, nao um terceiro valor. O `indice` vem com
        # `optional: false` porque nao ha como desliga-lo.
        "representations": representations.catalogo_para_tela(),
        # Auxiliares em chave separada: a tela precisa dizer que elas nao criam
        # conteudo, so abrem outro caminho ate o conteudo que ja existe.
        "auxiliaries": representations.catalogo_auxiliar_para_tela(),
        # O slot de ENRIQUECIMENTO DE CHUNK, interno a representacao-indice
        # (ingestion-pipeline.md §5 E4a, passo 2). Nao confundir com
        # representacao: este decide o que e prependado a cada trecho antes do
        # embedding, e roda DENTRO do indice.
        "enrichments": [
            {
                "id": "nenhum",
                "label": "Nenhum",
                "summary": "indexa o trecho como ele saiu do corte",
                "does": "nada é prependado; o texto indexado é o do documento",
                "cost": "nenhum",
                "needs_chat": False,
                "spec": "",
            },
            {
                "id": "conceito",
                "label": "Identidade do conceito",
                "summary": "põe tipo e título do documento na frente de cada trecho",
                "does": (
                    "resolve um conceito por documento — lido do frontmatter quando o arquivo já "
                    "vem escrito em OKF, derivado pelo modelo de chat quando não vem — e prepende "
                    "o tipo e o título a cada trecho antes do embedding, para o trecho ficar "
                    "autocontido. É a variante que a taxonomia chama de Contextual Chunk Headers"
                ),
                "cost": "uma chamada ao modelo de chat por documento que não vier escrito em OKF",
                "needs_chat": True,
                "spec": "GoogleCloudPlatform/knowledge-catalog · OKF v0.2",
                "default_types": list(okf.TIPOS_PADRAO),
                "generic_type": okf.TIPO_GENERICO,
            },
        ],
        "engines": [
            {
                "id": "markdown",
                "label": "Estrutura do documento",
                "lib": "LlamaIndex MarkdownNodeParser + SentenceSplitter",
                "cuts_by": "cabeçalhos, depois sentenças",
                "good_for": "manual, política, procedimento — documento com seções",
                "cost": "nenhum",
            },
            {
                "id": "sentence",
                "label": "Sentenças",
                "lib": "LlamaIndex SentenceSplitter",
                "cuts_by": "fronteira de sentença, ignorando a estrutura",
                "good_for": "texto corrido, ata, transcrição",
                "cost": "nenhum",
            },
            {
                "id": "semantic",
                "label": "Mudança de assunto",
                "lib": "LlamaIndex SemanticSplitterNodeParser",
                "cuts_by": "queda de similaridade entre sentenças vizinhas",
                "good_for": "texto sem formatação em que o assunto muda sem aviso",
                "cost": "embedding de cada sentença NA INGESTÃO — o único que gasta para decidir onde cortar",
            },
            {
                "id": "fixed",
                "label": "Tamanho fixo",
                "lib": "nenhuma — corte próprio",
                "cuts_by": "número de caracteres, com sobreposição",
                "good_for": "linha de base para comparar, e formato que confunde os outros",
                "cost": "nenhum",
            },
        ],
    }


@app.delete("/v1/spaces/{slug}")
def delete_space(slug: str, principal: Principal = Depends(require_write)) -> dict[str, Any]:
    removed = ingest.drop_space(slug)
    if not removed:
        raise HTTPException(status_code=404, detail=f"Espaco {slug} nao existe")
    return {"removed": slug}


# ── documentos ─────────────────────────────────────────────────────────────


@app.post("/v1/spaces/{slug}/documents")
async def upload_document(
    slug: str,
    file: UploadFile,
    wait: bool = Query(default=False),
    principal: Principal = Depends(require_write),
) -> JSONResponse:
    """Enfileira o arquivo e responde 202. Quem processa e `fila.py`, um por vez.

    Sincrono, dez arquivos grandes enviados juntos viravam dez conexoes de
    minutos: qualquer engasgo soltava a conexao, o cliente mandava o proximo e
    o pod acabava com dois docling juntos e morria por memoria. Enfileirado, a
    concorrencia deixa de depender de quem envia.

    `wait=true` mantem o contrato antigo para os scripts de carga: o arquivo
    passa pela MESMA fila, e a resposta so volta quando ele terminar.
    """
    data = await file.read()
    limit = settings.max_upload_mb * 1024 * 1024
    if len(data) > limit:
        raise HTTPException(
            status_code=413,
            detail=f"arquivo de {len(data) // 1048576} MB passa do limite de {settings.max_upload_mb} MB",
        )

    with conn() as connection, connection.cursor() as cur:
        cur.execute("SELECT 1 FROM space WHERE slug=%s AND active", (slug,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail=f"Espaco {slug} nao existe")

    nome = file.filename or "sem-nome"
    enfileirado = await run_in_threadpool(
        ingest.enfileirar, slug, nome, data, principal.describe()
    )
    del data
    fila.acordar()
    if not wait:
        return JSONResponse(enfileirado, status_code=202)

    run_id = enfileirado["run_id"]
    prazo = time.monotonic() + 3600
    while time.monotonic() < prazo:
        await asyncio.sleep(2)
        run = await run_in_threadpool(_ingest_run, run_id)
        if run and run["status"] not in ("queued", "running"):
            codigo = 200 if run["status"] in ("indexed", "skipped") else 422
            completo = fila.resultado(run_id) or {}
            # `status` do log primeiro: `skipped` diz mais que o `indexed` do
            # resultado, e os scripts leem o primeiro `status` da resposta.
            return JSONResponse({"status": run["status"], **completo, **run},
                                status_code=codigo)
    return JSONResponse({**enfileirado, "status": "running",
                         "detail": "ainda processando; acompanhe em /v1/ingest-runs"},
                        status_code=202)


def _ingest_run(run_id: int) -> dict[str, Any] | None:
    """Uma linha de `ingest_run`, com `status` primeiro (os scripts leem o primeiro)."""
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            SELECT status, id, space_slug, filename, document_id, extractor, pages,
                   figures, parents, children, embed_tokens, total_ms, error
              FROM ingest_run WHERE id = %s
            """,
            (run_id,),
        )
        r = cur.fetchone()
    if r is None:
        return None
    return {
        "status": r[0], "run_id": r[1], "space": r[2], "filename": r[3],
        "document_id": r[4], "extractor": r[5], "pages": r[6], "figures": r[7],
        "parents": r[8], "children": r[9], "embed_tokens": r[10], "total_ms": r[11],
        "already_indexed": r[0] == "skipped", "error": r[12],
    }


@app.delete("/v1/documents/{document_id}")
def delete_document(
    document_id: int,
    principal: Principal = Depends(require_write),
) -> dict[str, Any]:
    """Remove o documento: trechos, vetores, figuras, no do grafo e o bruto.

    O bruto sai por ultimo e a falha nele NAO desfaz o resto: um objeto orfao no
    bucket e barato, enquanto um documento meio removido -- fora da listagem mas
    ainda respondendo na busca -- e um vazamento.
    """
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            "SELECT space_slug, filename, raw_key FROM document WHERE id = %s",
            (document_id,),
        )
        row = cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail=f"documento {document_id} nao encontrado")
        space_slug, filename, raw_key = row

        cur.execute(
            "SELECT image_key FROM document_figure WHERE document_id = %s AND image_key <> ''",
            (document_id,),
        )
        chaves = [linha[0] for linha in cur.fetchall()]
        # chunk, chunk_embedding e document_figure caem por ON DELETE CASCADE.
        cur.execute("DELETE FROM document WHERE id = %s", (document_id,))
        connection.commit()

    graph.forget_document(document_id)

    perdidos = 0
    for chave in [raw_key, *chaves]:
        if not chave:
            continue
        try:
            storage.delete(chave)
        except Exception as exc:  # noqa: BLE001
            perdidos += 1
            log.warning("objeto %s nao removido: %s", chave, exc)

    log.info("documento %s (%s) removido por %s", document_id, filename, principal.describe())
    return {
        "removed": document_id, "filename": filename, "space": space_slug,
        "orphan_objects": perdidos,
    }


@app.post("/v1/documents/{document_id}/reprocess")
async def reprocess_document(
    document_id: int,
    principal: Principal = Depends(require_write),
) -> JSONResponse:
    """Reprocessa a partir do BRUTO guardado, sem reenviar o arquivo.

    E o caminho para dois casos reais: documento que falhou na extracao (e cujo
    conserto veio depois, numa versao nova do extrator) e documento indexado por
    um pipeline antigo -- OCR desligado, por exemplo. Em ambos o arquivo original
    esta intacto no object store; pedir de novo a quem enviou seria absurdo.
    """
    try:
        result = await run_in_threadpool(
            _reprocessar_um, document_id, principal.describe()
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None
    except _SemBruto as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    except _ObjectStoreIndisponivel as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from None
    return JSONResponse(result.to_dict(), status_code=200 if result.status == "indexed" else 422)


class _SemBruto(RuntimeError):
    pass


class _ObjectStoreIndisponivel(RuntimeError):
    pass


def _reprocessar_um(document_id: int, por_quem: str) -> ingest.IngestResult:
    """Reprocessa UM documento a partir do bruto. Sincrono, para rodar em thread.

    Compartilhado entre a rota de um documento e a de reprocessar o Espaco
    inteiro. Levanta excecoes proprias em vez de HTTPException porque tambem
    roda fora do ciclo de requisicao, onde HTTPException nao significa nada.
    """
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            "SELECT space_slug, filename, raw_key FROM document WHERE id = %s",
            (document_id,),
        )
        row = cur.fetchone()
    if row is None:
        raise LookupError(f"documento {document_id} nao encontrado")
    space_slug, filename, raw_key = row
    if not raw_key:
        raise _SemBruto("este documento nao tem bruto guardado; reenvie o arquivo")
    try:
        data = storage.get(raw_key)
    except Exception as exc:  # noqa: BLE001
        raise _ObjectStoreIndisponivel(f"object store: {exc}") from None

    # `force=True` no lugar de apagar antes.
    #
    # A versao anterior NAO e removida aqui. O `force` desliga o atalho de "sha
    # identico = ja indexado", e quem versiona passa a ser o caminho normal da
    # ingestao: desativa a antiga e insere a nova na MESMA transacao.
    #
    # A ordem importa e custou dado. Apagando antes, a falha do embedding (que
    # acontece depois do delete e antes do insert) deixava o documento
    # simplesmente inexistente: foi assim que os quatro documentos do Espaco
    # `juridico` desta instalacao desapareceram num reprocessamento com provedor
    # de IA mal configurado. Agora a falha deixa a versao antiga ativa.
    resultado = ingest.ingest_document(space_slug, filename, data, por_quem, force=True)

    # A versao antiga sai SO depois do sucesso, e e o delete que faz chunk,
    # embedding e figura dela cascatearem (ON DELETE CASCADE). Sem isto, cada
    # reprocessamento deixaria para tras o indice da versao anterior.
    if resultado.status == "indexed" and resultado.document_id != document_id:
        with conn() as connection, connection.cursor() as cur:
            cur.execute("DELETE FROM document WHERE id = %s", (document_id,))
            connection.commit()
        graph.forget_document(document_id)

    return resultado


# ── reprocessamento do Espaco inteiro ──────────────────────────────────────
#
# POR QUE NAO E SINCRONO, como o de um documento so: reprocessar o Espaco `rh`
# desta base leva cerca de uma HORA (43 documentos, com OCR). O ingress corta em
# 1800s e o cliente muito antes, entao uma rota que so devolvesse no fim
# entregaria timeout com o trabalho ainda rodando -- exatamente a confusao que
# ja aconteceu aqui com a ingestao de um PDF de 13,5 min.
#
# Entao: a rota DISPARA e devolve na hora. O progresso e consultavel, e cada
# documento continua aparecendo no log de ingestao (`ingest_run`) como qualquer
# outro, porque passa pelo mesmo caminho.
#
# Uma thread, e nao BackgroundTasks do FastAPI: o trabalho e sincrono e pesado
# (docling, OCR, torch) e ficaria ocupando um worker do threadpool que atende
# requisicao. Serial de proposito -- em paralelo, dois PDFs grandes ao mesmo
# tempo ja derrubaram o pod por falta de memoria.

# Progresso por Espaco, EM MEMORIA. Some se o pod reiniciar, e isso e o
# comportamento certo: a thread morre com ele, entao um progresso persistido
# ficaria eternamente "rodando" sem ninguem trabalhando.
#
# ⚠ A trava contra duas execucoes tambem e por processo. Ela basta porque o
# kb-api roda com UMA replica (ver o comentario de `replicaCount` no overlay,
# que amarra isso ao PVC RWO do storage). Com mais replicas, duas rodadas
# concorrentes voltariam a ser possiveis e a trava teria de ir para o banco.
_reprocessos: dict[str, dict[str, Any]] = {}
_trava_reprocessos = threading.Lock()


def _documentos_para_reprocessar(slug: str, so_desalinhados: bool) -> list[tuple[int, str]]:
    """Ids e nomes dos documentos elegiveis, em ordem estavel.

    Documento sem `raw_key` fica FORA: nao ha bruto para reprocessar, e incluir
    apenas para falhar poluiria o log com erro que ninguem pode consertar.
    """
    with conn() as connection, connection.cursor() as cur:
        cur.execute("SELECT chunking FROM space WHERE slug = %s AND active", (slug,))
        linha = cur.fetchone()
        if linha is None:
            raise HTTPException(status_code=404, detail=f"Espaco {slug} nao encontrado")
        config_atual = chunking.ChunkConfig.from_space(linha[0])

        sql = (
            "SELECT id, filename FROM document "
            "WHERE space_slug = %s AND active AND raw_key <> ''"
        )
        parametros: list[Any] = [slug]
        if so_desalinhados:
            # MOTOR **e** ENRIQUECIMENTO. Comparar so o motor deixava passar a
            # troca de variante, que muda mais do que a fronteira do corte: ela
            # muda o TEXTO INDEXADO (na variante `conceito` a identidade do
            # conceito entra na frente de cada trecho). Uma base com as duas
            # variantes convivendo tem metade dos trechos respondendo uma
            # pergunta e a outra metade nao -- e sem esta comparacao, nada na
            # tela dizia por que.
            #
            # Coluna vazia = indexado antes de ela existir: desconhecido conta
            # como desalinhado, nunca como alinhado.
            sql += " AND (chunk_engine IS DISTINCT FROM %s OR chunk_enrichment IS DISTINCT FROM %s)"
            parametros.append(config_atual.engine)
            parametros.append(config_atual.enrichment)
        sql += " ORDER BY size_bytes ASC, id ASC"
        cur.execute(sql, tuple(parametros))
        return [(linha[0], linha[1]) for linha in cur.fetchall()]


def _rodar_reprocesso(slug: str, documentos: list[tuple[int, str]], por_quem: str) -> None:
    """Laco de reprocessamento, executado na thread."""
    estado = _reprocessos[slug]
    for document_id, filename in documentos:
        if estado.get("cancel"):
            estado["status"] = "cancelado"
            break
        estado["current"] = filename
        try:
            resultado = _reprocessar_um(document_id, por_quem)
            if resultado.status == "indexed":
                estado["done"] += 1
            else:
                estado["failed"] += 1
                estado["errors"].append(f"{filename}: {resultado.error[:200]}")
        except Exception as exc:  # noqa: BLE001
            # Um documento que falha NAO para a fila. Era o comportamento
            # oposto do desejado: o primeiro PDF problematico deixaria os
            # outros 42 sem reprocessar.
            estado["failed"] += 1
            estado["errors"].append(f"{filename}: {str(exc)[:200]}")
            log.warning("reprocesso de %s falhou em %s: %s", slug, filename, exc)
    else:
        estado["status"] = "concluido"
    estado["current"] = ""
    estado["finished_at"] = datetime.now(UTC).isoformat()
    log.info(
        "reprocesso de %s terminou: %s ok, %s falhas (%s)",
        slug, estado["done"], estado["failed"], estado["status"],
    )


@app.post("/v1/spaces/{slug}/reprocess")
def start_space_reprocess(
    slug: str,
    payload: dict = Body(default={}),
    principal: Principal = Depends(require_write),
) -> dict[str, Any]:
    """Reprocessa os documentos do Espaco com o motor de corte ATUAL.

    `only_outdated` (padrao `true`) limita aos documentos cortados por outro
    motor. E o caso comum depois de trocar o motor na tela, e economiza a hora
    inteira quando so alguns ficaram para tras.
    """
    so_desalinhados = payload.get("only_outdated", True) is not False
    documentos = _documentos_para_reprocessar(slug, so_desalinhados)

    with _trava_reprocessos:
        atual = _reprocessos.get(slug)
        if atual and atual["status"] == "rodando":
            raise HTTPException(
                status_code=409,
                detail=(
                    f"ja ha um reprocessamento em andamento neste Espaco "
                    f"({atual['done'] + atual['failed']} de {atual['total']})."
                ),
            )
        if not documentos:
            return {
                "space": slug,
                "started": False,
                "total": 0,
                "reason": (
                    "nenhum documento desalinhado do motor atual"
                    if so_desalinhados
                    else "nenhum documento com bruto guardado"
                ),
            }
        _reprocessos[slug] = {
            "space": slug,
            "status": "rodando",
            "total": len(documentos),
            "done": 0,
            "failed": 0,
            "current": "",
            "errors": [],
            "only_outdated": so_desalinhados,
            "started_at": datetime.now(UTC).isoformat(),
            "finished_at": None,
            "started_by": principal.describe(),
            "cancel": False,
        }

    # `daemon=True`: um reprocesso pendente nao deve segurar o encerramento do
    # pod. O trabalho ja feito esta gravado, e o que faltou aparece como
    # desalinhado na tela.
    threading.Thread(
        target=_rodar_reprocesso,
        args=(slug, documentos, principal.describe()),
        name=f"reprocesso-{slug}",
        daemon=True,
    ).start()

    log.info(
        "reprocesso de %s iniciado: %s documentos (por %s)",
        slug, len(documentos), principal.describe(),
    )
    return {"space": slug, "started": True, "total": len(documentos)}


@app.get("/v1/spaces/{slug}/reprocess")
def space_reprocess_status(
    slug: str, principal: Principal = Depends(require_write)
) -> dict[str, Any]:
    """Progresso do reprocessamento, e quantos estao desalinhados agora."""
    estado = _reprocessos.get(slug)
    desalinhados = len(_documentos_para_reprocessar(slug, True))
    if estado is None:
        return {"space": slug, "status": "parado", "outdated": desalinhados}
    # `cancel` e detalhe interno da thread; nao vaza para a tela.
    return {**{k: v for k, v in estado.items() if k != "cancel"}, "outdated": desalinhados}


@app.delete("/v1/spaces/{slug}/reprocess")
def cancel_space_reprocess(
    slug: str, principal: Principal = Depends(require_write)
) -> dict[str, Any]:
    """Pede o cancelamento. O documento EM CURSO termina.

    Interromper no meio de uma ingestao deixaria o documento apagado (o
    reprocessamento remove a versao antiga antes de gravar a nova) e sem
    substituto. Entao o cancelamento vale a partir do proximo da fila.
    """
    estado = _reprocessos.get(slug)
    if estado is None or estado["status"] != "rodando":
        raise HTTPException(status_code=409, detail="nao ha reprocessamento em andamento")
    estado["cancel"] = True
    log.info("reprocesso de %s: cancelamento pedido por %s", slug, principal.describe())
    return {"space": slug, "cancelling": True, "current": estado["current"]}


@app.get("/v1/ingest-runs")
def list_ingest_runs(
    limit: int = Query(default=50, le=1000),
    offset: int = Query(default=0, ge=0),
    space: str = Query(default=""),
    status: str = Query(default=""),
    principal: Principal = Depends(require_write),
) -> dict[str, Any]:
    """O que esta processando agora e o que processou antes, com o tempo.

    A ingestao e sincrona: um PDF grande com OCR fica minutos sem dar sinal. Sem
    esta lista, "esta travado?" nao tem resposta -- e "a ingestao esta lenta" nao
    vira "este arquivo leva 13 min e os outros levam 20 s".

    TODOS OS ARQUIVOS, E NAO OS ULTIMOS QUARENTA

    A tela mostrava um teto fixo, e numa carga de 273 arquivos isso significava
    que 233 deles nao existiam para quem estava olhando -- justamente na hora em
    que o log serve para alguma coisa. Agora ela pagina, e o `total` diz de
    quantos: sem ele "40 linhas" e indistinguivel de "so houve 40".

    O filtro vai no BANCO e nao na tela pelo mesmo motivo do corte do grafo:
    filtrar depois de cortar mostraria as falhas que por acaso caiam na primeira
    pagina.
    """
    condicoes: list[str] = []
    parametros: list[Any] = []
    if space:
        condicoes.append("space_slug = %s")
        parametros.append(space)
    if status:
        condicoes.append("status = %s")
        parametros.append(status)
    onde = f"WHERE {' AND '.join(condicoes)}" if condicoes else ""

    with conn() as connection, connection.cursor() as cur:
        cur.execute(f"SELECT count(*) FROM ingest_run {onde}", parametros)
        total = (cur.fetchone() or [0])[0]
        cur.execute(
            f"""
            SELECT id, space_slug, filename, document_id, status, extractor,
                   size_bytes, pages, figures, parents, children, embed_tokens,
                   total_ms, error, principal, started_at, finished_at,
                   EXTRACT(EPOCH FROM (now() - started_at)) * 1000,
                   chunk_engine, stage, progress, stage_detail, attempts, queued_at
              FROM ingest_run
              {onde}
             ORDER BY started_at DESC
             LIMIT %s OFFSET %s
            """,
            [*parametros, limit, offset],
        )
        linhas = cur.fetchall()
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "runs": [
            {
                "id": r[0], "space": r[1], "filename": r[2], "document_id": r[3],
                "status": r[4], "extractor": r[5], "size_bytes": r[6], "pages": r[7],
                "figures": r[8], "parents": r[9], "children": r[10],
                "embed_tokens": r[11],
                # Enquanto roda, `total_ms` ainda e zero: o tempo util e o
                # relogio desde o inicio, senao a linha em andamento aparece
                # como "0 ms" e parece concluida.
                "total_ms": r[12] if r[4] != "running" else int(r[17] or 0),
                "chunk_engine": r[18] or "",
                "stage": r[19] or "", "progress": float(r[20] or 0),
                "stage_detail": r[21] or "", "attempts": r[22] or 0,
                "queued_at": r[23].isoformat() if r[23] else None,
                "error": r[13], "principal": r[14],
                "started_at": r[15].isoformat() if r[15] else None,
                "finished_at": r[16].isoformat() if r[16] else None,
            }
            for r in linhas
        ]
    }


_COLUNAS_FILA = """
    id, space_slug, filename, status, size_bytes, stage, progress, stage_detail,
    attempts, principal, queued_at, started_at, finished_at, total_ms, error,
    document_id, extractor, pages, children,
    EXTRACT(EPOCH FROM (now() - started_at)) * 1000
"""


def _linha_da_fila(r: tuple) -> dict[str, Any]:
    em_curso = r[3] == "running"
    return {
        "id": r[0], "space": r[1], "filename": r[2], "status": r[3],
        "size_bytes": r[4], "stage": r[5] or "", "progress": float(r[6] or 0),
        "stage_detail": r[7] or "", "attempts": r[8] or 0, "principal": r[9],
        "queued_at": r[10].isoformat() if r[10] else None,
        "started_at": r[11].isoformat() if r[11] else None,
        "finished_at": r[12].isoformat() if r[12] else None,
        # Em curso, o `total_ms` ainda e zero: o util e o relogio desde o inicio.
        "total_ms": int(r[19] or 0) if em_curso else (r[13] or 0),
        "error": r[14] or "", "document_id": r[15], "extractor": r[16] or "",
        "pages": r[17] or 0, "children": r[18] or 0,
    }


@app.get("/v1/ingest-queue")
def ingest_queue(
    recent: int = Query(default=30, le=200),
    principal: Principal = Depends(require_write),
) -> dict[str, Any]:
    """A fila de ingestao inteira, de todas as bases: o que roda, o que espera,
    e o que acabou de sair.

    E a tela da fila que le isto. Separado de `/v1/ingest-runs` porque a
    pergunta e outra: la e o historico paginado de uma base; aqui e "o que o
    servidor esta fazendo agora e o que vem depois", na ORDEM em que o worker
    vai pegar (`id` crescente), que e o que da sentido a "posicao na fila".
    """
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            f"SELECT {_COLUNAS_FILA} FROM ingest_run"
            " WHERE status IN ('running', 'queued')"
            " ORDER BY (status = 'running') DESC, id"
        )
        ativos = [_linha_da_fila(r) for r in cur.fetchall()]
        cur.execute(
            f"SELECT {_COLUNAS_FILA} FROM ingest_run"
            " WHERE status NOT IN ('running', 'queued')"
            " ORDER BY coalesce(finished_at, started_at) DESC LIMIT %s",
            (recent,),
        )
        recentes = [_linha_da_fila(r) for r in cur.fetchall()]
        cur.execute(
            "SELECT status, count(*) FROM ingest_run"
            " WHERE coalesce(finished_at, started_at) > now() - interval '24 hours'"
            "    OR status IN ('running', 'queued')"
            " GROUP BY status"
        )
        contagem = {status: int(n) for status, n in cur.fetchall()}
    posicao = 0
    for linha in ativos:
        if linha["status"] == "queued":
            posicao += 1
            linha["position"] = posicao
    return {"active": ativos, "recent": recentes, "counts_24h": contagem}


@app.get("/v1/ingest-runs/{run_id}/events")
def ingest_run_events(run_id: int, principal: Principal = Depends(require_write)) -> dict[str, Any]:
    """O log de um documento: cada troca de etapa e cada marco, em ordem."""
    with conn() as connection, connection.cursor() as cur:
        cur.execute(f"SELECT {_COLUNAS_FILA} FROM ingest_run WHERE id = %s", (run_id,))
        linha = cur.fetchone()
        if linha is None:
            raise HTTPException(status_code=404, detail=f"execução {run_id} não encontrada")
        cur.execute(
            "SELECT at, stage, progress, message FROM ingest_event"
            " WHERE run_id = %s ORDER BY id",
            (run_id,),
        )
        eventos = [
            {"at": r[0].isoformat(), "stage": r[1], "progress": r[2], "message": r[3]}
            for r in cur.fetchall()
        ]
    return {"run": _linha_da_fila(linha), "events": eventos}


@app.post("/v1/ingest-runs/{run_id}/cancel")
def cancel_ingest_run(run_id: int, principal: Principal = Depends(require_write)) -> dict[str, Any]:
    """Tira da fila um arquivo que ainda nao comecou. O que ja roda, termina."""
    if not fila.cancelar(run_id):
        raise HTTPException(
            status_code=409,
            detail="só dá para cancelar o que ainda está na fila; este já começou ou terminou",
        )
    return {"id": run_id, "status": "cancelled"}


@app.delete("/v1/ingest-runs")
def clear_ingest_runs(principal: Principal = Depends(require_write)) -> dict[str, Any]:
    """Limpa o log, preservando o que esta em andamento."""
    with conn() as connection, connection.cursor() as cur:
        cur.execute("DELETE FROM ingest_run WHERE status NOT IN ('running', 'queued')")
        removidas = cur.rowcount
        connection.commit()
    return {"removed": removidas}


@app.get("/v1/documents/{document_id}")
def get_document(
    document_id: int,
    include_related: bool = Query(default=True),
    principal: Principal = Depends(current_principal),
) -> dict[str, Any]:
    document = search.fetch_document(document_id, principal.allowed_spaces())
    if document is None:
        raise HTTPException(status_code=404, detail=f"documento {document_id} nao encontrado")
    if include_related:
        document["related"] = graph.related(document_id, principal.allowed_spaces())
    return document


@app.get("/v1/graph/schema")
def graph_schema(principal: Principal = Depends(current_principal)) -> dict[str, Any]:
    """A forma do grafo: rotulos e tipos de aresta, com contagem.

    Responde "que forma tem este grafo?" sem trazer um no sequer -- e o mapa que
    se olha antes de abrir a instancia.
    """
    return graph.esquema(principal.allowed_spaces())


@app.get("/v1/graph")
def graph_instance(
    limit: int = Query(default=300, ge=10, le=graph.MAX_NOS),
    focus: str = Query(default=""),
    space: str = Query(default=""),
    labels: str = Query(default=""),
    principal: Principal = Depends(current_principal),
) -> dict[str, Any]:
    """O grafo para desenhar: nos e arestas, dentro do escopo do chamador.

    ⚠ O escopo vem do `Principal`, e o parametro `space` so RESTRINGE (ADR-0005).
    Pedir um Espaco nao alcancavel devolve vazio, nao erro -- erro confirmaria
    que ele existe. Um grafo desenhado sem este filtro mostraria titulo de
    documento e nome de entidade de Espaco proibido: vazamento por imagem, que
    nenhuma outra rota permitiria.
    """
    alcancaveis = principal.allowed_spaces()
    if space:
        escopo = [space] if (alcancaveis is None or space in alcancaveis) else []
    else:
        escopo = alcancaveis
    if escopo is not None and not escopo:
        return {"enabled": True, "reachable": True, "nodes": [], "edges": [],
                "total": 0, "truncated": False}
    # `labels` restringe o TIPO de no desenhado, e nao tem nada a ver com
    # escopo: e so o que cabe na figura. Filtrar aqui e nao na tela importa
    # porque o corte por grau vem antes -- numa base onde 93% dos nos sao termo,
    # desmarcar "Term" no navegador deixaria uma dezena de documentos.
    rotulos = [r.strip() for r in labels.split(",") if r.strip()]
    return graph.instancia(escopo, limite=limit, foco=focus.strip(), rotulos=rotulos)


@app.get("/v1/wiki/pages/{page_id}")
def get_wiki_page(
    page_id: int, principal: Principal = Depends(current_principal)
) -> dict[str, Any]:
    """Uma pagina da wiki inteira, com as referencias dela (BUS-07).

    O `fetch` da especificacao e por id e cobre os dois tipos de item: documento
    canonico (`/v1/documents/{id}`) e pagina da wiki (esta rota). Junto com o
    conteudo vem a navegacao: os links cruzados para outras paginas e os
    documentos de onde a pagina foi destilada.

    O filtro de Espaco vale aqui igual a busca: pagina fora do escopo do
    chamador nao e lida nem aparece como referencia navegavel.
    """
    pagina = wiki.buscar_pagina(page_id, principal.allowed_spaces())
    if pagina is None:
        raise HTTPException(status_code=404, detail=f"página {page_id} não encontrada")
    return pagina


@app.get("/v1/spaces/{slug}/wiki")
def list_wiki_pages(slug: str, principal: Principal = Depends(current_principal)) -> dict[str, Any]:
    """O indice da wiki de um Espaco: o ponto de partida da navegacao."""
    allowed = principal.allowed_spaces()
    if allowed is not None and slug not in allowed:
        # Mesma resposta de "nao existe": nao revela Espaco proibido.
        raise HTTPException(status_code=404, detail=f"Espaço {slug} não encontrado")
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            SELECT p.id, p.path, p.type, p.title, p.description, p.words, p.updated_at,
                   (SELECT count(*) FROM wiki_page_source s WHERE s.page_id = p.id)
              FROM wiki_page p
             WHERE p.space_slug = %s
             ORDER BY p.path
            """,
            (slug,),
        )
        paginas = [
            {
                "id": r[0], "path": r[1], "type": r[2], "title": r[3], "description": r[4],
                "words": r[5],
                "updated_at": r[6].isoformat() if r[6] else None,
                "sources": r[7],
                # O contrato de destilacao e 200 a 800 palavras. Pagina fora da
                # faixa continua valendo, e fica marcada para o lint da wiki --
                # recusar seria jogar conhecimento fora.
                "out_of_contract": not (wiki.PALAVRAS_MIN <= (r[5] or 0) <= wiki.PALAVRAS_MAX),
            }
            for r in cur.fetchall()
        ]
    return {"space": slug, "pages": paginas, "contract": {
        "min_words": wiki.PALAVRAS_MIN, "max_words": wiki.PALAVRAS_MAX,
    }}


def _valor_de_cabecalho(texto: str) -> str:
    """Texto que cabe num cabecalho HTTP, com aspas escapadas.

    Mesmo motivo do `_content_disposition`: cabecalho e latin-1, e o que nao
    couber vira `UnicodeEncodeError` na construcao da resposta, ou seja **500**.

    Aqui e pior que no download, porque parte do texto vem DE FORA: o
    `issuer inesperado: {issuer}` le o issuer do proprio token. Um token
    malformado com caractere fora do latin-1 transformaria o 401 num 500 -- e o
    401 desta rota e o que carrega o `WWW-Authenticate` que dispara a descoberta
    no cliente MCP. Perder o 401 e perder o "clique em Entrar".

    A aspa tambem sai: ela fecharia o `error_description="..."` no meio e o
    resto viraria parametro solto.
    """
    limpo = unicodedata.normalize("NFKD", texto).encode("latin-1", "ignore").decode("latin-1")
    return limpo.replace('"', "'").replace("\\", "").replace("\n", " ").replace("\r", " ")


def _content_disposition(filename: str) -> str:
    """`Content-Disposition` que aguenta nome de arquivo fora do latin-1.

    ⚠ CABECALHO HTTP E CODIFICADO EM LATIN-1, e o Starlette levanta
    `UnicodeEncodeError` na CONSTRUCAO da resposta -- que vira **HTTP 500**, sem
    nada no erro dizendo que o problema e o nome do arquivo.

    Isso quase nao aparece em portugues, e foi por isso que passou despercebido:
    `Í` e `Ç` CABEM em latin-1, entao `POLÍTICA DE AVALIAÇÃO.docx` baixa normal.
    O que nao cabe e a pontuacao tipografica que o editor de texto gera sozinho
    -- travessao (U+2013), aspas curvas, reticencias. `Anexo 1 – Resumo de
    Contratos.pdf` derrubava o download enquanto todos os vizinhos acentuados
    funcionavam.

    A saida e a RFC 6266: `filename` em ASCII para quem e antigo, e `filename*`
    em UTF-8 percent-encoded para quem entende -- que e todo navegador atual.
    """
    ascii_seguro = (
        unicodedata.normalize("NFKD", filename)
        .encode("ascii", "ignore")
        .decode("ascii")
        # Aspas e barra invertida fechariam o `filename="..."` no meio, e o resto
        # do nome viraria parametro solto do cabecalho.
        .replace('"', "")
        .replace("\\", "")
        .strip()
    ) or "documento"
    return (
        f'attachment; filename="{ascii_seguro}"; '
        f"filename*=UTF-8''{quote(filename, safe='')}"
    )


@app.get("/v1/documents/{document_id}/raw")
def get_document_raw(
    document_id: int,
    principal: Principal = Depends(current_principal),
):
    """Arquivo ORIGINAL, como entrou (ING-02).

    Existe para a auditoria poder confrontar o canonico com a fonte: sem isso o
    canonico e a palavra final, e o requisito pede o bruto preservado
    justamente para nao ser.
    """
    from fastapi.responses import Response

    document = search.fetch_document(document_id, principal.allowed_spaces())
    if document is None:
        raise HTTPException(status_code=404, detail=f"documento {document_id} nao encontrado")
    with conn() as connection, connection.cursor() as cur:
        cur.execute("SELECT raw_key FROM document WHERE id = %s", (document_id,))
        row = cur.fetchone()
    if not row or not row[0]:
        raise HTTPException(status_code=404, detail="este documento nao tem bruto guardado")
    try:
        data = storage.get(row[0])
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"object store: {exc}") from None
    return Response(
        content=data,
        media_type=document.get("mime") or "application/octet-stream",
        headers={"Content-Disposition": _content_disposition(document["filename"])},
    )


@app.get("/v1/spaces/{slug}/documents")
def list_documents(slug: str, principal: Principal = Depends(current_principal)) -> dict[str, Any]:
    allowed = principal.allowed_spaces()
    if allowed is not None and slug not in allowed:
        # Mesma resposta de "nao existe": nao revela Espaco proibido.
        raise HTTPException(status_code=404, detail=f"Espaco {slug} nao encontrado")
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            SELECT d.id, d.filename, d.title, d.extractor, d.status, d.version,
                   d.size_bytes, d.error, d.indexed_at, d.pages, d.mime,
                   (SELECT count(*) FROM document_figure f WHERE f.document_id = d.id),
                   (SELECT count(*) FROM chunk c
                     WHERE c.document_id = d.id AND c.parent_id IS NOT NULL),
                   d.chunk_engine, d.okf->>'type', d.chunk_enrichment
              FROM document d
             WHERE d.space_slug = %s AND d.active
             ORDER BY d.filename
            """,
            (slug,),
        )
        rows = cur.fetchall()
    return {
        "space": slug,
        "documents": [
            {
                "id": row[0], "filename": row[1], "title": row[2],
                "extractor": row[3], "status": row[4], "version": row[5],
                "size_bytes": row[6], "error": row[7],
                "indexed_at": row[8].isoformat() if row[8] else None,
                "pages": row[9] or 0, "mime": row[10] or "",
                "figures": row[11], "chunks": row[12],
                "chunk_engine": row[13] or "",
                "okf_type": row[14] or "",
                "chunk_enrichment": row[15] or "",
            }
            for row in rows
        ],
    }


# ── figuras ────────────────────────────────────────────────────────────────


@app.get("/v1/documents/{document_id}/figures")
def list_figures(
    document_id: int,
    principal: Principal = Depends(current_principal),
) -> dict[str, Any]:
    """Figuras do documento com o texto que o OCR leu.

    A permissao passa pelo mesmo `fetch_document`: figura e conteudo do
    documento, e listar figura de Espaco proibido vazaria por outra porta.
    """
    if search.fetch_document(document_id, principal.allowed_spaces()) is None:
        raise HTTPException(status_code=404, detail=f"documento {document_id} nao encontrado")
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            SELECT ref, page, caption, ocr_text, image_key, bytes
              FROM document_figure
             WHERE document_id = %s
             ORDER BY id
            """,
            (document_id,),
        )
        rows = cur.fetchall()
    return {
        "document_id": document_id,
        "figures": [
            {
                "ref": row[0], "page": row[1], "caption": row[2],
                "ocr_text": row[3], "has_image": bool(row[4]), "bytes": row[5],
            }
            for row in rows
        ],
    }


@app.get("/v1/documents/{document_id}/figures/{ref}/image")
def get_figure_image(
    document_id: int,
    ref: str,
    principal: Principal = Depends(current_principal),
):
    from fastapi.responses import Response

    if search.fetch_document(document_id, principal.allowed_spaces()) is None:
        raise HTTPException(status_code=404, detail=f"documento {document_id} nao encontrado")
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            "SELECT image_key FROM document_figure WHERE document_id=%s AND ref=%s",
            (document_id, ref),
        )
        row = cur.fetchone()
    if not row or not row[0]:
        raise HTTPException(status_code=404, detail="figura sem imagem guardada")
    try:
        data = storage.get(row[0])
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"object store: {exc}") from None
    # Cache longo: a figura e derivada de um bruto imutavel e a chave inclui o
    # sha do arquivo, entao ela nunca muda de conteudo sob a mesma URL.
    return Response(
        content=data,
        media_type="image/png",
        headers={"Cache-Control": "private, max-age=86400"},
    )


# ── localizacao de um trecho no original ───────────────────────────────────


@app.get("/v1/chunks/{chunk_id}/locate")
def locate_chunk(
    chunk_id: int,
    principal: Principal = Depends(current_principal),
) -> dict[str, Any]:
    """Onde este trecho esta no arquivo original.

    Devolve o documento, a pagina e o texto do trecho. A UI usa o texto para
    achar e destacar a passagem na camada de texto do PDF -- a pagina sozinha
    ainda deixa a pessoa procurando com o olho.
    """
    allowed = principal.allowed_spaces()
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            SELECT c.id, c.document_id, c.space_slug, c.content, c.page, c.char_start,
                   c.parent_id, d.filename, d.title, d.mime, d.pages
              FROM chunk c
              JOIN document d ON d.id = c.document_id AND d.active
             WHERE c.id = %s
               AND (%s::text[] IS NULL OR c.space_slug = ANY(%s::text[]))
            """,
            (chunk_id, allowed, allowed),
        )
        row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"trecho {chunk_id} nao encontrado")
    return {
        "chunk_id": row[0],
        "document_id": row[1],
        "space": row[2],
        "content": row[3],
        "page": row[4],
        "char_start": row[5],
        "is_parent": row[6] is None,
        "filename": row[7],
        "title": row[8],
        "mime": row[9],
        "document_pages": row[10] or 0,
    }


# ── permissao: quem alcanca o que (WEB-01) ─────────────────────────────────

GRANT_TYPES = {"group", "role", "entra_oid", "email", "public"}


# ── avaliacao offline: dataset golden e benchmark (FUN-07) ─────────────────
#
# ⚠ TODAS SAO `require_write`, e a escolha e deliberada. Gerar perguntas e rodar
# uma execucao GASTAM IA -- uma execucao completa de cinquenta perguntas custa
# centenas de chamadas ao provedor. Deixar isso atras de qualquer identidade
# autenticada seria deixar a conta de IA aberta. Ler resultado tambem e
# administracao: o resultado contem trechos dos documentos, e quem le precisa
# alcancar a base do mesmo jeito que na busca.

_STATUS_PERGUNTA = {"rascunho", "aprovada", "descartada"}


def _espaco_alcancavel(slug: str, principal: Principal) -> None:
    """Recusa Espaco que o chamador nao alcanca OU que nao existe.

    Inalcancavel e inexistente respondem IGUAL (ADR-0005): um 403 dizendo
    "sem permissao para o Espaco X" entregaria que X existe.

    A checagem de existencia nao e zelo: para o administrador, `allowed_spaces()`
    devolve `None` (alcanca tudo) e o filtro acima nao roda -- entao um slug
    errado seguia ate o INSERT e voltava como violacao de chave estrangeira,
    HTTP 500. Medido ao cadastrar pergunta num Espaco que a limpeza do e2e tinha
    acabado de remover.
    """
    alcancaveis = principal.allowed_spaces()
    if alcancaveis is not None and slug not in alcancaveis:
        raise HTTPException(status_code=404, detail=f"Espaço {slug} não encontrado")
    with conn() as connection, connection.cursor() as cur:
        cur.execute("SELECT 1 FROM space WHERE slug = %s AND active", (slug,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail=f"Espaço {slug} não encontrado")


@app.get("/v1/spaces/{slug}/benchmark/questions")
def list_benchmark_questions(
    slug: str,
    status: str = Query(default=""),
    principal: Principal = Depends(require_write),
) -> dict[str, Any]:
    """O dataset golden desta base."""
    _espaco_alcancavel(slug, principal)
    condicao = " AND q.status = %s" if status else ""
    parametros: list[Any] = [slug] + ([status] if status else [])
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            f"""
            SELECT q.id, q.question, q.reference, q.document_id, q.origin, q.status,
                   q.created_by, q.created_at, d.filename, d.title, q.strategy, q.kind
              FROM benchmark_question q
              LEFT JOIN document d ON d.id = q.document_id
             WHERE q.space_slug = %s{condicao}
             ORDER BY q.status, q.id DESC
            """,
            parametros,
        )
        linhas = cur.fetchall()
    return {
        "space": slug,
        "questions": [
            {"id": r[0], "question": r[1], "reference": r[2], "document_id": r[3],
             "origin": r[4], "status": r[5], "created_by": r[6],
             "created_at": r[7].isoformat() if r[7] else None,
             "filename": r[8], "title": r[9], "strategy": r[10], "kind": r[11]}
            for r in linhas
        ],
    }


@app.post("/v1/spaces/{slug}/benchmark/questions")
def create_benchmark_question(
    slug: str, payload: dict = Body(...), principal: Principal = Depends(require_write)
) -> dict[str, Any]:
    """Cadastra uma pergunta a mao. Nasce APROVADA: quem escreveu ja curou."""
    _espaco_alcancavel(slug, principal)
    pergunta = str(payload.get("question") or "").strip()
    if not pergunta:
        raise HTTPException(status_code=400, detail="`question` é obrigatório")
    try:
        estrategia, tipo = benchmark.classificar(payload.get("strategy"), payload.get("kind"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            INSERT INTO benchmark_question
                (space_slug, question, reference, origin, status, created_by, strategy, kind)
            VALUES (%s, %s, %s, 'manual', 'aprovada', %s, %s, %s)
            RETURNING id
            """,
            (slug, pergunta, str(payload.get("reference") or "").strip(),
             principal.describe(), estrategia, tipo),
        )
        novo_id = cur.fetchone()[0]
        connection.commit()
    return {"id": novo_id, "space": slug, "status": "aprovada",
            "strategy": estrategia, "kind": tipo}


@app.put("/v1/benchmark/questions/{question_id}")
def update_benchmark_question(
    question_id: int, payload: dict = Body(...),
    principal: Principal = Depends(require_write),
) -> dict[str, Any]:
    """Aprova, descarta ou corrige uma pergunta.

    E aqui que mora a "selecao humana" que a especificacao pede: a pergunta
    gerada nasce `rascunho` e so entra numa execucao depois de passar por aqui.
    """
    campos: list[str] = []
    valores: list[Any] = []
    if "status" in payload:
        status = str(payload["status"])
        if status not in _STATUS_PERGUNTA:
            raise HTTPException(
                status_code=400,
                detail=f"status desconhecido: {status}. Use {', '.join(sorted(_STATUS_PERGUNTA))}",
            )
        campos.append("status = %s")
        valores.append(status)
    for chave in ("question", "reference"):
        if chave in payload:
            campos.append(f"{chave} = %s")
            valores.append(str(payload[chave] or "").strip())
    if not campos:
        raise HTTPException(status_code=400, detail="nada para alterar")

    with conn() as connection, connection.cursor() as cur:
        cur.execute("SELECT space_slug FROM benchmark_question WHERE id = %s", (question_id,))
        linha = cur.fetchone()
        if linha is None:
            raise HTTPException(status_code=404, detail=f"pergunta {question_id} não encontrada")
        _espaco_alcancavel(linha[0], principal)
        cur.execute(
            f"UPDATE benchmark_question SET {', '.join(campos)} WHERE id = %s",
            [*valores, question_id],
        )
        connection.commit()
    return {"id": question_id, "updated": True}


@app.delete("/v1/benchmark/questions/{question_id}")
def delete_benchmark_question(
    question_id: int, principal: Principal = Depends(require_write)
) -> dict[str, Any]:
    with conn() as connection, connection.cursor() as cur:
        cur.execute("SELECT space_slug FROM benchmark_question WHERE id = %s", (question_id,))
        linha = cur.fetchone()
        if linha is None:
            raise HTTPException(status_code=404, detail=f"pergunta {question_id} não encontrada")
        _espaco_alcancavel(linha[0], principal)
        cur.execute("DELETE FROM benchmark_question WHERE id = %s", (question_id,))
        connection.commit()
    return {"id": question_id, "removed": True}


@app.post("/v1/spaces/{slug}/benchmark/questions/generate")
def generate_benchmark_questions(
    slug: str, payload: dict = Body(default={}),
    principal: Principal = Depends(require_write),
) -> dict[str, Any]:
    """A LLM lê documentos reais e propõe perguntas com resposta de referência.

    Síncrona de propósito: é uma chamada por documento e a pessoa está olhando.
    O teto de 20 existe porque acima disso a espera deixa de ser tolerável na
    tela -- e porque um dataset bom se constrói em rodadas, com curadoria no
    meio, não de uma vez.
    """
    _espaco_alcancavel(slug, principal)
    estrategia = str(payload.get("strategy") or "direta")
    if estrategia not in benchmark.ESTRATEGIAS:
        raise HTTPException(
            status_code=400,
            detail=(f"estratégia desconhecida: {estrategia}. "
                    f"Use {', '.join(benchmark.ESTRATEGIAS)}"),
        )
    # `count` ausente ou 0 quer dizer TODOS os documentos que ainda nao tem
    # pergunta desta estrategia. Nao ha teto: com 275 documentos a geracao leva
    # uma hora, e por isso ela roda em segundo plano -- o teto de 20 que existia
    # antes era um limite de PACIENCIA de uma chamada sincrona, disfarcado de
    # limite de produto.
    bruto = payload.get("count")
    quantidade: int | None
    if bruto in (None, "", 0, "0", "todos"):
        quantidade = None
    else:
        try:
            quantidade = int(bruto)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="`count` deve ser número") from None
        if quantidade < 1:
            raise HTTPException(status_code=400, detail="`count` precisa ser positivo")

    if benchmark.estado_geracao(slug):
        raise HTTPException(
            status_code=409, detail="já há uma geração em andamento nesta base."
        )
    faltam = benchmark.pendentes(slug, estrategia)
    if not faltam:
        return {"status": "vazio", "criadas": 0, "pendentes": 0,
                "erro": ("todos os documentos desta base já têm pergunta desta estratégia. "
                         "Suba documentos novos, ou gere com a outra estratégia.")}

    alvo = faltam if quantidade is None else min(quantidade, faltam)
    threading.Thread(
        target=benchmark.gerar_perguntas,
        args=(slug, quantidade, principal.describe(), estrategia),
        name=f"geracao-{slug}", daemon=True,
    ).start()
    log.info("geracao de perguntas em %s: %s documentos, estrategia %s (por %s)",
             slug, alvo, estrategia, principal.describe())
    return {"status": "iniciada", "total": alvo, "pendentes": faltam,
            "estrategia": estrategia}


@app.get("/v1/spaces/{slug}/benchmark/questions/generate")
def benchmark_generation_status(
    slug: str, strategy: str = Query(default="direta"),
    principal: Principal = Depends(require_write),
) -> dict[str, Any]:
    """Progresso da geração, e quantos documentos ainda faltam.

    `pendentes` é o que responde "a cobertura está completa?" — a pergunta que o
    número de documentos escolhido no lote não responde sozinho.
    """
    _espaco_alcancavel(slug, principal)
    if strategy not in benchmark.ESTRATEGIAS:
        strategy = "direta"
    return {
        "space": slug,
        "running": benchmark.estado_geracao(slug),
        "pendentes": {e: benchmark.pendentes(slug, e) for e in benchmark.ESTRATEGIAS},
    }


@app.delete("/v1/spaces/{slug}/benchmark/questions/generate")
def cancel_benchmark_generation(
    slug: str, principal: Principal = Depends(require_write)
) -> dict[str, Any]:
    """Cancela a geração. O que já foi gerado fica."""
    _espaco_alcancavel(slug, principal)
    return {"space": slug, "cancelled": benchmark.cancelar_geracao(slug)}


@app.post("/v1/spaces/{slug}/benchmark/runs")
def start_benchmark_run(
    slug: str, payload: dict = Body(default={}),
    principal: Principal = Depends(require_write),
) -> dict[str, Any]:
    """Inicia uma execução em segundo plano."""
    _espaco_alcancavel(slug, principal)
    modo = str(payload.get("mode") or "completo")
    if modo not in benchmark.MODOS:
        raise HTTPException(
            status_code=400,
            detail=f"modo desconhecido: {modo}. Use {', '.join(benchmark.MODOS)}",
        )
    # Os slots de melhoria de query entram na execucao, e e assim que se mede se
    # eles valem a pena: o MESMO conjunto de perguntas com e sem, e a diferenca
    # atribuivel so ao slot.
    reescrita = str(payload.get("rewrite") or "nenhuma")
    embedding_query = str(payload.get("query_embedding") or "crua")
    if reescrita not in query_slot.REESCRITAS:
        raise HTTPException(status_code=400, detail=f"reescrita desconhecida: {reescrita}")
    if embedding_query not in query_slot.EMBEDDINGS_DE_QUERY:
        raise HTTPException(
            status_code=400, detail=f"embedding de query desconhecido: {embedding_query}"
        )

    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM benchmark_question "
            " WHERE space_slug = %s AND status = 'aprovada'",
            (slug,),
        )
        aprovadas = cur.fetchone()[0]
        if not aprovadas:
            raise HTTPException(
                status_code=400,
                detail=("nenhuma pergunta aprovada nesta base. Gere perguntas e aprove as "
                        "que fizerem sentido, ou cadastre uma à mão."),
            )
        cur.execute(
            "SELECT 1 FROM benchmark_run WHERE space_slug = %s AND status = 'running'",
            (slug,),
        )
        if cur.fetchone():
            raise HTTPException(
                status_code=409,
                detail="já há uma execução em andamento nesta base.",
            )
        cur.execute("SELECT chunking, representations FROM space WHERE slug = %s AND active",
                    (slug,))
        espaco = cur.fetchone()
        if espaco is None:
            raise HTTPException(status_code=404, detail=f"Espaço {slug} não encontrado")
        # O retrato da configuracao. Sem ele, comparar duas execucoes de meses
        # diferentes nao diz nada: a nota pode ter caido por regressao ou por
        # outro motor de corte, e nao haveria como distinguir.
        configuracao = {"chunking": espaco[0], "representations": espaco[1], "mode": modo,
                        "rewrite": reescrita, "query_embedding": embedding_query}
        cur.execute(
            """
            INSERT INTO benchmark_run (space_slug, mode, total, config, started_by)
            VALUES (%s, %s, %s, %s, %s) RETURNING id
            """,
            (slug, modo, aprovadas, jsonb(configuracao), principal.describe()),
        )
        run_id = cur.fetchone()[0]
        connection.commit()

    # `daemon=True` pela mesma razao do reprocesso: execucao pendente nao segura
    # o encerramento do pod. O que ja foi avaliado esta gravado.
    threading.Thread(
        target=benchmark.executar, args=(run_id, slug, modo, (reescrita, embedding_query)),
        name=f"benchmark-{run_id}", daemon=True,
    ).start()
    log.info("benchmark %s iniciado em %s: %s perguntas, modo %s (por %s)",
             run_id, slug, aprovadas, modo, principal.describe())
    return {"run_id": run_id, "space": slug, "mode": modo, "total": aprovadas}


@app.get("/v1/spaces/{slug}/benchmark/runs")
def list_benchmark_runs(
    slug: str, limit: int = Query(default=20, le=100),
    principal: Principal = Depends(require_write),
) -> dict[str, Any]:
    _espaco_alcancavel(slug, principal)
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            SELECT id, mode, status, total, done, config, summary, error,
                   started_by, started_at, finished_at
              FROM benchmark_run WHERE space_slug = %s
             ORDER BY started_at DESC LIMIT %s
            """,
            (slug, limit),
        )
        linhas = cur.fetchall()
    return {"space": slug, "runs": [_run_para_dict(r) for r in linhas]}


def _run_para_dict(r: tuple) -> dict[str, Any]:
    vivo = benchmark.estado(r[0])
    return {
        "id": r[0], "mode": r[1], "status": r[2],
        "total": r[3], "done": vivo["done"] if vivo else r[4],
        "config": r[5], "summary": r[6], "error": r[7], "started_by": r[8],
        "started_at": r[9].isoformat() if r[9] else None,
        "finished_at": r[10].isoformat() if r[10] else None,
    }


@app.get("/v1/benchmark/runs/{run_id}")
def get_benchmark_run(
    run_id: int, principal: Principal = Depends(require_write)
) -> dict[str, Any]:
    """A execução com o resultado POR PERGUNTA.

    A média esconde o caso que interessa. Quem abre esta tela quer achar a
    pergunta que falhou e ver qual trecho veio no lugar do certo.
    """
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            SELECT id, mode, status, total, done, config, summary, error,
                   started_by, started_at, finished_at, space_slug
              FROM benchmark_run WHERE id = %s
            """,
            (run_id,),
        )
        linha = cur.fetchone()
        if linha is None:
            raise HTTPException(status_code=404, detail=f"execução {run_id} não encontrada")
        _espaco_alcancavel(linha[11], principal)
        cur.execute(
            """
            SELECT r.id, r.question_id, r.question, r.reference, r.answer, r.contexts,
                   r.metrics, r.diagnosis, r.latency_ms, r.error,
                   coalesce(q.strategy, 'direta'), coalesce(q.kind, '')
              FROM benchmark_result r
              LEFT JOIN benchmark_question q ON q.id = r.question_id
             WHERE r.run_id = %s ORDER BY r.id
            """,
            (run_id,),
        )
        resultados = cur.fetchall()
    return {
        **_run_para_dict(linha[:11]),
        "space": linha[11],
        "results": [
            {"id": r[0], "question_id": r[1], "question": r[2], "reference": r[3],
             "answer": r[4], "contexts": r[5], "metrics": r[6], "diagnosis": r[7],
             "latency_ms": r[8], "error": r[9], "strategy": r[10], "kind": r[11]}
            for r in resultados
        ],
    }


@app.delete("/v1/benchmark/runs/{run_id}")
def cancel_benchmark_run(
    run_id: int, principal: Principal = Depends(require_write)
) -> dict[str, Any]:
    """Cancela uma execução em andamento. O que já foi avaliado fica."""
    with conn() as connection, connection.cursor() as cur:
        cur.execute("SELECT space_slug, status FROM benchmark_run WHERE id = %s", (run_id,))
        linha = cur.fetchone()
        if linha is None:
            raise HTTPException(status_code=404, detail=f"execução {run_id} não encontrada")
        _espaco_alcancavel(linha[0], principal)
    if linha[1] != "running":
        return {"run_id": run_id, "cancelled": False, "reason": f"execução está {linha[1]}"}
    return {"run_id": run_id, "cancelled": benchmark.cancelar(run_id)}


# ── retentativa automatica (fila de recuperacao) ───────────────────────────


@app.get("/v1/retry")
def retry_status(principal: Principal = Depends(require_write)) -> dict[str, Any]:
    """O que falhou, o que vai ser retentado e quando.

    O `next_retry_at` nulo separa "parou de tentar" de "esperando a vez", e essa
    e a distincao que decide se alguem precisa agir.
    """
    fila = retry.pendentes()
    alcancaveis = principal.allowed_spaces()
    if alcancaveis is not None:
        fila = [f for f in fila if f["space"] in alcancaveis]
    return {
        "enabled": settings.retry_enabled,
        "interval_seconds": settings.retry_interval_seconds,
        "max_tentativas": ingest.MAX_TENTATIVAS,
        "backoff_minutos": list(ingest.BACKOFF_MINUTOS),
        "estado": retry.estado(),
        "pendentes": fila,
    }


@app.post("/v1/retry")
def retry_agora(principal: Principal = Depends(require_write)) -> dict[str, Any]:
    """Roda uma passada agora, sem esperar o intervalo.

    Existe porque esperar cinco minutos para verificar um conserto e atrito
    desnecessario: quem acabou de configurar o provedor quer ver os documentos
    voltarem, nao cronometrar.

    Com ingestao de usuario em andamento a rodada e ADIADA, e a resposta traz
    `adiada` e `ingestoes_em_andamento` dizendo por que. "Agora" nao passa na
    frente de quem esta esperando na tela, e nada se perde: a fila fica intacta
    e a proxima rodada pega os mesmos documentos.
    """
    log.info("retentativa disparada a mao por %s", principal.describe())
    # Rota `def`, e nao `async def`: o FastAPI ja a executa no threadpool, e uma
    # rodada faz ingestao inteira -- no event loop ela travaria o processo.
    return retry.rodada()


@app.get("/v1/grants")
def list_grants(principal: Principal = Depends(require_write)) -> dict[str, Any]:
    """Todos os vinculos de permissao, por Espaco.

    Exige admin: a lista de quem alcanca o que e, ela mesma, informacao
    sensivel -- diz quais areas existem e quem as le.
    """
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            SELECT g.space_slug, s.label, g.id, g.principal_type, g.principal_id,
                   g.role, g.created_at
              FROM space_grant g
              JOIN space s ON s.slug = g.space_slug
             WHERE s.active
             ORDER BY g.space_slug, g.principal_type, g.principal_id
            """
        )
        rows = cur.fetchall()
    por_espaco: dict[str, dict[str, Any]] = {}
    for slug, label, gid, kind, value, role, created in rows:
        entry = por_espaco.setdefault(slug, {"slug": slug, "label": label, "grants": []})
        entry["grants"].append(
            {
                "id": gid, "principal_type": kind, "principal_id": value,
                "role": role, "created_at": created.isoformat() if created else None,
            }
        )
    # Espaco sem grant nenhum tambem aparece: um Espaco que ninguem alcanca e
    # justamente o que precisa ser visto nesta tela.
    with conn() as connection, connection.cursor() as cur:
        cur.execute("SELECT slug, label FROM space WHERE active ORDER BY slug")
        for slug, label in cur.fetchall():
            por_espaco.setdefault(slug, {"slug": slug, "label": label, "grants": []})
    return {"spaces": sorted(por_espaco.values(), key=lambda s: s["slug"])}


@app.post("/v1/grants")
def create_grant(
    payload: dict = Body(...),
    principal: Principal = Depends(require_write),
) -> dict[str, Any]:
    slug = str(payload.get("space") or "").strip()
    kind = str(payload.get("principal_type") or "group").strip()
    value = str(payload.get("principal_id") or "").strip()
    role = str(payload.get("role") or "reader").strip()

    if kind not in GRANT_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"principal_type invalido: {kind}. Use {', '.join(sorted(GRANT_TYPES))}",
        )
    if role not in {"reader", "editor", "owner"}:
        raise HTTPException(status_code=400, detail=f"role invalida: {role}")
    # `public` nao tem identificador: qualquer valor ali seria ignorado em
    # silencio, e o grant abriria o Espaco para todo mundo sem parecer.
    if kind == "public":
        value = ""
    elif not value:
        raise HTTPException(status_code=400, detail="principal_id e obrigatorio")
    if kind == "email":
        value = value.lower()

    with conn() as connection, connection.cursor() as cur:
        cur.execute("SELECT 1 FROM space WHERE slug=%s AND active", (slug,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail=f"Espaco {slug} nao encontrado")
        cur.execute(
            """
            INSERT INTO space_grant (space_slug, principal_type, principal_id, role)
            VALUES (%s,%s,%s,%s)
            ON CONFLICT (space_slug, principal_type, principal_id)
              DO UPDATE SET role = EXCLUDED.role
            RETURNING id
            """,
            (slug, kind, value, role),
        )
        grant_id = cur.fetchone()[0]
        connection.commit()
    log.info("grant %s %s=%s em %s por %s", role, kind, value, slug, principal.describe())
    return {"id": grant_id, "space": slug, "principal_type": kind,
            "principal_id": value, "role": role}


@app.delete("/v1/grants/{grant_id}")
def delete_grant(
    grant_id: int,
    principal: Principal = Depends(require_write),
) -> dict[str, Any]:
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            "DELETE FROM space_grant WHERE id=%s RETURNING space_slug, principal_type, principal_id",
            (grant_id,),
        )
        row = cur.fetchone()
        connection.commit()
    if row is None:
        raise HTTPException(status_code=404, detail=f"vinculo {grant_id} nao encontrado")
    log.info("grant removido: %s %s=%s por %s", row[0], row[1], row[2], principal.describe())
    return {"removido": grant_id, "space": row[0]}


@app.get("/v1/admins")
def list_admins(principal: Principal = Depends(require_write)) -> dict[str, Any]:
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            SELECT id, principal_type, principal_id, note, created_by, created_at
              FROM kb_admin ORDER BY principal_type, principal_id
            """
        )
        rows = cur.fetchall()
    return {
        # O grupo do Identity aparece junto porque ele e a regra que NAO da para
        # remover aqui: sem mostra-lo, a tela sugeriria que a lista abaixo e a
        # unica fonte de administracao.
        "identity_group": settings.admin_group,
        "identity_role": settings.admin_role,
        "admins": [
            {
                "id": row[0], "principal_type": row[1], "principal_id": row[2],
                "note": row[3], "created_by": row[4],
                "created_at": row[5].isoformat() if row[5] else None,
            }
            for row in rows
        ],
    }


@app.post("/v1/admins")
def create_admin(
    payload: dict = Body(...),
    principal: Principal = Depends(require_write),
) -> dict[str, Any]:
    kind = str(payload.get("principal_type") or "email").strip()
    value = str(payload.get("principal_id") or "").strip()
    note = str(payload.get("note") or "").strip()[:200]
    if kind not in {"group", "role", "entra_oid", "email"}:
        raise HTTPException(status_code=400, detail=f"principal_type invalido: {kind}")
    if not value:
        raise HTTPException(status_code=400, detail="principal_id e obrigatorio")
    if kind == "email":
        value = value.lower()

    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            INSERT INTO kb_admin (principal_type, principal_id, note, created_by)
            VALUES (%s,%s,%s,%s)
            ON CONFLICT (principal_type, principal_id)
              DO UPDATE SET note = EXCLUDED.note
            RETURNING id
            """,
            (kind, value, note, principal.describe()),
        )
        admin_id = cur.fetchone()[0]
        connection.commit()
    invalidate_admin_cache()
    log.info("admin acrescentado: %s=%s por %s", kind, value, principal.describe())
    return {"id": admin_id, "principal_type": kind, "principal_id": value}


@app.delete("/v1/admins/{admin_id}")
def delete_admin(
    admin_id: int,
    principal: Principal = Depends(require_write),
) -> dict[str, Any]:
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            "DELETE FROM kb_admin WHERE id=%s RETURNING principal_type, principal_id",
            (admin_id,),
        )
        row = cur.fetchone()
        connection.commit()
    if row is None:
        raise HTTPException(status_code=404, detail=f"admin {admin_id} nao encontrado")
    invalidate_admin_cache()
    log.info("admin removido: %s=%s por %s", row[0], row[1], principal.describe())
    return {"removido": admin_id}


@app.get("/v1/principals")
def observed_principals(principal: Principal = Depends(require_write)) -> dict[str, Any]:
    """Quem JA consultou a base, com o que consultou.

    A aplicacao nao tem diretorio de usuarios -- quem tem e o Identity. Mas para
    conceder acesso e util saber quem apareceu e nao alcancou nada: e
    exatamente a pessoa que esta esperando permissao. Vem do log de execucoes.
    """
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            SELECT principal, count(*) AS buscas, max(created_at) AS ultima,
                   sum(CASE WHEN result_count = 0 THEN 1 ELSE 0 END) AS vazias
              FROM search_run
             WHERE principal <> ''
             GROUP BY principal
             ORDER BY max(created_at) DESC
             LIMIT 100
            """
        )
        rows = cur.fetchall()
    return {
        "principals": [
            {
                "principal": row[0], "searches": row[1],
                "last_seen": row[2].isoformat() if row[2] else None,
                "empty_results": row[3],
            }
            for row in rows
        ]
    }


# ── busca ──────────────────────────────────────────────────────────────────


@app.post("/v1/search")
def post_search(
    payload: dict = Body(...),
    principal: Principal = Depends(current_principal),
) -> dict[str, Any]:
    query = (payload.get("query") or "").strip()
    if not query:
        raise HTTPException(status_code=400, detail="`query` e obrigatorio")

    spaces = narrow(principal.allowed_spaces(), payload.get("spaces"))
    # Slots de melhoria de query (BUS-02). Desligados por padrao, e vindo do
    # PAYLOAD porque sao escolha de quem chama: o agente normalmente reformula
    # sozinho e manda desligado, o simulador liga para medir. Valor desconhecido
    # nao e erro -- cai no default, que e o comportamento de sempre.
    reescrita = str(payload.get("rewrite") or "nenhuma")
    if reescrita not in query_slot.REESCRITAS:
        raise HTTPException(
            status_code=400,
            detail=f"reescrita desconhecida: {reescrita}. "
                   f"Use {', '.join(query_slot.REESCRITAS)}",
        )
    embedding_query = str(payload.get("query_embedding") or "crua")
    if embedding_query not in query_slot.EMBEDDINGS_DE_QUERY:
        raise HTTPException(
            status_code=400,
            detail=f"embedding de query desconhecido: {embedding_query}. "
                   f"Use {', '.join(query_slot.EMBEDDINGS_DE_QUERY)}",
        )
    # Recorte do chamador. RECUSADO quando vem escrito errado, e nao ignorado:
    # um `min_trust` com sublinhado no lugar do hifen, aceito em silencio,
    # devolveria conteudo nao revisado para quem pediu justamente que ele nao
    # viesse -- e a resposta pareceria filtrada.
    min_trust = str(payload.get("min_trust") or "")
    if min_trust and min_trust not in okf.TRUST_ESCALA:
        raise HTTPException(
            status_code=400,
            detail=f"nivel de confianca desconhecido: {min_trust}. "
                   f"Use {', '.join(okf.TRUST_ESCALA)}",
        )
    as_of = str(payload.get("as_of") or "")
    if as_of and not okf.data_iso(as_of):
        raise HTTPException(
            status_code=400,
            detail=f"data invalida em `as_of`: {as_of}. Use o formato AAAA-MM-DD",
        )
    outcome = search.search(
        query, spaces, top_k=payload.get("top_k"),
        principal=principal.describe(), surface="rest",
        reescrita=reescrita, embedding_query=embedding_query,
        min_trust=min_trust, as_of=as_of,
    )
    return {
        "results": [passage.to_dict() for passage in outcome.passages],
        "telemetry": {
            "run_id": outcome.run_id,
            "total_ms": outcome.total_ms,
            "embed_tokens": outcome.embed_tokens,
            "stages": outcome.stages,
        },
    }


@app.get("/v1/runs")
def list_runs(
    limit: int = Query(default=30, le=200),
    principal: Principal = Depends(current_principal),
) -> dict[str, Any]:
    """Log de execucoes de busca: pergunta, resposta e custo (WEB-04/WEB-05).

    Nao exige admin, mas FILTRA: quem nao e admin ve apenas as execucoes das
    proprias buscas. Um log de auditoria que expusesse a pergunta de todo mundo
    seria vazamento por outra porta -- a pergunta em si revela o que a pessoa
    procurava.
    """
    own_only = not principal.unrestricted
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            """
            SELECT id, query, spaces, principal, surface, total_ms,
                   embed_tokens, result_count, stages, results, created_at
              FROM search_run
             WHERE (%s = FALSE OR principal = %s)
             ORDER BY created_at DESC
             LIMIT %s
            """,
            (own_only, principal.describe(), limit),
        )
        rows = cur.fetchall()
    return {
        "scope": "proprias" if own_only else "todas",
        "runs": [
            {
                "id": row[0], "query": row[1], "spaces": row[2], "principal": row[3],
                "surface": row[4], "total_ms": row[5], "embed_tokens": row[6],
                "result_count": row[7], "stages": row[8], "results": row[9],
                "created_at": row[10].isoformat() if row[10] else None,
            }
            for row in rows
        ],
    }


# ── MCP ────────────────────────────────────────────────────────────────────


@app.post("/mcp")
async def mcp_endpoint(request: Request) -> Any:
    """Streamable HTTP do MCP: um POST por mensagem JSON-RPC.

    ⚠ TUDO QUE BLOQUEIA VAI PARA O THREADPOOL, e isto nao e otimizacao.

    Este handler e `async` porque precisa de `await request.body()`. Mas o que
    ele chama nao e: `mcp.handle` faz consulta ao Postgres e uma ida ao provedor
    de embedding (~350 ms medidos), e resolver o token de conexao le o banco.
    Chamados direto, rodam NO EVENT LOOP -- e enquanto um roda, nenhuma outra
    requisicao do processo anda, incluindo `/v1/health` e a probe de liveness.

    Medido antes da correcao, pelo protocolo: 25 chamadas MCP simultaneas
    levavam 7,7 s de parede com a pior em 7,6 s, enquanto 50 buscas pela REST
    (que e rota `def`, e portanto ja ia para o threadpool) levavam 2,2 s. O MCP
    nao era mais lento por fazer mais coisa; era mais lento por serializar.

    E a mesma armadilha ja registrada em `upload_document`, que por isso usa
    `run_in_threadpool` desde sempre.
    """
    try:
        principal = await run_in_threadpool(
            principal_from_authorization, request.headers.get("authorization")
        )
    except AuthError as exc:
        # O `WWW-Authenticate` NAO e detalhe: e ele que dispara a descoberta no
        # cliente MCP. Sem esse header o Claude e o Cursor mostram "nao
        # autorizado" e param ali; com ele, buscam os metadados do recurso,
        # registram-se sozinhos e abrem o login. E a diferenca entre "cole um
        # token" e "clique em Entrar".
        recurso = f"{_base_publica(request)}/.well-known/oauth-protected-resource"
        return JSONResponse(
            {"jsonrpc": "2.0", "id": None, "error": {"code": -32001, "message": str(exc)}},
            status_code=401,
            headers={
                "WWW-Authenticate": (
                    f'Bearer realm="knowledge-base", resource_metadata="{recurso}", '
                    f'error="invalid_token", error_description="{_valor_de_cabecalho(str(exc))}"'
                )
            },
        )

    body = await request.body()
    try:
        message = __import__("json").loads(body.decode("utf-8"))
    except Exception:  # noqa: BLE001
        return JSONResponse(
            {"jsonrpc": "2.0", "id": None,
             "error": {"code": -32700, "message": "corpo nao e JSON valido"}},
            status_code=400,
        )

    # Lote: a especificacao permite array de mensagens. O lote inteiro vai numa
    # ida ao threadpool -- uma por mensagem custaria uma troca de contexto por
    # item sem ganhar paralelismo, porque as mensagens de um lote sao ordenadas.
    base = _base_publica(request)
    if isinstance(message, list):
        lote = message
        respostas = await run_in_threadpool(
            lambda: [mcp.handle(item, principal, base) for item in lote]
        )
        responses = [r for r in respostas if r]
        return JSONResponse(responses) if responses else JSONResponse(None, status_code=202)

    response = await run_in_threadpool(mcp.handle, message, principal, base)
    if response is None:
        return JSONResponse(None, status_code=202)
    return JSONResponse(response)


@app.get("/mcp/icon.png")
def mcp_icon():
    """O icone que o cliente MCP mostra ao lado do conector.

    SEM AUTENTICACAO, de proposito -- e a spec que pede: o cliente busca o icone
    SEM credencial (nada de cookie, nada de `Authorization`), para nao vazar
    sessao para quem hospeda a imagem. Aqui quem hospeda somos nos e o conteudo e
    um logotipo, entao nao ha o que proteger.

    Serve da MESMA origem do `/mcp` pelo mesmo motivo: a spec manda o cliente
    conferir isso, e um icone em dominio de terceiro seria um pixel de rastreio
    disparado toda vez que alguem abre a lista de conectores.
    """
    from fastapi.responses import Response

    if not mcp.ICONE_BYTES:
        raise HTTPException(status_code=404, detail="icone do MCP nao esta na imagem")
    return Response(
        content=mcp.ICONE_BYTES,
        media_type=mcp.ICONE_TIPO,
        # Imutavel dentro de uma versao da imagem: o arquivo so muda em deploy, e
        # cada deploy e uma imagem nova. Um dia de cache poupa uma ida por cliente
        # por dia e nunca serve pixel velho por mais que isso.
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.get("/mcp/favicon.ico")
def mcp_favicon():
    """A marca no endereco convencional, ao lado do `/mcp`.

    Existe para o cliente que procura o icone POR FAVICON em vez de ler
    `serverInfo.icons` -- hoje o Claude nao desenha nenhum dos dois em conector
    customizado (anthropics/claude-ai-mcp#152), entao isto e aposta em
    descoberta futura, nao correcao de um bug nosso.

    ⚠ NAO cobre a sonda de favicon da RAIZ da origem. Quem procura o
    `/favicon.ico` da raiz do dominio cai fora desta aplicacao, que vive sob o
    prefixo `/knowledge-base` -- aquela raiz e de outro servico. Este
    arquivo so e alcancado por quem resolve o favicon contra o endereco do
    servidor MCP.

    Sem credencial e com o mesmo cache do `icon.png`, pelas mesmas razoes.
    """
    from fastapi.responses import Response

    if not mcp.FAVICON_BYTES:
        raise HTTPException(status_code=404, detail="favicon do MCP nao esta na imagem")
    return Response(
        content=mcp.FAVICON_BYTES,
        media_type=mcp.FAVICON_TIPO,
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.get("/mcp")
def mcp_probe() -> JSONResponse:
    """GET no endpoint MCP: sonda de saude, nao parte do protocolo.

    A especificacao usa POST; um GET aqui existe para o operador (e o script de
    espera do deploy) checar que o servidor esta atendendo sem falar JSON-RPC.
    """
    return JSONResponse(
        {
            "server": SERVER_INFO_NAME,
            "transport": "streamable-http (POST)",
            "tools": [tool["name"] for tool in mcp.TOOLS],
            "auth": "keycloak" if settings.auth_enabled else "desligada",
        }
    )


SERVER_INFO_NAME = mcp.SERVER_INFO["name"]

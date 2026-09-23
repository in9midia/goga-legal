#!/usr/bin/env python3
"""Exercita a stack local de ponta a ponta, com login real no Identity.

POR QUE ISTO EXISTE

`docs/testes.md` diz, e continua verdade, que a verificacao de ponta a ponta
deste projeto e manual: extracao, busca e permissao dependem de Postgres, object
store e Identity, e teste unitario honesto delas nao existe. Este script nao
substitui os unitarios -- ele automatiza o "manual", para a conferencia antes de
entregar deixar de depender de alguem lembrar a sequencia.

O QUE ELE NAO E

Nao e teste de unidade e nao roda no gate. Ele fala com a stack de verdade,
gasta IA de verdade e grava dado de verdade. Por isso limpa o que cria, e por
isso o Espaco que usa tem prefixo proprio (`e2e-`).

CREDENCIAL

Vem do `.env` da raiz do repositorio (`LOGIN_KC_USER`, `LOGIN_KC_PASSWORD`) e
NUNCA e impressa. O login e authorization code com PKCE -- o MESMO fluxo da
interface, e nao um grant de senha: o client e uma SPA publica e nao permite
acesso direto. Exercita o caminho real de autenticacao, inclusive o PKCE.

USO

    uv run -- python ../../scripts/e2e.py            # tudo
    uv run -- python ../../scripts/e2e.py --keep     # nao limpa no fim
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

RAIZ = pathlib.Path(__file__).resolve().parent.parent
API = "http://localhost:8890"
PREFIXO = "e2e-"


def env() -> dict[str, str]:
    """O `.env` da raiz, sem depender de biblioteca."""
    valores: dict[str, str] = {}
    arquivo = RAIZ / ".env"
    if not arquivo.exists():
        sair(f"sem {arquivo}: o login real precisa de LOGIN_KC_USER e LOGIN_KC_PASSWORD")
    for linha in arquivo.read_text().splitlines():
        linha = linha.strip()
        if not linha or linha.startswith("#") or "=" not in linha:
            continue
        chave, _, valor = linha.partition("=")
        valores[chave.strip()] = valor.strip().strip('"').strip("'")
    return valores


class _Recusado(Exception):
    """A API recusou, e era isso que o passo queria provar."""


def sair(mensagem: str) -> None:
    print(f"\n  FALHOU: {mensagem}")
    sys.exit(1)


def token(cfg: dict[str, str]) -> str:
    """Access token do Identity, pelo MESMO fluxo que a interface usa.

    Authorization code com PKCE, e nao grant de senha: o client `kb-ui` e uma
    SPA publica e nao permite acesso direto -- corretamente, e afrouxar isso no
    realm para facilitar um teste seria trocar seguranca por conveniencia. O
    que este codigo faz e o que o navegador faria: pede o
    codigo, preenche o formulario de login, segue o redirect e troca o codigo
    pelo token.

    O efeito colateral e bom: o e2e passa a exercitar o caminho real de
    autenticacao, inclusive o PKCE, em vez de um atalho que a producao nao tem.
    """
    import base64
    import hashlib
    import http.cookiejar
    import re
    import secrets

    base = cfg.get("KB_KEYCLOAK_URL", "").rstrip("/")
    realm = cfg.get("KB_KEYCLOAK_REALM", "")
    cliente = cfg.get("KB_KEYCLOAK_CLIENT_ID", "")
    usuario = cfg.get("LOGIN_KC_USER", "")
    senha = cfg.get("LOGIN_KC_PASSWORD", "")
    if not all((base, realm, cliente, usuario, senha)):
        sair("faltam KB_KEYCLOAK_* ou LOGIN_KC_* no .env")

    verifier = secrets.token_urlsafe(64)
    desafio = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .decode()
        .rstrip("=")
    )
    redirect = f"{API}/"

    # Um opener que NAO segue redirect: o codigo vem no `Location` do 302 para o
    # `redirect_uri`, e seguir levaria a tentar buscar a pagina da SPA.
    class SemRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None

    cookies = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(cookies), SemRedirect
    )

    autorizacao = f"{base}/realms/{realm}/protocol/openid-connect/auth?" + urllib.parse.urlencode(
        {
            "client_id": cliente,
            "redirect_uri": redirect,
            "response_type": "code",
            "scope": "openid",
            "code_challenge": desafio,
            "code_challenge_method": "S256",
            "state": secrets.token_urlsafe(8),
        }
    )
    try:
        with opener.open(autorizacao, timeout=20) as resposta:
            pagina = resposta.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        sair(f"pagina de login recusada: HTTP {exc.code} (redirect_uri {redirect} registrado?)")
    except Exception as exc:  # noqa: BLE001
        sair(f"Identity inacessivel em {base}: {exc}")

    # O `action` do formulario carrega a sessao; sem ele o POST nao tem contexto.
    achado = re.search(r'action="([^"]+)"', pagina)
    if not achado:
        sair("nao achei o formulario de login na pagina do Identity")
    acao = achado.group(1).replace("&amp;", "&")

    corpo = urllib.parse.urlencode({"username": usuario, "password": senha}).encode()
    local = ""
    try:
        opener.open(
            urllib.request.Request(
                acao, data=corpo,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            ),
            timeout=20,
        )
    except urllib.error.HTTPError as exc:
        if exc.code not in (302, 303):
            sair(f"login recusado pelo Identity: HTTP {exc.code}")
        local = exc.headers.get("Location", "")

    if not local:
        sair("o Identity nao redirecionou apos o login (credencial errada?)")
    codigo = urllib.parse.parse_qs(urllib.parse.urlparse(local).query).get("code", [""])[0]
    if not codigo:
        sair(f"sem `code` no retorno do login: {local[:160]}")

    troca = urllib.parse.urlencode(
        {
            "grant_type": "authorization_code",
            "client_id": cliente,
            "code": codigo,
            "redirect_uri": redirect,
            "code_verifier": verifier,
        }
    ).encode()
    try:
        with urllib.request.urlopen(
            urllib.request.Request(
                f"{base}/realms/{realm}/protocol/openid-connect/token",
                data=troca,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            ),
            timeout=20,
        ) as resposta:
            dados = json.loads(resposta.read().decode())
    except urllib.error.HTTPError as exc:
        detalhe = exc.read().decode("utf-8", "replace")[:200]
        sair(f"troca do codigo recusada: HTTP {exc.code} {detalhe}")
    return dados["access_token"]


class Api:
    """Cliente da API com o token real. Erro vira falha visivel, nao excecao muda."""

    def __init__(self, jwt: str):
        self._jwt = jwt

    def __call__(
        self,
        metodo: str,
        caminho: str,
        corpo: dict | None = None,
        arquivo: tuple[str, bytes] | None = None,
        timeout: int = 600,
        tolerar_404: bool = False,
        espera_recusa: bool = False,
    ):
        url = f"{API}/v1{caminho}"
        headers = {"Authorization": f"Bearer {self._jwt}"}
        dados = None
        if arquivo is not None:
            nome, conteudo = arquivo
            limite = "----e2e"
            partes = [
                f"--{limite}".encode(),
                f'Content-Disposition: form-data; name="file"; filename="{nome}"'.encode(),
                b"Content-Type: text/markdown",
                b"",
                conteudo,
                f"--{limite}--".encode(),
                b"",
            ]
            dados = b"\r\n".join(partes)
            headers["Content-Type"] = f"multipart/form-data; boundary={limite}"
        elif corpo is not None:
            dados = json.dumps(corpo).encode()
            headers["Content-Type"] = "application/json"

        pedido = urllib.request.Request(url, data=dados, headers=headers, method=metodo)
        try:
            with urllib.request.urlopen(pedido, timeout=timeout) as resposta:
                bruto = resposta.read().decode()
                return json.loads(bruto) if bruto else {}
        except urllib.error.HTTPError as exc:
            if exc.code == 404 and tolerar_404:
                # Limpeza preventiva de Espaco que nao existe e o caso normal na
                # primeira rodada, nao falha.
                return {}
            detalhe = exc.read().decode("utf-8", "replace")[:400]
            if espera_recusa:
                # Caso negativo: a recusa E o resultado esperado, e imprimir
                # "FALHOU" aqui faria uma saida verde parecer quebrada.
                raise _Recusado(detalhe) from None
            sair(f"{metodo} {caminho} -> HTTP {exc.code} {detalhe}")
        except Exception as exc:  # noqa: BLE001
            sair(f"{metodo} {caminho} -> {exc}")


def passo(titulo: str) -> None:
    print(f"\n── {titulo} " + "─" * max(0, 62 - len(titulo)))


def confere(condicao: bool, descricao: str, detalhe: str = "") -> None:
    marca = "  ok  " if condicao else " FALHA"
    print(f"  [{marca}] {descricao}" + (f"  {detalhe}" if detalhe else ""))
    if not condicao:
        sair(descricao)


DOCUMENTO = b"""# Politica de Ferias

## Quem pode solicitar

Todo colaborador CLT com mais de doze meses de casa pode solicitar ferias.
Estagiario segue o calendario academico e nao entra nesta politica.

## Como solicitar

O pedido e aberto no portal de RH com no minimo trinta dias de antecedencia.
O gestor direto aprova ou recusa em ate cinco dias uteis. Recusa precisa de
justificativa escrita, que fica anexada ao pedido.

## Fracionamento

As ferias podem ser divididas em ate tres periodos, desde que um deles tenha ao
menos quatorze dias corridos e nenhum tenha menos de cinco dias.

## Venda de dias

E permitido vender ate um terco do periodo. A venda e solicitada junto com o
pedido e nao pode ser pedida depois da aprovacao.

## Excecoes

Periodo de fechamento contabil (dezembro e janeiro) tem bloqueio para as areas
Financeiro e Controladoria. A diretoria pode liberar caso a caso.
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep", action="store_true", help="nao remove o Espaco de teste no fim")
    parser.add_argument("--space", default=f"{PREFIXO}completo", help="slug do Espaco de teste")
    args = parser.parse_args()
    slug = args.space

    cfg = env()
    passo("1. login real no Identity (authorization code + PKCE)")
    api = Api(token(cfg))
    eu = api("GET", "/spaces")
    confere(bool(eu.get("principal")), "token aceito pela API",
            f"grupos={eu['principal'].get('groups')}")
    confere(eu["principal"].get("unrestricted") is True, "identidade alcanca todos os Espacos")

    passo("2. catalogo de representacoes")
    catalogo = api("GET", "/chunking-engines")
    reps = {r["id"]: r for r in catalogo.get("representations", [])}
    aux = {a["id"]: a for a in catalogo.get("auxiliaries", [])}
    confere(set(reps) == {"indice", "wiki"}, "representacoes publicadas", str(sorted(reps)))
    confere(reps["indice"]["optional"] is False, "o indice nao pode ser desligado")
    confere(set(aux) == {"grafo"}, "auxiliares publicadas", str(sorted(aux)))
    confere(aux["grafo"]["of"] == "indice", "o grafo e auxiliar DO INDICE, nao representacao")

    try:
        passo(f"3. Espaco de teste `{slug}` com as tres coisas ligadas")
        api("DELETE", f"/spaces/{slug}", tolerar_404=True)
        api("POST", "/spaces", {"slug": slug, "label": "E2E completo"})
        ativado = api("PUT", f"/spaces/{slug}/representations", {"wiki": True, "grafo": True})
        confere(ativado["representations"].get("indice") is True, "indice ligado")
        confere(ativado["representations"].get("wiki") is True, "wiki ligada")
        confere(ativado["representations"].get("grafo") is True, "grafo ligado")
        motivo = ""
        try:
            api("PUT", f"/spaces/{slug}/representations", {"indice": False}, espera_recusa=True)
        except _Recusado as recusa:
            motivo = str(recusa)
        confere(bool(motivo), "desligar o indice e recusado",
                motivo[:96] if motivo else "aceitou, e nao deveria")

        passo("4. ingestao real: extrai, corta, vetoriza, destila a wiki e extrai o grafo")
        inicio = time.time()
        resultado = api("POST", f"/spaces/{slug}/documents?wait=true", arquivo=("politica-ferias.md", DOCUMENTO))
        confere(resultado.get("status") == "indexed", "documento indexado",
                f"{resultado.get('parents')} pais / {resultado.get('children')} filhos "
                f"em {resultado.get('total_ms')} ms")
        document_id = resultado["document_id"]

        construidas = resultado.get("representations") or {}
        wiki_resultado = construidas.get("wiki") or {}
        confere(wiki_resultado.get("status") == "ok",
                "representacao WIKI construida",
                f"{wiki_resultado.get('paginas')} paginas / {wiki_resultado.get('vetores')} vetores"
                + (f" — {wiki_resultado.get('erro')}" if wiki_resultado.get("erro") else ""))
        grafo_resultado = construidas.get("grafo") or {}
        confere(grafo_resultado.get("status") == "ok",
                "estrutura auxiliar GRAFO construida",
                f"{grafo_resultado.get('entidades')} entidades / "
                f"{grafo_resultado.get('relacoes')} relacoes"
                + (f" — {grafo_resultado.get('erro')}" if grafo_resultado.get("erro") else ""))
        print(f"       ingestao completa em {time.time() - inicio:.1f}s")

        passo("5. a wiki: paginas OKF, contrato de tamanho e rastreabilidade")
        wiki = api("GET", f"/spaces/{slug}/wiki")
        paginas = wiki["pages"]
        confere(len(paginas) > 0, "a wiki tem pagina", f"{len(paginas)} pagina(s)")
        for p in paginas:
            print(f"       [{p['type']}] {p['path']:<34} {p['words']:>4} palavras"
                  + ("  FORA DO CONTRATO" if p["out_of_contract"] else ""))
        confere(all(p["type"] for p in paginas), "toda pagina tem `type` (OKF exige)")
        confere(all(p["sources"] >= 1 for p in paginas), "toda pagina registra a fonte")

        pagina = api("GET", f"/wiki/pages/{paginas[0]['id']}")
        confere(pagina["content"].startswith("---"), "a pagina e um arquivo OKF com frontmatter")
        confere("generated" in pagina["frontmatter"] or "generated" in pagina["content"],
                "o frontmatter marca que foi gerada por modelo")
        confere(any(f["id"] == document_id for f in pagina["sources"]),
                "a pagina aponta para o documento canonico de origem")

        passo("6. fetch do documento traz as paginas derivadas (BUS-07)")
        documento = api("GET", f"/documents/{document_id}")
        confere(len(documento.get("wiki_pages") or []) > 0,
                "o documento lista as paginas da wiki que derivam dele",
                str([p["path"] for p in documento["wiki_pages"]]))

        passo("7. busca heterogenea: uma pergunta, todos os metodos, fusao RRF")
        busca = api("POST", "/search", {"query": "Como solicitar ferias", "top_k": 6})
        etapas = busca.get("telemetry", {}).get("stages", {})
        metodos = etapas.get("escopo", {}).get("metodos", [])
        confere("semantica" in metodos and "lexical" in metodos, "metodos do indice acionados")
        confere("paginas" in metodos, "metodo da wiki acionado")
        confere("travessia" in metodos, "metodo do grafo acionado")
        print("\n       por metodo:")
        for nome in metodos:
            dados = etapas.get(nome, {})
            print(f"         {nome:<16} candidatos={dados.get('candidatos', 0):<4} "
                  f"{dados.get('estado') or dados.get('tecnica', '')[:48]}")

        resultados = busca.get("results", [])
        confere(len(resultados) > 0, "a busca devolveu evidencia", f"{len(resultados)} passagens")
        origens = {r.get("representation") for r in resultados}
        print("\n       evidencias:")
        for r in resultados[:6]:
            print(f"         [{r['representation']:<6}] score={r['score']:.5f} "
                  f"metodos={sorted((r.get('scores') or {}).get('by_method') or {})}")
            print(f"                   {' '.join((r.get('content') or '').split())[:88]}")
        confere("wiki" in origens,
                "a wiki contribuiu evidencia na mesma lista do indice", str(sorted(origens)))
        confere(any((r.get("scores") or {}).get("by_method") for r in resultados),
                "cada passagem diz por quais metodos chegou")

        passo("8. heterogeneidade: base SEM wiki nao aciona o metodo da wiki")
        outro = f"{PREFIXO}so-indice"
        api("DELETE", f"/spaces/{outro}", tolerar_404=True)
        # Sem `representations` no payload, a base nasce com o padrao da casa --
        # que inclui o grafo. A assercao aqui e sobre a WIKI: o metodo dela nao
        # pode aparecer numa base que nao a tem. Fixar a lista inteira fazia o
        # teste falhar quando o padrao mudou, sem que nada da wiki tivesse
        # mudado -- teste que quebra por motivo errado ensina a ignora-lo.
        api("POST", "/spaces", {"slug": outro, "label": "E2E so indice"})
        busca2 = api("POST", "/search", {"query": "Como solicitar ferias", "spaces": [outro]})
        metodos2 = busca2.get("telemetry", {}).get("stages", {}).get("escopo", {}).get("metodos", [])
        da_wiki = {"paginas", "lexical_paginas"}
        confere(not (set(metodos2) & da_wiki) and "semantica" in metodos2,
                "nenhum metodo da wiki numa base sem wiki", str(metodos2))
        api("DELETE", f"/spaces/{outro}", tolerar_404=True)

        passo("9. o grafo desenhado (WEB-02)")
        esquema = api("GET", "/graph/schema")
        confere(esquema.get("reachable") is True, "grafo alcancavel",
                str({n["label"]: n["total"] for n in esquema.get("nodes", [])}))
        rotulos = {n["label"] for n in esquema.get("nodes", [])}
        confere("Entity" in rotulos, "entidades extraidas por LLM estao no grafo")
        print("       ligacoes:")
        for a in esquema.get("edges", [])[:6]:
            print(f"         {a['de']:<10} -{a['tipo']}-> {a['para']:<10} {a['total']}")

        desenho = api("GET", "/graph?limit=100")
        confere(len(desenho.get("nodes", [])) > 0, "ha no para desenhar",
                f"{len(desenho['nodes'])} nos / {len(desenho['edges'])} arestas")
        confere(all(n.get("grau") is not None for n in desenho["nodes"]),
                "todo no traz o grau (e o que dimensiona o desenho)")

        # A fronteira de seguranca: um grafo desenhado sem filtro mostraria nome
        # de entidade e titulo de documento de Espaco proibido -- vazamento por
        # imagem, que nenhuma outra rota permitiria.
        so_do_espaco = api("GET", f"/graph?space={slug}&limit=100")
        # O `:Term` vem sem `space` de proposito: o no e compartilhado entre
        # bases, e o escopo dele vem da ARESTA -- so entra se um documento
        # alcancavel o menciona. Por isso o vazio conta como dentro do escopo.
        espacos = {n["space"] for n in so_do_espaco.get("nodes", [])}
        confere(espacos <= {slug, ""}, "o grafo respeita o escopo pedido", str(espacos))
        termos = [n for n in so_do_espaco.get("nodes", []) if n["label"] == "Term"]
        confere(bool(termos), "o termo lexical entra no desenho", f"{len(termos)} termo(s)")
        fora = api("GET", "/graph?space=nao-existe&limit=50")
        confere(fora.get("nodes") == [], "Espaco inalcancavel devolve grafo vazio, nao erro")

        foco = api("GET", "/graph?focus=ferias&limit=50")
        confere(len(foco.get("nodes", [])) > 0,
                "o foco casa ignorando acento", f"{len(foco['nodes'])} nos para 'ferias'")

        passo("10. escopo: a permissao e do servidor")
        busca3 = api("POST", "/search", {"query": "ferias", "spaces": ["nao-existe"]})
        confere(busca3.get("results") == [], "Espaco inalcancavel devolve vazio, nao erro")

    finally:
        if not args.keep:
            passo("limpeza")
            api("DELETE", f"/spaces/{slug}", tolerar_404=True)
            api("DELETE", f"/spaces/{PREFIXO}so-indice", tolerar_404=True)
            print("  [  ok  ] Espacos de teste removidos")
        else:
            print(f"\n  (--keep: `{slug}` ficou de pe para inspecao na interface)")

    print("\n" + "=" * 66)
    print("  E2E COMPLETO: tudo verde")
    print("=" * 66)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

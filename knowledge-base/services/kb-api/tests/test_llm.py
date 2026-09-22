"""A chamada de chat: como ela e montada, e como ela desiste.

Este arquivo existe porque a chamada de chat nao tem, hoje, verificacao de ponta
a ponta: a instalacao de dev so tem provedor de `embedding`, entao nenhum teste
honesto chega a falar com um modelo. O que da para travar sem rede e o que
costuma quebrar de verdade ao acrescentar um provedor:

1. **a URL e o cabecalho de cada dialeto.** O Azure poe o deployment no CAMINHO
   e autentica com `api-key`; a OpenAI poe o modelo no CORPO e autentica com
   `Authorization: Bearer`. Trocar os dois e o erro classico, e ele so aparece
   como um 401 ou um 404 vindo do provedor;
2. **`model` no corpo do Azure faz o pedido ser recusado com 400.** Ja e assim
   no embedding, e a regra e a mesma aqui;
3. **degradacao.** Toda falha vira `None`, nunca excecao. A ingestao nao pode
   morrer porque o provedor de chat esta fora do ar -- esta base ja perdeu
   quatro documentos para um provedor de IA mal configurado.
"""

from __future__ import annotations

import io
import json


class _RespostaFalsa(io.BytesIO):
    """O suficiente de `http.client.HTTPResponse` para o `urlopen` do modulo."""

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
        return False


def _provedor(kind: str, **extra):
    from kb_api import providers

    padrao = {
        "id": 1, "name": f"teste-{kind}", "kind": kind,
        "endpoint": "https://exemplo.invalido", "model": "meu-modelo",
        "api_version": "", "dimensions": 0, "api_key": "segredo",
    }
    padrao.update(extra)
    return providers.Provedor(**padrao)


def _captura(monkeypatch, resposta: dict):
    """Troca o `urlopen` e guarda o pedido que teria ido para a rede."""
    from kb_api import llm

    visto: dict = {}

    def falso(request, timeout=None):
        visto["url"] = request.full_url
        visto["headers"] = dict(request.headers)
        visto["body"] = json.loads(request.data.decode())
        visto["timeout"] = timeout
        return _RespostaFalsa(json.dumps(resposta).encode())

    monkeypatch.setattr(llm.urllib.request, "urlopen", falso)
    return visto


_OK = {
    "choices": [{"message": {"content": '{"type": "Norma"}'}}],
    "usage": {"total_tokens": 42},
}


# ── montagem do pedido, por dialeto ───────────────────────────────────────


def test_azure_openai_poe_o_deployment_na_url_e_nao_no_corpo(monkeypatch):
    """`model` no corpo faz o Azure recusar com 400. Mesma regra do embedding."""
    from kb_api import llm

    visto = _captura(monkeypatch, _OK)
    dados, gasto, _ = llm._post(_provedor("azure_openai"), [{"role": "user", "content": "x"}], 600)

    assert "/openai/deployments/meu-modelo/chat/completions" in visto["url"]
    assert "api-version=" in visto["url"]
    assert "model" not in visto["body"]
    assert visto["headers"]["Api-key"] == "segredo"
    assert dados == {"type": "Norma"} and gasto.total == 42


def test_openai_poe_o_modelo_no_corpo_e_usa_bearer(monkeypatch):
    from kb_api import llm

    visto = _captura(monkeypatch, _OK)
    llm._post(_provedor("openai"), [{"role": "user", "content": "x"}], 600)

    assert visto["url"] == "https://exemplo.invalido/chat/completions"
    assert visto["body"]["model"] == "meu-modelo"
    assert visto["headers"]["Authorization"] == "Bearer segredo"


def test_litellm_anexa_o_v1_que_o_endpoint_nao_tem(monkeypatch):
    """O endpoint cadastrado e a RAIZ do gateway, sem `/v1` -- por convencao.

    Mesma regra do cadastro do agentic-sdlc, para quem opera os dois nao ter de
    lembrar de duas.
    """
    from kb_api import llm

    visto = _captura(monkeypatch, _OK)
    llm._post(_provedor("litellm"), [{"role": "user", "content": "x"}], 600)
    assert visto["url"] == "https://exemplo.invalido/v1/chat/completions"


def test_pede_json_e_temperatura_zero(monkeypatch):
    """Temperatura zero nao e capricho: a mesma ingestao tem de dar o mesmo conceito.

    Metadado que muda a cada reprocessamento tornaria a comparacao entre
    tecnicas (FUN-04) impossivel de ler.
    """
    from kb_api import llm

    visto = _captura(monkeypatch, _OK)
    llm._post(_provedor("openai"), [{"role": "user", "content": "x"}], 600)
    assert visto["body"]["temperature"] == 0
    assert visto["body"]["response_format"] == {"type": "json_object"}
    assert visto["timeout"] == llm.TIMEOUT_SEGUNDOS


def test_endpoint_vazio_nao_levanta(monkeypatch):
    from kb_api import llm

    dados, gasto, _ = llm._post(
        _provedor("azure_openai", endpoint=""), [{"role": "user", "content": "x"}], 600
    )
    assert dados is None and gasto.total == 0


# ── leitura da resposta ───────────────────────────────────────────────────


def test_json_dentro_de_cerca_de_codigo(monkeypatch):
    """Alguns modelos devolvem ```json ...``` mesmo com `response_format`.

    Recusar por causa da cerca seria jogar fora uma resposta correta por causa
    da embalagem.
    """
    from kb_api import llm

    _captura(monkeypatch, {"choices": [{"message": {"content": '```json\n{"type": "Ata"}\n```'}}]})
    dados, _, _ = llm._post(_provedor("openai"), [{"role": "user", "content": "x"}], 600)
    assert dados == {"type": "Ata"}


def test_frase_antes_do_json(monkeypatch):
    from kb_api import llm

    _captura(
        monkeypatch,
        {"choices": [{"message": {"content": 'Aqui está o JSON: {"type": "Ata"} — pronto.'}}]},
    )
    dados, _, _ = llm._post(_provedor("openai"), [{"role": "user", "content": "x"}], 600)
    assert dados == {"type": "Ata"}


def test_resposta_que_nao_e_json_vira_nada(monkeypatch):
    from kb_api import llm

    _captura(monkeypatch, {"choices": [{"message": {"content": "não consegui classificar"}}]})
    dados, _, _ = llm._post(_provedor("openai"), [{"role": "user", "content": "x"}], 600)
    assert dados is None


def test_lista_no_lugar_de_objeto_vira_nada(monkeypatch):
    """Quem consome espera um mapa; uma lista passaria pelo `json.loads` e
    quebraria no primeiro `.get()`."""
    from kb_api import llm

    _captura(monkeypatch, {"choices": [{"message": {"content": '["Norma"]'}}]})
    dados, _, _ = llm._post(_provedor("openai"), [{"role": "user", "content": "x"}], 600)
    assert dados is None


# ── dialeto dos modelos novos ─────────────────────────────────────────────


def _recusa_uma_vez(monkeypatch, mensagem: str, resposta: dict):
    """Recusa o PRIMEIRO pedido com 400 e aceita o segundo. Guarda os dois corpos."""
    import urllib.error

    from kb_api import llm

    corpos: list[dict] = []

    def falso(request, timeout=None):
        corpos.append(json.loads(request.data.decode()))
        if len(corpos) == 1:
            raise urllib.error.HTTPError(
                request.full_url, 400, "bad request", {},
                io.BytesIO(json.dumps({"error": {"message": mensagem}}).encode()),
            )
        return _RespostaFalsa(json.dumps(resposta).encode())

    monkeypatch.setattr(llm.urllib.request, "urlopen", falso)
    monkeypatch.setattr(llm, "ESPERA_SEGUNDOS", 0)
    return corpos


def test_modelo_que_exige_max_completion_tokens_e_reatendido(monkeypatch):
    """O defeito que existia: `gpt-5*` recusava o cadastro correto com 400.

    "Unsupported parameter: \'max_tokens\' is not supported with this model" e o
    provedor dizendo o nome certo do campo. Fazer o operador descobrir isso na
    tela seria cobrar dele o que a recusa ja explica.
    """
    from kb_api import llm

    corpos = _recusa_uma_vez(
        monkeypatch,
        "Unsupported parameter: 'max_tokens' is not supported with this model. "
        "Use 'max_completion_tokens' instead.",
        _OK,
    )
    dados, gasto, erro = llm._post(_provedor("azure_openai"), [{"role": "user", "content": "x"}], 600)

    assert dados == {"type": "Norma"} and erro == "" and gasto.total == 42
    assert corpos[0]["max_tokens"] == 600
    assert "max_tokens" not in corpos[1]
    assert corpos[1]["max_completion_tokens"] == 600


def test_modelo_que_so_aceita_a_temperatura_padrao_e_reatendido(monkeypatch):
    """Mesmo caminho, outro campo: sem o zero, mas com metadado.

    Conceito instavel entre reprocessamentos e pior que o zero -- e muito melhor
    que documento sem conceito nenhum.
    """
    from kb_api import llm

    corpos = _recusa_uma_vez(
        monkeypatch,
        "Unsupported value: 'temperature' does not support 0 with this model. "
        "Only the default (1) is supported.",
        _OK,
    )
    dados, _, erro = llm._post(_provedor("openai"), [{"role": "user", "content": "x"}], 600)

    assert dados == {"type": "Norma"} and erro == ""
    assert corpos[0]["temperature"] == 0
    assert "temperature" not in corpos[1]


def test_o_ajuste_nao_gasta_as_retentativas_de_rede(monkeypatch):
    """Um 400 de campo nao e uma tentativa perdida: o pedido nem foi processado.

    Se gastasse, o modelo novo ficaria com UMA tentativa para toda a instabilidade
    de rede -- e um 429 depois do ajuste derrubaria a derivacao.
    """
    import urllib.error

    from kb_api import llm

    corpos: list[dict] = []

    def falso(request, timeout=None):
        corpos.append(json.loads(request.data.decode()))
        if len(corpos) == 1:
            raise urllib.error.HTTPError(
                request.full_url, 400, "bad request", {},
                io.BytesIO(b'{"error":{"message":"Use \'max_completion_tokens\' instead."}}'),
            )
        if len(corpos) == 2:
            raise urllib.error.HTTPError(request.full_url, 429, "slow down", {}, io.BytesIO(b"{}"))
        return _RespostaFalsa(json.dumps(_OK).encode())

    monkeypatch.setattr(llm.urllib.request, "urlopen", falso)
    monkeypatch.setattr(llm, "ESPERA_SEGUNDOS", 0)

    dados, _, _ = llm._post(_provedor("azure_openai"), [{"role": "user", "content": "x"}], 600)
    assert dados == {"type": "Norma"}
    assert len(corpos) == 3


def test_recusa_que_nao_e_de_campo_conhecido_continua_desistindo(monkeypatch):
    """O ajuste nao pode virar laco: campo desconhecido desiste na hora."""
    import urllib.error

    from kb_api import llm

    chamadas: list = []

    def recusa(request, timeout=None):
        chamadas.append(1)
        raise urllib.error.HTTPError(
            request.full_url, 400, "bad request", {},
            io.BytesIO(b'{"error":{"message":"deployment nao existe"}}'),
        )

    monkeypatch.setattr(llm.urllib.request, "urlopen", recusa)
    monkeypatch.setattr(llm, "ESPERA_SEGUNDOS", 0)

    dados, _, erro = llm._post(_provedor("azure_openai"), [{"role": "user", "content": "x"}], 600)
    assert dados is None and "deployment nao existe" in erro
    assert len(chamadas) == 1


# ── degradacao ────────────────────────────────────────────────────────────


def test_sem_provedor_de_chat_devolve_nada_sem_levantar(monkeypatch):
    from kb_api import llm, providers

    def sem_provedor(purpose="embedding", space=""):
        raise providers.ProviderError("nenhum provedor")

    monkeypatch.setattr(providers, "padrao", sem_provedor)
    assert llm.complete_json("instrucao", "entrada", "teste") is None
    assert llm.disponivel() is False


def test_falha_de_rede_nao_levanta_e_entra_no_contador(monkeypatch):
    """Gasto que nao aparece e gasto que ninguem controla -- inclusive o que falhou."""
    from kb_api import llm, providers

    monkeypatch.setattr(
        providers, "padrao", lambda purpose="embedding", space="": _provedor("openai")
    )
    monkeypatch.setattr(llm, "ESPERA_SEGUNDOS", 0)

    def explode(request, timeout=None):
        raise OSError("connection refused")

    monkeypatch.setattr(llm.urllib.request, "urlopen", explode)

    registrado: list = []
    monkeypatch.setattr(
        providers, "registrar_uso",
        lambda p, op, **kw: registrado.append((op, kw.get("erro"))),
    )

    assert llm.complete_json("instrucao", "entrada", "okf-derive") is None
    assert registrado == [("okf-derive", True)]


# ── teste de cadastro ─────────────────────────────────────────────────────


def test_testar_usa_chat_e_nao_embedding(monkeypatch):
    """O defeito que existia: o botao "Testar" mandava um embedding.

    Num modelo de chat isso devolve `OperationNotSupported` do proprio Azure --
    um erro verdadeiro sobre uma pergunta que ninguem fez, que fazia um cadastro
    correto parecer quebrado na tela.
    """
    from kb_api import llm

    visto = _captura(monkeypatch, _OK)
    ok, erro, tokens = llm.testar(_provedor("azure_openai"))

    assert ok is True and erro == "" and tokens == 42
    assert "/chat/completions" in visto["url"]
    assert "embeddings" not in visto["url"]
    # Poucos tokens: o teste confirma que o modelo RESPONDE, nao que escreve bem.
    assert visto["body"]["max_tokens"] <= 64


def test_testar_devolve_o_texto_do_erro_do_provedor(monkeypatch):
    """"Nao deu" nao e diagnostico.

    Chave errada, deployment inexistente e modelo sem JSON mode sao tres causas
    diferentes, e o provedor diz qual e em cada uma.
    """
    import io
    import urllib.error

    from kb_api import llm

    def recusa(request, timeout=None):
        raise urllib.error.HTTPError(
            request.full_url, 404, "nao achou", {},
            io.BytesIO(b'{"error":{"message":"deployment nao existe"}}'),
        )

    monkeypatch.setattr(llm.urllib.request, "urlopen", recusa)
    ok, erro, _ = llm.testar(_provedor("azure_openai"))
    assert ok is False
    assert "404" in erro and "deployment nao existe" in erro


def test_testar_nunca_levanta(monkeypatch):
    from kb_api import llm

    def explode(request, timeout=None):
        raise OSError("connection refused")

    monkeypatch.setattr(llm, "ESPERA_SEGUNDOS", 0)
    monkeypatch.setattr(llm.urllib.request, "urlopen", explode)
    ok, erro, _ = llm.testar(_provedor("openai"))
    assert ok is False and "rede" in erro

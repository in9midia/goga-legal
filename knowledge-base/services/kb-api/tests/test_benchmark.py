"""Avaliação offline: o que o benchmark promete e o que já quebrou nele.

Os testes de LLM de verdade não moram aqui — eles exigem provedor e são a
verificação manual descrita em `docs/testes.md`. O que este arquivo protege é o
que é lógica pura e falha em silêncio: a agregação, o diagnóstico e a adaptação
de dialeto do juiz.
"""
from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from kb_api import benchmark
from kb_api.ragas_client import TransporteAdaptativo

# ── agregação ─────────────────────────────────────────────────────────────


def test_media_harmonica_penaliza_a_metrica_baixa():
    """É por isso que a especificação pede harmônica, e não aritmética.

    Quatro métricas perfeitas e uma zerada: a aritmética diria 0,80 e a execução
    pareceria boa. Um sistema que não recupera o contexto certo não é 80% bom.
    """
    valores = {"a": 1.0, "b": 1.0, "c": 1.0, "d": 1.0, "e": 0.0}
    assert sum(valores.values()) / len(valores) == pytest.approx(0.8)
    assert benchmark.media_harmonica(valores) == 0.0

    # E ela continua sendo uma média quando ninguém está mal.
    assert benchmark.media_harmonica({"a": 1.0, "b": 1.0}) == pytest.approx(1.0)
    assert benchmark.media_harmonica({}) is None
    # Métrica que falhou não vira zero: ela não entra na conta.
    assert benchmark.media_harmonica({"a": 1.0, "b": {"erro": "429"}}) == pytest.approx(1.0)


# ── diagnóstico ───────────────────────────────────────────────────────────


def test_o_diagnostico_separa_recuperador_de_gerador():
    """Os três cenários, com os números medidos contra o provedor real.

    `faithfulness` cai nos DOIS casos ruins — ela sozinha não distingue. Quem
    distingue é o contexto: com contexto bom e resposta ruim a culpa é do
    gerador; com contexto ruim não adianta mexer no prompt de resposta.
    """
    bom = {"context_precision": 1.0, "context_recall": 1.0,
           "faithfulness": 1.0, "answer_relevancy": 0.741, "answer_correctness": 0.950}
    resposta_ruim = {"context_precision": 1.0, "context_recall": 1.0,
                     "faithfulness": 0.0, "answer_relevancy": 0.612,
                     "answer_correctness": 0.124}
    contexto_ruim = {"context_precision": 0.0, "context_recall": 0.0,
                     "faithfulness": 0.0, "answer_relevancy": 0.733,
                     "answer_correctness": 0.950}

    assert benchmark.diagnosticar(bom) == "ok"
    assert benchmark.diagnosticar(resposta_ruim) == "gerador"
    assert benchmark.diagnosticar(contexto_ruim) == "recuperador"


def test_contexto_ruim_ganha_do_gerador_ruim_no_diagnostico():
    """Quando os dois estão mal, o recuperador vem primeiro.

    Não é desempate arbitrário: sem contexto certo não existe resposta certa
    possível, e mandar alguém mexer no prompt do gerador nesse caso é mandar
    para o lugar errado.
    """
    tudo_mal = {"context_precision": 0.1, "context_recall": 0.0,
                "faithfulness": 0.0, "answer_relevancy": 0.1, "answer_correctness": 0.0}
    assert benchmark.diagnosticar(tudo_mal) == "recuperador"


def test_o_modo_recuperacao_diagnostica_sem_as_metricas_de_gerador():
    """O modo barato não tem resposta, e mesmo assim precisa apontar."""
    assert benchmark.diagnosticar({"context_precision": 0.9, "context_recall": 0.85}) == "ok"
    assert benchmark.diagnosticar({"context_precision": 0.1, "context_recall": 0.0}) == (
        "recuperador"
    )


def test_as_metricas_sao_as_cinco_da_especificacao():
    """taxonomy §7 nomeia estas cinco, e a divisão entre elas é o diagnóstico."""
    assert set(benchmark.METRICAS) == {
        "faithfulness", "answer_relevancy", "context_precision",
        "context_recall", "answer_correctness",
    }
    assert set(benchmark.METRICAS_RECUPERADOR) == {"context_precision", "context_recall"}
    assert set(benchmark.METRICAS_GERADOR) == {
        "faithfulness", "answer_relevancy", "answer_correctness"
    }


# ── adaptação de dialeto do juiz ──────────────────────────────────────────


class _TransporteFalso(httpx.AsyncBaseTransport):
    """Um servidor que recusa parâmetros um a um, como o Azure faz."""

    def __init__(self, recusa: list[str]):
        self.recusa = list(recusa)
        self.corpos: list[dict] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        corpo = json.loads(request.content or b"{}")
        self.corpos.append(corpo)
        for parametro in self.recusa:
            if parametro in corpo:
                return httpx.Response(
                    400,
                    json={"error": {"message":
                                    f"Unsupported parameter: '{parametro}' is not supported "
                                    f"with this model."}},
                    request=request,
                )
        return httpx.Response(200, json={"ok": True}, request=request)


def _mandar(transporte: TransporteAdaptativo, corpo: dict) -> httpx.Response:
    """`asyncio.run` em vez de plugin de teste assíncrono.

    O projeto não tem `pytest-asyncio` nem `anyio` configurado, e trazer um
    plugin para quatro testes seria uma dependência a mais no gate por
    conveniência de escrita.
    """
    pedido = httpx.Request(
        "POST", "https://exemplo/openai/deployments/m/chat/completions",
        json=corpo,
    )
    return asyncio.run(transporte.handle_async_request(pedido))


def test_o_juiz_aprende_o_que_o_modelo_recusa():
    falso = _TransporteFalso(["max_tokens", "top_p", "temperature"])
    transporte = TransporteAdaptativo(falso)

    resposta = _mandar(transporte, {"max_tokens": 100, "top_p": 1, "temperature": 0.01})
    assert resposta.status_code == 200
    assert transporte.proibidos == {"max_tokens", "top_p", "temperature"}
    # `max_tokens` tem substituto: teto de tokens sem teto nenhum faria o juiz
    # gastar o orçamento inteiro num caso só.
    assert falso.corpos[-1]["max_completion_tokens"] == 100
    assert "top_p" not in falso.corpos[-1] and "temperature" not in falso.corpos[-1]

    # A segunda chamada já sai adaptada: o aprendizado economiza a ida extra.
    antes = len(falso.corpos)
    resposta = _mandar(transporte, {"max_tokens": 50, "top_p": 1, "temperature": 0.01})
    assert resposta.status_code == 200
    assert len(falso.corpos) - antes == 1


def test_o_juiz_nao_desiste_por_causa_de_corrida_entre_perguntas():
    """Regressão do defeito que fez `context_precision` falhar em 2 de 4.

    O controle de laço era pelo conjunto COMPARTILHADO: se o parâmetro recusado
    já estivesse lá, a requisição desistia. Com quatro perguntas em paralelo, a
    requisição B saía com o corpo montado antes de A aprender — e quando B levava
    a recusa, o parâmetro já estava no conjunto, então B devolvia o 400.

    Estar no conjunto não prova que ESTA requisição foi adaptada.
    """
    falso = _TransporteFalso(["top_p"])
    transporte = TransporteAdaptativo(falso)
    # Simula o que a concorrência causa: outra pergunta já aprendeu `top_p`.
    transporte._proibidos.add("top_p")

    # Esta requisição ainda traz `top_p` (foi montada antes). Antes do conserto
    # ela voltava 400; agora é adaptada e passa.
    resposta = _mandar(transporte, {"top_p": 1})
    assert resposta.status_code == 200


def test_400_que_nao_e_de_parametro_volta_como_erro():
    """Prompt inválido ou deployment errado é definitivo: insistir só atrasa."""
    class Quatrocentos(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request):
            return httpx.Response(
                400, json={"error": {"message": "deployment nao encontrado"}}, request=request
            )

    resposta = _mandar(TransporteAdaptativo(Quatrocentos()), {"max_tokens": 1})
    assert resposta.status_code == 400


# ── as duas estratégias de geração ────────────────────────────────────────


def test_a_pergunta_dificil_e_instruida_a_nao_reusar_o_vocabulario():
    """É a regra que faz a diferença, e ela veio de uma medição.

    A primeira execução só com perguntas diretas deu `context_recall` = 1,0 em
    16 de 16. Não era o recuperador indo bem: a pergunta gerada herda as
    palavras do documento ("em qual tela cadastro Grupos de Descontos?"), e o
    braço lexical acha por coincidência de termo, sem entender nada. Um
    benchmark em que o recuperador não pode errar não mede recuperador.
    """
    from kb_api.benchmark import _INSTRUCAO_DIFICIL, ESTRATEGIAS, TIPOS_DIFICEIS

    assert set(ESTRATEGIAS) == {"direta", "dificil"}
    texto = _INSTRUCAO_DIFICIL.lower()
    assert "não use as palavras do documento" in texto
    # Nome de tela e título de seção são os atalhos que fazem a busca acertar
    # sem entender — por isso a instrução os proíbe explicitamente.
    assert "nunca cite nome de tela" in texto
    # O vocabulário de tipos é FIXO, e cada um tem de aparecer na instrução:
    # tipo que o prompt não explica o modelo não usa, e a etiqueta fica vazia.
    for tipo in TIPOS_DIFICEIS:
        assert f'"{tipo}"' in _INSTRUCAO_DIFICIL, tipo


def test_o_titulo_nao_vai_junto_na_estrategia_dificil():
    """O título é a fonte mais forte de vocabulário emprestado.

    Medido na estratégia direta: saiu "Como acesso a tela Plano Didático e
    Pedagógico?" — que é o título do arquivo, palavra por palavra.
    """
    import inspect

    from kb_api import benchmark

    fonte = inspect.getsource(benchmark.gerar_perguntas)
    assert 'cabecalho = "" if estrategia == "dificil"' in fonte


def test_o_tipo_fora_do_vocabulario_vira_vazio():
    """Rótulo inventado agruparia errado; vazio não mente.

    Mesma regra dos tipos OKF: com texto livre, quarenta perguntas rendem trinta
    rótulos quase-iguais e a etiqueta deixa de agrupar qualquer coisa.
    """
    from kb_api.benchmark import TIPOS_DIFICEIS

    assert "parafrase" in TIPOS_DIFICEIS
    assert "multi_salto" in TIPOS_DIFICEIS
    # E o conjunto é pequeno de propósito: seis categorias que uma pessoa
    # consegue distinguir ao olhar o relatório.
    assert len(TIPOS_DIFICEIS) <= 8


def test_a_pergunta_que_aponta_para_o_nada_e_recusada_na_origem():
    """Regressão do que contaminou a primeira medição de perguntas difíceis.

    Três dos cinco fracassos inspecionados não eram falha de busca: eram
    perguntas escritas como se continuassem o documento. Enquanto elas entram no
    conjunto, a nota mistura falha real com pergunta impossível — e a conclusão
    "a busca está ruim" não se sustenta.

    Instrução no prompt não basta: o modelo escreveu assim mesmo. Por isso a
    trava é determinística, e roda antes de gravar.
    """
    from kb_api.benchmark import autossuficiente

    # Os casos REAIS que passaram e não deviam.
    assert not autossuficiente(
        "O que acontece com lançamentos ainda dentro do prazo quando essa configuração é ativada?"
    )
    assert not autossuficiente(
        "Depois de informar os dados exigidos e acionar o processamento, "
        "o que acontece com essa solicitação?"
    )
    assert not autossuficiente("Nesse caso, quem aprova o pedido?")

    # E a regra é ESTREITA de propósito: ela não julga se a pergunta é boa (isso
    # é a curadoria humana), só se ela referencia o que não está nela.
    assert autossuficiente(
        "Como habilitar a contestação de cobranças cujo prazo de pagamento já venceu?"
    )
    assert autossuficiente("Qual a diferença entre matrícula e pré-matrícula?")
    # Demonstrativo com antecedente DENTRO da pergunta continua passando: aqui
    # "esse período" se refere a "um período do calendário", dito antes.
    assert autossuficiente(
        "Depois de achar um período do calendário, como faço ele valer numa unidade?"
    )


# ── melhoria de query (BUS-02) ────────────────────────────────────────────


def test_os_dois_slots_de_query_agem_em_lugares_diferentes():
    """F1 muda o TEXTO (vale para o lexical); F3 muda o VETOR (só o semântico).

    Juntá-los seria errado na prática: o HyDE gera um parágrafo hipotético de
    cem palavras, e mandar esse parágrafo para o braço lexical encheria a
    consulta de termos inventados pelo modelo.
    """
    import inspect

    from kb_api import query, search

    assert set(query.REESCRITAS) == {"nenhuma", "rewrite", "step_back"}
    assert set(query.EMBEDDINGS_DE_QUERY) == {"crua", "hyde"}

    # O semântico é o único que recebe o texto do vetor.
    fonte = inspect.getsource(search.search)
    assert 'if metodo == "semantica" and alvo_do_vetor != texto_da_busca:' in fonte


def test_a_melhoria_de_query_nasce_desligada():
    """A especificação manda, e a latência medida confirma: 377 ms → 9,2 s."""
    import inspect

    from kb_api import search

    assinatura = inspect.signature(search.search)
    assert assinatura.parameters["reescrita"].default == "nenhuma"
    assert assinatura.parameters["embedding_query"].default == "crua"


def test_falha_do_modelo_devolve_a_pergunta_original(monkeypatch):
    """Busca com pergunta crua é pior que com a melhorada, e MUITO melhor que
    busca que não aconteceu — a mesma regra do método de acesso que cai."""
    from kb_api import query

    monkeypatch.setattr(query, "complete_json", lambda *a, **k: None)
    texto, trace = query.reescrever("como tirar férias", "rewrite")
    assert texto == "como tirar férias"
    assert trace["aplicada"] is False

    alvo, trace = query.texto_para_vetor("como tirar férias", "hyde")
    assert alvo == "como tirar férias"
    assert trace["embedding_query"] == "crua"


def test_o_hyde_leva_a_pergunta_junto(monkeypatch):
    """Vetorizar só o texto inventado joga fora o sinal da pergunta real — e
    quando o modelo inventa para o lado errado, o vetor vai junto."""
    from kb_api import query
    from kb_api.llm import Resposta

    monkeypatch.setattr(
        query, "complete_json",
        lambda *a, **k: Resposta(dados={"texto": "Na tela X o usuário faz Y."},
                                 tokens=10, latency_ms=1, model="falso"),
    )
    alvo, trace = query.texto_para_vetor("como faço isso?", "hyde")
    assert alvo.startswith("como faço isso?")
    assert "Na tela X" in alvo
    assert trace["hyde_aplicado"] is True

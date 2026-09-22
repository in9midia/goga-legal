"""Avaliacao offline: dataset golden e execucoes com metricas Ragas (FUN-07).

O QUE ESTE PLANO RESPONDE, E O QUE ELE NAO RESPONDE

A especificacao separa quatro planos transversais (conceptual-model §5). A
telemetria responde "quanto custou e demorou"; este arquivo responde a outra
pergunta, **"quao boa e a resposta?"**, e ela so se responde periodicamente,
contra um conjunto curado, nao por consulta.

DUAS FASES DESACOPLADAS, COMO A ESPECIFICACAO PEDE

1. **Geracao** -- a LLM le documentos reais da base e propoe perguntas com
   resposta de referencia. Elas nascem `rascunho`: "geracao assistida por LLM e
   SELECAO HUMANA". Dataset golden que ninguem leu nao e golden, e a nota que
   sai dele mede o gerador de perguntas, nao a base.
2. **Avaliacao** -- uma execucao roda as perguntas aprovadas e grava as notas.

Sao fases separadas porque tem ritmos diferentes: o dataset muda devagar e as
execucoes se repetem a cada mudanca de configuracao. E a repeticao sobre o MESMO
dataset que permite comparar tecnicas entre si, que e o objetivo declarado.

DOIS MODOS, E A DIFERENCA E DE CUSTO

* `recuperacao` mede so o recuperador: `context_precision` e `context_recall`.
  Nao sintetiza resposta, entao custa duas chamadas de juiz por pergunta.
* `completo` sintetiza uma resposta a partir das passagens e mede as cinco.

O gerador de resposta existe **so aqui**. Em producao o sistema devolve
evidencia, nao resposta (ADR-0006) -- mas nao da para medir `faithfulness` sem
uma resposta para medir, e a especificacao pede o diagnostico do gerador
separado do diagnostico do recuperador.

O CUSTO E REAL, E FOI MEDIDO

Contra o provedor em uso (`gpt-5.6-luna`), uma metrica sozinha leva de 8 a 53 s.
Cinco metricas por pergunta, dezenas de perguntas: uma execucao completa e
questao de dezenas de minutos. Por isso ela roda em segundo plano com progresso,
e por isso as perguntas rodam em paralelo.
"""
from __future__ import annotations

import asyncio
import logging
import re
import threading
import time
from typing import Any

from . import providers, search
from .db import conn, jsonb
from .llm import complete_json

log = logging.getLogger(__name__)

# ── vocabulario ───────────────────────────────────────────────────────────

MODOS = ("recuperacao", "completo")

# As cinco da especificacao (taxonomy §7), com a separacao que da o diagnostico.
METRICAS_RECUPERADOR = ("context_precision", "context_recall")
METRICAS_GERADOR = ("faithfulness", "answer_relevancy", "answer_correctness")
METRICAS = METRICAS_RECUPERADOR + METRICAS_GERADOR

# Quantas perguntas sao avaliadas ao mesmo tempo.
#
# Quatro, e nao "o maximo que der": cada pergunta dispara varias chamadas ao
# provedor, e o provedor e compartilhado com a ingestao e com a busca de quem
# esta usando o sistema. Uma execucao de benchmark nao pode consumir a cota
# inteira e fazer a busca de producao comecar a levar 429.
MAX_PARALELO = 4

# Teto de passagens que viram contexto. E o mesmo top-k da busca: medir com 40
# passagens e depois entregar 10 mediria outro sistema.
TOP_K = 10

# Tamanho do trecho de documento que vai para o gerador de perguntas. Documento
# inteiro estoura o contexto e dilui: a pergunta sai generica ("do que trata o
# documento?"), que nao mede recuperacao nenhuma.
JANELA_GERACAO = 6000


# ── diagnostico: onde esta o problema ─────────────────────────────────────

# Os limiares abaixo nao sao calibrados -- sao o ponto de partida declarado. O
# projeto ja tem uma regra para isso (ADR-0017): numero chutado esconde
# resultado bom, e o valor definitivo vem da medicao. Estao aqui no codigo, e
# nao no banco, porque mudar um limiar precisa aparecer no diff.
LIMIAR_BOM = 0.7
LIMIAR_RUIM = 0.4


def diagnosticar(metricas: dict[str, float]) -> str:
    """Onde esta o problema, pelo PADRAO das metricas.

    A ideia inteira da separacao retriever/gerador esta aqui, e ela foi
    verificada com tres cenarios construidos de proposito, contra o provedor
    real:

    | cenario                       | faithfulness | ctx_prec | ctx_recall | correctness |
    |-------------------------------|--------------|----------|------------|-------------|
    | resposta boa, contexto certo  | 1,000        | 1,000    | 1,000      | 0,950       |
    | resposta ruim, contexto certo | 0,000        | 1,000    | 1,000      | 0,124       |
    | resposta boa, contexto errado | 0,000        | 0,000    | 0,000      | 0,950       |

    Repare que `faithfulness` cai nos DOIS casos ruins -- ela sozinha nao
    distingue. Quem distingue e o contexto: com contexto bom e resposta ruim, a
    culpa e do gerador; com contexto ruim, a culpa e do recuperador, e nao
    adianta mexer no prompt de resposta.
    """
    def media(nomes: tuple[str, ...]) -> float | None:
        valores = [metricas[n] for n in nomes if isinstance(metricas.get(n), (int, float))]
        return sum(valores) / len(valores) if valores else None

    recuperador = media(METRICAS_RECUPERADOR)
    gerador = media(METRICAS_GERADOR)

    if recuperador is not None and recuperador < LIMIAR_RUIM:
        # Sem contexto certo nao ha resposta certa possivel. Este caso vem
        # primeiro de proposito: mexer no gerador aqui e trabalho jogado fora.
        return "recuperador"
    if gerador is not None and gerador < LIMIAR_RUIM:
        return "gerador"
    if recuperador is not None and recuperador < LIMIAR_BOM:
        return "recuperador_fraco"
    if gerador is not None and gerador < LIMIAR_BOM:
        return "gerador_fraco"
    return "ok"


def media_harmonica(valores: dict[str, float]) -> float | None:
    """Agregacao da especificacao: "media harmonica, penalizando qualquer
    metrica individual baixa".

    E o ponto do harmonico: com aritmetica, quatro metricas em 1,0 e uma em 0,0
    dariam 0,80 e a execucao pareceria boa. Com harmonica da ZERO, que e a
    leitura honesta -- um sistema que nao recupera o contexto certo nao e 80%
    bom.
    """
    numeros = [v for v in valores.values() if isinstance(v, (int, float))]
    if not numeros:
        return None
    if any(v <= 0 for v in numeros):
        return 0.0
    return len(numeros) / sum(1.0 / v for v in numeros)


# ── fase 1: geracao de perguntas ──────────────────────────────────────────

# ── as duas estrategias de geracao ────────────────────────────────────────
#
# POR QUE DUAS, E O QUE A MEDICAO MOSTROU
#
# A primeira execucao completa sobre 275 manuais devolveu `context_recall` = 1,0
# em TODAS as dezesseis perguntas. Nao era o recuperador indo bem: era o dataset
# ser facil por construcao. A pergunta gerada herda o VOCABULARIO do documento
# ("em qual tela cadastro Grupos de Descontos?"), entao o braco lexical acha o
# documento por coincidencia de palavra -- sem entender nada.
#
# Um benchmark em que o recuperador nao pode errar nao mede recuperador.
#
# `direta` continua existindo, e nao e a versao ruim: ela e a linha de base
# barata, e cobre o caso comum de quem pergunta usando os termos do manual.
# `dificil` existe para atacar exatamente o que a direta deixa passar.

ESTRATEGIAS = ("direta", "dificil")

# Vocabulario FIXO dos tipos de dificuldade. Fixo pela mesma razao dos tipos OKF:
# com texto livre, quarenta perguntas rendem trinta rotulos quase-iguais e a
# etiqueta deixa de agrupar. E saber QUAL dificuldade quebra a base importa --
# parafrase e problema de embedding, multi-salto e problema de recuperar uma
# passagem so, e os consertos sao diferentes.
TIPOS_DIFICEIS = (
    "parafrase",      # as palavras de quem pergunta, nao as do documento
    "excecao",        # a condicao em que a regra NAO vale
    "limite",         # o numero, o teto, o prazo -- o que a resposta generica erra
    "multi_salto",    # exige juntar dois pontos distantes do texto
    "consequencia",   # o que acontece se
    "distincao",      # a diferenca entre dois casos parecidos
)


def classificar(estrategia: object, tipo: object) -> tuple[str, str]:
    """Estrategia e tipo de uma pergunta CADASTRADA A MAO.

    POR QUE A PERGUNTA MANUAL PRECISA DIZER A ESTRATEGIA

    Ate aqui so a pergunta GERADA carregava estrategia, e a cadastrada a mao caia
    em `direta` por default da coluna. Isso funcionava enquanto o conjunto manual
    era pequeno e homogeneo. Deixa de funcionar quando o conjunto e desenhado com
    DUAS VOZES de proposito -- a de quem tem o problema e a de quem conhece o
    vocabulario tecnico -- porque as duas entram no mesmo `direta` e o relatorio
    por estrategia passa a comparar um grupo consigo mesmo. A separacao e a razao
    de a coluna existir (migracao 0010); sem esta funcao ela so valia para metade
    do dataset.

    Tolerante por default e NAO por descuido: quem cadastra uma pergunta solta na
    tela nao precisa saber do vocabulario, e a ausencia cai em `direta`, que e o
    que a coluna ja fazia. O que nao passa e valor DESCONHECIDO -- ai o silencio
    criaria um grupo fantasma no relatorio, que e o problema que o vocabulario
    fixo existe para impedir.
    """
    nome = str(estrategia or "").strip() or ESTRATEGIAS[0]
    if nome not in ESTRATEGIAS:
        raise ValueError(
            f"estrategia desconhecida: {nome}. Use {', '.join(ESTRATEGIAS)}"
        )
    rotulo = str(tipo or "").strip()
    if rotulo and rotulo not in TIPOS_DIFICEIS:
        raise ValueError(
            f"tipo de dificuldade desconhecido: {rotulo}. Use {', '.join(TIPOS_DIFICEIS)}"
        )
    # Tipo de dificuldade numa pergunta `direta` seria rotulo sem grupo: o
    # relatorio agrupa por tipo DENTRO do conjunto dificil, e um `limite` solto
    # no conjunto direto apareceria como se fosse do outro grupo.
    if nome != "dificil":
        rotulo = ""
    return nome, rotulo


_INSTRUCAO_GERACAO ="""Você lê um trecho de um documento corporativo e escreve perguntas que uma pessoa da empresa faria, e que este trecho responde.

Regras:
- a pergunta tem de ser respondível SÓ com o trecho. Se precisar de algo que não está aí, não faça a pergunta;
- escreva como alguém pergunta de verdade ("como faço para...", "quem aprova...", "qual o prazo de..."), não como um título;
- NÃO use o nome do arquivo nem cite "o documento": a pergunta é sobre o assunto, não sobre o papel. Uma pergunta que repete o nome do arquivo é achada pela busca por acidente e não mede nada;
- a resposta de referência é curta (1 a 3 frases), factual, e sai DO TRECHO — não invente nada;
- prefira o que tem número, prazo, nome de tela, condição ou exceção: é o que distingue uma base que funciona de uma que devolve genérico.

Responda um objeto JSON: {"perguntas": [{"pergunta": "...", "resposta": "..."}]}"""

_INSTRUCAO_DIFICIL = """Você lê um trecho de documento corporativo e escreve perguntas DIFÍCEIS para um sistema de busca — perguntas que só serão respondidas se o sistema realmente entender o conteúdo, e não se ele apenas casar palavras.

O QUE TORNA UMA PERGUNTA DIFÍCIL AQUI

A regra mais importante: **não use as palavras do documento**. Use as palavras de quem tem o problema, não as de quem escreveu o manual. Se o texto diz "Grupos de Descontos", pergunte sobre "abatimento na mensalidade". Se o texto diz "Execução de Processos em lote", pergunte "como faço isso para a turma inteira de uma vez". Uma pergunta que repete os termos do documento é encontrada por coincidência de palavra, e não mede nada.

Nunca cite nome de tela, código de tela, título de seção nem nome de arquivo. Esses são justamente os atalhos que fazem a busca acertar sem entender.

Escolha para cada pergunta UM tipo de dificuldade, desta lista:
- "parafrase": o assunto do trecho, dito inteiramente com outras palavras;
- "excecao": o caso em que a regra NÃO se aplica, ou quem fica de fora;
- "limite": o número, o prazo, o teto, o mínimo — o que uma resposta genérica erra;
- "multi_salto": exige juntar dois pontos distantes do trecho para responder;
- "consequencia": o que acontece se alguém fizer (ou deixar de fazer) algo;
- "distincao": a diferença entre dois casos parecidos descritos no trecho.

A PERGUNTA PRECISA SE SUSTENTAR SOZINHA — ESTA É A REGRA QUE MAIS SE ERRA

Quem lê a pergunta não viu o documento. Ela tem de dizer sobre O QUE está perguntando, com palavras próprias, sem apontar para nada fora dela.

- **nunca** use "essa", "esse", "esta", "este", "aquele", "nesse caso", "dessa configuração": não há antecedente nenhum. Nomeie a coisa;
- **nunca** escreva como se continuasse o documento ("depois de informar os dados exigidos...", "quando essa opção é ativada...");
- **teste antes de responder**: se a pergunta caberia em dez documentos diferentes de um sistema acadêmico, ela está vaga demais. Refaça nomeando o assunto.

Exemplos REAIS de perguntas ruins, que passaram e não deviam:

- ✗ "O que acontece com lançamentos ainda dentro do prazo quando essa configuração é ativada?" — que configuração? ninguém responde isso;
- ✗ "Depois de informar os dados exigidos e acionar o processamento, o que acontece com essa solicitação?" — serve para qualquer tela de processamento em lote;
- ✗ "Em que parte da listagem é possível entender melhor o conteúdo de cada opção financeira?" — que listagem?

E as boas, difíceis E autossuficientes:

- ✓ "Como habilitar a contestação de cobranças cujo prazo de pagamento já venceu?" — não usa os termos do manual, e diz exatamente sobre o que pergunta;
- ✓ "Depois de achar um período do calendário acadêmico, como faço ele valer só para uma das unidades da instituição?" — paráfrase, e sozinha de pé.

REGRAS QUE CONTINUAM VALENDO

- a pergunta tem de ser respondível SÓ com o trecho. Se a resposta não está aí, não faça a pergunta — pergunta sem resposta no material mede cobertura de conteúdo, não qualidade de busca;
- a resposta de referência sai DO TRECHO, curta (1 a 3 frases) e factual. Ela PODE usar os termos do documento: quem precisa despistar é a pergunta, não o gabarito;
- prefira o que é específico e verificável. "Do que trata este assunto?" não serve.

Responda um objeto JSON: {"perguntas": [{"pergunta": "...", "resposta": "...", "tipo": "..."}]}"""


# Demonstrativo numa pergunta SOLTA quase sempre aponta para o nada.
#
# Isto e uma trava deterministica, e ela existe porque instrucao no prompt nao
# basta: medido, o modelo produziu "O que acontece com lancamentos ainda dentro
# do prazo quando ESSA CONFIGURACAO e ativada?" -- escrito como se continuasse o
# documento. Tres dos cinco fracassos que inspecionei eram deste tipo, o que
# contaminava a nota: metade do que parecia falha de busca era pergunta
# impossivel.
#
# A regra e estreita de proposito. Nao tenta julgar se a pergunta e boa (isso e
# a curadoria humana, e a tela existe para ela); tenta pegar so o caso em que a
# pergunta REFERENCIA algo que nao esta nela. Numa pergunta de uma frase, um
# demonstrativo seguido de substantivo generico nao tem a que se referir.
_DEMONSTRATIVOS = r"(?:ess[ae]s?|est[ae]s?|aquel[ae]s?|dess[ae]s?|ness[ae]s?|dest[ae]s?|nest[ae]s?)"
_GENERICOS = (
    r"(?:configura(?:ção|cao)|op(?:ção|cao)|tela|campo|processo|procedimento|recurso|"
    r"funcionalidade|item|solicita(?:ção|cao)|listagem|rotina|parametro|par(?:â|a)metro|"
    r"informa(?:ção|cao)|dado|registro|cadastro|etapa|passo|caso|situa(?:ção|cao)|"
    r"altera(?:ção|cao)|marca(?:ção|cao)|grid|coluna|se(?:ção|cao)|aba|bot(?:ã|a)o)"
)
_APONTA_PARA_O_NADA = re.compile(rf"\b{_DEMONSTRATIVOS}\s+{_GENERICOS}", re.IGNORECASE)


def autossuficiente(pergunta: str) -> bool:
    """A pergunta se sustenta sem o documento na frente?

    Devolve `False` para a que aponta para algo que nao esta nela. Ver
    `_APONTA_PARA_O_NADA` para por que a regra e so essa.
    """
    return _APONTA_PARA_O_NADA.search(pergunta or "") is None


# Progresso das geracoes em andamento, por Espaco. Em memoria, como o
# reprocessamento: o que precisa sobreviver -- as perguntas -- esta no banco.
_geracoes: dict[str, dict[str, Any]] = {}


def estado_geracao(space_slug: str) -> dict[str, Any] | None:
    with _trava:
        atual = _geracoes.get(space_slug)
        return {k: v for k, v in atual.items() if k != "cancelar"} if atual else None


def cancelar_geracao(space_slug: str) -> bool:
    with _trava:
        atual = _geracoes.get(space_slug)
        if atual is None:
            return False
        atual["cancelar"] = True
        return True


# Documento que ainda NAO tem pergunta desta estrategia.
#
# E o que faz "gerar" ser incremental em vez de sorteio. Antes, cada rodada
# sorteava do acervo inteiro: com 275 documentos e lotes de cinco, a chance de
# repetir crescia a cada rodada e a cobertura andava devagar e ao acaso. Agora
# rodar de novo SEMPRE avanca, e rodar depois de subir documentos novos pega so
# os novos -- o que resolve tambem o caso de manter o conjunto em dia sem
# acoplar isso a ingestao.
#
# `length(canonical_md) > 400` porque documento minusculo (capa, indice) rende
# pergunta generica, que nao mede recuperacao nenhuma.
_DOCUMENTOS_PENDENTES = """
SELECT d.id, d.title, d.filename, d.canonical_md
  FROM document d
 WHERE d.space_slug = %s AND d.active AND d.status = 'indexed'
   AND length(d.canonical_md) > 400
   AND NOT EXISTS (
        SELECT 1 FROM benchmark_question q
         WHERE q.document_id = d.id AND q.strategy = %s
   )
 {ordem}
 {limite}
"""


def pendentes(space_slug: str, estrategia: str) -> int:
    """Quantos documentos ainda nao tem pergunta desta estrategia."""
    with conn() as connection, connection.cursor() as cur:
        cur.execute(_DOCUMENTOS_PENDENTES.format(ordem="", limite=""), (space_slug, estrategia))
        return len(cur.fetchall())


def gerar_perguntas(space_slug: str, quantidade: int | None, por_quem: str = "",
                    estrategia: str = "direta") -> dict[str, Any]:
    """Propoe perguntas a partir de documentos reais da base.

    `quantidade` e um LOTE, e nao um teto do conjunto: sao quantos documentos
    ainda-sem-pergunta entram nesta rodada. `None` quer dizer todos os pendentes.

    `estrategia` escolhe entre tirar a pergunta do conteudo como ele esta
    (`direta`) ou derivar uma pergunta que nao reusa o vocabulario do documento
    (`dificil`). Ver `ESTRATEGIAS` para o porque das duas.
    """
    if estrategia not in ESTRATEGIAS:
        estrategia = "direta"
    instrucao = _INSTRUCAO_DIFICIL if estrategia == "dificil" else _INSTRUCAO_GERACAO
    with conn() as connection, connection.cursor() as cur:
        cur.execute(
            _DOCUMENTOS_PENDENTES.format(
                # Aleatoria no lote parcial, para uma amostra parcial nao ser
                # sempre os mesmos primeiros; por id quando e o acervo inteiro.
                ordem="ORDER BY random()" if quantidade else "ORDER BY d.id",
                limite="LIMIT %s" if quantidade else "",
            ),
            (space_slug, estrategia, quantidade) if quantidade else (space_slug, estrategia),
        )
        documentos = cur.fetchall()

    if not documentos:
        return {"status": "vazio", "criadas": 0,
                "erro": ("todos os documentos desta base já têm pergunta desta estratégia. "
                         "Suba documentos novos, ou gere com a outra estratégia.")}

    with _trava:
        _geracoes[space_slug] = {"space": space_slug, "estrategia": estrategia,
                                 "total": len(documentos), "done": 0, "criadas": 0,
                                 "descartadas": 0, "status": "running", "cancelar": False}

    criadas = 0
    sem_resposta = 0
    descartadas = 0
    for doc_id, titulo, filename, canonico in documentos:
        with _trava:
            if _geracoes.get(space_slug, {}).get("cancelar"):
                break
        # Uma pergunta por documento por chamada: pedir cinco de um trecho so
        # rende variacoes da mesma pergunta, e o dataset fica com cinco vezes o
        # tamanho e uma vez a cobertura.
        # O titulo NAO vai junto na estrategia dificil: ele e a fonte mais forte
        # de vocabulario emprestado, e o modelo o copia para a pergunta sem
        # perceber. Medido na direta: perguntas como "Como acesso a tela Plano
        # Didatico e Pedagogico?" -- que e o titulo do arquivo, palavra por
        # palavra, e por isso achado pelo braco lexical sem esforco nenhum.
        cabecalho = "" if estrategia == "dificil" else f"Documento: {titulo or filename}\n\n"
        resposta = complete_json(
            instrucao,
            f"{cabecalho}{(canonico or '')[:JANELA_GERACAO]}",
            "benchmark_geracao",
            space=space_slug,
        )
        with _trava:
            if space_slug in _geracoes:
                _geracoes[space_slug].update(done=_geracoes[space_slug]["done"] + 1,
                                             criadas=criadas, descartadas=descartadas)
        if resposta is None:
            sem_resposta += 1
            continue
        for item in (resposta.dados.get("perguntas") or [])[:2]:
            pergunta = str(item.get("pergunta") or "").strip()
            referencia = str(item.get("resposta") or "").strip()
            if not pergunta:
                continue
            if not autossuficiente(pergunta):
                # Descartada na origem, e nao gravada como rascunho: pergunta
                # que aponta para o nada nao e "para revisar", e deixa-la na
                # lista so gasta a atencao de quem cura.
                log.info("pergunta descartada por nao se sustentar sozinha: %s", pergunta[:120])
                descartadas += 1
                continue
            tipo = str(item.get("tipo") or "").strip().lower()
            if tipo not in TIPOS_DIFICEIS:
                # Tipo fora do vocabulario e o sinal de que o modelo inventou um
                # rotulo. Vazio nao mente; um rotulo inventado agruparia errado.
                tipo = ""
            with conn() as connection, connection.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO benchmark_question
                        (space_slug, question, reference, document_id, origin, status,
                         created_by, strategy, kind)
                    VALUES (%s, %s, %s, %s, 'gerada', 'rascunho', %s, %s, %s)
                    """,
                    (space_slug, pergunta, referencia, doc_id, por_quem, estrategia, tipo),
                )
                connection.commit()
            criadas += 1

    with _trava:
        _geracoes.pop(space_slug, None)

    if sem_resposta == len(documentos):
        # Todas sem resposta e falha, nao "nenhuma pergunta boa apareceu".
        return {"status": "falha", "criadas": 0,
                "erro": "o modelo de chat nao respondeu em nenhum documento. "
                        "Verifique o provedor de chat em Administracao > Modelos de IA.",
                "documentos": len(documentos)}
    return {"status": "ok", "criadas": criadas, "documentos": len(documentos),
            "sem_resposta": sem_resposta, "estrategia": estrategia,
            # Aparece na tela: descarte alto e sinal de que o prompt esta
            # puxando demais para o vago, nao de que a base e dificil.
            "descartadas": descartadas}


# ── fase 2: execucao ──────────────────────────────────────────────────────

_INSTRUCAO_RESPOSTA = """Você responde a pergunta usando SOMENTE os trechos fornecidos.

- se os trechos não contêm a resposta, diga exatamente: "Não encontrei essa informação nos trechos fornecidos.";
- não complete com conhecimento próprio, não suponha e não generalize;
- seja direto: 1 a 4 frases.

Responda um objeto JSON: {"resposta": "..."}"""


def _sintetizar(pergunta: str, contextos: list[str], space_slug: str) -> str:
    """A resposta que sera medida. Existe so no benchmark.

    O prompt e deliberadamente ESTRITO ("somente os trechos"). Um gerador
    permissivo produziria respostas certas a partir do conhecimento do modelo,
    com contexto ruim -- e a nota diria que a base vai bem quando quem foi bem
    foi o modelo. A frase de escape existe pelo mesmo motivo: sem ela, o modelo
    inventa em vez de admitir que o contexto nao tem a resposta.
    """
    entrada = "\n\n---\n\n".join(contextos) + f"\n\n===\nPergunta: {pergunta}"
    resposta = complete_json(_INSTRUCAO_RESPOSTA, entrada, "benchmark_resposta", space=space_slug)
    if resposta is None:
        return ""
    return str(resposta.dados.get("resposta") or "").strip()


# Estado das execucoes em andamento, para o progresso e o cancelamento. Em
# memoria porque e do PROCESSO: com mais de uma replica, quem iniciou acompanha.
# O que precisa sobreviver -- as notas -- esta no banco.
_execucoes: dict[int, dict[str, Any]] = {}
_trava = threading.Lock()


def estado(run_id: int) -> dict[str, Any] | None:
    with _trava:
        atual = _execucoes.get(run_id)
        return {k: v for k, v in atual.items() if k != "cancelar"} if atual else None


def cancelar(run_id: int) -> bool:
    with _trava:
        atual = _execucoes.get(run_id)
        if atual is None:
            return False
        atual["cancelar"] = True
        return True


def _juizes(space_slug: str, modo: str):
    """As metricas do Ragas, ligadas aos provedores desta base.

    Instanciadas UMA vez por execucao: cada uma carrega o cliente HTTP, e o
    transporte adaptativo so vale a pena se ele sobreviver entre as chamadas --
    e nele que mora o aprendizado sobre o que o modelo recusa.
    """
    from ragas.embeddings import embedding_factory
    from ragas.llms import llm_factory
    from ragas.metrics.collections import (
        AnswerCorrectness,
        AnswerRelevancy,
        ContextPrecisionWithReference,
        ContextRecall,
        Faithfulness,
    )

    from .ragas_client import TransporteAdaptativo, cliente

    provedor_chat = providers.padrao("chat", space_slug)
    provedor_emb = providers.padrao("embedding", space_slug)
    transporte = TransporteAdaptativo()
    llm = llm_factory(
        model=provedor_chat.model, provider="openai",
        client=cliente(provedor_chat, transporte),
    )
    embeddings = embedding_factory(
        model=provedor_emb.model, provider="openai",
        client=cliente(provedor_emb, TransporteAdaptativo()),
    )

    juizes: dict[str, Any] = {
        "context_precision": ContextPrecisionWithReference(llm=llm),
        "context_recall": ContextRecall(llm=llm),
    }
    if modo == "completo":
        juizes["faithfulness"] = Faithfulness(llm=llm)
        juizes["answer_relevancy"] = AnswerRelevancy(llm=llm, embeddings=embeddings)
        juizes["answer_correctness"] = AnswerCorrectness(llm=llm, embeddings=embeddings)
    return juizes, transporte, {"chat": provedor_chat.model, "embedding": provedor_emb.model}


async def _notas(juizes: dict[str, Any], pergunta: str, referencia: str,
                 resposta: str, contextos: list[str]) -> dict[str, Any]:
    """As notas de UMA pergunta. Metrica que falha nao derruba as outras.

    Uma execucao de trinta minutos que morre na vigesima pergunta por causa de
    um 429 numa metrica seria pior que inutil. O erro fica na propria chave, e a
    tela mostra qual metrica nao saiu.
    """
    async def uma(nome: str) -> tuple[str, Any]:
        juiz = juizes[nome]
        try:
            if nome == "context_precision":
                r = await juiz.ascore(user_input=pergunta, reference=referencia,
                                      retrieved_contexts=contextos)
            elif nome == "context_recall":
                r = await juiz.ascore(user_input=pergunta, retrieved_contexts=contextos,
                                      reference=referencia)
            elif nome == "faithfulness":
                r = await juiz.ascore(user_input=pergunta, response=resposta,
                                      retrieved_contexts=contextos)
            elif nome == "answer_relevancy":
                r = await juiz.ascore(user_input=pergunta, response=resposta)
            else:
                r = await juiz.ascore(user_input=pergunta, response=resposta,
                                      reference=referencia)
            return nome, float(getattr(r, "value", r))
        except Exception as exc:  # noqa: BLE001
            log.warning("metrica %s falhou: %s", nome, exc)
            return nome, {"erro": str(exc)[:200]}

    # As metricas de uma pergunta rodam juntas: elas nao dependem umas das
    # outras, e em serie uma pergunta levaria a soma dos tempos (medido: ate
    # dois minutos) em vez do maior deles.
    aplicaveis = [n for n in juizes if referencia or n not in
                  ("context_precision", "context_recall", "answer_correctness")]
    return dict(await asyncio.gather(*(uma(n) for n in aplicaveis)))


async def _uma_pergunta(juizes, modo: str, space_slug: str, linha: dict,
                        laco, melhoria: tuple[str, str] = ("nenhuma", "crua")) -> dict[str, Any]:
    inicio = time.time()
    pergunta = linha["question"]
    # A busca e a de PRODUCAO, pelo mesmo caminho da tela e do MCP. Medir com
    # um atalho mediria o atalho.
    resultado = await laco.run_in_executor(
        None, lambda: search.search(pergunta, [space_slug], TOP_K, "benchmark", "benchmark",
                                    reescrita=melhoria[0], embedding_query=melhoria[1])
    )
    passagens = [p.to_dict() for p in resultado.passages]
    contextos = [p["content"] for p in passagens]

    resposta = ""
    if modo == "completo":
        if contextos:
            resposta = await laco.run_in_executor(
                None, lambda: _sintetizar(pergunta, contextos, space_slug)
            )
        else:
            # Sem contexto nao ha o que sintetizar, e inventar uma resposta aqui
            # daria nota de gerador a um caso que e do recuperador.
            resposta = "Não encontrei essa informação nos trechos fornecidos."

    metricas = await _notas(juizes, pergunta, linha["reference"], resposta, contextos) \
        if contextos or modo == "completo" else {}
    numericas = {k: v for k, v in metricas.items() if isinstance(v, (int, float))}
    return {
        "question_id": linha["id"],
        "strategy": linha.get("strategy", "direta"),
        "kind": linha.get("kind", ""),
        "question": pergunta,
        "reference": linha["reference"],
        "answer": resposta,
        "contexts": [
            {"chunk_id": p["chunk_id"], "document_id": p["document_id"],
             "filename": p["filename"], "title": p["title"],
             "representation": p["representation"], "score": p["score"],
             "content": p["content"][:1500]}
            for p in passagens
        ],
        "metrics": metricas,
        "diagnosis": diagnosticar(numericas) if numericas else "sem_metrica",
        "latency_ms": int((time.time() - inicio) * 1000),
        "error": "" if contextos else "a busca não devolveu nenhuma passagem",
    }


def executar(run_id: int, space_slug: str, modo: str,
             melhoria: tuple[str, str] = ("nenhuma", "crua")) -> None:
    """Roda a execucao inteira. Chamada numa thread, nunca no event loop.

    `melhoria` e o par (reescrita F1, embedding de query F3) desta execucao. E
    o que permite o A/B que motivou o recurso: o MESMO conjunto de perguntas,
    com e sem, e a diferenca atribuivel so ao slot.
    """
    async def principal() -> None:
        with conn() as connection, connection.cursor() as cur:
            cur.execute(
                """
                SELECT id, question, reference, strategy, kind FROM benchmark_question
                 WHERE space_slug = %s AND status = 'aprovada'
                 ORDER BY id
                """,
                (space_slug,),
            )
            perguntas = [{"id": r[0], "question": r[1], "reference": r[2],
                          "strategy": r[3], "kind": r[4]}
                         for r in cur.fetchall()]

        juizes, transporte, modelos = _juizes(space_slug, modo)
        with _trava:
            _execucoes[run_id] = {"run_id": run_id, "total": len(perguntas), "done": 0,
                                  "status": "running", "cancelar": False}

        with conn() as connection, connection.cursor() as cur:
            cur.execute("UPDATE benchmark_run SET total = %s WHERE id = %s",
                        (len(perguntas), run_id))
            connection.commit()

        laco = asyncio.get_running_loop()
        limite = asyncio.Semaphore(MAX_PARALELO)
        resultados: list[dict[str, Any]] = []

        async def com_limite(linha):
            async with limite:
                with _trava:
                    if _execucoes.get(run_id, {}).get("cancelar"):
                        return None
                try:
                    saida = await _uma_pergunta(juizes, modo, space_slug, linha, laco, melhoria)
                except Exception as exc:  # noqa: BLE001
                    log.warning("pergunta %s falhou: %s", linha["id"], exc)
                    saida = {"question_id": linha["id"], "question": linha["question"],
                             "strategy": linha.get("strategy", "direta"),
                             "kind": linha.get("kind", ""),
                             "reference": linha["reference"], "answer": "", "contexts": [],
                             "metrics": {}, "diagnosis": "erro", "latency_ms": 0,
                             "error": str(exc)[:300]}
                with conn() as connection, connection.cursor() as cur:
                    cur.execute(
                        """
                        INSERT INTO benchmark_result
                            (run_id, question_id, question, reference, answer, contexts,
                             metrics, diagnosis, latency_ms, error)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                        """,
                        (run_id, saida["question_id"], saida["question"], saida["reference"],
                         saida["answer"], jsonb(saida["contexts"]), jsonb(saida["metrics"]),
                         saida["diagnosis"], saida["latency_ms"], saida["error"]),
                    )
                    cur.execute("UPDATE benchmark_run SET done = done + 1 WHERE id = %s",
                                (run_id,))
                    connection.commit()
                with _trava:
                    if run_id in _execucoes:
                        _execucoes[run_id]["done"] += 1
                return saida

        for saida in await asyncio.gather(*(com_limite(p) for p in perguntas)):
            if saida is not None:
                resultados.append(saida)

        def medias_de(linhas: list[dict[str, Any]]) -> dict[str, float]:
            saida: dict[str, float] = {}
            for nome in METRICAS:
                valores = [r["metrics"][nome] for r in linhas
                           if isinstance(r["metrics"].get(nome), (int, float))]
                if valores:
                    saida[nome] = round(sum(valores) / len(valores), 4)
            return saida

        medias = medias_de(resultados)

        # A COMPARACAO ENTRE ESTRATEGIAS E O PONTO DE TER DUAS.
        #
        # Uma nota geral misturando perguntas diretas e dificeis esconde as duas
        # leituras que interessam: a direta e a linha de base (se ela esta ruim,
        # o problema e grave) e a dificil e o teste de verdade. Medido na
        # primeira execucao so-direta: `context_recall` = 1,0 em 16 de 16, um
        # numero que parecia otimo e so dizia que o dataset era facil.
        por_estrategia: dict[str, Any] = {}
        for nome_estrategia in ESTRATEGIAS:
            grupo = [r for r in resultados if r.get("strategy") == nome_estrategia]
            if not grupo:
                continue
            grupo_medias = medias_de(grupo)
            harmonica_grupo = media_harmonica(grupo_medias)
            por_estrategia[nome_estrategia] = {
                "perguntas": len(grupo),
                "medias": grupo_medias,
                "harmonica": round(harmonica_grupo, 4) if harmonica_grupo is not None else None,
                "diagnosticos": {d: sum(1 for r in grupo if r["diagnosis"] == d)
                                 for d in {r["diagnosis"] for r in grupo}},
            }

        # Qual tipo de dificuldade quebra a base. Parafrase mal e problema de
        # embedding; multi-salto mal e problema de recuperar passagem unica --
        # e os consertos sao diferentes.
        por_tipo: dict[str, Any] = {}
        for tipo in TIPOS_DIFICEIS:
            grupo = [r for r in resultados if r.get("kind") == tipo]
            if not grupo:
                continue
            grupo_medias = medias_de(grupo)
            harmonica_tipo = media_harmonica(grupo_medias)
            por_tipo[tipo] = {
                "perguntas": len(grupo),
                "harmonica": round(harmonica_tipo, 4) if harmonica_tipo is not None else None,
                "falhas": sum(1 for r in grupo if r["diagnosis"] not in ("ok", "sem_metrica")),
            }

        cancelada = bool(_execucoes.get(run_id, {}).get("cancelar"))
        resumo = {
            "medias": medias,
            "harmonica": (round(media_harmonica(medias), 4)
                          if media_harmonica(medias) is not None else None),
            "avaliadas": len(resultados),
            "diagnosticos": {d: sum(1 for r in resultados if r["diagnosis"] == d)
                             for d in {r["diagnosis"] for r in resultados}},
            "latencia_mediana_ms": (
                sorted(r["latency_ms"] for r in resultados)[len(resultados) // 2]
                if resultados else 0),
            "por_estrategia": por_estrategia,
            "por_tipo": por_tipo,
            "modelos": modelos,
            "melhoria_query": {"rewrite": melhoria[0], "query_embedding": melhoria[1]},
            # O que o modelo recusou vai para o trace: e o que explica uma
            # execucao com temperatura diferente da pedida.
            "parametros_recusados": sorted(transporte.proibidos),
        }
        with conn() as connection, connection.cursor() as cur:
            cur.execute(
                """
                UPDATE benchmark_run
                   SET status = %s, summary = %s, finished_at = now()
                 WHERE id = %s
                """,
                ("cancelled" if cancelada else "done", jsonb(resumo), run_id),
            )
            connection.commit()
        with _trava:
            _execucoes.pop(run_id, None)

    try:
        asyncio.run(principal())
    except Exception as exc:  # noqa: BLE001
        log.exception("execucao de benchmark %s falhou", run_id)
        with conn() as connection, connection.cursor() as cur:
            cur.execute(
                "UPDATE benchmark_run SET status='failed', error=%s, finished_at=now() "
                " WHERE id=%s",
                (str(exc)[:500], run_id),
            )
            connection.commit()
        with _trava:
            _execucoes.pop(run_id, None)

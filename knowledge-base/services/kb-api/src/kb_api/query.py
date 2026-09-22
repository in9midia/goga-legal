"""Melhoria de query: os dois slots que ficam antes da recuperacao.

POR QUE ISTO EXISTE, E QUAL MEDICAO O MOTIVOU

A avaliacao offline (ADR-0020) mediu o limite pratico da busca. Sobre a base de
275 manuais, com perguntas escritas com as palavras de quem pergunta em vez das
do manual, a recuperacao falhou completamente em 7 de 16 casos. O experimento
que isolou a causa foi buscar o MESMO documento com dois vocabularios:

    "fazer um intervalo do calendario valer para uma instituicao"  -> fora do top-40
    "vincular um subperiodo letivo a uma unidade de ensino"        -> 3a posicao

O conteudo e achavel. O que falha e a distancia de vocabulario. E o diagnostico
foi mais longe: dos nove fracassos da primeira rodada, ZERO eram de ranking --
o documento nao aparecia nem entre os quarenta candidatos. Reranking nao
resolveria nenhum deles.

DOIS SLOTS, E NAO UM, PORQUE ELES AGEM EM LUGARES DIFERENTES

A especificacao separa (retrieval-pipeline §3):

* **F1, melhoria de query** -- reescreve o TEXTO da pergunta, e o texto novo vale
  para todos os metodos, inclusive o lexical. Variantes `rewrite` e `step_back`;
* **F3, embedding de query** -- troca o VETOR usado pelo metodo semantico, sem
  tocar no texto que o lexical usa. E onde o HyDE vive.

Junta-los seria um erro com consequencia pratica: o HyDE gera um paragrafo
hipotetico de cem palavras, e mandar esse paragrafo para o braco lexical
encheria a consulta de termos inventados pelo modelo.

TUDO DESLIGADO POR PADRAO

E o que a especificacao manda, e a razao e boa: cada variante custa uma chamada
de LLM ANTES da busca, na frente de quem espera. Para o agente, reformular e
papel dele (ele tem a conversa inteira; a tool so ve a string). O slot existe
para o consumidor direto e para o simulador medir.
"""
from __future__ import annotations

import logging

from .llm import complete_json

log = logging.getLogger(__name__)

# F1: o texto da pergunta. `nenhuma` e o default, e nao e um placeholder.
REESCRITAS = ("nenhuma", "rewrite", "step_back")

# F3: o vetor do metodo semantico.
EMBEDDINGS_DE_QUERY = ("crua", "hyde")

_REWRITE = """Você reescreve a pergunta de alguém para uma base de documentos corporativos, de modo que ela case melhor com como a documentação fala.

A pergunta chega nas palavras de quem tem o problema. A documentação usa o vocabulário de quem escreveu o manual. Sua tarefa é atravessar essa distância.

- mantenha a MESMA intenção. Não responda, não amplie o escopo, não invente detalhe;
- troque o termo coloquial pelo termo que um manual usaria, e quando houver dúvida, inclua os dois ("turma (classe)");
- acrescente os sinônimos prováveis do domínio, sem encher: no máximo uma frase a mais;
- se a pergunta já está no vocabulário da documentação, devolva-a igual. Reescrever o que já está bom só adiciona ruído.

Exemplos do domínio acadêmico:
- "conteúdo programático da matéria" → "ementa da disciplina (conteúdo programático)"
- "classe de estudantes" → "turma"
- "conjunto de abatimentos" → "grupo de descontos"

Responda um objeto JSON: {"query": "..."}"""

_STEP_BACK = """Você recebe uma pergunta específica e escreve a pergunta mais GERAL cuja resposta contém a resposta dela.

É a técnica step-back: quando a pergunta é sobre um detalhe, o documento que explica o assunto inteiro costuma ser mais fácil de encontrar do que o parágrafo exato.

- suba UM nível, não mais. "Qual o prazo para pedir férias?" vira "Como funciona a solicitação de férias?", e não "Como funciona o RH?";
- mantenha o domínio e os nomes próprios da pergunta;
- não responda nada.

Responda um objeto JSON: {"query": "..."}"""

_HYDE = """Você escreve o PARÁGRAFO que responderia a pergunta, como se ele já estivesse no manual.

Isto não é uma resposta para alguém ler: é um texto de isca, usado para procurar o parágrafo de verdade. Por isso:

- escreva no tom de documentação técnica, não de conversa. Sem "você pode", sem "para isso";
- use o vocabulário que um manual do domínio usaria, inclusive nomes de tela, campos e menus plausíveis;
- 60 a 120 palavras, em um parágrafo;
- se não souber o detalhe, escreva o que seria plausível. Estar errado no detalhe não atrapalha — o texto serve para medir proximidade, não para ser lido.

Responda um objeto JSON: {"texto": "..."}"""


def reescrever(query: str, variante: str, space: str = "") -> tuple[str, dict]:
    """F1. Devolve (texto a usar, trace).

    Falha do modelo devolve a query ORIGINAL, e nao erro. Uma busca com a
    pergunta crua e pior que uma com a pergunta melhorada, e muito melhor que
    uma busca que nao aconteceu -- a mesma regra do metodo de acesso que cai.
    """
    if variante not in REESCRITAS or variante == "nenhuma":
        return query, {"tecnica": "query crua", "variante": "nenhuma"}

    instrucao = _STEP_BACK if variante == "step_back" else _REWRITE
    resposta = complete_json(instrucao, query, f"query_{variante}", space=space)
    if resposta is None:
        log.info("melhoria de query (%s) nao respondeu; seguindo com a pergunta crua", variante)
        return query, {"tecnica": f"query {variante}", "variante": variante,
                       "aplicada": False, "motivo": "o modelo nao respondeu"}

    nova = str(resposta.dados.get("query") or "").strip()
    if not nova:
        return query, {"tecnica": f"query {variante}", "variante": variante,
                       "aplicada": False, "motivo": "resposta vazia"}
    return nova, {
        "tecnica": f"query {variante}",
        "variante": variante,
        "aplicada": True,
        # A query REESCRITA vai para o trace. Sem ela, uma busca que trouxe algo
        # inesperado fica sem explicacao: quem audita ve a pergunta original e os
        # resultados de outra pergunta.
        "query_original": query,
        "query_usada": nova,
        "tokens": resposta.tokens,
    }


def texto_para_vetor(query: str, variante: str, space: str = "") -> tuple[str, dict]:
    """F3. O texto que o metodo semantico vai vetorizar.

    Com `crua`, e a propria pergunta -- o comportamento de sempre. Com `hyde`, e
    um paragrafo hipotetico escrito no tom do manual: a aposta e que o vetor de
    um texto que PARECE documentacao fique mais perto da documentacao de verdade
    do que o vetor de uma pergunta coloquial.
    """
    if variante != "hyde":
        return query, {"embedding_query": "crua"}

    resposta = complete_json(_HYDE, query, "query_hyde", space=space)
    if resposta is None:
        return query, {"embedding_query": "crua", "hyde_aplicado": False,
                       "motivo": "o modelo nao respondeu"}
    texto = str(resposta.dados.get("texto") or "").strip()
    if not texto:
        return query, {"embedding_query": "crua", "hyde_aplicado": False,
                       "motivo": "resposta vazia"}
    # A pergunta entra JUNTO com o texto hipotetico. Vetorizar so o hipotetico
    # joga fora o sinal da pergunta real, e quando o modelo inventa para o lado
    # errado o vetor vai junto -- com os dois, o erro do modelo e diluido.
    return f"{query}\n\n{texto}", {
        "embedding_query": "hyde",
        "hyde_aplicado": True,
        "hyde_palavras": len(texto.split()),
        "tokens": resposta.tokens,
    }

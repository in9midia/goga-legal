"""Representacoes e metodos de acesso: o esqueleto que a busca heterogenea usa.

VOCABULARIO, que aqui nao e detalhe (conceptual-model.md §2)

* **Representacao** -- estrutura derivada do canonico, construida NA INGESTAO
  para facilitar retrieval. Duas na v1: o `indice` (chunks pai/filho + vetores +
  BM25), que e a representacao de base e existe em TODO Espaco, e a `wiki`
  (paginas OKF destiladas), ligavel por Espaco (ING-11);
* **Estrutura auxiliar** -- dado a mais DENTRO de uma representacao, que abre
  outro caminho ate o MESMO conteudo sem criar conteudo novo. O grafo de
  entidades e isto: os nos apontam para chunks pais que ja existem (ING-12);
* **Metodo de acesso** -- motor de consulta que opera sobre uma representacao em
  TEMPO DE BUSCA. Semantica e BM25 sobre o indice, busca de paginas sobre a
  wiki, travessia sobre o grafo.

POR QUE UM CONJUNTO, E NAO UM ENUM

A versao anterior deste projeto tratou a escolha como um MODO unico por Espaco.
Nao expressa o modelo: `indice + wiki` nao e um terceiro valor de um enum, e sim
o conjunto com os dois -- e a especificacao diz que as representacoes sao
plugaveis e que ligar ou desligar uma nao afeta as demais. Um enum obrigaria a
inventar um valor por combinacao, e a combinacao de tres representacoes daria
sete valores para descrever tres interruptores.

O QUE ISTO RESOLVE NA BUSCA

O caso real: trinta bases, cada uma com representacoes diferentes, e UMA
pergunta. A busca nao vira trinta buscas. Ela agrupa os Espacos alcancaveis por
metodo de acesso disponivel, dispara cada metodo UMA vez sobre o seu grupo, e
funde tudo por RRF. Com duas representacoes sao tres ou quatro metodos, nao
trinta consultas -- e o embedding da pergunta e calculado uma vez por MODELO,
compartilhado entre os metodos, porque o vetor da pergunta nao depende de qual
representacao vai ser consultada.

A fusao e por POSICAO (RRF) e nao por score, e isso nao e preferencia: os
metodos tem escalas incomparaveis entre si. Pela mesma razao o threshold e por
metodo, com valor proprio de cada um (retrieval-pipeline.md §3 F4).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

log = logging.getLogger(__name__)


# A representacao de base. Existe em todo Espaco e nao ha como desliga-la: sem
# indice o Espaco nao tem como responder nada, e oferecer o interruptor seria
# oferecer um jeito de quebrar a base em silencio.
INDICE = "indice"

# Ligavel por Espaco (ING-11, opcional). Constroi paginas OKF destiladas.
WIKI = "wiki"

REPRESENTACOES = (INDICE, WIKI)

# Estrutura AUXILIAR do indice, e nao representacao: os nos apontam para chunks
# pais que ja existem e nao criam conteudo novo (ING-12). Vive numa chave
# separada em `space.representations` de proposito -- pô-la junto das
# representacoes seria repetir na configuracao o erro de vocabulario que a
# especificacao corrige.
GRAFO = "grafo"
AUXILIARES = (GRAFO,)


@dataclass(frozen=True)
class Auxiliar:
    """Estrutura auxiliar de uma representacao. Nao cria conteudo novo."""

    id: str
    label: str
    resumo: str
    de: str
    metodos: tuple[str, ...]
    needs_chat: bool
    custo: str
    requisito: str


@dataclass(frozen=True)
class Representacao:
    id: str
    label: str
    resumo: str
    # O que ela constroi na ingestao, para a tela dizer o que sera feito.
    constroi: str
    # Metodos de acesso que ela oferece em tempo de busca.
    metodos: tuple[str, ...]
    # Pode ser desligada? O indice nao pode.
    opcional: bool
    # Precisa de modelo de chat na base? A destilacao precisa; o indice nao.
    needs_chat: bool
    custo: str
    requisito: str


CATALOGO: dict[str, Representacao] = {
    INDICE: Representacao(
        id=INDICE,
        label="Índice",
        resumo="chunks pai/filho, vetor e busca textual",
        constroi=(
            "corta o canônico em pais e filhos pelo motor escolhido, vetoriza os filhos e "
            "indexa o texto para a busca lexical"
        ),
        metodos=("semantica", "lexical"),
        opcional=False,
        needs_chat=False,
        custo="embedding dos filhos, na ingestão",
        requisito="ING-07, ING-09",
    ),
    WIKI: Representacao(
        id=WIKI,
        label="Wiki destilada",
        resumo="páginas OKF atômicas, escritas pelo modelo a partir dos documentos",
        constroi=(
            "destila os documentos em páginas atômicas de 200 a 800 palavras em formato OKF, "
            "cada uma registrando de quais documentos deriva, e indexa um vetor por seção "
            "resolvendo para a página inteira"
        ),
        metodos=("paginas", "paginas_lexical"),
        opcional=True,
        needs_chat=True,
        custo="uma destilação por documento, no modelo de chat",
        requisito="ING-11",
    ),
}


CATALOGO_AUXILIAR: dict[str, Auxiliar] = {
    GRAFO: Auxiliar(
        id=GRAFO,
        label="Grafo de entidades",
        resumo="entidades e relações tipadas, extraídas dos chunks pais",
        de=INDICE,
        metodos=("travessia",),
        needs_chat=True,
        custo="uma extração por documento, no modelo de chat",
        requisito="ING-12",
    ),
}


@dataclass(frozen=True)
class MetodoDeAcesso:
    """Um motor de consulta sobre uma representacao.

    `threshold` e por METODO de proposito. As escalas nao sao comparaveis entre
    si -- similaridade de cosseno e `ts_rank_cd` nao querem dizer a mesma coisa
    -- entao um corte global ou zeraria um metodo ou nao cortaria nada do outro
    (retrieval-pipeline.md §3 F4).
    """

    id: str
    label: str
    representacao: str
    # Unidade de ENTREGA deste metodo: o que ele devolve como passagem.
    entrega: str
    threshold: float
    tecnica: str


METODOS: dict[str, MetodoDeAcesso] = {
    "semantica": MetodoDeAcesso(
        id="semantica",
        label="Semântica",
        representacao=INDICE,
        entrega="chunk pai",
        # 0.0 = desligado. O corte por similaridade so faz sentido calibrado
        # contra o corpus real, e um valor chutado aqui esconderia resultado bom
        # numa base pequena. Fica ligavel, e o numero vem da medicao.
        threshold=0.0,
        tecnica="pgvector cosseno",
    ),
    "lexical": MetodoDeAcesso(
        id="lexical",
        label="Textual",
        representacao=INDICE,
        entrega="chunk pai",
        threshold=0.0,
        tecnica="postgres full-text (portuguese, unaccent, OR) + ts_rank_cd",
    ),
    "paginas": MetodoDeAcesso(
        id="paginas",
        label="Busca de páginas",
        representacao=WIKI,
        entrega="página inteira",
        threshold=0.0,
        tecnica="multi-vetor por seção (qualquer seção devolve a página)",
    ),
    "paginas_lexical": MetodoDeAcesso(
        id="paginas_lexical",
        label="Textual na wiki",
        representacao=WIKI,
        entrega="página inteira",
        threshold=0.0,
        tecnica="postgres full-text por página (portuguese, unaccent, OR)",
    ),
    "travessia": MetodoDeAcesso(
        id="travessia",
        label="Travessia de grafo",
        # A travessia opera sobre o INDICE: ela devolve chunk pai, que e a
        # unidade de entrega do indice. O grafo e o caminho, nao o destino.
        representacao=INDICE,
        entrega="chunk pai",
        threshold=0.0,
        tecnica="entidades por LLM sobre os chunks pais, dois saltos no Memgraph",
    ),
}


@dataclass
class Ativacao:
    """As representacoes ativas de um Espaco."""

    ativas: set[str] = field(default_factory=lambda: {INDICE})
    # Estruturas auxiliares ligadas. Separadas das representacoes porque sao
    # outra coisa: uma auxiliar nao produz conteudo, so abre um caminho a mais
    # ate o conteudo que a representacao dela ja tem.
    auxiliares: set[str] = field(default_factory=set)

    @classmethod
    def from_space(cls, bruto: dict | None) -> Ativacao:
        """Le a coluna `space.representations`, tolerando o que veio antes dela.

        O `indice` entra SEMPRE, venha o que vier no JSON. Ele e a representacao
        de base (conceptual-model §2): um Espaco sem indice nao responde nada, e
        aceitar um JSON que o desligue seria aceitar quebrar a base em silencio
        por um campo mal preenchido.
        """
        dados = bruto or {}
        ativas = {INDICE}
        for nome in REPRESENTACOES:
            if nome != INDICE and bool(dados.get(nome)):
                ativas.add(nome)
        auxiliares = {
            nome for nome in AUXILIARES
            # A auxiliar so vale se a representacao dela estiver ativa: grafo
            # sobre um indice desligado nao existiria. Hoje o indice e sempre
            # ativo, mas a amarra fica escrita para a proxima auxiliar.
            if bool(dados.get(nome)) and CATALOGO_AUXILIAR[nome].de in ativas
        }
        return cls(ativas=ativas, auxiliares=auxiliares)

    def tem(self, representacao: str) -> bool:
        return representacao in self.ativas

    def metodos(self) -> list[str]:
        """Os metodos de acesso que este Espaco oferece, em ordem estavel.

        Ordem estavel porque ela aparece no trace e nos testes: um conjunto
        iterado em ordem de hash faria o trace mudar entre execucoes iguais.
        """
        saida: list[str] = []
        for nome in REPRESENTACOES:
            if nome in self.ativas:
                saida.extend(CATALOGO[nome].metodos)
        for nome in AUXILIARES:
            if nome in self.auxiliares:
                saida.extend(CATALOGO_AUXILIAR[nome].metodos)
        return saida

    def to_dict(self) -> dict:
        return {
            **{nome: (nome in self.ativas) for nome in REPRESENTACOES},
            **{nome: (nome in self.auxiliares) for nome in AUXILIARES},
        }


def agrupar_por_metodo(ativacoes: dict[str, Ativacao]) -> dict[str, list[str]]:
    """Espacos agrupados pelo metodo de acesso que cada um oferece.

    E o que faz trinta bases heterogeneas custarem tres ou quatro consultas em
    vez de trinta: cada metodo roda UMA vez, sobre a lista de Espacos em que ele
    existe. Um Espaco com duas representacoes aparece em mais de um grupo, e e
    assim que tem de ser -- ele contribui candidato por cada metodo, e a fusao
    resolve a sobreposicao.
    """
    grupos: dict[str, list[str]] = {}
    for slug, ativacao in ativacoes.items():
        for metodo in ativacao.metodos():
            grupos.setdefault(metodo, []).append(slug)
    return grupos


def catalogo_auxiliar_para_tela() -> list[dict]:
    """As estruturas auxiliares, separadas das representacoes na tela.

    Separadas porque sao outra coisa: a tela precisa poder dizer "isto nao cria
    conteudo, so abre outro caminho ate o mesmo conteudo" -- que e exatamente o
    que distingue auxiliar de representacao.
    """
    return [
        {
            "id": a.id,
            "label": a.label,
            "summary": a.resumo,
            "of": a.de,
            "methods": [
                {"id": m, "label": METODOS[m].label, "delivers": METODOS[m].entrega}
                for m in a.metodos
                if m in METODOS
            ],
            "needs_chat": a.needs_chat,
            "cost": a.custo,
            "requirement": a.requisito,
        }
        for a in (CATALOGO_AUXILIAR[nome] for nome in AUXILIARES)
    ]


def catalogo_para_tela() -> list[dict]:
    """O catalogo que a tela desenha. Ela nao conhece representacao por nome."""
    return [
        {
            "id": r.id,
            "label": r.label,
            "summary": r.resumo,
            "builds": r.constroi,
            "methods": [
                {"id": m, "label": METODOS[m].label, "delivers": METODOS[m].entrega}
                for m in r.metodos
                if m in METODOS
            ],
            "optional": r.opcional,
            "needs_chat": r.needs_chat,
            "cost": r.custo,
            "requirement": r.requisito,
        }
        for r in (CATALOGO[nome] for nome in REPRESENTACOES)
    ]

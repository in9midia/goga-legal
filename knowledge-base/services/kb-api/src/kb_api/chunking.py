"""Chunking pai/filho, com MOTOR configuravel por Espaco.

O contrato pai/filho e o do requisito ING-07: busca no filho, entrega do pai. O
filho e pequeno o suficiente para o vetor ser preciso, e o pai carrega contexto
suficiente para a resposta fazer sentido. O que MUDA por Espaco e como o corte
acontece.

POR QUE POR ESPACO, E NAO GLOBAL

Nao existe um corte bom para tudo. Um manual com heading e um contrato em texto
corrido pedem estrategias diferentes, e ate agora o pipeline aplicava a mesma
nos dois. Com o motor fixo no servico, testar outra abordagem exigia
reconfigurar a instalacao inteira -- e duas bases nunca podiam usar cortes
diferentes ao mesmo tempo.

Com a escolha no Espaco, cada base usa o corte que o formato dos documentos
dela pede, e a troca de uma nao mexe na outra.

OS MOTORES

| motor      | corta por                              | quando usar |
|------------|----------------------------------------|-------------|
| `markdown` | estrutura de heading, depois sentenca  | documento com secoes -- o padrao |
| `sentence` | sentenca, sem olhar estrutura          | texto corrido, ata, transcricao |
| `semantic` | queda de similaridade entre sentencas  | texto sem formatacao onde o assunto muda sem aviso |
| `fixed`    | numero de caracteres, com sobreposicao | linha de base para comparar, e formato que confunde os outros |

`semantic` custa embedding NA INGESTAO, uma chamada por documento alem das dos
filhos. E o unico que gasta dinheiro para decidir onde cortar -- por isso nao e
o padrao, mesmo sendo o mais esperto.

Sem o LlamaIndex na imagem, todo motor cai para o corte mecanico por paragrafo.
O pipeline nao para, a qualidade do corte cai, e a tecnica efetivamente usada
fica registrada no retorno para a telemetria poder comparar (FUN-04).

O ENRIQUECIMENTO DE CHUNK E OUTRO SLOT

Este modulo inteiro e interno a representacao-INDICE. Dentro dela, a
especificacao do projeto (ingestion-pipeline.md §5 E4a) tem quatro slots em
sequencia -- chunking, enriquecimento, embedding, indexacao -- e dois moram
aqui:

* o **motor** (`engine`) preenche o slot de CHUNKING: onde cortar a prosa;
* o **enriquecimento** (`enrichment`) preenche o slot seguinte: o que e
  prependado a cada trecho ANTES do embedding, para ele ficar autocontido.

Sao slots diferentes, e os dois tem resposta em todo documento. Juntar num enum
so obrigaria a escolher entre enriquecer o trecho e cortar por estrutura, que
sao coisas que se somam.

Duas variantes hoje (`ENRIQUECIMENTOS`): `nenhum` indexa o trecho como ele saiu
do corte; `conceito` resolve o conceito do documento (lido do frontmatter OKF ou
derivado pelo modelo) e poe a identidade dele na frente de cada trecho. A
segunda e a variante que a taxonomia do projeto chama de **Contextual Chunk
Headers**.

⚠ NAO CONFUNDIR COM REPRESENTACAO. Enriquecimento e um slot DENTRO do indice.
Representacao e outra coisa (indice, wiki), vive em `representations.py` e e um
CONJUNTO ativo por Espaco. Uma versao anterior deste codigo chamou o
enriquecimento de "modo de ingestao", o que colidia de frente com o vocabulario
da especificacao -- `_enriquecimento` ainda le aquele nome para Espaco gravado
naquele formato nao mudar de comportamento num deploy.
"""

from __future__ import annotations

import bisect
import logging
import re
from dataclasses import dataclass, field

from . import okf
from .config import settings

log = logging.getLogger(__name__)


# Motores disponiveis. O nome viaja no JSON do Espaco e aparece na tela, entao
# muda-lo quebraria a configuracao ja gravada.
MOTORES = ("markdown", "sentence", "semantic", "fixed")
MOTOR_PADRAO = "markdown"

# Variantes do slot de enriquecimento de chunk. Mesmo contrato dos motores: o id
# viaja no JSON do Espaco.
#
# `nenhum` precisa continuar sendo o primeiro E o default -- Espaco gravado sem a
# chave cai aqui, e nenhum deles pode mudar de comportamento por uma entrega que
# so acrescenta variante.
ENRIQUECIMENTOS = ("nenhum", "conceito")
ENRIQUECIMENTO_PADRAO = "nenhum"

# O nome antigo de cada variante, de quando isto se chamava "modo de ingestao".
# Sem esta tabela, um Espaco gravado com `mode: okf` voltaria em silencio ao
# padrao no primeiro deploy, e a base seria reindexada com outro texto sem
# ninguem pedir.
_NOME_ANTIGO = {"padrao": "nenhum", "okf": "conceito"}


def _enriquecimento(dados: dict) -> str:
    """A variante gravada no Espaco, lendo tambem os dois nomes que ela ja teve.

    Tres formatos ja existiram para a MESMA escolha, e todos precisam continuar
    sendo lidos: `okf: true` (booleano), `mode: okf` (enum de "modo de
    ingestao") e o atual `enrichment: conceito`. Nao e zelo excessivo -- cada um
    desses formatos foi para producao, e um Espaco gravado num deles voltaria em
    silencio ao padrao se a leitura sumisse, reindexando a base com outro texto
    sem ninguem pedir.
    """
    valor = str(dados.get("enrichment") or "").strip()
    if not valor:
        antigo = str(dados.get("mode") or "").strip()
        if antigo:
            valor = _NOME_ANTIGO.get(antigo, "")
            if not valor:
                log.warning("enriquecimento desconhecido (mode=%s); usando %s", antigo, ENRIQUECIMENTO_PADRAO)
                return ENRIQUECIMENTO_PADRAO
    if not valor and dados.get("okf"):
        return "conceito"
    if valor and valor not in ENRIQUECIMENTOS:
        log.warning("enriquecimento desconhecido (%s); usando %s", valor, ENRIQUECIMENTO_PADRAO)
        return ENRIQUECIMENTO_PADRAO
    return valor or ENRIQUECIMENTO_PADRAO


@dataclass
class ChunkConfig:
    """Como cortar. Vem do Espaco; sem configuracao, o default do servico."""

    engine: str = MOTOR_PADRAO
    child_chars: int = 0
    child_overlap: int = 0
    parent_chars: int = 0
    # Percentil de quebra do motor semantico: quanto MENOR, mais cortes. 95 e o
    # default do LlamaIndex e corta so onde o assunto muda de verdade.
    breakpoint_percentile: int = 95
    # Formato de entrada Open Knowledge Format, ORTOGONAL ao motor. Desligado
    # por padrao: ligar muda o texto indexado (o frontmatter sai, a identidade
    # do conceito entra em cada trecho), e mudanca de texto indexado nunca deve
    # acontecer sozinha numa base que ja estava funcionando.
    # O que e prependado a cada trecho antes do embedding. Ver `ENRIQUECIMENTOS`.
    # `nenhum` por padrao: ligar outra variante muda o texto indexado, e mudanca
    # de texto indexado nunca deve acontecer sozinha numa base que ja funcionava.
    enrichment: str = ENRIQUECIMENTO_PADRAO
    # Vocabulario de tipos que a derivacao pode escolher, ja resolvido: vem do
    # Espaco quando ha um, senao e o padrao da casa. Resolver aqui (e nao em
    # quem usa) faz a tela mostrar o que esta EM VIGOR, nao um campo vazio que
    # o operador leria como "nenhum tipo".
    okf_types: list[str] = field(default_factory=lambda: list(okf.TIPOS_PADRAO))

    @property
    def okf(self) -> bool:
        """O enriquecimento por conceito esta ligado?

        Propriedade, e nao campo: o estado e UM (`enrichment`), e manter um
        booleano ao lado abriria a chance de os dois discordarem -- o tipo de
        divergencia que so aparece como comportamento errado, nunca como erro.
        """
        return self.enrichment == "conceito"

    @classmethod
    def from_space(cls, bruto: dict | None) -> ChunkConfig:
        dados = bruto or {}
        engine = str(dados.get("engine") or MOTOR_PADRAO)
        if engine not in MOTORES:
            log.warning("motor de chunking desconhecido (%s); usando %s", engine, MOTOR_PADRAO)
            engine = MOTOR_PADRAO
        return cls(
            engine=engine,
            child_chars=int(dados.get("child_chars") or 0) or settings.child_chunk_chars,
            child_overlap=int(dados.get("child_overlap") or 0) or settings.child_overlap_chars,
            parent_chars=int(dados.get("parent_chars") or 0) or settings.parent_chunk_chars,
            breakpoint_percentile=int(dados.get("breakpoint_percentile") or 95),
            enrichment=_enriquecimento(dados),
            okf_types=okf.tipos_do_espaco(dados),
        )

    def to_dict(self) -> dict:
        return {
            "engine": self.engine,
            "child_chars": self.child_chars,
            "child_overlap": self.child_overlap,
            "parent_chars": self.parent_chars,
            "breakpoint_percentile": self.breakpoint_percentile,
            "enrichment": self.enrichment,
            "okf_types": self.okf_types,
        }


@dataclass
class Piece:
    """Um pedaco de texto e ONDE ele estava no canonico.

    O offset nao e enfeite: e o que permite dizer em que pagina do original o
    trecho aparece. Sem ele, a evidencia devolvida ao usuario aponta para o
    arquivo, nao para o lugar.
    """

    content: str
    start: int = -1
    # Caminho de secoes onde o trecho comeca ("Titulo I › Capitulo IV"). Vazio
    # em documento sem titulo. Vai para `chunk.section` e para a citacao.
    section: str = ""


@dataclass
class Parent:
    content: str
    start: int = -1
    children: list[Piece] = field(default_factory=list)
    section: str = ""


@dataclass
class ChunkPlan:
    parents: list[Parent]
    technique: str
    # O conceito OKF, quando o modo estava ligado E o arquivo era um. Viaja
    # junto do plano para a ingestao nao ter de reanalisar o mesmo Markdown so
    # para gravar o metadado e as arestas do grafo.
    concept: okf.Concept | None = None

    @property
    def child_count(self) -> int:
        return sum(len(parent.children) for parent in self.parents)


def _split_hard(text: str, limit: int, overlap: int) -> list[str]:
    """Corte mecanico com sobreposicao. Fallback e ultimo recurso."""
    if len(text) <= limit:
        return [text]
    pieces: list[str] = []
    step = max(limit - overlap, 1)
    for start in range(0, len(text), step):
        piece = text[start : start + limit].strip()
        if piece:
            pieces.append(piece)
        if start + limit >= len(text):
            break
    return pieces


class _EmbeddingDoProjeto:
    """Adaptador do nosso `embed()` para a interface do LlamaIndex.

    Existe para o motor semantico nao trazer um segundo cliente de embedding: o
    corte tem de usar o MESMO modelo que indexa, senao ele decide onde cortar
    com uma nocao de similaridade diferente da que a busca vai usar depois.

    O Espaco viaja ate aqui pelo mesmo motivo, agora que cada base escolhe o seu
    modelo: sem ele, o corte semantico de uma base usaria o modelo padrao da
    instalacao enquanto o indice dela guarda vetores de outro -- e isso nao
    falha, so corta nos lugares errados.
    """

    def __new__(cls, space: str = ""):  # noqa: D102 - fabrica: a base so existe com a lib
        from llama_index.core.base.embeddings.base import BaseEmbedding

        from .embedding import embed

        class Adaptador(BaseEmbedding):
            def _get_query_embedding(self, query: str) -> list[float]:
                return embed([query], "chunking", space).vectors[0]

            async def _aget_query_embedding(self, query: str) -> list[float]:
                return self._get_query_embedding(query)

            def _get_text_embedding(self, text: str) -> list[float]:
                return embed([text], "chunking", space).vectors[0]

            def _get_text_embeddings(self, texts: list[str]) -> list[list[float]]:
                # Em lote de propósito: o motor semantico pede o embedding de
                # TODA sentenca do documento, e uma chamada por sentenca
                # multiplicaria a latencia da ingestao por dez.
                return embed(texts, "chunking", space).vectors

        return Adaptador()


def _semantic_blocks(markdown: str, cfg: ChunkConfig, space: str = "") -> list[str] | None:
    """Blocos onde a similaridade entre sentencas vizinhas CAI.

    O corte acontece na mudanca de assunto, nao numa contagem de caracteres nem
    num heading -- que e o que serve para documento sem formatacao.
    """
    try:
        from llama_index.core import Document
        from llama_index.core.node_parser import SemanticSplitterNodeParser
    except Exception as exc:  # noqa: BLE001
        log.info("semantic splitter indisponivel (%s)", exc)
        return None
    try:
        parser = SemanticSplitterNodeParser(
            buffer_size=1,
            breakpoint_percentile_threshold=cfg.breakpoint_percentile,
            embed_model=_EmbeddingDoProjeto(space),
        )
        nodes = parser.get_nodes_from_documents([Document(text=markdown)])
        return [node.get_content() for node in nodes if node.get_content().strip()]
    except Exception as exc:  # noqa: BLE001
        # Falha aqui NAO derruba a ingestao: cai para o motor de markdown, e o
        # nome da tecnica no retorno diz o que de fato aconteceu.
        log.warning("chunking semantico falhou (%s); caindo para markdown", exc)
        return None


def _sentence_blocks(markdown: str, cfg: ChunkConfig) -> list[str] | None:
    """Blocos por sentenca, ignorando a estrutura do documento."""
    return _llamaindex_children(markdown, ChunkConfig(
        engine="sentence",
        child_chars=cfg.parent_chars,
        child_overlap=0,
        parent_chars=cfg.parent_chars,
    ))


def _pack(blocks: list[str], limit: int) -> list[str]:
    """Junta blocos em pedacos de ate `limit` caracteres.

    Bloco MAIOR que o limite e dividido antes de entrar: sem isso um documento
    sem heading nenhum -- o caso comum quando a extracao devolve texto corrido,
    como o fallback pymupdf faz -- viraria UM pai unico com o documento inteiro,
    e a expansao pai/filho entregaria 40 paginas como "passagem". O sintoma e
    silencioso: a ingestao reporta sucesso, so a busca fica inutil.
    """
    packed: list[str] = []
    current = ""
    for block in blocks:
        block = block.strip()
        if not block:
            continue

        pieces = [block] if len(block) <= limit else _split_hard(block, limit, 0)
        for piece in pieces:
            if not current:
                current = piece
            elif len(current) + len(piece) + 2 <= limit:
                current = f"{current}\n\n{piece}"
            else:
                packed.append(current)
                current = piece
    if current:
        packed.append(current)
    return packed


def _llamaindex_blocks(markdown: str) -> list[str] | None:
    """Blocos por secao do Markdown, via LlamaIndex."""
    try:
        from llama_index.core import Document
        from llama_index.core.node_parser import MarkdownNodeParser
    except Exception as exc:  # noqa: BLE001 - ausencia da lib e caso previsto
        log.info("llama-index indisponivel (%s); chunking mecanico", exc)
        return None
    try:
        nodes = MarkdownNodeParser().get_nodes_from_documents(
            [Document(text=markdown)]
        )
        return [node.get_content() for node in nodes if node.get_content().strip()]
    except Exception as exc:  # noqa: BLE001
        log.warning("MarkdownNodeParser falhou: %s", exc)
        return None


def _llamaindex_children(text: str, cfg: ChunkConfig) -> list[str] | None:
    try:
        from llama_index.core import Document
        from llama_index.core.node_parser import SentenceSplitter
    except Exception:  # noqa: BLE001
        return None
    try:
        splitter = SentenceSplitter(
            # O SentenceSplitter mede em tokens; a configuracao do projeto e em
            # caracteres. A divisao por 4 e a aproximacao usual de pt-BR e serve
            # bem porque o alvo aqui e "pedaco pequeno e coerente", nao um
            # tamanho exato.
            chunk_size=max(cfg.child_chars // 4, 64),
            chunk_overlap=max(cfg.child_overlap // 4, 16),
        )
        nodes = splitter.get_nodes_from_documents([Document(text=text)])
        return [node.get_content() for node in nodes if node.get_content().strip()]
    except Exception as exc:  # noqa: BLE001
        log.warning("SentenceSplitter falhou: %s", exc)
        return None


def _collapse(text: str) -> tuple[str, list[int]]:
    """Texto com espaco colapsado, e o mapa de volta para o offset original.

    Existe porque a busca literal do pedaco no canonico falha em ~11% dos casos:
    o splitter junta linhas e normaliza espaco, entao a substring exata nao esta
    mais la. Comparar os dois lados com espaco colapsado remove essa diferenca
    -- e o mapa e o que permite voltar ao offset REAL, que e o que localiza a
    pagina.
    """
    saida: list[str] = []
    mapa: list[int] = []
    espaco = False
    for indice, char in enumerate(text):
        if char.isspace():
            if not espaco and saida:
                saida.append(" ")
                mapa.append(indice)
                espaco = True
            continue
        saida.append(char)
        mapa.append(indice)
        espaco = False
    return "".join(saida), mapa


def _locate(markdown: str, pieces: list[str], overlap: int) -> list[int]:
    """Offset de cada pedaco no canonico, varrendo para frente.

    Os pedacos saem do proprio texto e na mesma ordem, entao um cursor que so
    avanca acha todos em uma passada -- O(n) em vez de um `find` do inicio por
    pedaco. O cursor recua o tamanho da sobreposicao antes de cada busca porque
    filho com overlap COMECA antes de onde o anterior terminou.

    A comparacao e feita com espaco colapsado nos dois lados: o splitter
    reescreve o espaco em branco, e a busca literal perdia 1 de cada 9 trechos.

    Pedaco que ainda nao aparece recebe -1, e quem consome trata como "pagina
    desconhecida" em vez de chutar uma pagina errada.
    """
    plano, mapa = _collapse(markdown)
    offsets: list[int] = []
    cursor = 0  # posicao no texto COLAPSADO
    for piece in pieces:
        agulha, _ = _collapse(piece)
        agulha = agulha.strip()
        if not agulha:
            offsets.append(-1)
            continue
        inicio = max(0, cursor - overlap)
        achado = plano.find(agulha, inicio)
        if achado < 0:
            # Segunda tentativa com o comeco do pedaco: basta para localizar a
            # pagina, e sobrevive a um pedaco que o splitter cortou no fim.
            achado = plano.find(agulha[:80], inicio)
        if achado < 0:
            offsets.append(-1)
            continue
        offsets.append(mapa[achado])
        cursor = achado + len(agulha)
    return offsets


def _mascara_frontmatter(markdown: str, ate: int) -> str:
    """O canonico com o frontmatter trocado por espacos do MESMO tamanho.

    Serve so para localizar os trechos. Trocar por espaco em vez de recortar
    preserva todo offset depois do bloco -- e o offset e o que diz a pagina, o
    unico dado do corte que nao da para recalcular depois. Recortar deslocaria
    cada trecho do documento pelo tamanho do YAML, em silencio.

    O espaco em excesso nao atrapalha: `_locate` compara com espaco colapsado
    nos dois lados, entao o bloco inteiro vira um caractere na busca e nenhum
    trecho pode casar la dentro.
    """
    return (" " * ate) + markdown[ate:]


def _blocos(texto: str, cfg: ChunkConfig, space: str = "") -> tuple[list[str], str]:
    """Os blocos de primeiro nivel e o nome da tecnica que os produziu.

    A cascata de fallback e parte do contrato (FUN-04): motor que nao esta
    disponivel cai para o proximo, a ingestao continua, e o nome devolvido diz o
    que de fato aconteceu -- nao o que foi pedido.
    """
    blocks: list[str] | None = None
    technique = ""
    if cfg.engine == "semantic":
        blocks = _semantic_blocks(texto, cfg, space)
        technique = "llamaindex-semantic+sentence"
    elif cfg.engine == "sentence":
        blocks = _sentence_blocks(texto, cfg)
        technique = "llamaindex-sentence"
    elif cfg.engine == "fixed":
        # Corte mecanico deliberado, nao fallback: e a linha de base contra a
        # qual os outros motores sao comparados.
        blocks = _split_hard(texto, cfg.parent_chars, 0)
        technique = "fixo-caracteres"

    if blocks is None:
        blocks = _llamaindex_blocks(texto)
        technique = "llamaindex-markdown+sentence"
    if blocks is None:
        blocks = [part for part in texto.split("\n\n") if part.strip()]
        technique = "mecanico-paragrafo"
    return blocks, technique


def plan(
    markdown: str,
    cfg: ChunkConfig | None = None,
    concept: okf.Concept | None = None,
    space: str = "",
) -> ChunkPlan:
    """Corta o canonico em pais e filhos, com o motor pedido pelo Espaco.

    Quando o Espaco esta em modo OKF e o arquivo e mesmo um conceito, muda o que
    entra no corte e o que sai dele, mas NAO o motor: o frontmatter fica de fora
    da prosa, e a identidade do conceito e colada na frente de cada trecho
    indexado. Arquivo que nao e OKF -- e sao a maioria mesmo num Espaco em modo
    OKF, porque PDF e docx continuam chegando -- passa por aqui sem diferenca
    nenhuma em relacao a antes.
    """
    cfg = cfg or ChunkConfig.from_space(None)

    # O conceito pode vir PRONTO de quem chama. A ingestao resolve la porque so
    # ela sabe o Espaco e pode pagar a derivacao pelo modelo; este modulo
    # continua sem tocar a rede, o que e o que mantem o corte testavel sem
    # provedor de IA nenhum.
    #
    # Sem conceito informado, so a leitura do frontmatter acontece, e so com o
    # modo ligado. Detectar sempre seria tentador (e barato), mas mudaria o
    # texto indexado de bases que nunca pediram OKF -- e reindexacao silenciosa
    # e exatamente o tipo de surpresa que este projeto evita.
    if concept is None and cfg.okf:
        concept = okf.parse(markdown)

    # O que o motor corta e o que serve de mapa para achar os offsets sao textos
    # diferentes no modo OKF: o primeiro e so o corpo, o segundo e o canonico
    # inteiro com o frontmatter mascarado. Sem essa separacao ou o YAML entra
    # nos trechos, ou os offsets deixam de apontar para o canonico gravado.
    fonte = concept.body if concept else markdown
    mapa = _mascara_frontmatter(markdown, concept.body_start) if concept else markdown

    blocks, technique = _blocos(fonte, cfg, space)
    if concept:
        # Prefixo, e nao substituicao: o motor usado continua sendo a informacao
        # que a comparacao entre tecnicas precisa (FUN-04). `okf+fixo-caracteres`
        # diz as duas coisas.
        technique = f"okf+{technique}"

    cabecalho = okf.header(concept) if concept else ""
    secoes = MapaDeSecoes(mapa)
    # A secao entra no TEXTO do trecho so junto do cabecalho do conceito: e o
    # mesmo principio (Contextual Chunk Headers), um nivel abaixo -- o conceito
    # diz de que documento o trecho e, a secao diz de que capitulo. Sem conceito
    # o texto fica o de sempre (contrato de `test_okf`: ligar o modo num arquivo
    # que nao e conceito nao muda nada); a secao continua indo para a coluna.
    com_secao = bool(cabecalho)

    parent_texts = _pack(blocks, cfg.parent_chars)
    # Pais nao tem sobreposicao entre si, entao o cursor nunca precisa recuar.
    parent_starts = _locate(mapa, parent_texts, 0)

    parents: list[Parent] = []
    for parent_text, parent_start in zip(parent_texts, parent_starts, strict=True):
        if cfg.engine == "fixed":
            # A linha de base tem de ser fixa nos DOIS niveis; usar sentenca no
            # filho misturaria as tecnicas e a comparacao nao mediria mais nada.
            children = _split_hard(parent_text, cfg.child_chars, cfg.child_overlap)
        else:
            children = _llamaindex_children(parent_text, cfg)
            if children is None:
                children = _split_hard(parent_text, cfg.child_chars, cfg.child_overlap)
        # Pai curto nao precisa de filho separado: duplicar o texto so gastaria
        # embedding e poluiria o pool de candidatos.
        if len(parent_text) <= cfg.child_chars:
            children = [parent_text]
        child_starts = _locate(mapa, children, cfg.child_overlap)

        # O cabecalho entra DEPOIS de localizar, nunca antes. Ele nao existe no
        # canonico -- e do frontmatter, que foi retirado da prosa -- entao um
        # trecho ja prefixado nao seria encontrado por `_locate`, todo offset
        # viraria -1 e o documento inteiro perderia a pagina de cada trecho. O
        # sintoma seria mudo: a ingestao reporta sucesso, so a evidencia deixa
        # de apontar para onde estava.
        secao_pai = secoes.em(parent_start)
        filhos: list[Piece] = []
        for text, start in zip(children, child_starts, strict=True):
            secao = secoes.em(start) or secao_pai
            filhos.append(Piece(
                content=_com_cabecalho(_cabecalho_do_trecho(cabecalho, secao, com_secao), text),
                start=start, section=secao,
            ))
        parents.append(
            Parent(
                content=_com_cabecalho(
                    _cabecalho_do_trecho(cabecalho, secao_pai, com_secao), parent_text
                ),
                start=parent_start,
                children=filhos,
                section=secao_pai,
            )
        )

    return ChunkPlan(parents=parents, technique=technique, concept=concept)


_TITULO_RE = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$", re.MULTILINE)
# Quantos niveis do caminho entram na citacao. Um livro com sumario de 1.279
# entradas chega a 5-6 niveis; o caminho inteiro vira uma linha que ninguem le,
# e os ultimos tres ja dizem capitulo e secao.
NIVEIS_DA_SECAO = 3
SECAO_MAX_CHARS = 200


class MapaDeSecoes:
    """Em que secao do documento cai cada ponto do canonico.

    Existe para livro: um documento de 1.169 paginas era UMA unidade para tudo
    que e "por documento", e a citacao dizia so a pagina. Com o caminho de
    secoes, cada trecho sabe o capitulo em que esta -- sem chamada de IA, so
    lendo os titulos que a extracao ja pos no canonico (o sumario do PDF, na
    extracao hibrida; o layout, no docling).
    """

    def __init__(self, markdown: str) -> None:
        self.offsets: list[int] = []
        self.caminhos: list[str] = []
        pilha: list[tuple[int, str]] = []
        for m in _TITULO_RE.finditer(markdown):
            nivel, titulo = len(m.group(1)), m.group(2).strip()
            while pilha and pilha[-1][0] >= nivel:
                pilha.pop()
            pilha.append((nivel, titulo))
            caminho = " › ".join(t for _, t in pilha[-NIVEIS_DA_SECAO:])
            self.offsets.append(m.start())
            self.caminhos.append(caminho[:SECAO_MAX_CHARS])

    def __bool__(self) -> bool:
        return bool(self.offsets)

    def em(self, offset: int) -> str:
        """Caminho da secao que contem o offset. Vazio antes do primeiro titulo."""
        if offset < 0 or not self.offsets:
            return ""
        i = bisect.bisect_right(self.offsets, offset) - 1
        return self.caminhos[i] if i >= 0 else ""


def _cabecalho_do_trecho(conceito: str, secao: str, com_secao: bool) -> str:
    if not (com_secao and secao):
        return conceito
    linha = f"Seção: {secao}"
    return f"{conceito}\n{linha}" if conceito else linha


def _com_cabecalho(cabecalho: str, texto: str) -> str:
    """Identidade do conceito na frente do trecho, sem repetir o que ja esta la.

    A guarda do `startswith` evita o caso comum de um conceito curto: quando o
    corpo inteiro cabe num pai so, e esse pai comeca pelo proprio titulo, o
    prefixo duplicaria a linha no texto indexado e no que a busca devolve.
    """
    if not cabecalho:
        return texto
    if texto.lstrip().startswith(cabecalho):
        return texto
    return f"{cabecalho}\n\n{texto}"

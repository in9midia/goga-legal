"""Open Knowledge Format (OKF) como FORMATO DE ENTRADA, nao como motor de corte.

O OKF e uma especificacao aberta do Google Cloud (`GoogleCloudPlatform/
knowledge-catalog`, v0.2) para empacotar conhecimento de um jeito que um agente
leia sem tradutor: um diretorio de arquivos Markdown, cada um um CONCEITO, com
frontmatter YAML no topo e links Markdown comuns entre eles. O unico campo
sempre obrigatorio e `type`.

POR QUE ISTO NAO E UM QUINTO MOTOR DE CORTE

A tentacao era obvia -- ja existe uma tela com quatro cartoes de motor, e um
quinto cartao "OKF" custaria dez linhas. Foi recusado por dois motivos que so
aparecem depois:

1. **nao e mutuamente exclusivo com os motores.** Um conceito OKF tem corpo em
   Markdown, e esse corpo ainda precisa virar pai e filho. OKF responde "o que
   neste arquivo e metadado e o que e prosa"; o motor responde "onde cortar a
   prosa". Sao perguntas diferentes, e transformar uma em opcao da outra
   obrigaria a escolher entre as duas;
2. **a base nao e homogenea.** O Espaco que recebe um bundle OKF tambem recebe
   PDF e docx. Um "motor OKF" teria de decidir o corte desses tambem, e a
   escolha degradaria em silencio todo documento que nao fosse OKF.

Entao o OKF entra como uma CHAVE separada no mesmo dialogo: `okf` no
`space.chunking`, ao lado do motor, nao no lugar dele. Ligada, o pipeline
reconhece conceito OKF e trata o frontmatter como metadado; arquivo que nao for
OKF passa reto pelo motor escolhido, exatamente como antes.

DUAS PROCEDENCIAS PARA O MESMO CONCEITO

Um conceito pode chegar de dois jeitos, e a especificacao ja distingue os dois:

* **escrito.** O arquivo veio de um bundle OKF de verdade, com o frontmatter
  redigido por quem produziu. `parse()` le o que esta la;
* **derivado.** O arquivo e um PDF, um docx, um Markdown comum -- o caso de
  quase tudo que uma base corporativa recebe. `derive()` pede ao modelo o tipo,
  o titulo, a descricao e as tags, e marca o resultado com
  `generated: {by, at}`, que e o campo que o OKF reserva para exatamente isso.

A distincao nao e cosmetica: conceito derivado nao tem `verified`, entao o nivel
de confianca sai `unverified` sozinho, e a tela mostra isso. Nada finge ter sido
revisado por alguem.

O QUE MUDA QUANDO O ARQUIVO E UM CONCEITO OKF

* **o frontmatter sai da prosa.** Sem isto o bloco YAML vira texto indexado:
  `type: Metric` e `generated: {by: ...}` entram no `tsv` e no vetor, e a busca
  lexical passa a casar `type` em todo conceito do bundle;
* **a identidade do conceito entra em cada filho.** E o ganho central. Um filho
  que diz "o calculo roda toda madrugada" nao tem valor de recuperacao nenhum
  solto; com "Metric -- Usuarios ativos mensais" na frente, o vetor passa a
  ficar perto da pergunta que alguem faria de verdade. O OKF poe essa
  identidade no frontmatter justamente para o consumidor usar assim;
* **os links viram aresta no grafo.** O OKF ja diz quais conceitos se referem a
  quais. O grafo deste projeto derivava relacao de termo compartilhado, que e um
  chute estatistico -- aqui a relacao esta declarada.

TRES CAMPOS QUE O CONSUMIDOR APRENDEU A ENTENDER

A especificacao nao registra esquema, e o produtor pode declarar o que quiser no
frontmatter. Ate aqui tudo o que nao fosse `type`, `title`, `description`,
`tags`, `resource`, `status`, `generated` e `verified` ficava em `meta` sem
ninguem ler. Tres chaves sairam de la porque a BUSCA precisa delas, e nenhuma
delas e de um dominio so:

* **`vigencia: {de, ate}`** -- desde quando e ate quando o conteudo vale. Vale
  para norma revogada, politica interna substituida, versao de manual que saiu
  de circulacao. Sem isso o conteudo revogado e recuperado com score alto e nada
  falha: ele responde a pergunta, so que pela regra que nao vale mais;
* **`auditoria: {status, fonte, conferido_em, conferido_por}`** -- o registro da
  conferencia. `verified` diz QUE alguem validou; a auditoria diz contra O QUE,
  quando, e em que estado a conferencia esta. Status `em-verificacao` REBAIXA o
  nivel de confianca, e essa e a unica regra de comportamento aqui;
* **`armadilha`** -- conteudo que engana quem le rapido. O aviso viaja colado ao
  resultado da busca, porque a leitura errada acontece na primeira leitura e uma
  segunda chamada para buscar o aviso nunca e feita.

TOLERANCIA E OBRIGATORIA

A especificacao e explicita: o consumidor **nao pode** recusar um bundle por
campo opcional ausente, `type` desconhecido, chave extra no frontmatter, link
quebrado ou `index.md` faltando. Este modulo segue isso ao pe da letra -- toda
funcao aqui devolve o melhor que conseguiu extrair, e `parse()` devolve `None`
apenas quando o arquivo nao e OKF de forma alguma (sem frontmatter, ou sem
`type`), que e diferente de ser um OKF imperfeito.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path

log = logging.getLogger(__name__)


# Frontmatter: bloco YAML delimitado por `---` no INICIO do arquivo. A ancora
# `\A` nao e detalhe: `---` no meio do texto e uma regra horizontal em Markdown,
# e sem a ancora um documento comum com separador virava "OKF" na primeira
# linha horizontal que tivesse.
_FRONTMATTER_RE = re.compile(r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", re.DOTALL)

# Link Markdown que aponta para outro conceito do bundle. So `.md` interessa:
# `https://...` e `![imagem](...)` nao sao aresta entre conceitos.
_LINK_RE = re.compile(r"(?<!!)\[([^\]]*)\]\(\s*([^)\s]+?\.md)(?:#[^)\s]*)?\s*\)")

# Arquivos com papel definido pela especificacao. Nao sao conceitos, e tratar o
# `index.md` como um deles encheria a base de documentos que sao so sumario --
# o pior tipo de ruido para a busca, porque casa com tudo e nao responde nada.
RESERVADOS = {"index.md", "log.md"}

# Teto do cabecalho de identidade. A descricao do OKF e "uma frase", mas nada na
# especificacao a limita: um conceito com tres paragrafos de `description`
# empurraria o corpo para fora de todo filho pequeno.
_LIMITE_DESCRICAO = 300

# A escala de confianca da especificacao, DO MENOR PARA O MAIOR. A ordem e o
# contrato: `min_trust` na busca corta a lista neste ponto e aceita o que sobra.
# Guardar como tupla ordenada (e nao como conjunto) e o que permite "pelo menos
# este nivel" sem tabela de comparacao espalhada pelo codigo.
TRUST_ESCALA = ("unverified", "machine-confirmed", "human-reviewed")

# O nivel de quem ninguem revisou. Vale tambem para documento que NAO e conceito
# OKF: nao ter metadado de conferencia nao e o mesmo que ter sido conferido, e
# tratar a ausencia como "confiavel" derrubaria o filtro inteiro no dia em que
# alguem ligasse o `min_trust` numa base sem conceito nenhum.
TRUST_PADRAO = TRUST_ESCALA[0]

# O unico status de auditoria com COMPORTAMENTO. Conteudo declarado em
# conferencia nao conta como conferido, mesmo que alguem ja tenha assinado um
# `verified` antes: a conferencia foi reaberta justamente porque ha duvida sobre
# aquela assinatura. O rebaixamento so anda para baixo -- nenhum status faz
# subir de nivel, senao bastaria escrever no frontmatter para virar revisado.
EM_VERIFICACAO = "em-verificacao"

# Aviso usado quando `armadilha` vem como booleano, sem texto. E generico de
# proposito: o que a marca diz e "a leitura obvia deste conteudo esta errada", e
# quem marca sabe o motivo particular e pode escreve-lo no lugar do booleano.
AVISO_PADRAO = (
    "Conteúdo marcado como armadilha: o sentido óbvio na leitura rápida "
    "não é o que ele diz."
)

# Teto do aviso. Ele viaja em TODA passagem que a busca devolve daquele
# documento, e um paragrafo aqui competiria com a evidencia pelo contexto do
# agente.
_LIMITE_AVISO = 300

# Data no fim do calendario, para "ainda vigente". A comparacao de vigencia e
# TEXTUAL sobre ISO-8601 (ver `data_iso`), e um limite superior fixo evita
# espalhar `IS NULL` por toda consulta que pergunta pela data do fato.
SEM_FIM = "9999-12-31"


def data_iso(valor: object) -> str:
    """A data em `AAAA-MM-DD`, ou vazio quando nao da para ler uma.

    DUAS ENTRADAS, UM FORMATO. O YAML converte `de: 1990-09-11` sem aspas em
    `datetime.date` sozinho, e `de: "1990-09-11"` em string. Os dois chegam aqui,
    e sair daqui em formatos diferentes seria gravar duas formas da mesma data no
    mesmo campo JSONB.

    A NORMALIZACAO NAO E COSMETICA. A comparacao de vigencia acontece como TEXTO
    no Postgres, e texto ISO-8601 com zero a esquerda ordena igual a data. O
    `::date` foi recusado: o cast de texto para data e `stable`, nao `immutable`
    (depende do `DateStyle` da sessao), entao ele nao entra em indice de
    expressao nem em coluna gerada -- e sem indice o filtro de vigencia so
    existiria varrendo a tabela. Aqui, em compensacao, `1990-9-11` e recusado
    ANTES de ser gravado, que e onde o conserto e barato.
    """
    if isinstance(valor, datetime):
        return valor.date().isoformat()
    if isinstance(valor, date):
        return valor.isoformat()
    texto = _texto(valor, 40)
    if len(texto) < 10:
        return ""
    try:
        return date(int(texto[0:4]), int(texto[5:7]), int(texto[8:10])).isoformat()
    except ValueError:
        return ""


def trust_aceitos(min_trust: str) -> list[str]:
    """Os niveis que atendem a "pelo menos `min_trust`". Vazio = sem filtro.

    Devolve LISTA de niveis, e nao um numero de corte, porque quem consome e o
    SQL: `= ANY(%s::text[])` resolve a comparacao ordenada sem precisar de uma
    coluna numerica nem de um `CASE` replicado em cada consulta.
    """
    alvo = (min_trust or "").strip()
    if not alvo:
        return []
    try:
        corte = TRUST_ESCALA.index(alvo)
    except ValueError:
        raise ValueError(
            f"nivel de confianca desconhecido: {min_trust}. "
            f"Use {', '.join(TRUST_ESCALA)}"
        ) from None
    return list(TRUST_ESCALA[corte:])


def aviso_de_armadilha(bruto: object) -> str:
    """O aviso desta marca de armadilha, ou vazio quando nao ha marca.

    Aceita booleano e texto pela mesma razao que o resto do modulo aceita quase
    tudo: o frontmatter nao tem esquema, e quem escreve `armadilha: true` esta
    dizendo a mesma coisa que quem escreve o motivo por extenso. O booleano
    passa pelo JSONB como o texto `"true"`, entao a normalizacao tem de
    reconhecer as duas formas -- sem isso a palavra `true` apareceria como aviso
    para quem le.
    """
    if bruto is True:
        return AVISO_PADRAO
    if bruto is False or bruto is None:
        return ""
    texto = _texto(bruto, _LIMITE_AVISO)
    if texto.casefold() in {"true", "sim", "1"}:
        return AVISO_PADRAO
    if texto.casefold() in {"false", "nao", "não", "0"}:
        return ""
    return texto


@dataclass
class Concept:
    """Um conceito OKF: o frontmatter separado do corpo."""

    # `type` e o unico campo que a especificacao sempre exige. Conceito que so
    # carrega `type` e plenamente conformante.
    type: str
    body: str
    # Offset do corpo dentro do Markdown ORIGINAL. Existe para o corte continuar
    # localizavel: quem corta o corpo precisa somar isto para achar o ponto real
    # no canonico gravado, e sem ele a pagina de cada trecho se perde.
    body_start: int
    title: str = ""
    description: str = ""
    status: str = ""
    tags: list[str] = field(default_factory=list)
    resource: str = ""
    # Frontmatter inteiro, como veio. Guardado cru porque a especificacao nao
    # tem registro de esquema: o produtor pode declarar chave que este codigo
    # nao conhece, e jogar fora o que nao se entende apagaria justamente o que
    # o bundle tem de proprio.
    meta: dict = field(default_factory=dict)

    @property
    def derived(self) -> bool:
        """Este conceito foi gerado por um modelo, e nao escrito por alguem?

        O `generated` do OKF e a fonte, e nao um campo nosso: a especificacao o
        reserva exatamente para conceito produzido por agente. Ler dali em vez
        de carregar um booleano proprio mantem o metadado exportavel -- um
        bundle gerado daqui continua dizendo a sua propria procedencia em
        qualquer outro consumidor de OKF.
        """
        return isinstance(self.meta.get("generated"), dict)

    @property
    def trust(self) -> str:
        """Nivel de confianca derivado de `verified`, na escala da especificacao.

        Tres niveis, do menor para o maior: sem a chave e `unverified`; validado
        so por ator nao humano e `machine-confirmed`; validado por um
        `human:<id>` e `human-reviewed`. E derivado, nunca declarado: conceito
        que escreve `trust: alto` no frontmatter nao ganha nivel por isso.

        A AUDITORIA SO ANDA PARA BAIXO. Conceito com a conferencia reaberta
        (`auditoria.status: em-verificacao`) volta a `unverified` mesmo tendo um
        `verified` assinado: a conferencia foi reaberta porque ha duvida sobre
        aquela assinatura, e continuar contando com ela seria confiar
        exatamente no que se pos em duvida. O caminho inverso nao existe --
        escrever um status bonito no frontmatter nao faz subir de nivel, senao a
        escala inteira viraria declaracao.
        """
        if self.auditoria.get("status") == EM_VERIFICACAO:
            return TRUST_PADRAO
        verified = self.meta.get("verified")
        if not isinstance(verified, list) or not verified:
            return TRUST_PADRAO
        for entrada in verified:
            if isinstance(entrada, dict) and str(entrada.get("by", "")).startswith("human:"):
                return "human-reviewed"
        return "machine-confirmed"

    @property
    def vigencia(self) -> dict:
        """Desde quando e ate quando este conceito vale. Vazio quando nao diz.

        `{}` e "nao ha vigencia declarada", e a busca trata isso como SEMPRE
        VALIDO -- nunca como "nao vale". A inversao seria um desastre silencioso:
        a imensa maioria dos documentos de qualquer base nao declara vigencia, e
        um filtro que os escondesse esvaziaria a busca sem erro nenhum.

        Data ilegivel tambem vira ausencia, pela regra de tolerancia da
        especificacao: `ate: "ano que vem"` nao pode fazer a ingestao recusar o
        bundle, e tratar isso como "revogado" seria pior que ignorar.
        """
        bruto = self.meta.get("vigencia")
        if not isinstance(bruto, dict):
            return {}
        de, ate = data_iso(bruto.get("de")), data_iso(bruto.get("ate"))
        if not de and not ate:
            return {}
        return {"de": de, "ate": ate}

    @property
    def auditoria(self) -> dict:
        """O registro da conferencia: status, contra o que, quando e por quem.

        Separado de `verified` de proposito, e os dois nao competem: `verified` e
        o campo da especificacao e diz QUE alguem validou, em formato exportavel
        para qualquer outro consumidor de OKF; a auditoria diz contra O QUE a
        conferencia foi feita e em que estado ela esta. Fundir os dois obrigaria
        a inventar subcampo dentro de um campo da especificacao, e o bundle
        deixaria de ser legivel fora daqui.
        """
        bruto = self.meta.get("auditoria")
        if not isinstance(bruto, dict):
            return {}
        registro = {
            "status": _texto(bruto.get("status"), 60),
            "fonte": _texto(bruto.get("fonte"), 500),
            "conferido_em": data_iso(bruto.get("conferido_em")),
            "conferido_por": _texto(bruto.get("conferido_por"), 120),
        }
        return registro if any(registro.values()) else {}

    @property
    def armadilha(self) -> str:
        """O aviso colado a este conceito, ou vazio quando nao ha marca."""
        return aviso_de_armadilha(self.meta.get("armadilha"))

    def to_dict(self) -> dict:
        """O que vai para o banco e para a tela. NAO e o frontmatter inteiro.

        O `meta` cru pode trazer qualquer coisa que o produtor tenha inventado,
        inclusive volume. Aqui sai o subconjunto que a tela usa, mais o `meta`
        completo para quem quiser inspecionar -- o custo de guardar e baixo e o
        de ter jogado fora, alto.
        """
        saida = {
            "type": self.type,
            "title": self.title,
            "description": self.description,
            "status": self.status,
            "tags": self.tags,
            "resource": self.resource,
            "trust": self.trust,
            "derived": self.derived,
            "meta": self.meta,
        }
        # AUSENTE, e nao vazio. Os tres sao a excecao numa base comum: escrever
        # `"vigencia": {}` em todo conceito poria tres chaves mortas em cada
        # linha e, pior, tiraria o sentido dos indices parciais das migracoes
        # 0016 e 0018 -- eles existem justamente para varrer so a fracao dos
        # documentos que declara cada coisa.
        for chave, valor in (
            ("vigencia", self.vigencia),
            ("auditoria", self.auditoria),
            ("armadilha", self.armadilha),
        ):
            if valor:
                saida[chave] = valor
        return saida


def _yaml(texto: str) -> dict | None:
    """Frontmatter em dicionario. `None` quando nao da para ler.

    Import tardio pelo mesmo motivo do docling e do LlamaIndex: ausencia da lib
    e caso previsto, e o pipeline continua sem OKF em vez de morrer.
    """
    try:
        import yaml
    except Exception as exc:  # noqa: BLE001
        log.info("PyYAML indisponivel (%s); OKF desligado", exc)
        return None
    try:
        dados = yaml.safe_load(texto)
    except Exception as exc:  # noqa: BLE001
        # YAML invalido NAO e erro de ingestao: o arquivo simplesmente nao e um
        # conceito OKF, e segue pelo caminho comum.
        log.info("frontmatter nao e YAML valido (%s); tratando como Markdown comum", exc)
        return None
    return dados if isinstance(dados, dict) else None


def _texto(valor: object, limite: int = 0) -> str:
    if valor is None or isinstance(valor, (dict, list)):
        return ""
    saida = str(valor).strip()
    return saida[:limite] if limite and len(saida) > limite else saida


def parse(markdown: str) -> Concept | None:
    """O conceito OKF deste Markdown, ou `None` se ele nao for um.

    Sao tres as razoes para `None`, e todas significam "nao e OKF", nunca "e OKF
    quebrado": nao ha frontmatter no topo, o frontmatter nao e um mapa YAML, ou
    nao ha `type` com valor. Qualquer outra imperfeicao e aceita, porque a
    especificacao proibe recusar por ela.
    """
    match = _FRONTMATTER_RE.match(markdown or "")
    if match is None:
        return None
    meta = _yaml(match.group(1))
    if meta is None:
        return None
    tipo = _texto(meta.get("type"), 120)
    if not tipo:
        return None

    tags = meta.get("tags")
    return Concept(
        type=tipo,
        body=markdown[match.end():],
        body_start=match.end(),
        title=_texto(meta.get("title"), 180),
        description=_texto(meta.get("description"), _LIMITE_DESCRICAO),
        status=_texto(meta.get("status"), 40),
        tags=[_texto(t, 60) for t in tags if _texto(t)] if isinstance(tags, list) else [],
        resource=_texto(meta.get("resource"), 500),
        meta=meta,
    )


def is_reserved(filename: str) -> bool:
    """`index.md` e `log.md`, que a especificacao reserva e nao sao conceitos."""
    return Path(filename).name.lower() in RESERVADOS


def header(concept: Concept, filename: str = "") -> str:
    """A identidade do conceito, para ir na frente de cada trecho indexado.

    E a razao de existir do modo OKF. O frontmatter e o que diz de QUE o corpo
    fala, e sem ele na frente cada filho volta a ser prosa anonima -- que e
    exatamente o problema que o pai/filho ja tenta resolver, so que aqui a
    resposta esta escrita no arquivo e bastava usar.

    Formato deliberadamente curto e em UMA linha: ele e repetido em todo pai e
    todo filho do documento, e duas linhas por trecho em um bundle de 300
    conceitos viram ruido em cada vetor e em cada resultado de busca lexical.
    """
    nome = concept.title or Path(filename).stem or concept.type
    partes = [f"{concept.type}: {nome}" if nome != concept.type else concept.type]
    if concept.description:
        partes.append(concept.description)
    return " — ".join(partes)


def links(concept: Concept) -> list[str]:
    """Caminhos dos conceitos referenciados pelo corpo, sem repetir.

    As duas formas da especificacao entram iguais: a recomendada, relativa ao
    bundle (`/tables/customers.md`), e a relativa comum (`./outro.md`). A
    normalizacao para aqui de proposito -- resolver `../` exigiria saber onde no
    bundle este arquivo estava, e a ingestao recebe arquivo avulso, nao a arvore.
    Quem consome resolve pelo nome final, e link que nao casa e ignorado, como a
    especificacao manda.
    """
    vistos: list[str] = []
    for _, alvo in _LINK_RE.findall(concept.body):
        alvo = alvo.strip()
        if alvo and alvo not in vistos:
            vistos.append(alvo)
    return vistos


def link_targets(concept: Concept) -> list[str]:
    """Nome do arquivo de cada link, que e por onde o alvo e reconhecido aqui.

    A ingestao deste projeto recebe arquivos avulsos e guarda `filename`, nao o
    caminho dentro do bundle. Casar pelo nome final e a unica ligacao possivel
    sem inventar uma nocao de bundle que o resto do sistema nao tem -- e o custo
    e conhecido: dois conceitos homonimos em pastas diferentes do mesmo bundle
    ficam indistinguiveis.
    """
    nomes: list[str] = []
    for alvo in links(concept):
        nome = Path(alvo).name
        if nome and nome not in nomes and not is_reserved(nome):
            nomes.append(nome)
    return nomes


# ── derivacao: o conceito que o arquivo nao traz ──────────────────────────
#
# Quase nada do que uma base corporativa recebe vem escrito em OKF. PDF, docx e
# planilha nao tem frontmatter, e o Markdown que a casa escreve tambem nao --
# nos quatro arquivos do Espaco `juridico` desta instalacao, zero tinham. Sem
# derivacao, o formato de entrada so serviria para bundle vindo de fora, e nao
# faria nada pelos documentos que ja estao aqui.


# Vocabulario padrao. Existe para o modelo ESCOLHER, nunca para inventar: com
# tipo livre, 40 documentos rendem 31 tipos quase-duplicados ("Politica",
# "Politica Interna", "Diretriz") e a etiqueta deixa de agrupar qualquer coisa.
# Cada Espaco pode trocar a lista em `space.chunking.okf_types`.
TIPOS_PADRAO = (
    "Política",
    "Procedimento",
    "Manual",
    "Contrato",
    "Norma",
    "Ata",
    "Relatório",
    "Referência",
)

# Saida para quando nenhum tipo do vocabulario serve. E melhor que forcar o
# documento num tipo errado: "Documento" nao informa, mas tambem nao mente, e
# ver varios deles na tela e o sinal de que o vocabulario daquela base precisa
# de mais uma entrada.
TIPO_GENERICO = "Documento"

# Quanto do canonico vai no pedido. O que diz o que um documento E aparece no
# comeco dele: titulo, sumario, primeiras secoes. Mandar um PDF de 121 paginas
# inteiro multiplicaria o custo por documento sem mudar a resposta -- e
# estouraria a janela de contexto de modelo pequeno, que e justamente o que faz
# sentido usar aqui.
_LIMITE_ENTRADA = 6000

_INSTRUCAO = """Você classifica documentos de uma base de conhecimento corporativa.

Responda APENAS com um objeto JSON, com exatamente estas chaves:

- "type": um valor EXATO da lista de tipos permitidos que o usuário informar. \
Se nenhum servir, use "{generico}".
- "title": o título do documento, em até 100 caracteres. Use o título real que \
aparece no texto; não invente nem reescreva em outras palavras.
- "description": UMA frase dizendo do que o documento trata e a quem serve, em \
até 200 caracteres. Comece pelo assunto, não por "Este documento".
- "tags": de 2 a 5 termos do domínio que aparecem no documento, em minúsculas.

Regras:
- responda em português do Brasil;
- use SOMENTE o que está no texto. Não complete com conhecimento externo, não \
suponha o que o documento diria adiante, e não deduza área ou setor que não \
esteja escrito;
- se o texto for curto ou ilegível demais para classificar, devolva \
"type": "{generico}" e uma descrição que diga isso."""


def _texto_de(dados: dict, chave: str, limite: int) -> str:
    return _texto(dados.get(chave), limite)


def _tipo_valido(bruto: str, permitidos: list[str]) -> str:
    """O tipo devolvido pelo modelo, casado contra o vocabulario da base.

    A comparacao ignora caixa e espaco em volta porque o modelo devolve
    "política" onde a lista diz "Política", e recusar por isso jogaria fora uma
    classificacao correta. O que NAO e aceito e tipo fora da lista: o operador
    escolheu o vocabulario justamente para a etiqueta agrupar.
    """
    alvo = (bruto or "").strip().casefold()
    for permitido in permitidos:
        if permitido.casefold() == alvo:
            return permitido
    if alvo:
        log.info("o modelo devolveu o tipo '%s', fora do vocabulario; usando %s", bruto, TIPO_GENERICO)
    return TIPO_GENERICO


def tipos_do_espaco(bruto: dict | None) -> list[str]:
    """O vocabulario de tipos desta base, ou o padrao da casa."""
    valores = (bruto or {}).get("okf_types")
    if not isinstance(valores, list):
        return list(TIPOS_PADRAO)
    limpos = [_texto(v, 60) for v in valores]
    limpos = [v for v in limpos if v]
    return limpos or list(TIPOS_PADRAO)


def derive(
    markdown: str,
    filename: str = "",
    tipos: list[str] | None = None,
    titulo: str = "",
    space: str = "",
) -> Concept | None:
    """Pede ao modelo o conceito que o documento nao traz escrito. `None` se nao der.

    Devolve um `Concept` com `body` igual ao Markdown INTEIRO e `body_start`
    zero: nao ha frontmatter para retirar aqui, e o corte trata o texto como
    sempre tratou. O que o conceito acrescenta e a identidade que vai na frente
    de cada trecho.

    NUNCA levanta. Provedor ausente, rede fora, JSON invalido -- tudo vira
    `None`, e a ingestao segue sem o conceito. Um documento sem metadado
    auxiliar continua perfeitamente buscavel; um documento que nao entrou, nao.
    """
    from . import llm  # import tardio: `okf.parse` nao deve puxar rede nenhuma

    corpo = (markdown or "").strip()
    if not corpo:
        return None

    permitidos = tipos or list(TIPOS_PADRAO)
    entrada = corpo[:_LIMITE_ENTRADA]
    contexto = f"Arquivo: {filename}\n" if filename else ""
    if titulo:
        contexto += f"Título extraído: {titulo}\n"

    resposta = llm.complete_json(
        _INSTRUCAO.format(generico=TIPO_GENERICO),
        f"{contexto}Tipos permitidos: {', '.join(permitidos)}\n\n---\n\n{entrada}",
        operation="okf-derive",
        space=space,
    )
    if resposta is None:
        return None

    dados = resposta.dados
    tags = dados.get("tags")
    return Concept(
        type=_tipo_valido(_texto_de(dados, "type", 120), permitidos),
        body=markdown,
        body_start=0,
        # O titulo do modelo so entra se houver um; senao fica o que a extracao
        # ja tinha achado, que e o primeiro cabecalho real do documento.
        title=_texto_de(dados, "title", 180) or titulo,
        description=_texto_de(dados, "description", _LIMITE_DESCRICAO),
        tags=[_texto(t, 60) for t in tags if _texto(t)][:5] if isinstance(tags, list) else [],
        meta={
            # O formato de ator e o da especificacao: `<produtor>/<versao>` para
            # agente. Sem `verified`, entao `trust` sai `unverified` sozinho --
            # e e assim que tem de ser, porque ninguem revisou isto.
            "generated": {
                "by": f"kb-api/{resposta.model}",
                "at": datetime.now(UTC).isoformat(timespec="seconds"),
            },
        },
    )


def resolve(
    markdown: str,
    filename: str = "",
    tipos: list[str] | None = None,
    titulo: str = "",
    space: str = "",
) -> Concept | None:
    """O conceito deste documento: o escrito, se houver; o derivado, se nao.

    A ORDEM e a regra, e ela nao e negociavel. Frontmatter escrito a mao ganha
    do modelo sempre: foi redigido por quem conhece o documento, pode trazer um
    `verified` com `human:<id>` de verdade, e deixar a derivacao passar por cima
    rebaixaria um conceito revisado a `unverified` a cada reprocessamento -- de
    graca, e pagando uma chamada de IA para piorar o dado.

    Devolve `None` quando o arquivo nao e OKF **e** a derivacao nao aconteceu
    (sem provedor de chat, rede fora, resposta invalida). Quem chama segue sem
    conceito; o documento continua sendo indexado normalmente.
    """
    escrito = parse(markdown)
    if escrito is not None:
        return escrito
    return derive(markdown, filename, tipos, titulo, space)

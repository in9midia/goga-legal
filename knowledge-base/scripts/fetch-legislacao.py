#!/usr/bin/env python3
"""Baixa a legislacao primaria do Planalto e grava como conceito OKF.

`planning/00-MVP-PLANO.md` §5.4 item 4. Grava em
`content/legislacao/<espaco>/<arquivo>.md`, e opcionalmente ingere na KB.

POR QUE O TEXTO VEM DO PLANALTO, E NAO DE UM AGREGADOR

O repertorio existe para o agente NAO citar de memoria (R4). Texto de agregador
e copia de copia, sem data de consolidacao e com revogado misturado ao vigente.
O Planalto e a fonte oficial do texto compilado, e a URL dele fica no
frontmatter de cada arquivo para quem conferir.

TRES COISAS DO HTML DO PLANALTO QUE QUEBRAM SEM AVISO

1. **encoding.** As paginas sao windows-1252 (FrontPage, sem `charset` no
   cabecalho HTTP na maioria). Decodificar como UTF-8 com `errors="replace"`
   trocaria todo "ç" e "º" por U+FFFD, e "art. 3º" viraria "art. 3" seguido do caractere de substituicao:
   a busca lexical nao casaria mais o numero do artigo com nada;
2. **texto revogado riscado.** O texto compilado mantem a redacao antiga
   dentro de `<strike>` (as vezes `<s>` ou `<del>`), seguida da redacao nova.
   Sem descartar o riscado, o arquivo teria DUAS versoes do mesmo artigo, e a
   revogada seria recuperada com score igual ao da vigente. Nada falha: o
   agente so responde pela regra que nao vale mais;
3. **HTML aninhado.** Varias paginas tem um `<html><body>` inteiro colado no
   meio do `<body>` (copia do Word). Por isso o conversor e um `HTMLParser`
   tolerante que so olha tags de bloco, e nao uma arvore DOM.

POR QUE OS CODIGOS GRANDES SAO DIVIDIDOS

A ingestao e sincrona: o upload so responde depois de cortar e embedar tudo.
O CC inteiro sao ~2 MB de HTML e milhares de artigos, e o risco de estourar o
timeout do pedido esta registrado nos riscos do plano (§11). Dividir por Livro
ou Titulo mantem cada upload curto e, se um falhar, o reprocesso e daquela
parte, nao do codigo inteiro.

O NIVEL DE CONFIANCA

Cada arquivo sai com `verified: [{by: "machine:planalto"}]`, que o `okf.py`
deriva como `machine-confirmed`: o texto veio da fonte primaria por maquina.
NUNCA `human-reviewed`, que e a assinatura do responsavel tecnico (§8 do plano
da KB) e o unico nivel que abre a zona amarela.

USO

    python3 scripts/fetch-legislacao.py --dry-run
    python3 scripts/fetch-legislacao.py --only l14905
    python3 scripts/fetch-legislacao.py --only cc,cpc
    python3 scripts/fetch-legislacao.py --only l14905 --ingest

So biblioteca padrao.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from datetime import date
from html.parser import HTMLParser

RAIZ = pathlib.Path(__file__).resolve().parent.parent
DESTINO = RAIZ / "content" / "legislacao"
SPACES_YAML = RAIZ / "content" / "spaces.yaml"
BASE_URL = os.environ.get("KB_URL", "http://localhost:8890").rstrip("/")

VERMELHO, VERDE, AZUL, AMARELO, NEUTRO = (
    "\033[31m", "\033[32m", "\033[36m", "\033[33m", "\033[0m",
)


def cor(texto: str, codigo: str) -> str:
    return f"{codigo}{texto}{NEUTRO}"


class Falha(RuntimeError):
    pass


# ── o que baixar ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Diploma:
    slug: str
    titulo: str
    url: str
    espacos: tuple[str, ...]
    # Unidade de divisao em arquivos: "LIVRO", "TITULO", "CAPITULO" ou None.
    dividir_por: str | None = None
    # Inicio da vigencia do diploma ORIGINAL, so onde ela foi conferida. Fica
    # vazio no resto de proposito: conceito sem `vigencia` e tratado como
    # sempre valido (ADR-0024), que e o lado seguro; uma data chutada, ao
    # contrario, esconderia a norma de pergunta sobre fato anterior a ela.
    # Artigo alterado depois tem vigencia propria, que o texto compilado nao
    # separa -- a data aqui vale para o diploma, nao para cada redacao.
    vigencia_de: str = ""
    # Subconjunto de artigos (so para a CF, cuja integra nao cabe no MVP).
    artigos: tuple[str, ...] = ()
    # Fora do Planalto: o script avisa e pula, em vez de raspar um formato que
    # ninguem conferiu.
    manual: str = ""
    # Regex de bloco onde o texto que interessa acaba. Existe pela CF: o ADCT
    # vem depois do corpo permanente e RECOMECA a numeracao, entao o filtro de
    # artigos pegava o art. 5 do ADCT como se fosse o art. 5 da CF.
    parar_em: str = ""
    tags: tuple[str, ...] = field(default_factory=tuple)


P = "https://www.planalto.gov.br/ccivil_03"

# A lista e a do §5.4 item 4. O espaco de cada diploma segue a coluna
# "Repertorio" do `spaces.yaml`; quando o mesmo diploma serve a Espacos cujos
# leitores sao disjuntos (o CDC para `cdc` e `bancario`), ele e copiado nos
# dois, pela mesma regra do seed da auditoria: o agente do `bancario` nao le
# `cdc`, e uma copia so deixaria o especialista 15 sem o CDC.
DIPLOMAS: tuple[Diploma, ...] = (
    # ── transversal
    Diploma("cf", "Constituição Federal de 1988 (artigos selecionados)",
            f"{P}/constituicao/constituicao.htm",
            ("processual-civil", "fazenda-publica"),
            artigos=("5", "6", "37", "93", "98", "102", "103-A", "105", "109",
                     "133", "134", "170", "192", "196", "197", "198", "199"),
            parar_em=r"^ATO DAS DISPOSI[CÇ][OÕ]ES CONSTITUCIONAIS TRANSIT"),
    Diploma("cdc", "Código de Defesa do Consumidor (Lei 8.078/1990)",
            f"{P}/leis/l8078compilado.htm", ("cdc", "bancario"),
            dividir_por="TITULO", vigencia_de="1991-03-11"),
    Diploma("cc", "Código Civil (Lei 10.406/2002)",
            f"{P}/leis/2002/l10406compilada.htm",
            ("civil-contratos", "condominial", "seguros"),
            dividir_por="LIVRO", vigencia_de="2003-01-11"),
    Diploma("cpc", "Código de Processo Civil (Lei 13.105/2015)",
            f"{P}/_ato2015-2018/2015/lei/l13105.htm", ("processual-civil",),
            dividir_por="LIVRO", vigencia_de="2016-03-18"),
    Diploma("l9099", "Lei 9.099/1995 (Juizados Especiais Cíveis e Criminais)",
            f"{P}/leis/l9099.htm", ("processual-civil",)),
    Diploma("l10259", "Lei 10.259/2001 (Juizados Especiais Federais)",
            f"{P}/leis/leis_2001/l10259.htm", ("processual-civil",)),
    Diploma("l12153", "Lei 12.153/2009 (Juizados Especiais da Fazenda Pública)",
            f"{P}/_ato2007-2010/2009/lei/l12153.htm",
            ("processual-civil", "fazenda-publica")),
    Diploma("l8906", "Lei 8.906/1994 (Estatuto da Advocacia e da OAB)",
            f"{P}/leis/l8906.htm", ("etica-regulatorio",)),
    Diploma("lgpd", "Lei 13.709/2018 (LGPD)",
            f"{P}/_ato2015-2018/2018/lei/l13709compilado.htm",
            ("lgpd-digital", "etica-regulatorio")),
    Diploma("marco-civil", "Lei 12.965/2014 (Marco Civil da Internet)",
            f"{P}/_ato2011-2014/2014/lei/l12965.htm", ("lgpd-digital",)),
    Diploma("l14905", "Lei 14.905/2024 (atualização monetária e juros)",
            f"{P}/_ato2023-2026/2024/lei/l14905.htm",
            ("calculo-monetario", "civil-contratos")),
    # ── por area
    Diploma("l14181", "Lei 14.181/2021 (superendividamento)",
            f"{P}/_ato2019-2022/2021/lei/l14181.htm", ("bancario",)),
    Diploma("l9472", "Lei 9.472/1997 (Lei Geral de Telecomunicações)",
            f"{P}/leis/l9472.htm", ("telecom-essenciais",), dividir_por="LIVRO"),
    # O plano lista o Decreto 6.523/2008, que foi REVOGADO pelo Decreto
    # 11.034/2022 (o SAC vigente). Baixar o 6.523 poria no repertorio a regra
    # de SAC que nao vale mais, marcada como fonte primaria. Entra o vigente.
    Diploma("d11034", "Decreto 11.034/2022 (SAC; revogou o Decreto 6.523/2008)",
            f"{P}/_ato2019-2022/2022/decreto/d11034.htm",
            ("telecom-essenciais", "cdc")),
    Diploma("res-anac-400", "Resolução ANAC 400/2016", "", ("aereo",),
            manual="não é publicada no Planalto; coletar do sítio da ANAC"),
    Diploma("l9656", "Lei 9.656/1998 (planos de saúde)",
            f"{P}/leis/l9656.htm", ("saude-suplementar",)),
    Diploma("l14454", "Lei 14.454/2022 (rol da ANS)",
            f"{P}/_ato2019-2022/2022/lei/l14454.htm", ("saude-suplementar",)),
    Diploma("d7962", "Decreto 7.962/2013 (comércio eletrônico)",
            f"{P}/_ato2011-2014/2013/decreto/d7962.htm", ("cdc",)),
    Diploma("l4591", "Lei 4.591/1964 (condomínio e incorporações)",
            f"{P}/leis/l4591.htm", ("imobiliario",)),
    Diploma("l13786", "Lei 13.786/2018 (distrato imobiliário)",
            f"{P}/_ato2015-2018/2018/lei/l13786.htm", ("imobiliario",)),
    Diploma("ctb", "Código de Trânsito Brasileiro (Lei 9.503/1997)",
            f"{P}/leis/l9503compilado.htm", ("transito-veiculos",),
            dividir_por="CAPITULO"),
    Diploma("l8245", "Lei 8.245/1991 (locações)",
            f"{P}/leis/l8245.htm", ("imobiliario",)),
    Diploma("clt", "Consolidação das Leis do Trabalho (DL 5.452/1943)",
            f"{P}/decreto-lei/del5452.htm", ("trabalhista",), dividir_por="TITULO"),
    Diploma("l8213", "Lei 8.213/1991 (planos de benefícios da Previdência)",
            f"{P}/leis/l8213cons.htm", ("previdenciario",), dividir_por="TITULO"),
    Diploma("l8742", "Lei 8.742/1993 (LOAS)",
            f"{P}/leis/l8742.htm", ("previdenciario",)),
    Diploma("ctn", "Código Tributário Nacional (Lei 5.172/1966)",
            f"{P}/leis/l5172compilado.htm", ("tributario-pf",), dividir_por="TITULO"),
    Diploma("d20910", "Decreto 20.910/1932 (prescrição contra a Fazenda)",
            f"{P}/decreto/antigos/d20910.htm", ("fazenda-publica",)),
    Diploma("l14063", "Lei 14.063/2020 (assinaturas eletrônicas)",
            f"{P}/_ato2019-2022/2020/lei/l14063.htm",
            ("processual-civil", "fazenda-publica")),
)


# ── HTML -> blocos de texto ────────────────────────────────────────────────

_BLOCO = {"p", "div", "br", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "li",
          "blockquote", "table", "center"}
# `strike`/`s`/`del`: texto revogado (ver cabecalho). `head`/`style`/`script`:
# o CSS do FrontPage vira prosa se nao for descartado, e entra no indice.
_DESCARTE = {"strike", "s", "del", "style", "script", "head", "title"}
_RISCADO = {"strike", "s", "del"}
# Riscado deste tamanho nao e texto revogado, e formatacao: o CC compilado
# escreve `§ 1<s>º</s>` (o Word marcou o ordinal assim). Descartar tudo
# transformava "§ 1º" em "§ 1", e a busca lexical por "§ 1º" deixava de casar.
# Nenhuma redacao revogada tem tres caracteres.
_RISCADO_MINIMO = 3


class _Extrator(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocos: list[str] = []
        self._atual: list[str] = []
        self._descartando: list[str] = []
        self._riscado: list[str] = []

    def _fechar_bloco(self) -> None:
        texto = " ".join("".join(self._atual).split())
        if texto:
            self.blocos.append(texto)
        self._atual = []

    def handle_starttag(self, tag: str, attrs) -> None:  # noqa: ANN001
        if tag in _DESCARTE:
            if tag in _RISCADO and not self._descartando:
                self._riscado = []
            self._descartando.append(tag)
        elif tag in _BLOCO and not self._descartando:
            self._fechar_bloco()

    def handle_startendtag(self, tag: str, attrs) -> None:  # noqa: ANN001
        if tag == "br" and not self._descartando:
            self._fechar_bloco()

    def handle_endtag(self, tag: str) -> None:
        if tag in _DESCARTE:
            # HTML do Planalto fecha fora de ordem com frequencia. Desempilhar
            # ate a tag que fechou evita que um `</s>` perdido deixe o resto
            # do documento inteiro "riscado" -- e o arquivo sairia vazio.
            if tag in self._descartando:
                while self._descartando:
                    if self._descartando.pop() == tag:
                        break
                if not self._descartando and tag in _RISCADO:
                    riscado = "".join(self._riscado)
                    if len(riscado.strip()) <= _RISCADO_MINIMO:
                        self._atual.append(riscado)
                    self._riscado = []
        elif tag in _BLOCO and not self._descartando:
            self._fechar_bloco()

    def handle_data(self, data: str) -> None:
        texto = data.replace("\xa0", " ")
        if not self._descartando:
            self._atual.append(texto)
        elif all(t in _RISCADO for t in self._descartando):
            self._riscado.append(texto)

    def close(self) -> None:
        super().close()
        self._fechar_bloco()


def decodificar(bruto: bytes, content_type: str = "") -> str:
    """O HTML como texto. Ver o item 1 do cabecalho."""
    declarado = re.search(r"charset=([\w-]+)", content_type or "", re.I)
    if not declarado:
        declarado = re.search(rb"charset=[\"']?([\w-]+)", bruto[:4096], re.I)
        nome = declarado.group(1).decode("ascii", "ignore") if declarado else ""
    else:
        nome = declarado.group(1)
    nome = (nome or "").lower()
    if nome in ("utf-8", "utf8"):
        try:
            return bruto.decode("utf-8")
        except UnicodeDecodeError:
            pass  # declarado utf-8 e nao e: acontece no Planalto, cai no cp1252
    # cp1252, e nao latin-1: as aspas curvas e o travessao do Word ficam na
    # faixa 0x80-0x9F, que no latin-1 sao caracteres de controle invisiveis.
    return bruto.decode("cp1252", errors="replace")


# Linhas de moldura da pagina, sem valor juridico, que casariam com qualquer
# pergunta sobre "Presidencia" ou "vigencia".
_RUIDO = re.compile(
    r"^(Presid[eê]ncia da Rep[uú]blica|Casa Civil|Secretaria[- ]Geral|"
    r"Subchefia para Assuntos Jur[ií]dicos|Secretaria Especial para Assuntos Jur[ií]dicos|"
    r"Mensagem de veto|Vig[eê]ncia|Texto compilado|Regulamento|Regulamenta[cç][aã]o|"
    r"Convers[aã]o da Medida Provis[oó]ria.*|Produ[cç][aã]o de efeitos|[ÍI]ndice|"
    r"Este texto n[aã]o substitui o publicado.*|\*|\.{5,}.*)$",
    re.I,
)

_ESTRUTURA = [
    # (regex no inicio do bloco, nivel de heading, chave de divisao)
    # O CC escreve "P A R T E  G E R A L", letra a letra: o `\s?` entre as
    # letras e o que faz a Parte Geral do CC ser reconhecida como a do CPC.
    (re.compile(r"^P\s?A\s?R\s?T\s?E\s+(G\s?E\s?R\s?A\s?L|E\s?S\s?P\s?E\s?C\s?I\s?A\s?L)\b", re.I),
     2, "PARTE"),
    (re.compile(r"^LIVRO\s+(COMPLEMENTAR|[IVXLC]+|PRIMEIRO|SEGUNDO|TERCEIRO)\b", re.I), 2, "LIVRO"),
    (re.compile(r"^T[IÍ]TULO\s+([IVXLC]+|[ÚU]NICO)\b", re.I), 3, "TITULO"),
    (re.compile(r"^CAP[IÍ]TULO\s+([IVXLC]+(-[A-Z])?|[ÚU]NICO)\b", re.I), 4, "CAPITULO"),
    (re.compile(r"^(Sub)?[Ss]e[cç][aã]o\s+([IVXLC]+(-[A-Z])?|[ÚU]nica)\b"), 5, "SECAO"),
]
# "Brasilia, 28 de junho de 2024; ..." -- a data de assinatura fecha o texto
# normativo. O que vem depois e assinatura, anexo ou sumario.
_ASSINATURA = re.compile(r"^Bras[ií]lia,\s+\d")

# Artigo so no INICIO do bloco e sem aspas: `“Art. 389.` dentro de uma lei que
# altera outra e texto citado, nao um artigo desta lei. Como heading, ele
# criaria um corte com o numero de artigo de outro diploma.
_ARTIGO = re.compile(r"^Art\.\s*(\d+(?:\.\d+)?)\s*[ºo°]?\s*(-\s*[A-Z]+)?\b")


def _numero_artigo(bloco: str) -> str:
    achado = _ARTIGO.match(bloco)
    if not achado:
        return ""
    numero = achado.group(1).replace(".", "")
    sufixo = (achado.group(2) or "").replace(" ", "")
    return numero + sufixo


@dataclass
class Parte:
    rotulo: str  # "" para o preambulo
    linhas: list[str] = field(default_factory=list)


def para_markdown(html_texto: str, diploma: Diploma) -> list[Parte]:
    """Blocos -> Markdown com heading por estrutura, dividido em partes."""
    extrator = _Extrator()
    extrator.feed(html_texto)
    extrator.close()
    blocos = [html.unescape(b) for b in extrator.blocos if not _RUIDO.match(b)]

    partes = [Parte("")]
    artigo_atual = ""
    parte_atual = ""
    assinado = False
    manter = not diploma.artigos
    i = 0
    while i < len(blocos):
        bloco = blocos[i]
        if _ASSINATURA.match(bloco):
            assinado = True
        if diploma.parar_em and re.match(diploma.parar_em, bloco):
            break
        estrutura = next(((n, k) for r, n, k in _ESTRUTURA if r.match(bloco)), None)
        if estrutura and assinado:
            # Estrutura DEPOIS da data de assinatura e o sumario que o Planalto
            # cola no fim do CC e de outros codigos. Tratado como estrutura, ele
            # virava um "Livro IV" duplicado, sem nenhum artigo, que a busca
            # devolveria no lugar do Livro IV verdadeiro.
            break
        if estrutura:
            nivel, chave = estrutura
            # O nome da divisao vem no bloco seguinte ("LIVRO I" / "DAS
            # PESSOAS"). Juntar os dois e o que faz o heading dizer do que a
            # secao trata; sozinho, "LIVRO I" casaria com todo Livro I do CC.
            rotulo = bloco
            # Divisao incluida por lei posterior traz a anotacao entre o numero
            # e o nome ("TITULO II-A" / "(Incluido pela Lei 13.467)" / "DO
            # DANO EXTRAPATRIMONIAL"). Sem pular a anotacao, o nome da divisao
            # virava "(Incluido pela Lei ...)", igual em dezenas de divisoes.
            j = i + 1
            while j < len(blocos) and blocos[j].startswith("(") and len(blocos[j]) < 120:
                j += 1
            if j < len(blocos):
                seguinte = blocos[j]
                if (len(seguinte) < 160 and not _ARTIGO.match(seguinte)
                        and not any(r.match(seguinte) for r, _, _ in _ESTRUTURA)):
                    rotulo = f"{bloco} — {seguinte}"
                    i = j
            if chave == "PARTE":
                rotulo = re.sub(r"^P\s?A\s?R\s?T\s?E\s+(\S(\s?\S)*?)(?=\s*(—|$))",
                                lambda m: "PARTE " + m.group(1).replace(" ", ""), rotulo)
                parte_atual = rotulo
            if diploma.dividir_por == chave:
                # "Livro I" existe duas vezes no CC e no CPC (Parte Geral e
                # Parte Especial). Sem a Parte no rotulo, os dois arquivos
                # teriam o mesmo titulo de conceito.
                prefixo = f"{parte_atual} — " if parte_atual and chave == "LIVRO" else ""
                partes.append(Parte(prefixo + rotulo))
            if not diploma.artigos:
                partes[-1].linhas.append(f"{'#' * nivel} {rotulo}")
            i += 1
            continue

        numero = _numero_artigo(bloco)
        if numero:
            artigo_atual = numero
            manter = not diploma.artigos or numero in diploma.artigos
            if manter:
                # Artigo como heading de nivel 6: o motor `markdown` corta por
                # heading, e cortar por artigo e o corte certo para lei (o
                # comentario do `spaces.yaml` sobre o motor). Com o artigo em
                # prosa, o corte cairia no meio de um e juntaria dois.
                partes[-1].linhas.append(f"###### Art. {numero}")
                partes[-1].linhas.append(bloco)
            i += 1
            continue

        if manter and (artigo_atual or not diploma.artigos):
            partes[-1].linhas.append(bloco)
        i += 1

    partes = [p for p in partes if any(not linha.startswith("#") for linha in p.linhas)]
    # O preambulo sem artigo (ementa e formula de promulgacao) iria para um
    # arquivo de oito linhas, que a busca devolveria para qualquer pergunta
    # sobre o diploma sem responder nada. Ele entra no topo da primeira parte.
    if (len(partes) > 1 and not partes[0].rotulo
            and not any(linha.startswith("###### ") for linha in partes[0].linhas)):
        partes[1].linhas[:0] = partes[0].linhas
        partes = partes[1:]
    return partes


# ── gravacao ───────────────────────────────────────────────────────────────


def _yaml_str(texto: str) -> str:
    return json.dumps(texto, ensure_ascii=False)


def frontmatter(diploma: Diploma, titulo: str, hoje: str, parte: str) -> str:
    linhas = [
        "---",
        "type: Norma",
        f"title: {_yaml_str(titulo)}",
        f"description: {_yaml_str('Texto compilado do Planalto, sem a redação revogada.' + (' ' + parte if parte else ''))}",
        f"tags: [legislacao, {diploma.slug}{''.join(', ' + t for t in diploma.tags)}]",
        f"resource: {_yaml_str(diploma.url)}",
        "",
        "fonte:",
        "  orgao: \"Presidência da República — Planalto\"",
        f"  url: {_yaml_str(diploma.url)}",
        f"  consultado_em: {hoje}",
        "  texto: compilado",
        "",
        "auditoria:",
        "  status: fonte-primaria",
        f"  fonte: {_yaml_str(diploma.url)}",
        f"  conferido_em: {hoje}",
        "  conferido_por: \"scripts/fetch-legislacao.py\"",
        "",
        "verified:",
        "  - by: \"machine:planalto\"",
        f"    at: {hoje}",
    ]
    if diploma.vigencia_de:
        linhas += ["", "vigencia:", f"  de: {diploma.vigencia_de}"]
    linhas.append("---")
    return "\n".join(linhas) + "\n"


def _slug_parte(indice: int, rotulo: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", rotulo.lower()
                  .translate(str.maketrans("áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ",
                                           "aaaaeeiooouucaaaaeeiooouuc")))
    return f"{indice:02d}-{base.strip('-')[:48]}".rstrip("-")


def gravar(diploma: Diploma, partes: list[Parte], hoje: str) -> list[pathlib.Path]:
    arquivos: dict[str, str] = {}
    if len(partes) == 1:
        p = partes[0]
        corpo = f"# {diploma.titulo}\n\n" + "\n\n".join(p.linhas) + "\n"
        arquivos[f"{diploma.slug}.md"] = frontmatter(diploma, diploma.titulo, hoje, "") + "\n" + corpo
    else:
        for indice, p in enumerate(partes):
            rotulo = p.rotulo or "Preâmbulo e disposições iniciais"
            titulo = f"{diploma.titulo} — {rotulo}"
            corpo = f"# {titulo}\n\n" + "\n\n".join(p.linhas) + "\n"
            nome = f"{diploma.slug}-{_slug_parte(indice, rotulo)}.md"
            arquivos[nome] = (frontmatter(diploma, titulo, hoje, f"Parte {indice} de {len(partes) - 1}.")
                              + "\n" + corpo)

    gravados = []
    for espaco in diploma.espacos:
        pasta = DESTINO / espaco
        pasta.mkdir(parents=True, exist_ok=True)
        # Partes antigas do mesmo diploma saem antes: se o Planalto reorganizar
        # um Livro, o arquivo da divisao que deixou de existir ficaria para
        # tras e seria reingerido como se valesse.
        for velho in pasta.glob(f"{diploma.slug}-[0-9][0-9]-*.md"):
            velho.unlink()
        for nome, texto in arquivos.items():
            destino = pasta / nome
            destino.write_text(texto, encoding="utf-8")
            gravados.append(destino)
    return gravados


# ── rede ───────────────────────────────────────────────────────────────────


def baixar(url: str) -> str:
    pedido = urllib.request.Request(url, headers={
        # O Planalto devolve 403 para o User-Agent padrao do urllib.
        "User-Agent": "Mozilla/5.0 (goga-legal fetch-legislacao)",
    })
    ultimo: Exception | None = None
    for tentativa in range(3):
        try:
            # 120s: o CC compilado tem ~2 MB e o Planalto ja levou mais de um
            # minuto para entrega-lo em horario de pico.
            with urllib.request.urlopen(pedido, timeout=120) as resposta:
                return decodificar(resposta.read(), resposta.headers.get("Content-Type", ""))
        except (urllib.error.URLError, TimeoutError) as exc:
            ultimo = exc
            time.sleep(2 * (tentativa + 1))
    raise Falha(f"nao consegui baixar {url}: {ultimo}")


def enviar(arquivo: pathlib.Path, espaco: str) -> str:
    """Sobe um arquivo na KB, pela mesma rota do `ingest.sh`.

    Direto na rota de documento, e NAO pelo `ingest.sh`: ele faz upsert do
    Espaco com rotulo `Base <SLUG>` e descricao vazia antes de subir, o que
    desfaz o que o `apply-spaces.py` gravou (a armadilha do content/README).
    """
    fronteira = uuid.uuid4().hex
    corpo = (
        f"--{fronteira}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{arquivo.name}"\r\n'
        "Content-Type: text/markdown; charset=utf-8\r\n\r\n"
    ).encode() + arquivo.read_bytes() + f"\r\n--{fronteira}--\r\n".encode()
    cabecalhos = {"Content-Type": f"multipart/form-data; boundary={fronteira}"}
    token = os.environ.get("KB_SERVICE_TOKEN", "").strip()
    if token:
        cabecalhos["Authorization"] = f"Bearer {token}"
    pedido = urllib.request.Request(
        f"{BASE_URL}/v1/spaces/{espaco}/documents?wait=true", data=corpo, method="POST",
        headers=cabecalhos,
    )
    try:
        # 3600s: o mesmo teto do `ingest.sh`, pelo mesmo motivo (o servidor
        # termina e grava mesmo depois que o cliente desiste).
        with urllib.request.urlopen(pedido, timeout=3600) as resposta:
            dados = json.loads(resposta.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return f"HTTP {exc.code}: {exc.read().decode(errors='replace')[:160]}"
    except urllib.error.URLError as exc:
        raise Falha(f"{BASE_URL} nao responde ({exc.reason})") from None
    return str(dados.get("status") or dados)[:160]


def espacos_declarados() -> set[str]:
    # Regex e nao PyYAML: o script roda fora do `uv` do kb-api. O formato do
    # `spaces.yaml` e fixo o bastante para isto, e o teste do repertorio
    # garante que todo slug esta nessa forma.
    texto = SPACES_YAML.read_text(encoding="utf-8")
    return set(re.findall(r"^  - slug: ([a-z0-9-]+)\s*$", texto, re.M))


# ── principal ──────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(description="Baixa legislacao do Planalto para content/legislacao")
    parser.add_argument("--dry-run", action="store_true", help="mostra o plano sem baixar")
    parser.add_argument("--only", default="", help="slugs separados por virgula (ex.: l14905,cc)")
    parser.add_argument("--ingest", action="store_true",
                        help="depois de gravar, sobe os arquivos na KB")
    parser.add_argument("--ingest-only", action="store_true",
                        help="nao baixa; so sobe o que ja esta em content/legislacao")
    args = parser.parse_args()

    declarados = espacos_declarados()
    for d in DIPLOMAS:
        for espaco in d.espacos:
            if espaco not in declarados:
                print(cor(f"✗ {d.slug} aponta para Espaco inexistente: {espaco}", VERMELHO))
                sys.exit(1)

    escolhidos = DIPLOMAS
    if args.only:
        pedidos = {s.strip() for s in args.only.split(",") if s.strip()}
        desconhecidos = pedidos - {d.slug for d in DIPLOMAS}
        if desconhecidos:
            print(cor(f"✗ slug desconhecido: {', '.join(sorted(desconhecidos))}", VERMELHO))
            print("  validos: " + ", ".join(d.slug for d in DIPLOMAS))
            sys.exit(1)
        escolhidos = tuple(d for d in DIPLOMAS if d.slug in pedidos)

    hoje = date.today().isoformat()
    print(cor(f"== legislacao -> {DESTINO.relative_to(RAIZ)}", AZUL))
    if args.dry_run:
        print(cor("   (dry-run: nada e baixado nem gravado)", AMARELO))

    gravados: list[tuple[pathlib.Path, str]] = []
    falhas = 0
    for d in escolhidos:
        destino = ", ".join(d.espacos)
        divisao = f" (dividido por {d.dividir_por})" if d.dividir_por else ""
        if d.manual:
            print(f"  {cor('pular', AMARELO):>18} {d.slug:<14} {d.manual}")
            continue
        print(f"  {cor('baixar', VERDE):>18} {d.slug:<14} -> {destino}{divisao}")
        if args.dry_run or args.ingest_only:
            continue
        try:
            partes = para_markdown(baixar(d.url), d)
        except Falha as exc:
            print(cor(f"    ✗ {exc}", VERMELHO))
            falhas += 1
            continue
        if not partes:
            print(cor("    ✗ nenhum artigo extraido; o formato da pagina mudou?", VERMELHO))
            falhas += 1
            continue
        for arquivo in gravar(d, partes, hoje):
            gravados.append((arquivo, arquivo.parent.name))
        print(f"    {len(partes)} arquivo(s) por Espaco")

    if args.ingest_only:
        slugs = {d.slug for d in escolhidos}
        for arquivo in sorted(DESTINO.rglob("*.md")):
            if any(arquivo.name == f"{s}.md" or arquivo.name.startswith(f"{s}-") for s in slugs):
                gravados.append((arquivo, arquivo.parent.name))

    if (args.ingest or args.ingest_only) and not args.dry_run:
        print(cor(f"\n== ingestao -> {BASE_URL}", AZUL))
        # Um por vez, em serie: pelo mesmo motivo do `ingest.sh` (dois
        # documentos grandes em paralelo ja derrubaram o pod por memoria).
        for arquivo, espaco in gravados:
            estado = enviar(arquivo, espaco)
            ok = estado == "indexed"
            falhas += 0 if ok else 1
            print(f"  {espaco:<20} {arquivo.name:<60} "
                  + (cor("ok", VERDE) if ok else cor(estado, VERMELHO)))

    if falhas:
        print(cor(f"\n{falhas} falha(s).", VERMELHO))
        sys.exit(1)
    print(cor("\nOK.", VERDE))


if __name__ == "__main__":
    try:
        main()
    except Falha as exc:
        print(cor(f"\n✗ {exc}", VERMELHO), file=sys.stderr)
        sys.exit(1)

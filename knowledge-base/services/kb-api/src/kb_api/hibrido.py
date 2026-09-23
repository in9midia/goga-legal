"""Extracao hibrida de PDF: PyMuPDF onde basta, docling so onde precisa.

POR QUE EXISTE

O docling analisa o layout de cada pagina com um modelo de visao em CPU: ~3,7 s
por pagina medidos no pod de 3 CPU. Para o livro "Comentarios ao CDC" (1.169
paginas, PDF digital) isso era mais de uma hora -- para chegar ao MESMO texto
que o PyMuPDF le em 1,1 s, porque 1.168 das 1.169 paginas tinham camada de
texto limpa. Com oito livros na fila, eram horas de CPU disputada com a busca.

O que o docling faz que o PyMuPDF nao faz (OCR, tabela em Markdown, texto de
print de tela) so importa em algumas paginas. A triagem acha essas paginas em
~1,5 s para o livro inteiro e manda so elas ao docling.

A TRIAGEM, POR PAGINA

Vai para o docling a pagina que tiver qualquer um destes (limiares em config):

- sem camada de texto (escaneada)            -> precisa de OCR
- imagem cobrindo parte grande da pagina     -> print/grafico, precisa de OCR
- texto com caracteres corrompidos           -> fonte mal codificada
- muitos tracos vetoriais                    -> provavel tabela

O resto sai pelo PyMuPDF. Se a maior parte do PDF precisa do docling
(escaneado, apresentacao), a triagem desiste e o arquivo vai inteiro para ele,
como antes. PDF curto tambem: abaixo de `pdf_hibrido_min_paginas` o docling
inteiro leva minutos, e o layout dele vale o tempo.

TITULOS SEM O DOCLING

O corte `markdown` usa os titulos para nao partir uma secao ao meio, e o
PyMuPDF devolve texto sem titulo. O sumario embutido no PDF (outline) diz
exatamente onde comeca cada capitulo e secao -- em livro, mais confiavel que
adivinhar pelo tamanho da fonte. Cada entrada vira `#`/`##`/... na pagina dela.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass

from . import progresso
from .config import settings
from .extract import (
    PAGE_MARK,
    Extracted,
    Figure,
    _clean,
    docling_paginas,
)

log = logging.getLogger(__name__)

# Cabecalho/rodape corrente: bloco do topo ou do pe que se repete (numero de
# pagina mascarado) em pelo menos esta fracao das paginas. "COMENTARIOS AO CDC",
# "Art. 12 | 245" -- ruido que ia para todo trecho e confundia a busca lexical.
FRACAO_REPETICAO = 0.2
# So os blocos das bordas sao candidatos: repeticao no meio da pagina e conteudo
# (uma formula legal que se repete e texto de verdade).
BLOCOS_DE_BORDA = 2
# E curtos: cabecalho corrente e titulo do livro, secao, numero de pagina. Sem
# este teto, pagina com poucos blocos tinha o PARAGRAFO tratado como borda, e um
# paragrafo repetido (teste sintetico, mas tambem formula de despacho) sumia.
BORDA_MAX_CHARS = 120


@dataclass
class Triagem:
    total: int
    # pagina (1-based) -> motivo de ir ao docling
    docling: dict[int, str]

    @property
    def rapidas(self) -> int:
        return self.total - len(self.docling)

    def resumo(self) -> str:
        motivos = Counter(self.docling.values())
        detalhe = ", ".join(f"{m}: {n}" for m, n in motivos.most_common())
        base = f"triagem: {self.rapidas} págs pelo PyMuPDF, {len(self.docling)} pelo docling"
        return f"{base} ({detalhe})" if detalhe else base


def _corrompido(texto: str) -> bool:
    if not texto:
        return False
    ruins = sum(
        1 for ch in texto
        if ch == "�" or (unicodedata.category(ch) in ("Co", "Cc") and ch not in "\n\t\r")
    )
    return ruins / len(texto) > 0.02


def triar(doc) -> Triagem:
    """Quais paginas precisam do docling, e por que. So PyMuPDF, ~1 ms por pagina."""
    docling: dict[int, str] = {}
    for numero, page in enumerate(doc, start=1):
        texto = page.get_text()
        if len(texto.strip()) < 50:
            docling[numero] = "sem texto"
            continue
        if _corrompido(texto):
            docling[numero] = "texto corrompido"
            continue
        area = abs(page.rect) or 1.0
        coberta = 0.0
        for info in page.get_images(full=True):
            try:
                coberta += sum(abs(r) for r in page.get_image_rects(info[0]))
            except Exception:  # noqa: BLE001 - imagem quebrada nao decide nada
                continue
        if coberta / area > settings.pdf_imagem_area:
            docling[numero] = "imagem"
            continue
        try:
            desenhos = len(page.get_drawings())
        except Exception:  # noqa: BLE001
            desenhos = 0
        if desenhos > settings.pdf_tabela_desenhos:
            docling[numero] = "tabela"
    return Triagem(total=doc.page_count, docling=docling)


def _faixas(paginas: list[int], lote: int) -> list[tuple[int, int]]:
    """Paginas soltas -> faixas contiguas, cada uma com no maximo `lote` paginas."""
    faixas: list[tuple[int, int]] = []
    for p in sorted(paginas):
        if faixas and p == faixas[-1][1] + 1 and p - faixas[-1][0] < lote:
            faixas[-1] = (faixas[-1][0], p)
        else:
            faixas.append((p, p))
    return faixas


def _chave(texto: str) -> str:
    """Forma comparavel de um bloco de borda: numeros viram `#`, espaco some."""
    return re.sub(r"\s+", " ", re.sub(r"\d+", "#", texto)).strip().lower()


def _blocos(page) -> list[str]:
    """Blocos de texto da pagina, na ordem de leitura, com as linhas de cada um unidas.

    O `get_text("text")` quebra a linha onde o PDF quebrou ("produtos\\nperecíveis."),
    e isso ia para o canonico e para o trecho que o agente cita. Dentro de um
    bloco a quebra e de diagramacao, nao de paragrafo.
    """
    import pymupdf

    blocos = []
    for b in page.get_text("blocks", sort=True, flags=pymupdf.TEXT_DEHYPHENATE):
        if b[6] != 0:  # 1 = bloco de imagem
            continue
        texto = " ".join(linha.strip() for linha in b[4].splitlines() if linha.strip())
        if texto:
            blocos.append(texto)
    return blocos


def _bordas_repetidas(paginas_blocos: dict[int, list[str]]) -> set[str]:
    contagem: Counter[str] = Counter()
    for blocos in paginas_blocos.values():
        vistos = {
            _chave(b) for b in blocos[:BLOCOS_DE_BORDA] + blocos[-BLOCOS_DE_BORDA:]
            if len(b) <= BORDA_MAX_CHARS
        }
        contagem.update(vistos)
    minimo = max(3, int(len(paginas_blocos) * FRACAO_REPETICAO))
    return {chave for chave, n in contagem.items() if n >= minimo and chave}


def _sem_bordas(blocos: list[str], repetidas: set[str]) -> list[str]:
    """Tira da pagina os blocos de borda que sao cabecalho/rodape corrente."""
    total = len(blocos)
    return [
        b for i, b in enumerate(blocos)
        if not ((i < BLOCOS_DE_BORDA or i >= total - BLOCOS_DE_BORDA) and _chave(b) in repetidas)
    ]


def _normal(texto: str) -> str:
    """Forma de comparacao de titulo: sem acento, sem caixa, sem espaco nem pontuacao.

    Sem espaco de proposito: no Filomeno o corpo traz "1.1Introdução" (o PDF
    posiciona o numero e o titulo sem o caractere de espaco) e o sumario traz
    "1.1 Introdução". Comparando com espaco, 118 de 123 titulos nao casavam.
    """
    sem_acento = unicodedata.normalize("NFKD", texto)
    sem_acento = "".join(ch for ch in sem_acento if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]+", "", sem_acento.lower())


# Quantas paginas adiante do titulo anterior se procura o proximo. Titulos
# consecutivos do sumario raramente distam mais que isso; uma janela maior so
# aumentaria a chance de casar com um bloco que por acaso comeca igual.
JANELA_ANCORA = 200
# Abaixo desta fracao de titulos achados no texto, o sumario e descartado.
MIN_ANCORADOS = 0.3
# Pagina onde pelo menos tantos titulos DIFERENTES do sumario comecam um bloco
# e o proprio sumario impresso do livro, nao conteudo. No "Direitos do
# Consumidor" (Filomeno) 121 de 123 entradas foram "achadas" nas paginas 47-49
# -- o sumario impresso -- e o livro inteiro ficou com 12 secoes. Pagina de
# conteudo abre, no maximo, umas poucas subsecoes curtas.
MIN_TITULOS_PAGINA_DE_SUMARIO = 8


def ancorar_sumario(
    sumario: list[tuple[int, str, int]], blocos: dict[int, list[str]], total: int,
) -> tuple[dict[int, list[tuple[int, str]]], int]:
    """Pagina REAL de cada entrada do sumario, achada no texto.

    POR QUE NAO CONFIAR NA PAGINA DECLARADA: no "Comentarios ao CDC" 1.222 das
    1.279 entradas apontavam para as paginas 100-199 (muitas para a 182), e o
    texto delas estava espalhado pelo livro inteiro. Confiando, 1.282 titulos
    foram parar nas primeiras paginas e 2.605 trechos receberam a mesma secao
    ("Capitulo I › Art. 1º"). Sumario gerado por conversor quebra assim, em
    silencio.

    O sumario esta em ordem de leitura, entao cada entrada e procurada a partir
    da pagina da anterior: um bloco que COMECA pelo titulo (referencia no meio
    de um paragrafo, "conforme o art. 18", nao comeca). A pagina declarada e
    tentada primeiro quando nao esta atras do cursor. Entrada nao achada fica de
    fora -- titulo nenhum e melhor que titulo no lugar errado.

    O sumario IMPRESSO do livro (as paginas "Sumario" no comeco) casa com todos
    os titulos e engoliria todas as ancoras; essas paginas ficam de fora
    (`MIN_TITULOS_PAGINA_DE_SUMARIO`).

    Devolve {pagina: [(nivel, titulo)]} e quantas entradas foram ancoradas.
    """
    inicios = {
        n: [_normal(b) for b in lista if not b.startswith("#")]
        for n, lista in blocos.items()
    }

    # Paginas do sumario impresso: indice pelos 20 primeiros caracteres para
    # nao comparar cada titulo com cada bloco do livro (1.279 x ~20 mil).
    por_prefixo: dict[str, set[str]] = {}
    for _nivel, titulo, _pag in sumario:
        alvo = _normal(titulo)
        if alvo:
            por_prefixo.setdefault(alvo[:20], set()).add(alvo)
    # A deteccao do sumario impresso fica com a forma estrita (bloco comeca pelo
    # titulo completo): e assim que uma linha de sumario impresso se parece.
    impressas: set[int] = set()
    for n, lista in inicios.items():
        casados = {
            alvo for b in lista for alvo in por_prefixo.get(b[:20], ()) if b.startswith(alvo)
        }
        if len(casados) >= MIN_TITULOS_PAGINA_DE_SUMARIO:
            impressas.add(n)

    def comeca(pagina: int, alvo: str, sem_numero: str) -> bool:
        if pagina in impressas:
            return False
        return any(_casa(b, alvo, sem_numero) for b in inicios.get(pagina, ()))

    ancorado: dict[int, list[tuple[int, str]]] = {}
    cursor, achados = 1, 0
    for nivel, titulo, declarada in sumario:
        alvo, sem_numero = _formas(titulo)
        if not alvo:
            continue
        candidatas = [declarada] if declarada >= cursor else []
        candidatas += range(cursor, min(total, cursor + JANELA_ANCORA) + 1)
        pagina = next((p for p in candidatas if comeca(p, alvo, sem_numero)), None)
        if pagina is None:
            continue
        ancorado.setdefault(pagina, []).append((nivel, titulo))
        cursor, achados = pagina, achados + 1
    return ancorado, achados


_NUMERACAO = re.compile(r"^\s*(?:§+\s*)?\d+(?:\.\d+)*[.)º°]?\s*[-–:]?\s*")
# Titulo sem numeracao so casa se sobrar texto bastante: "Conceito" sozinho
# aparece como titulo em dezenas de secoes e casaria com a errada.
MIN_TITULO_SEM_NUMERO = 12
# Bloco que e o COMECO do titulo (titulo quebrado em duas linhas) so conta a
# partir deste tamanho; bloco curto como "Art." seria comeco de tudo.
MIN_COMECO_DE_TITULO = 20


def _formas(titulo: str) -> tuple[str, str]:
    """(titulo normalizado, titulo normalizado sem a numeracao inicial)."""
    sem_numero = _normal(_NUMERACAO.sub("", titulo, count=1))
    alvo = _normal(titulo)
    return alvo, (sem_numero if sem_numero != alvo else "")


def _casa(bloco: str, alvo: str, sem_numero: str) -> bool:
    """O bloco (normalizado) e o titulo do sumario?

    Tres formas, todas vistas em livro real:
    - o bloco comeca pelo titulo ("Art. 18. Os fornecedores...");
    - o bloco e o COMECO do titulo, quebrado em duas linhas ("§ 35. PROCEDIMENTO
      DA ARRECADACAO DE HERANCA" + "JACENTE" no bloco seguinte, Theodoro vol. 2);
    - o numero vem separado e o bloco e so o texto ("78." na margem, e o bloco
      "Procedimento: as acoes de forca nova e forca velha"). Aqui o bloco tem de
      ser praticamente so o titulo, senao qualquer paragrafo que o cite casaria.
    """
    if bloco.startswith(alvo):
        return True
    if len(bloco) >= MIN_COMECO_DE_TITULO and alvo.startswith(bloco):
        return True
    return (
        len(sem_numero) >= MIN_TITULO_SEM_NUMERO
        and bloco.startswith(sem_numero)
        and len(bloco) <= len(sem_numero) + 3
    )


def _com_titulos(blocos: list[str], entradas: list[tuple[int, str]]) -> list[str]:
    """Poe as entradas do sumario desta pagina como titulo Markdown.

    O bloco que comeca pelo titulo e substituido pelo `#` (e o resto do bloco,
    se houver, fica como paragrafo). Titulo que nao se acha no texto entra no
    topo da pagina: a secao comeca aqui, segundo o proprio PDF.
    """
    saida = list(blocos)
    no_topo: list[str] = []
    for nivel, titulo in entradas:
        marca = "#" * min(max(nivel, 1), 6) + " " + titulo.strip()
        alvo, sem_numero = _formas(titulo)
        achou = False
        if alvo:
            for i, bloco in enumerate(saida):
                if bloco.startswith("#"):
                    continue
                normal = _normal(bloco)
                if _casa(normal, alvo, sem_numero):
                    if bloco.startswith(titulo.strip()):
                        resto = bloco[len(titulo.strip()):].strip()
                        saida[i:i + 1] = [marca] + ([resto] if resto else [])
                    elif len(normal) <= len(alvo) + 3 or alvo.startswith(normal):
                        saida[i] = marca
                    else:
                        # Casou so depois de normalizar e o bloco tem mais que o
                        # titulo: o titulo entra antes, o bloco fica inteiro. Cortar
                        # por posicao aqui ja comeu texto do paragrafo.
                        saida.insert(i, marca)
                    achou = True
                    break
        if not achou:
            no_topo.append(marca)
    return no_topo + saida


def extrair(data: bytes, filename: str) -> Extracted | None:
    """Extracao hibrida, ou `None` quando o PDF deve ir inteiro para o docling."""
    if not settings.pdf_hibrido or not filename.lower().endswith(".pdf"):
        return None
    try:
        import pymupdf
    except Exception:  # noqa: BLE001
        return None

    try:
        doc = pymupdf.open(stream=data, filetype="pdf")
    except Exception as exc:  # noqa: BLE001 - o docling tenta do jeito dele
        log.info("hibrido: PyMuPDF nao abriu %s (%s)", filename, exc)
        return None

    with doc:
        if doc.page_count < settings.pdf_hibrido_min_paginas:
            return None
        triagem = triar(doc)
        if len(triagem.docling) / triagem.total > settings.pdf_hibrido_max_fracao_docling:
            log.info("hibrido: %s -> docling inteiro (%s)", filename, triagem.resumo())
            progresso.nota(f"{triagem.resumo()}; quase tudo precisa do docling, vai inteiro")
            return None
        log.info("hibrido: %s -> %s", filename, triagem.resumo())
        progresso.nota(triagem.resumo())

        # Paginas rapidas: blocos, sem o cabecalho/rodape corrente.
        blocos = {
            n: _blocos(doc[n - 1])
            for n in range(1, triagem.total + 1) if n not in triagem.docling
        }
        repetidas = _bordas_repetidas(blocos)
        blocos = {n: _sem_bordas(lista, repetidas) for n, lista in blocos.items()}

        try:
            toc = [
                (nivel, titulo, pagina) for nivel, titulo, pagina in doc.get_toc(simple=True)
                if titulo.strip()
            ]
        except Exception:  # noqa: BLE001 - sumario quebrado = sem titulos, nao sem texto
            toc = []
        sumario, achados = ancorar_sumario(toc, blocos, triagem.total) if toc else ({}, 0)
        if toc:
            if achados < MIN_ANCORADOS * len(toc):
                aviso = (f"sumário do PDF descartado: só {achados} de {len(toc)} títulos "
                         "achados no texto; corte por tamanho")
                sumario = {}
            else:
                aviso = f"sumário: {achados} de {len(toc)} títulos ancorados no texto"
            log.info("hibrido: %s: %s", filename, aviso)
            progresso.nota(aviso)

    # Paginas do docling, em faixas contiguas e no maximo um lote por conversao.
    do_docling: dict[int, str] = {}
    figuras: list[Figure] = []
    if triagem.docling:
        faixas = _faixas(list(triagem.docling), max(1, settings.docling_page_batch))

        def ao_iniciar(n: int, faixa: tuple[int, int]) -> None:
            progresso.avancar(
                "extracao", n + 1, len(faixas) + 1,
                f"docling: páginas {faixa[0]}-{faixa[1]} "
                f"({n + 1} de {len(faixas)} faixas; {len(triagem.docling)} págs no total)",
                marco_a_cada=0,
            )

        resultado = docling_paginas(data, filename, faixas, ao_iniciar)
        if resultado is None:
            # Sem docling, essas paginas saem pelo PyMuPDF mesmo: texto parcial
            # (ou nenhum, se escaneada) e melhor que perder o livro inteiro.
            log.warning("hibrido: docling falhou; %s paginas ficam com o texto do PyMuPDF",
                        len(triagem.docling))
            try:
                with pymupdf.open(stream=data, filetype="pdf") as doc:
                    do_docling = {n: doc[n - 1].get_text().strip() for n in triagem.docling}
            except Exception:  # noqa: BLE001
                do_docling = {}
        else:
            do_docling, figuras = resultado

    partes: list[str] = []
    for n in range(1, triagem.total + 1):
        if n in triagem.docling:
            corpo = do_docling.get(n, "")
        else:
            corpo = "\n\n".join(_com_titulos(blocos.get(n, []), sumario.get(n, [])))
        if corpo.strip():
            partes.append(f"{PAGE_MARK.format(page=n)}\n{corpo.strip()}")
    markdown = _clean("\n\n".join(partes))
    if not markdown:
        return None
    extrator = "pymupdf+docling" if triagem.docling else "pymupdf"
    # Titulo pelo nome do arquivo, e nao pelo primeiro cabecalho: a primeira
    # entrada do sumario do "Comentarios ao CDC" e "dLivros" (marca d'agua do
    # site de onde o PDF saiu), e foi isso que virou titulo e fonte citada. Em
    # livro o nome do arquivo costuma ser "Titulo - Autor", que e a citacao certa.
    titulo = filename.rsplit("/", 1)[-1].removesuffix(".pdf").removesuffix(".PDF").strip()
    return Extracted(
        markdown=markdown, extractor=extrator, title=titulo, pages=triagem.total, figures=figuras,
    )

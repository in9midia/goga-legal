"""O docling em lotes isolados, com retomada por lote, e o OCR direto do escaneado.

O caso que motivou: a Novissima Gramatica (livro escaneado) foi OOMKilled em 45
tentativas por uma semana. A memoria crescia de lote em lote no mesmo processo,
e cada tentativa recomecava da pagina 1. O que os testes travam:

1. lote ja convertido numa tentativa anterior nao e convertido de novo, e so
   vale com a mesma numeracao de figuras e a mesma configuracao;
2. lote cujo processo morre e dividido ao meio, a numeracao das figuras
   continua, e a pagina sozinha que mata o processo falha o docling;
3. o PDF escaneado vai ao tesseract pagina a pagina, sem o docling, e o OCR
   tambem retoma por lote;
4. os lotes saem do object store quando o documento e gravado.

Fica de fora, e e verificado a mao contra o cluster: o processo filho de
verdade (`spawn` carregando o docling) e o pico de memoria medido no Job.
"""

from __future__ import annotations

import importlib
from dataclasses import replace

import pytest

pymupdf = pytest.importorskip("pymupdf")


@pytest.fixture
def modulos(tmp_path, monkeypatch):
    monkeypatch.setenv("KB_STORAGE_BACKEND", "filesystem")
    monkeypatch.setenv("KB_STORAGE_DIR", str(tmp_path / "objetos"))
    from kb_api import config as modulo_config

    importlib.reload(modulo_config)
    from kb_api import storage as modulo_storage

    importlib.reload(modulo_storage)
    modulo_storage.ensure_bucket()
    from kb_api import extract, hibrido, retomada

    # `retomada` guarda a referencia ao modulo `storage` recarregado acima so
    # depois do reload dela; extract e hibrido leem `settings` do proprio modulo.
    importlib.reload(retomada)
    monkeypatch.setattr(extract, "retomada", retomada)
    monkeypatch.setattr(hibrido, "retomada", retomada)
    monkeypatch.setattr(extract, "settings", replace(
        extract.settings, docling_page_batch=10, docling_isolar_lote=False,
    ))
    return extract, hibrido, retomada


def _pdf(paginas: int, com_texto: bool = True) -> bytes:
    doc = pymupdf.open()
    for i in range(1, paginas + 1):
        page = doc.new_page()
        if com_texto:
            page.insert_text((60, 90), f"Pagina {i} do livro", fontsize=12)
    return doc.tobytes()


def _lote_falso(extract, faixa, ja, figuras_por_lote=1):
    a, b = faixa
    figuras = [
        extract.Figure(ref=f"fig-{ja + k + 1}", page=a, data=b"png")
        for k in range(figuras_por_lote)
    ]
    return extract.LoteDocling(
        paginas={p: f"texto {p}" + (" <!-- image -->" if p == a else "") for p in range(a, b + 1)},
        inteiro="", total=b - a + 1, figures=figuras,
    )


@pytest.fixture
def conversoes(modulos, monkeypatch):
    extract, _, _ = modulos
    feitas: list[tuple[int, int]] = []

    def falso(data, filename, faixa, ja, bytes_anteriores):
        feitas.append(faixa)
        return _lote_falso(extract, faixa, ja)

    monkeypatch.setattr(extract, "_converter_lote", falso)
    monkeypatch.setattr(extract, "_docling_disponivel", lambda: True)
    return feitas


# ── 1. retomada por lote ───────────────────────────────────────────────────


def test_segunda_tentativa_nao_converte_de_novo(modulos, conversoes):
    extract, _, _ = modulos
    data = _pdf(25)
    primeiro = extract._docling(data, "livro.pdf")
    assert conversoes == [(1, 10), (11, 20), (21, 25)]

    conversoes.clear()
    segundo = extract._docling(data, "livro.pdf")
    assert conversoes == []
    assert segundo.markdown == primeiro.markdown
    assert [f.ref for f in segundo.figures] == ["fig-1", "fig-2", "fig-3"]


def test_tentativa_que_morreu_no_meio_so_converte_o_que_falta(modulos, monkeypatch):
    extract, _, _ = modulos
    data = _pdf(25)
    feitas: list[tuple[int, int]] = []

    def morre_no_terceiro(data, filename, faixa, ja, bytes_anteriores):
        feitas.append(faixa)
        if faixa == (21, 25):
            raise MemoryError("simula o OOM no terceiro lote")
        return _lote_falso(extract, faixa, ja)

    monkeypatch.setattr(extract, "_converter_lote", morre_no_terceiro)
    monkeypatch.setattr(extract, "_docling_disponivel", lambda: True)
    assert extract._docling(data, "livro.pdf") is None

    feitas.clear()
    monkeypatch.setattr(extract, "_converter_lote", lambda d, f, faixa, ja, b: (
        feitas.append(faixa) or _lote_falso(extract, faixa, ja)
    ))
    r = extract._docling(data, "livro.pdf")
    assert feitas == [(21, 25)]
    assert "<!-- pagina 25 -->" in r.markdown


def test_lote_de_outra_configuracao_nao_serve(modulos, conversoes, monkeypatch):
    extract, _, _ = modulos
    data = _pdf(25)
    extract._docling(data, "livro.pdf")
    conversoes.clear()
    monkeypatch.setattr(extract, "settings", replace(extract.settings, figure_scale=3.0))
    extract._docling(data, "livro.pdf")
    assert conversoes == [(1, 10), (11, 20), (21, 25)]


def test_lote_com_outra_numeracao_de_figuras_nao_serve(modulos):
    _, _, retomada = modulos
    retomada.docling_gravar("ab" * 32, "assin", (11, 20), 1, "lote")
    assert retomada.docling_carregar("ab" * 32, "assin", (11, 20), 1) == "lote"
    assert retomada.docling_carregar("ab" * 32, "assin", (11, 20), 4) is None


def test_limpar_remove_os_lotes_de_qualquer_assinatura(modulos):
    _, _, retomada = modulos
    sha = "cd" * 32
    retomada.docling_gravar(sha, "a1", (1, 10), 0, "x")
    retomada.docling_gravar(sha, "a2", (1, 10), 0, "y")
    retomada.docling_gravar("ef" * 32, "a1", (1, 10), 0, "outro")
    retomada.docling_limpar(sha)
    assert retomada.docling_carregar(sha, "a1", (1, 10), 0) is None
    assert retomada.docling_carregar(sha, "a2", (1, 10), 0) is None
    assert retomada.docling_carregar("ef" * 32, "a1", (1, 10), 0) == "outro"


def test_ingest_limpa_os_lotes_do_docling_depois_do_commit():
    import inspect

    from kb_api import ingest

    fonte = inspect.getsource(ingest)
    commit = fonte.index("retomada.limpar(space_slug, content_sha)")
    assert "retomada.docling_limpar(content_sha)" in fonte[commit:commit + 200]


# ── 2. processo que morre ──────────────────────────────────────────────────


def test_lote_que_morre_e_dividido_e_as_figuras_continuam(modulos, monkeypatch):
    extract, _, _ = modulos
    data = _pdf(10)
    pedidas: list[tuple[int, int]] = []

    def converter(self, faixa, ja, bytes_anteriores):
        pedidas.append(faixa)
        if faixa[1] - faixa[0] + 1 > 3:
            raise extract.LoteMorreu("OOM")
        return _lote_falso(extract, faixa, ja)

    monkeypatch.setattr(extract._Conversor, "_converter", converter)
    monkeypatch.setattr(extract, "_docling_disponivel", lambda: True)
    monkeypatch.setattr(extract, "settings", replace(extract.settings, docling_page_batch=0))
    r = extract.docling_paginas(data, "livro.pdf", [(1, 10)])
    assert r is not None
    paginas, figuras = r
    assert sorted(paginas) == list(range(1, 11))
    assert pedidas == [(1, 10), (1, 5), (1, 3), (4, 5), (6, 10), (6, 8), (9, 10)]
    assert [f.ref for f in figuras] == ["fig-1", "fig-2", "fig-3", "fig-4"]
    assert "<!-- figura fig-3 -->" in paginas[6]


def test_pagina_sozinha_que_mata_o_processo_falha_o_docling(modulos, monkeypatch):
    extract, _, _ = modulos

    def sempre_morre(self, faixa, ja, bytes_anteriores):
        raise extract.LoteMorreu("OOM")

    monkeypatch.setattr(extract._Conversor, "_converter", sempre_morre)
    monkeypatch.setattr(extract, "_docling_disponivel", lambda: True)
    assert extract.docling_paginas(_pdf(4), "livro.pdf", [(1, 4)]) is None


def test_filho_morto_vira_lote_morreu(modulos, monkeypatch):
    """O executor de processo avisa a morte do filho com BrokenProcessPool."""
    extract, _, _ = modulos
    from concurrent.futures.process import BrokenProcessPool

    class Futuro:
        def result(self):
            raise BrokenProcessPool("filho morreu")

    class Executor:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def submit(self, *a, **k):
            return Futuro()

    monkeypatch.setattr(extract, "ProcessPoolExecutor", Executor)
    monkeypatch.setattr(extract, "settings", replace(extract.settings, docling_isolar_lote=True))
    with extract._Conversor(_pdf(2), "livro.pdf") as conversor:
        with pytest.raises(extract.LoteMorreu):
            conversor._converter((1, 2), 0, 0)
        caminho = conversor._caminho
    assert caminho is not None
    import os

    assert not os.path.exists(caminho)


# ── 3. escaneado pelo tesseract ────────────────────────────────────────────


@pytest.fixture
def ocr_falso(modulos, monkeypatch):
    _, hibrido, _ = modulos
    lidas: list[int] = []

    def falso(png):
        lidas.append(len(lidas))
        return f"texto lido {len(lidas)}"

    monkeypatch.setattr(hibrido, "_ocr_image", falso)
    monkeypatch.setattr(hibrido, "docling_paginas", lambda *a, **k: pytest.fail("foi ao docling"))
    monkeypatch.setattr(hibrido, "settings", replace(hibrido.settings, docling_page_batch=40))
    return lidas


def test_escaneado_vai_ao_tesseract_sem_o_docling(modulos, ocr_falso):
    _, hibrido, _ = modulos
    r = hibrido.extrair(_pdf(90, com_texto=False), "escaneado.pdf")
    assert r is not None
    assert r.extractor == "pymupdf+tesseract"
    assert len(ocr_falso) == 90
    assert "<!-- pagina 90 -->\ntexto lido 90" in r.markdown


def test_ocr_do_escaneado_retoma_por_lote(modulos, ocr_falso):
    _, hibrido, _ = modulos
    data = _pdf(90, com_texto=False)
    hibrido.extrair(data, "escaneado.pdf")
    ocr_falso.clear()
    r = hibrido.extrair(data, "escaneado.pdf")
    assert ocr_falso == []
    assert "texto lido 90" in r.markdown


def test_digital_com_poucas_paginas_sem_texto_segue_no_docling(modulos, monkeypatch):
    """Pagina sem texto num PDF digital costuma ser diagrama: o docling extrai a
    figura e a legenda, que o tesseract direto perderia."""
    _, hibrido, _ = modulos
    doc = pymupdf.open()
    for i in range(1, 101):
        page = doc.new_page()
        if i != 50:
            page.insert_textbox(pymupdf.Rect(60, 110, 540, 760),
                                f"Pagina {i}. Texto corrido do livro digital. " * 5, fontsize=10)
    pedidas: list[tuple[int, int]] = []
    monkeypatch.setattr(hibrido, "_ocr_image", lambda png: pytest.fail("foi ao tesseract"))
    monkeypatch.setattr(hibrido, "docling_paginas", lambda d, f, faixas, cb=None: (
        pedidas.extend(faixas) or ({p: "[DOCLING]" for a, b in faixas for p in range(a, b + 1)}, [])
    ))
    r = hibrido.extrair(doc.tobytes(), "digital.pdf")
    assert pedidas == [(50, 50)]
    assert r.extractor == "pymupdf+docling"


# ── 4. escaneado que ja tem camada de texto ────────────────────────────────


def _pagina_escaneada(doc, texto: str) -> None:
    page = doc.new_page()
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 300, 420), 0)
    pix.clear_with(230)
    page.insert_image(page.rect, pixmap=pix)
    if texto:
        page.insert_textbox(pymupdf.Rect(60, 80, 540, 780), texto, fontsize=9)


def test_escaneada_com_camada_de_texto_sai_pelo_pymupdf():
    """A Novissima Gramatica: 687 de 695 paginas com a imagem do escaneado
    cobrindo a pagina e o texto do OCR por cima. Iam todas ao docling."""
    from kb_api import hibrido

    doc = pymupdf.open()
    _pagina_escaneada(doc, "Fonema e a menor unidade sonora da lingua. " * 10)
    _pagina_escaneada(doc, "Figura 3. Aparelho fonador: pulmoes, laringe, cordas vocais e boca.")
    _pagina_escaneada(doc, "")
    triagem = hibrido.triar(doc)
    assert triagem.docling == {2: "imagem", 3: "sem texto"}

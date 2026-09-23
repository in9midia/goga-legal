"""Livro: extracao hibrida (fase 1), secao do trecho (fase 2), grafo e wiki
cobrindo o documento inteiro (fase 3). Sem a stack de pe.

Fica de fora, e e verificado a mao contra o cluster: o docling de verdade nas
paginas triadas, a qualidade dos titulos vindos do sumario de um PDF real, e o
custo das chamadas de grafo e wiki num livro inteiro.
"""
from __future__ import annotations

from dataclasses import replace

import pytest

pymupdf = pytest.importorskip("pymupdf")


def _livro(paginas: int = 100, branca: int | None = 50, imagem: int | None = 70) -> bytes:
    doc = pymupdf.open()
    sumario = []
    for i in range(1, paginas + 1):
        page = doc.new_page()
        page.insert_text((60, 40), "COMENTÁRIOS AO CÓDIGO DE DEFESA DO CONSUMIDOR", fontsize=8)
        page.insert_text((300, 800), str(i), fontsize=8)
        if i == branca:
            continue
        if i % 10 == 1:
            titulo = f"Capítulo {i // 10 + 1} - Da responsabilidade"
            page.insert_text((60, 90), titulo, fontsize=14)
            sumario.append([1, titulo, i])
        if i == imagem:
            pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 400, 500), 0)
            pix.clear_with(200)
            page.insert_image(pymupdf.Rect(60, 120, 540, 700), pixmap=pix)
        page.insert_textbox(
            pymupdf.Rect(60, 110, 540, 760),
            f"Página {i}. O fornecedor responde pela reparação dos danos. " * 5,
            fontsize=10,
        )
    doc.set_toc(sumario)
    return doc.tobytes()


@pytest.fixture
def docling_falso(monkeypatch):
    from kb_api import hibrido

    pedidas: list[tuple[int, int]] = []

    def falso(data, filename, faixas, ao_iniciar=None):
        pedidas.extend(faixas)
        return {p: f"[DOCLING {p}]" for a, b in faixas for p in range(a, b + 1)}, []

    monkeypatch.setattr(hibrido, "docling_paginas", falso)
    return pedidas


# ── fase 1: triagem e extracao hibrida ─────────────────────────────────────


def test_so_as_paginas_que_precisam_vao_ao_docling(docling_falso):
    from kb_api import hibrido

    r = hibrido.extrair(_livro(), "livro.pdf")
    assert r.extractor == "pymupdf+docling"
    assert r.pages == 100
    assert docling_falso == [(50, 50), (70, 70)]
    assert "[DOCLING 50]" in r.markdown and "[DOCLING 70]" in r.markdown


def test_ordem_das_paginas_e_marcas_preservadas(docling_falso):
    from kb_api import extract, hibrido

    r = hibrido.extrair(_livro(), "livro.pdf")
    paginas = [int(m.group(1)) for m in extract.PAGE_MARK_RE.finditer(r.markdown)]
    assert paginas == sorted(paginas) and paginas[0] == 1 and paginas[-1] == 100
    # O texto da pagina 37 esta depois da marca 37 e antes da 38.
    i37 = r.markdown.index("<!-- pagina 37 -->")
    assert r.markdown.index("Página 37.") > i37
    assert r.markdown.index("Página 37.") < r.markdown.index("<!-- pagina 38 -->")


def test_sumario_vira_titulo_e_o_paragrafo_fica(docling_falso):
    from kb_api import hibrido

    r = hibrido.extrair(_livro(), "livro.pdf")
    titulos = [linha for linha in r.markdown.splitlines() if linha.startswith("# ")]
    assert len(titulos) == 10
    trecho = r.markdown[r.markdown.index("<!-- pagina 11 -->"):r.markdown.index("<!-- pagina 12 -->")]
    assert "# Capítulo 2 - Da responsabilidade" in trecho
    assert "Página 11." in trecho


def test_cabecalho_e_numero_de_pagina_correntes_somem(docling_falso):
    from kb_api import hibrido

    r = hibrido.extrair(_livro(), "livro.pdf")
    assert "COMENTÁRIOS AO CÓDIGO" not in r.markdown
    assert not [linha for linha in r.markdown.splitlines() if linha.strip().isdigit()]


def test_pdf_curto_vai_inteiro_para_o_docling(docling_falso):
    """Abaixo do minimo o docling inteiro leva minutos, e o layout dele vale."""
    from kb_api import hibrido

    assert hibrido.extrair(_livro(paginas=30, branca=None, imagem=None), "curto.pdf") is None


def test_pdf_quase_todo_sem_texto_vai_inteiro_para_o_docling(docling_falso):
    from kb_api import hibrido

    doc = pymupdf.open()
    for _ in range(100):
        doc.new_page()
    assert hibrido.extrair(doc.tobytes(), "escaneado.pdf") is None
    assert docling_falso == []


def test_desligado_por_configuracao(monkeypatch, docling_falso):
    from kb_api import hibrido

    monkeypatch.setattr(hibrido, "settings", replace(hibrido.settings, pdf_hibrido=False))
    assert hibrido.extrair(_livro(), "livro.pdf") is None


def test_faixas_contiguas_respeitam_o_lote():
    from kb_api import hibrido

    assert hibrido._faixas([5, 1, 2, 3, 9], 40) == [(1, 3), (5, 5), (9, 9)]
    assert hibrido._faixas(list(range(1, 91)), 40) == [(1, 40), (41, 80), (81, 90)]


def test_docling_falhando_nao_perde_o_livro(monkeypatch):
    from kb_api import hibrido

    monkeypatch.setattr(hibrido, "docling_paginas", lambda *a, **k: None)
    r = hibrido.extrair(_livro(), "livro.pdf")
    assert r is not None and "Página 37." in r.markdown


# ── fase 2: secao do trecho ────────────────────────────────────────────────


def test_mapa_de_secoes_da_o_caminho_do_trecho():
    from kb_api.chunking import MapaDeSecoes

    md = "# Título I\n\ntexto\n\n## Capítulo IV\n\nmais\n\n### 1. Controle\n\nfim\n\n## Capítulo V\n\nx"
    mapa = MapaDeSecoes(md)
    assert mapa.em(md.index("fim")) == "Título I › Capítulo IV › 1. Controle"
    assert mapa.em(md.index("x", md.index("Capítulo V"))) == "Título I › Capítulo V"
    assert MapaDeSecoes("sem titulo nenhum").em(3) == ""


def test_trecho_leva_a_secao_na_coluna_e_no_cabecalho_do_conceito():
    from kb_api import okf
    from kb_api.chunking import ChunkConfig, plan

    md = "# Livro\n\n## Capítulo 1\n\n" + ("Texto do capítulo um. " * 300) + \
         "\n\n## Capítulo 2\n\n" + ("Texto do capítulo dois. " * 300)
    cfg = ChunkConfig.from_space({"engine": "markdown", "enrichment": "conceito"})
    conceito = okf.Concept(type="Doutrina", title="Livro", description="d", body=md, body_start=0)
    com = plan(md, cfg, concept=conceito)
    secoes = [p.section for p in com.parents]
    assert "Livro › Capítulo 2" in secoes
    pai = next(p for p in com.parents if p.section == "Livro › Capítulo 2")
    assert "Seção: Livro › Capítulo 2" in pai.content

    sem = plan(md, ChunkConfig.from_space({"engine": "markdown"}))
    assert [p.section for p in sem.parents] == secoes
    assert all("Seção:" not in p.content for p in sem.parents)


# ── fase 3: grafo e wiki alem do comeco ────────────────────────────────────


def test_grafo_documento_curto_usa_todos_os_pais():
    from kb_api import graph

    assert graph.pais_amostrados(4) == [0, 1, 2, 3]


def test_grafo_livro_espalha_ate_o_teto():
    from kb_api import graph

    escolhidos = graph.pais_amostrados(450, teto=40)
    assert len(escolhidos) == 40
    assert escolhidos[0] == 0 and escolhidos[-1] == 449
    assert escolhidos == sorted(set(escolhidos))
    # Espalhados: nenhum buraco maior que o dobro do passo medio.
    assert max(b - a for a, b in zip(escolhidos, escolhidos[1:], strict=False)) <= 2 * 450 / 40


def test_grafo_manual_medio_cresce_pouco():
    from kb_api import graph

    assert len(graph.pais_amostrados(30, teto=40)) == 9


def test_wiki_documento_longo_vira_secoes_espalhadas():
    from kb_api import wiki

    md = "".join(f"# Capítulo {i}\n\n" + ("conteúdo " * 300) + "\n\n" for i in range(1, 31))
    secoes = wiki.secoes_do_documento(md, 8)
    assert len(secoes) == 8
    assert secoes[0][0] == "Capítulo 1" and secoes[-1][0] == "Capítulo 30"


def test_wiki_sem_titulo_usa_janelas():
    from kb_api import wiki

    secoes = wiki.secoes_do_documento("palavra " * 20000, 4)
    assert len(secoes) == 4 and all(len(t) <= wiki.LIMITE_DOCUMENTO for _, t in secoes)


def test_titulo_do_livro_vem_do_nome_do_arquivo(docling_falso):
    """A primeira entrada do sumario real era "dLivros" (marca d'agua)."""
    from kb_api import extract

    r = extract.extract(_livro(), "Comentários ao CDC - Rizzatto Nunes.pdf")
    assert r.title == "Comentários ao CDC - Rizzatto Nunes"


def test_sumario_com_paginas_erradas_e_ancorado_no_texto(docling_falso):
    """O caso real: o sumario do "Comentarios ao CDC" apontava 1.222 entradas
    para as paginas 100-199. Aqui todas apontam para a pagina 5."""
    from kb_api import hibrido

    doc = pymupdf.open(stream=_livro(branca=None, imagem=None), filetype="pdf")
    doc.set_toc([[1, f"Capítulo {i // 10 + 1} - Da responsabilidade", 5] for i in range(1, 101, 10)])
    r = hibrido.extrair(doc.tobytes(), "livro.pdf")
    trecho = r.markdown[r.markdown.index("<!-- pagina 41 -->"):r.markdown.index("<!-- pagina 42 -->")]
    assert "# Capítulo 5 - Da responsabilidade" in trecho
    pagina5 = r.markdown[r.markdown.index("<!-- pagina 5 -->"):r.markdown.index("<!-- pagina 6 -->")]
    assert "#" not in pagina5


def test_sumario_que_nao_casa_com_o_texto_e_descartado(docling_falso):
    from kb_api import hibrido

    doc = pymupdf.open(stream=_livro(branca=None, imagem=None), filetype="pdf")
    doc.set_toc([[1, f"Título inexistente {i}", i] for i in range(1, 50)])
    r = hibrido.extrair(doc.tobytes(), "livro.pdf")
    assert not [linha for linha in r.markdown.splitlines() if linha.startswith("#")]


def test_sumario_impresso_nao_engole_as_ancoras():
    """Filomeno: 121 de 123 entradas "achadas" nas paginas do sumario impresso."""
    from kb_api import hibrido

    titulos = [f"{i}.1 Seção número {i}" for i in range(1, 21)]
    blocos = {3: list(titulos)}  # a pagina do sumario impresso: todos os titulos
    for i, t in enumerate(titulos):
        blocos[10 + i * 5] = [t, "texto da seção " * 20]
    ancorado, achados = hibrido.ancorar_sumario([(2, t, 3) for t in titulos], blocos, 120)
    assert achados == 20
    assert 3 not in ancorado
    assert ancorado[10 + 7 * 5] == [(2, titulos[7])]


def test_titulo_sem_espaco_depois_do_numero_casa():
    """Filomeno: o corpo traz "1.1Introdução", o sumario "1.1 Introdução"."""
    from kb_api import hibrido

    blocos = {60: ["1.1Introdução à matéria: defesa do consumidor", "texto " * 30]}
    ancorado, achados = hibrido.ancorar_sumario(
        [(2, "1.1 Introdução à matéria: defesa do consumidor", 51)], blocos, 100
    )
    assert achados == 1 and 60 in ancorado
    saida = hibrido._com_titulos(blocos[60], ancorado[60])
    assert saida[0] == "## 1.1 Introdução à matéria: defesa do consumidor"


@pytest.mark.parametrize(
    ("bloco", "titulo", "casa"),
    [
        # numero impresso separado do titulo (Theodoro vol. 2)
        ("Procedimento: as ações de força nova e força velha",
         "78. Procedimento: as ações de força nova e força velha", True),
        # titulo quebrado em duas linhas, em caixa alta
        ("§ 35. PROCEDIMENTO DA ARRECADAÇÃO DE HERANÇA",
         "§ 35. Procedimento da arrecadação de herança jacente", True),
        # paragrafo que CITA o titulo nao e o titulo
        ("Procedimento: as ações de força nova e força velha exigem prova da posse e do esbulho",
         "78. Procedimento: as ações de força nova e força velha", False),
        # sem numero, titulo curto demais para casar sozinho
        ("Conceito", "12. Conceito", False),
    ],
)
def test_formas_de_titulo_no_corpo(bloco, titulo, casa):
    from kb_api import hibrido

    alvo, sem_numero = hibrido._formas(titulo)
    assert hibrido._casa(hibrido._normal(bloco), alvo, sem_numero) is casa

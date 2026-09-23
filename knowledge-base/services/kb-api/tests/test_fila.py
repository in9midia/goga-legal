"""A fila de ingestao, o docling em lotes e a espera do 429, sem a stack de pe.

O que fica de fora e e verificado a mao contra o cluster: o `FOR UPDATE SKIP
LOCKED` de verdade, a retomada depois de um OOMKilled real e o docling com um
livro inteiro dentro do limite de memoria do pod.
"""
from __future__ import annotations

from dataclasses import replace


class _Cur:
    def __init__(self, capturado, linha=None):
        self.capturado = capturado
        self.linha = linha
        self.rowcount = 0

    def execute(self, sql, params=None):
        self.capturado.append((sql, params))

    def fetchone(self):
        return self.linha

    def fetchall(self):
        return []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _Conn:
    def __init__(self, capturado, linha=None):
        self.capturado = capturado
        self.linha = linha

    def cursor(self):
        return _Cur(self.capturado, self.linha)

    def commit(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


# ── worker ─────────────────────────────────────────────────────────────────


def test_worker_processa_na_linha_que_o_upload_abriu(monkeypatch):
    """Sem `run_id`, `ingest_document` abriria uma SEGUNDA linha no log: o
    arquivo apareceria `queued` para sempre e `indexed` numa linha nova."""
    from kb_api import fila

    monkeypatch.setattr(fila, "_pegar", lambda: (42, "cdc", "livro.pdf", "cdc/ab/x/livro.pdf", "ana"))
    monkeypatch.setattr(fila.storage, "get", lambda k: b"pdf")
    chamadas = []

    class _Res:
        def to_dict(self):
            return {"status": "indexed", "representations": {"grafo": {}}}

    def ingerir(space, nome, dados, principal, run_id=None):
        chamadas.append((space, nome, dados, principal, run_id))
        return _Res()

    monkeypatch.setattr(fila.ingest, "ingest_document", ingerir)
    assert fila.processar_um() is True
    assert chamadas == [("cdc", "livro.pdf", b"pdf", "ana", 42)]
    # O resultado completo fica para o upload com `wait=true`.
    assert fila.resultado(42)["representations"] == {"grafo": {}}


def test_falha_da_ingestao_nao_mata_a_thread(monkeypatch):
    from kb_api import fila

    monkeypatch.setattr(fila, "_pegar", lambda: (1, "cdc", "a.pdf", "k", "p"))
    monkeypatch.setattr(fila.storage, "get", lambda k: b"x")

    def explode(*a, **k):
        raise RuntimeError("Gemini embedding recusou o embedding: HTTP 429")

    monkeypatch.setattr(fila.ingest, "ingest_document", explode)
    assert fila.processar_um() is True


def test_fila_vazia_devolve_false(monkeypatch):
    from kb_api import fila

    monkeypatch.setattr(fila, "_pegar", lambda: None)
    assert fila.processar_um() is False


def test_bruto_sumido_fecha_a_linha_em_vez_de_girar(monkeypatch):
    from kb_api import fila

    monkeypatch.setattr(fila, "_pegar", lambda: (9, "cdc", "a.pdf", "k", "p"))

    def sumiu(_k):
        raise FileNotFoundError("k")

    monkeypatch.setattr(fila.storage, "get", sumiu)
    falhas = []
    monkeypatch.setattr(fila, "_falhar", lambda i, e: falhas.append((i, e)))
    assert fila.processar_um() is True
    assert falhas and falhas[0][0] == 9


def test_retomada_so_devolve_a_fila_o_que_tem_bruto_e_tentativa(monkeypatch):
    """Um arquivo que derruba o pod toda vez nao pode voltar para a fila para
    sempre: seria um laco de OOMKilled."""
    from kb_api import fila

    capturado = []
    monkeypatch.setattr(fila, "conn", lambda: _Conn(capturado))
    fila.retomar_orfaos()
    volta, desiste = capturado[0], capturado[-1]
    assert "status = 'queued'" in volta[0]
    assert "raw_key <> ''" in volta[0] and "attempts < %s" in volta[0]
    assert volta[1] == (fila.MAX_TENTATIVAS,)
    assert "status = 'failed'" in desiste[0] and "attempts >= %s" in desiste[0]


def test_retentativa_cede_a_vez_para_a_fila(monkeypatch):
    """Com o upload enfileirado, a carga de usuario e o que esta `queued` tambem.
    Sem isso a retentativa rodaria no meio de uma carga de dez livros."""
    from kb_api import retry

    capturado = []
    monkeypatch.setattr(retry, "conn", lambda: _Conn(capturado, (0,)))
    retry._carga_de_gente()
    assert "status = 'queued'" in capturado[0][0]


# ── docling em lotes ───────────────────────────────────────────────────────


def _pdf(paginas: int) -> bytes:
    import fitz

    doc = fitz.open()
    for _ in range(paginas):
        doc.new_page()
    return doc.tobytes()


def test_pdf_grande_vira_faixas_cobrindo_todas_as_paginas(monkeypatch):
    from kb_api import extract

    monkeypatch.setattr(extract, "settings", replace(extract.settings, docling_page_batch=40))
    assert extract._faixas_de_pagina(_pdf(90), "livro.pdf") == [(1, 40), (41, 80), (81, 90)]


def test_pdf_curto_e_outros_formatos_vao_inteiros(monkeypatch):
    from kb_api import extract

    monkeypatch.setattr(extract, "settings", replace(extract.settings, docling_page_batch=40))
    assert extract._faixas_de_pagina(_pdf(40), "curto.pdf") == [None]
    assert extract._faixas_de_pagina(b"qualquer", "a.docx") == [None]
    # PDF ilegivel para o PyMuPDF: o docling decide sozinho, como antes.
    assert extract._faixas_de_pagina(b"nao e pdf", "quebrado.pdf") == [None]


# ── 429 do embedding ───────────────────────────────────────────────────────


class _Resposta:
    def __init__(self, retry_after=""):
        self.headers = {"Retry-After": retry_after} if retry_after else {}


def test_429_respeita_retry_after_e_tem_teto():
    from kb_api import embedding

    assert embedding._espera_429(_Resposta("30"), 1) == 30
    assert embedding._espera_429(_Resposta("600"), 1) == embedding.ESPERA_429_MAX_SECONDS


def test_429_sem_retry_after_cresce_ate_o_teto():
    from kb_api import embedding

    esperas = [embedding._espera_429(_Resposta(), n) for n in range(1, 8)]
    assert esperas[:4] == [5, 10, 20, 40]
    assert max(esperas) == embedding.ESPERA_429_MAX_SECONDS


# ── progresso ──────────────────────────────────────────────────────────────


def _relator_capturando(monkeypatch):
    from kb_api import progresso

    gravados = []
    monkeypatch.setattr(
        progresso, "_gravar",
        lambda r, detalhe, com_evento: gravados.append((r.etapa, r.percentual, detalhe, com_evento)),
    )
    return progresso, gravados


def test_sem_ingestao_em_curso_progresso_nao_faz_nada(monkeypatch):
    """O embedding da BUSCA passa pelo mesmo `embed`: nao pode escrever no log."""
    progresso, gravados = _relator_capturando(monkeypatch)
    progresso.avancar("embedding", 5, 10)
    progresso.etapa("grafo")
    assert gravados == []


def test_percentual_anda_dentro_da_faixa_da_etapa_e_nunca_volta(monkeypatch):
    progresso, gravados = _relator_capturando(monkeypatch)
    token = progresso.iniciar(7)
    try:
        progresso.etapa("extracao")
        inicio, fim, _ = progresso.ETAPAS["embedding"]
        progresso.avancar("embedding", 5, 10)
        meio = gravados[-1][1]
        assert inicio < meio < fim
        # Uma etapa anterior chegando atrasada nao faz a barra andar para tras.
        progresso.avancar("extracao", 1, 10)
        assert gravados[-1][1] >= meio
        progresso.etapa("falhou", "HTTP 429")
        assert gravados[-1][0] == "falhou" and gravados[-1][1] >= meio
    finally:
        progresso.encerrar(token)


def test_log_registra_marcos_e_nao_cada_lote(monkeypatch):
    """Um livro faz centenas de lotes de embedding; o log fica com ~10 linhas."""
    progresso, gravados = _relator_capturando(monkeypatch)
    monkeypatch.setattr(progresso, "INTERVALO_SEGUNDOS", 3600)
    token = progresso.iniciar(8)
    try:
        progresso.etapa("embedding")
        for feito in range(0, 500):
            progresso.avancar("embedding", feito, 500)
        eventos = [g for g in gravados if g[3]]
        assert 9 <= len(eventos) <= 12
    finally:
        progresso.encerrar(token)

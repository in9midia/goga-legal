"""`fetch_document` nao pode pedir a segunda conexao segurando a primeira.

Abrir um documento com figuras dispara um fetch por imagem, todos ao mesmo
tempo. Quando o fetch pedia as paginas da wiki (outra conexao) de dentro do
`with conn()`, 8 pedidos simultaneos prendiam as 8 conexoes do pool esperando a
nona, e todos morriam em PoolTimeout de 30 s. Este teste falha se o aninhamento
voltar.
"""

from __future__ import annotations

import contextlib

from kb_api import search


def test_paginas_da_wiki_sao_pedidas_depois_de_devolver_a_conexao(monkeypatch):
    abertas = {"n": 0}

    class Cursor:
        def __init__(self):
            self.resultados = [
                [(7, "rh", "T", "a.pdf", "texto", "docling", "application/pdf", 1, 1,
                  "sha", None, None, [], 3, {}, None)],
                [],
                [],
            ]

        def execute(self, *_):
            self.atual = self.resultados.pop(0)

        def fetchone(self):
            return self.atual[0] if self.atual else None

        def fetchall(self):
            return self.atual

    @contextlib.contextmanager
    def conn():
        abertas["n"] += 1
        try:
            yield Conexao()
        finally:
            abertas["n"] -= 1

    class Conexao:
        def cursor(self):
            return contextlib.nullcontext(cursor)

    cursor = Cursor()

    def paginas(_document_id):
        assert abertas["n"] == 0, "fetch_document ainda segura a conexao ao pedir a wiki"
        return []

    monkeypatch.setattr(search, "conn", conn)
    monkeypatch.setattr(search.wiki, "paginas_do_documento", paginas)
    documento = search.fetch_document(7, None)
    assert documento["id"] == 7
    assert documento["wiki_pages"] == []

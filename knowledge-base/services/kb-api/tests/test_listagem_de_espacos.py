"""A listagem de Espacos nao pode tomar o pool da busca.

Em 2026-10-19, trinta GET /v1/spaces simultaneos prenderam as 8 conexoes do
pool por mais de 30 s e as buscas morreram em PoolTimeout. Estes testes falham
se a rajada voltar a virar uma contagem por pedido, se o teto de contagens
simultaneas sumir, ou se a listagem voltar a reler a escolha de provedor de
cada base numa conexao propria.
"""

from __future__ import annotations

import threading
import time

from kb_api import ingest, providers


def _linha(slug: str) -> dict:
    return {"slug": slug}


def test_rajada_igual_faz_uma_contagem_so(monkeypatch):
    chamadas = {"n": 0}
    liberar = threading.Event()

    def contar(spaces):
        chamadas["n"] += 1
        liberar.wait(5)
        return [_linha("rh")]

    monkeypatch.setattr(ingest, "_space_stats", contar)
    resultados: list = []
    threads = [
        threading.Thread(target=lambda: resultados.append(ingest.space_stats(["rh"])))
        for _ in range(20)
    ]
    for t in threads:
        t.start()
    time.sleep(0.1)
    liberar.set()
    for t in threads:
        t.join(5)

    assert chamadas["n"] == 1
    assert len(resultados) == 20
    assert all(r == [_linha("rh")] for r in resultados)

    # Resolvida, a proxima leitura conta de novo: nada de cache velho na tela.
    ingest.space_stats(["rh"])
    assert chamadas["n"] == 2


def test_erro_chega_a_todos_que_esperavam(monkeypatch):
    liberar = threading.Event()

    def contar(spaces):
        liberar.wait(5)
        raise RuntimeError("pool esgotado")

    monkeypatch.setattr(ingest, "_space_stats", contar)
    erros: list = []

    def pedir():
        try:
            ingest.space_stats(None)
        except RuntimeError as exc:
            erros.append(str(exc))

    threads = [threading.Thread(target=pedir) for _ in range(5)]
    for t in threads:
        t.start()
    time.sleep(0.1)
    liberar.set()
    for t in threads:
        t.join(5)
    assert erros == ["pool esgotado"] * 5


def test_escopos_diferentes_contam_no_maximo_dois_por_vez(monkeypatch):
    agora = {"n": 0, "pico": 0}
    trava = threading.Lock()

    def contar(spaces):
        with trava:
            agora["n"] += 1
            agora["pico"] = max(agora["pico"], agora["n"])
        time.sleep(0.05)
        with trava:
            agora["n"] -= 1
        return []

    monkeypatch.setattr(ingest, "_space_stats", contar)
    threads = [
        threading.Thread(target=ingest.space_stats, args=([f"base-{i}"],)) for i in range(8)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(5)
    assert agora["pico"] == 2


def test_escolha_ja_lida_nao_abre_conexao(monkeypatch):
    def sem_conexao():
        raise AssertionError("resolvido releu a escolha do Espaco no banco")

    provedor = providers.Provedor.__new__(providers.Provedor)
    for campo, valor in {"id": 3, "name": "p", "model": "m", "kind": "openai"}.items():
        object.__setattr__(provedor, campo, valor)
    monkeypatch.setattr(providers, "conn", sem_conexao)
    monkeypatch.setattr(providers, "padrao", lambda purpose, space="": provedor)

    assert providers.resolvido("embedding", "rh", 3)["from_space"] is True
    assert providers.resolvido("chat", "rh", None)["from_space"] is False

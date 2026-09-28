"""Retomada da ingestao que falhou no embedding.

O caso que motivou: a licenca do provedor de embedding expira no meio de um
livro. A retentativa rodava tudo de novo -- docling, conceito OKF e os lotes
que ja tinham voltado. O que os testes travam:

1. o preparo (extracao, conceito, corte) volta so com a MESMA configuracao;
2. os lotes voltam em ordem, e param no primeiro que nao e continuacao
   confiavel (outro preparo, outro modelo, buraco);
3. `embed` so chama o provedor para o que falta, e descarta o que veio de
   outro modelo;
4. o ponto de retomada sai depois do sucesso, e so depois do commit.
"""

from __future__ import annotations

import importlib
import inspect
from types import SimpleNamespace

import pytest


@pytest.fixture
def retomada(tmp_path, monkeypatch):
    monkeypatch.setenv("KB_STORAGE_BACKEND", "filesystem")
    monkeypatch.setenv("KB_STORAGE_DIR", str(tmp_path / "objetos"))
    from kb_api import config as modulo_config

    importlib.reload(modulo_config)
    from kb_api import storage as modulo_storage

    importlib.reload(modulo_storage)
    modulo_storage.ensure_bucket()
    from kb_api import retomada as modulo

    importlib.reload(modulo)
    return modulo


SHA = "ab" + "0" * 62


def _vetor(valor: float, dim: int = 4) -> list[float]:
    return [valor] * dim


def test_preparo_ida_e_volta(retomada):
    assinatura = retomada.assinatura({"engine": "markdown"})
    token = retomada.guardar("rh", SHA, assinatura, {"md": "texto"}, None, ["plano"])
    preparo = retomada.carregar("rh", SHA, assinatura)
    assert preparo is not None
    assert preparo.token == token
    assert preparo.extracted == {"md": "texto"}
    assert preparo.chunk_plan == ["plano"]


def test_preparo_de_outro_corte_nao_serve(retomada):
    retomada.guardar("rh", SHA, retomada.assinatura({"engine": "markdown"}), {}, None, [])
    assert retomada.carregar("rh", SHA, retomada.assinatura({"engine": "sentence"})) is None


def test_sem_preparo_devolve_none(retomada):
    assert retomada.carregar("rh", SHA, "qualquer") is None


def test_lotes_voltam_em_ordem(retomada):
    retomada.gravar_lote("rh", SHA, "t1", "m", 0, [_vetor(1.0), _vetor(2.0)])
    retomada.gravar_lote("rh", SHA, "t1", "m", 2, [_vetor(3.0)])
    prontos, modelo = retomada.vetores("rh", SHA, "t1", 10)
    assert prontos == [_vetor(1.0), _vetor(2.0), _vetor(3.0)]
    assert modelo == "m"


def test_lote_de_outro_preparo_nao_e_continuacao(retomada):
    retomada.gravar_lote("rh", SHA, "t1", "m", 0, [_vetor(1.0)])
    retomada.gravar_lote("rh", SHA, "velho", "m", 1, [_vetor(9.0)])
    prontos, _ = retomada.vetores("rh", SHA, "t1", 10)
    assert prontos == [_vetor(1.0)]


def test_troca_de_modelo_no_meio_para(retomada):
    retomada.gravar_lote("rh", SHA, "t1", "m1", 0, [_vetor(1.0)])
    retomada.gravar_lote("rh", SHA, "t1", "m2", 1, [_vetor(2.0)])
    prontos, modelo = retomada.vetores("rh", SHA, "t1", 10)
    assert prontos == [_vetor(1.0)]
    assert modelo == "m1"


def test_limpar_remove_tudo(retomada):
    assinatura = retomada.assinatura({})
    token = retomada.guardar("rh", SHA, assinatura, {}, None, [])
    retomada.gravar_lote("rh", SHA, token, "m", 0, [_vetor(1.0)])
    retomada.gravar_lote("rh", SHA, token, "m", 1, [_vetor(2.0)])
    retomada.limpar("rh", SHA)
    assert retomada.carregar("rh", SHA, assinatura) is None
    assert retomada.vetores("rh", SHA, token, 10) == ([], "")


@pytest.fixture
def embedding(monkeypatch):
    from kb_api import embedding as modulo
    from kb_api.config import settings

    dim = settings.embedding_dim
    chamados: list[list[str]] = []

    def _post(textos, provedor, operation="index"):
        chamados.append(list(textos))
        return [[0.5] * dim for _ in textos], len(textos), 0

    monkeypatch.setattr(modulo, "_post", _post)
    monkeypatch.setattr(modulo.providers, "registrar_uso", lambda *a, **k: None)
    monkeypatch.setattr(
        modulo.providers, "padrao", lambda *a, **k: SimpleNamespace(model="atual", name="p")
    )
    monkeypatch.setattr(modulo, "BATCH_SIZE", 2)
    return modulo, chamados, dim


def test_embed_so_vetoriza_o_que_falta(embedding):
    modulo, chamados, dim = embedding
    textos = ["a", "b", "c", "d", "e"]
    prontos = [[0.1] * dim, [0.2] * dim]
    lotes: list[int] = []
    resultado = modulo.embed(
        textos, "index", "rh", prontos=prontos, modelo_prontos="atual",
        ao_lote=lambda inicio, lote, modelo: lotes.append(inicio),
    )
    assert chamados == [["c", "d"], ["e"]]
    assert lotes == [2, 4]
    assert resultado.vectors[:2] == prontos
    assert len(resultado.vectors) == 5


def test_embed_descarta_vetores_de_outro_modelo(embedding):
    modulo, chamados, dim = embedding
    resultado = modulo.embed(
        ["a", "b", "c"], "index", "rh", prontos=[[0.1] * dim], modelo_prontos="antigo",
    )
    assert chamados == [["a", "b"], ["c"]]
    assert resultado.vectors[0] == [0.5] * dim


def test_limpeza_vem_depois_do_commit():
    """Antes do commit, uma falha na gravacao ainda precisa do ponto de retomada."""
    from kb_api import ingest

    fonte = inspect.getsource(ingest._ingest_document)
    assert fonte.index("connection.commit()") < fonte.index("retomada.limpar(")


def test_reprocessar_indexado_nao_usa_retomada():
    """Quem reprocessa um documento indexado quer refazer, nao reaproveitar."""
    from kb_api import ingest

    fonte = inspect.getsource(ingest._ingest_document)
    assert "if not ja_indexado:" in fonte
    assert fonte.index("ja_indexado = cur.fetchone() is not None") < fonte.index(
        "retomada.carregar("
    )

"""Backend `filesystem` do object storage.

O que estes testes protegem, em ordem de importancia:

1. que uma chave nao consiga escapar da raiz -- a ultima parte da chave e o
   NOME DO ARQUIVO enviado por quem faz upload;
2. que o contrato seja o MESMO do backend s3 (put devolve a chave, delete de
   chave ausente nao levanta, get de ausente levanta StorageError);
3. que a escrita seja atomica -- nunca um arquivo pela metade.
"""

from __future__ import annotations

import importlib

import pytest


@pytest.fixture
def storage(tmp_path, monkeypatch):
    """Modulo de storage apontado para um diretorio descartavel, backend disco."""
    monkeypatch.setenv("KB_STORAGE_BACKEND", "filesystem")
    monkeypatch.setenv("KB_STORAGE_DIR", str(tmp_path / "objetos"))
    from kb_api import config as modulo_config

    importlib.reload(modulo_config)
    from kb_api import storage as modulo_storage

    importlib.reload(modulo_storage)
    modulo_storage.ensure_bucket()
    return modulo_storage


def test_ida_e_volta(storage):
    chave = "rh/ab/abcdef/Politica de Ferias.pdf"
    assert storage.put(chave, b"conteudo") == chave
    assert storage.get(chave) == b"conteudo"


def test_acento_e_espaco_no_nome(storage):
    # Nome real desta base: acento, espaco e parenteses.
    chave = "rh/cd/cdef01/Política_de_Acesso (1) 1.docx"
    storage.put(chave, b"x")
    assert storage.get(chave) == b"x"


def test_sobrescrita_mantem_o_ultimo(storage):
    storage.put("a/b/c", b"velho")
    storage.put("a/b/c", b"novo")
    assert storage.get("a/b/c") == b"novo"


def test_nao_deixa_temporario_para_tras(storage):
    storage.put("a/b/c", b"x")
    raiz = storage._raiz()
    assert [p.name for p in raiz.rglob(".*.parcial")] == []


def test_get_de_ausente_levanta(storage):
    with pytest.raises(storage.StorageError):
        storage.get("nao/existe/nada")


def test_delete_de_ausente_nao_levanta(storage):
    # Mesmo contrato do s3: a remocao de um documento percorre varias chaves e
    # abortar na primeira ausente deixaria o resto para tras.
    storage.delete("nao/existe/nada")


def test_delete_remove(storage):
    storage.put("a/b/c", b"x")
    storage.delete("a/b/c")
    with pytest.raises(storage.StorageError):
        storage.get("a/b/c")


@pytest.mark.parametrize(
    "chave",
    [
        "../fora.txt",
        "rh/../../fora.txt",
        "/etc/passwd",
        "rh/ab/../../../../tmp/fora.txt",
    ],
)
def test_chave_nao_escapa_da_raiz(storage, chave):
    with pytest.raises(storage.StorageError):
        storage.put(chave, b"invasao")
    with pytest.raises(storage.StorageError):
        storage.get(chave)


def test_chave_vazia_e_recusada(storage):
    with pytest.raises(storage.StorageError):
        storage.put("", b"x")


def test_stats_conta_objetos_e_bytes(storage):
    storage.put("a/1", b"12345")
    storage.put("a/b/2", b"123")
    resultado = storage.stats()
    assert resultado["objects"] == 2
    assert resultado["bytes"] == 8
    assert resultado["bucket"].endswith("objetos")


def test_stats_em_raiz_vazia(storage):
    assert storage.stats()["objects"] == 0


def test_backend_desconhecido_falha_claro(tmp_path, monkeypatch):
    monkeypatch.setenv("KB_STORAGE_BACKEND", "sei-la")
    monkeypatch.setenv("KB_STORAGE_DIR", str(tmp_path))
    from kb_api import config as modulo_config

    importlib.reload(modulo_config)
    from kb_api import storage as modulo_storage

    importlib.reload(modulo_storage)
    with pytest.raises(modulo_storage.StorageError, match="KB_STORAGE_BACKEND"):
        modulo_storage.stats()


def test_s3_continua_sendo_o_padrao(tmp_path, monkeypatch):
    # Se o default virar `filesystem` por acidente, producao passa a gravar no
    # disco efemero do pod e o bruto some no primeiro restart.
    monkeypatch.delenv("KB_STORAGE_BACKEND", raising=False)
    from kb_api import config as modulo_config

    importlib.reload(modulo_config)
    assert modulo_config.settings.storage_backend == "s3"

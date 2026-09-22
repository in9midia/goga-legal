"""Identidade visual do servidor MCP: `icons` no `initialize` e a rota que serve.

Estes testes NAO tocam banco nem rede. O que eles protegem:

1. que o `icons` saia com URL ABSOLUTA e da mesma origem do `/mcp` -- a spec
   manda o cliente recusar icone de outra origem, entao um caminho relativo ou
   um dominio fixo em codigo viram "icone nao aparece" sem erro nenhum;
2. que o PNG esteja DENTRO do pacote -- ele so chega na imagem porque
   `pyproject.toml` declara `assets/*.png`, e esquecer isso da 404 em producao
   sem quebrar o boot;
3. que a negociacao de versao devolva a que o cliente pediu, quando sabemos
   falar -- o servidor respondia uma constante e ignorava o pedido;
4. que a rota do icone NAO exija credencial: a spec manda o cliente buscar o
   icone sem cookie e sem `Authorization`.
"""

from __future__ import annotations

import pathlib

import pytest
from starlette.testclient import TestClient


@pytest.fixture
def mcp():
    from kb_api import mcp as modulo

    return modulo


@pytest.fixture
def app_kb():
    from kb_api import main

    return TestClient(main.app, base_url="https://hub.exemplo.br")


BASE = "https://hub.exemplo.br/knowledge-base"


def _initialize(mcp, base: str, versao: str = "2025-11-25"):
    return mcp.handle(
        {"jsonrpc": "2.0", "id": 1, "method": "initialize",
         "params": {"protocolVersion": versao}},
        None,
        base,
    )["result"]


def test_icone_sai_absoluto_e_na_mesma_origem(mcp):
    icones = _initialize(mcp, BASE)["serverInfo"]["icons"]
    assert icones[0]["src"] == f"{BASE}/mcp/icon.png"
    assert icones[0]["mimeType"] == "image/png"


def test_tipo_e_tamanho_vem_do_ARQUIVO(mcp):
    """O arquivo e feito para ser trocado, entao nada do que da para ler nele
    pode estar fixo no codigo -- senao a troca passa a mentir no `serverInfo`."""
    from PIL import Image

    with Image.open(mcp.ICONE_ARQUIVO) as imagem:
        esperado = f"{imagem.width}x{imagem.height}"
    icone = _initialize(mcp, BASE)["serverInfo"]["icons"][0]
    assert icone["sizes"] == [esperado]
    assert mcp.ICONE_TIPO == "image/png"


def test_trocar_o_arquivo_troca_o_que_e_anunciado(mcp, tmp_path, monkeypatch):
    """A operacao ESPERADA aqui: alguem larga o PNG da marca certa por cima."""
    from PIL import Image

    outro = tmp_path / "icon.png"
    Image.new("RGBA", (256, 256), (0, 0, 0, 255)).save(outro)
    monkeypatch.setattr(mcp, "ICONE_ARQUIVO", outro)
    monkeypatch.setattr(mcp, "ICONE_BYTES", outro.read_bytes())
    tipo, tamanho = mcp._carregar_icone()[1:]
    monkeypatch.setattr(mcp, "ICONE_TIPO", tipo)
    monkeypatch.setattr(mcp, "ICONE_TAMANHO", tamanho)

    icone = _initialize(mcp, BASE)["serverInfo"]["icons"][0]
    assert icone["sizes"] == ["256x256"]


def test_arquivo_ilegivel_nao_derruba_o_servidor(mcp, tmp_path, monkeypatch):
    """Icone e enfeite. Recusar a subir porque o logotipo sumiu seria trocar um
    conector feio por um conector fora do ar."""
    monkeypatch.setattr(mcp, "ICONE_ARQUIVO", tmp_path / "nao-existe.png")
    assert mcp._carregar_icone() == (b"", "", "")


def test_formato_que_a_spec_nao_garante_e_recusado(mcp, tmp_path, monkeypatch):
    """GIF e WebP renderizam em navegador mas a spec so garante PNG e JPEG em
    todo cliente. Aceitar em silencio daria "icone nao aparece" em alguns."""
    from PIL import Image

    gif = tmp_path / "icon.png"  # extensao mente; o conteudo e que vale
    Image.new("RGB", (64, 64)).save(gif, "GIF")
    monkeypatch.setattr(mcp, "ICONE_ARQUIVO", gif)
    assert mcp._carregar_icone() == (b"", "", "")


def test_sem_icone_legivel_o_serverInfo_nao_anuncia(mcp, monkeypatch):
    """Anunciar `icons` apontando para uma rota que devolve 404 e pior que nao
    anunciar: o cliente busca, falha, e nao ha o que investigar."""
    monkeypatch.setattr(mcp, "ICONE_BYTES", b"")
    assert "icons" not in _initialize(mcp, BASE)["serverInfo"]


def test_icone_acompanha_a_origem_do_ambiente(mcp):
    """DEV, PROD e local tem origens diferentes, e o `src` nao pode ser fixo."""
    for base in ("https://dev.hub.exemplo.br/knowledge-base", "http://localhost:8080"):
        icones = _initialize(mcp, base)["serverInfo"]["icons"]
        assert icones[0]["src"] == f"{base}/mcp/icon.png"


def test_sem_origem_conhecida_o_icone_fica_de_fora(mcp):
    """`src` relativo o cliente resolveria contra a origem DELE. Melhor omitir."""
    assert "icons" not in _initialize(mcp, "")["serverInfo"]


def test_rotulo_e_descricao_acompanham_o_icone(mcp):
    """Sao os tres campos do MESMO cartao na lista de conectores."""
    info = _initialize(mcp, BASE)["serverInfo"]
    assert info["title"] and info["description"]
    assert info["name"] == "knowledge-base"  # identificador, nao rotulo


@pytest.mark.parametrize("pedida", ["2025-11-25", "2025-06-18"])
def test_devolve_a_versao_que_o_cliente_pediu(mcp, pedida):
    assert _initialize(mcp, BASE, pedida)["protocolVersion"] == pedida


def test_versao_desconhecida_cai_na_mais_nova_nossa(mcp):
    resultado = _initialize(mcp, BASE, "1999-01-01")
    assert resultado["protocolVersion"] == mcp.PROTOCOL_VERSIONS[0]


def test_icons_exige_a_revisao_que_criou_o_campo(mcp):
    """`icons` entrou na `2025-11-25` (SEP-973). Anunciar so a revisao anterior
    e oferecer um campo que ela nao tem."""
    assert "2025-11-25" in mcp.PROTOCOL_VERSIONS


def test_o_png_esta_dentro_do_pacote(mcp):
    assert mcp.ICONE_ARQUIVO.exists(), "sem isto a rota do icone da 404 na imagem"
    assert mcp.ICONE_ARQUIVO.name == "icon.png", (
        "o nome do arquivo e o contrato com quem troca o icone"
    )
    assert mcp.ICONE_BYTES[:8] == b"\x89PNG\r\n\x1a\n"


def test_o_pacote_declara_o_asset(mcp):
    """O PNG so entra na imagem se o `pyproject.toml` disser -- e o esquecimento
    nao quebra o boot, so a rota."""
    from kb_api import mcp as _

    raiz = pathlib.Path(_.__file__).resolve().parents[2]
    assert 'assets/*.png' in (raiz / "pyproject.toml").read_text()


def test_a_rota_serve_o_png_sem_credencial(app_kb):
    """A spec manda o cliente buscar o icone SEM cookie e SEM `Authorization`."""
    resposta = app_kb.get("/mcp/icon.png")
    assert resposta.status_code == 200, resposta.text
    assert resposta.headers["content-type"] == "image/png"
    assert resposta.content[:8] == b"\x89PNG\r\n\x1a\n"
    assert "max-age" in resposta.headers.get("cache-control", "")


def test_o_src_anunciado_e_a_rota_que_existe(mcp, app_kb):
    """O elo que quebra calado: mudar o caminho num lugar e nao no outro."""
    src = _initialize(mcp, BASE)["serverInfo"]["icons"][0]["src"]
    assert app_kb.get(src.removeprefix(BASE)).status_code == 200


# --- Favicon -----------------------------------------------------------------
#
# O favicon e um SEGUNDO caminho ate a mesma marca, e existe por uma razao
# diferente do `icons` do protocolo: ele atende o cliente que procura o icone
# pelo endereco convencional em vez de ler o `initialize`.


def test_o_favicon_esta_dentro_do_pacote(mcp):
    assert mcp.FAVICON_ARQUIVO.exists(), "sem isto a rota do favicon da 404 na imagem"
    assert mcp.FAVICON_ARQUIVO.name == "favicon.ico", "o nome E o endereco convencional"
    assert mcp.FAVICON_BYTES[:4] == mcp.ICO_MAGICO


def test_o_pacote_declara_o_ico(mcp):
    """Mesma armadilha do PNG: `assets/*.png` sozinho NAO leva o .ico, e o
    esquecimento so aparece como 404 na imagem publicada."""
    from kb_api import mcp as _

    raiz = pathlib.Path(_.__file__).resolve().parents[2]
    assert 'assets/*.ico' in (raiz / "pyproject.toml").read_text()


def test_a_rota_serve_o_ico_sem_credencial(app_kb):
    resposta = app_kb.get("/mcp/favicon.ico")
    assert resposta.status_code == 200, resposta.text
    assert resposta.headers["content-type"] == "image/x-icon"
    assert resposta.content[:4] == b"\x00\x00\x01\x00"
    assert "max-age" in resposta.headers.get("cache-control", "")


def test_conteudo_que_nao_e_ico_nao_e_servido(mcp, tmp_path, monkeypatch):
    """A extensao mente; o conteudo e que vale. Um PNG renomeado para .ico faz o
    cliente desenhar nada, em silencio -- pior que o 404."""
    falso = tmp_path / "favicon.ico"
    falso.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 32)
    monkeypatch.setattr(mcp, "FAVICON_ARQUIVO", falso)
    assert mcp._carregar_favicon() == b""


def test_sem_favicon_o_servidor_segue_de_pe(mcp, app_kb, monkeypatch):
    """Favicon e enfeite: some a rota, nao o servidor."""
    monkeypatch.setattr(mcp, "FAVICON_BYTES", b"")
    assert app_kb.get("/mcp/favicon.ico").status_code == 404
    assert app_kb.get("/mcp/icon.png").status_code == 200


def test_o_favicon_fica_fora_do_serverInfo(mcp):
    """`image/x-icon` nao esta entre os formatos que a spec garante em todo
    cliente. Anunciar um que o cliente nao desenha e pior que nao anunciar."""
    icones = _initialize(mcp, BASE)["serverInfo"]["icons"]
    assert all(icone["mimeType"] in mcp.FORMATOS.values() for icone in icones)
    assert not any(icone["src"].endswith(".ico") for icone in icones)

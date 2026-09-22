"""O ícone da base: o que o servidor aceita, recusa e reduz.

Interessa aqui porque o valor é devolvido em TODA leitura de `/v1/spaces`, e
porque ele chega de fora — o downscale do navegador é conveniência, não
controle.
"""
from __future__ import annotations

import base64
import io

import pytest
from PIL import Image

from kb_api import icons


def _imagem(largura: int, altura: int, formato: str = "PNG") -> str:
    buf = io.BytesIO()
    # JPEG não guarda canal alfa. O caminho real converte para RGBA na leitura,
    # então isto é só o gerador do fixture sendo honesto com cada formato.
    modo = "RGB" if formato == "JPEG" else "RGBA"
    cor = (10, 120, 200) if modo == "RGB" else (10, 120, 200, 255)
    Image.new(modo, (largura, altura), cor).save(buf, format=formato)
    tipo = {"PNG": "png", "JPEG": "jpeg", "WEBP": "webp", "GIF": "gif"}[formato]
    return f"data:image/{tipo};base64," + base64.b64encode(buf.getvalue()).decode()


def _bytes_do_data_uri(uri: str) -> bytes:
    return base64.b64decode(uri.split(",", 1)[1])


def test_vazio_continua_valendo():
    assert icons.normalizar("") == ""
    assert icons.normalizar("   ") == ""


def test_aceita_nome_de_icone_da_biblioteca():
    assert icons.normalizar("lucide:BookOpen") == "lucide:BookOpen"


def test_recusa_nome_de_icone_fora_do_formato():
    # `lucide:<qualquer coisa>` viraria busca de componente por string na tela.
    for ruim in ("lucide:book-open", "lucide:", "lucide:bookOpen", "lucide:../../x"):
        with pytest.raises(icons.IconeInvalido):
            icons.normalizar(ruim)


def test_emoji_da_versao_anterior_continua_passando():
    """Base que já tem emoji gravado não pode quebrar por causa do formato novo."""
    assert icons.normalizar("📚") == "📚"
    assert icons.normalizar("RH") == "RH"


def test_reduz_imagem_grande_para_96px():
    # O ponto do módulo: 4000px entrando, 96px saindo.
    saida = icons.normalizar(_imagem(4000, 4000))
    assert saida.startswith("data:image/webp;base64,")
    with Image.open(io.BytesIO(_bytes_do_data_uri(saida))) as reduzida:
        assert max(reduzida.size) == icons.LADO


def test_preserva_a_proporcao_em_imagem_retangular():
    """Esticar para 96x96 deformaria logo retangular, que é o caso comum."""
    saida = icons.normalizar(_imagem(400, 100))
    with Image.open(io.BytesIO(_bytes_do_data_uri(saida))) as reduzida:
        assert reduzida.size == (96, 24)


def test_normaliza_o_formato_de_saida():
    """Entra PNG, JPEG ou GIF; sai WebP. A tela não precisa saber o que era."""
    for formato in ("PNG", "JPEG", "GIF"):
        saida = icons.normalizar(_imagem(200, 200, formato))
        assert saida.startswith("data:image/webp;base64,")


def test_imagem_reduzida_cabe_folgado_no_teto():
    saida = icons.normalizar(_imagem(2000, 2000))
    assert len(saida) < icons.MAX_BYTES


def test_recusa_svg():
    """SVG é documento executável (script, foreignObject) e iria intacto para um
    `<img>` na tela de todo mundo. Imagem que vira código não entra por um campo
    de enfeite."""
    svg = base64.b64encode(b'<svg xmlns="http://www.w3.org/2000/svg"></svg>').decode()
    with pytest.raises(icons.IconeInvalido):
        icons.normalizar(f"data:image/svg+xml;base64,{svg}")


def test_recusa_base64_corrompido():
    with pytest.raises(icons.IconeInvalido, match="base64"):
        icons.normalizar("data:image/png;base64,nao#eh#base64")


def test_recusa_o_que_nao_e_imagem_mesmo_com_cabecalho_certo():
    lixo = base64.b64encode(b"isto nao e um png" * 40).decode()
    with pytest.raises(icons.IconeInvalido):
        icons.normalizar(f"data:image/png;base64,{lixo}")


def test_recusa_texto_longo_que_nao_e_data_uri():
    with pytest.raises(icons.IconeInvalido, match="32"):
        icons.normalizar("x" * 40)

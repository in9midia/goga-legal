"""O icone da base: valida, reduz e normaliza o que a tela manda.

TRES FORMAS, e a coluna guarda as tres como texto:

  * ``""``              -- sem icone; a tela cai para a inicial do rotulo;
  * ``lucide:<Nome>``   -- icone da biblioteca da interface;
  * ``data:image/...``  -- imagem enviada, ja reduzida, em base64.

POR QUE O SERVIDOR REDUZ DE NOVO

O navegador tambem reduz, e isso e o que evita subir 4 MB pela rede. Mas
downscale no cliente e CONVENIENCIA: quem chama a API nao e obrigado a ser a
nossa tela. Sem reprocessar aqui, um `curl` com um PNG de 8000x8000 entraria na
coluna e seria devolvido em TODA leitura de `/v1/spaces` -- uma linha da lista
de bases custando megabytes, sem erro nenhum.

Reprocessar tambem normaliza o formato: o que entra como PNG, JPEG, GIF ou WebP
sai como WebP de 96x96, e a tela nao precisa saber com o que esta lidando.
"""
from __future__ import annotations

import base64
import binascii
import io
import re

from PIL import Image, UnidentifiedImageError

# 96px para um icone desenhado em 44px: cobre tela de densidade 2x sem
# guardar o dobro do necessario. Acima disso o ganho e invisivel e o custo
# aparece na listagem inteira.
LADO = 96

# Teto do que fica gravado. 96x96 WebP fica em poucos kB; 64 kB e folga grande
# o bastante para um PNG com transparencia e pequena o bastante para impedir
# que a coluna vire deposito.
MAX_BYTES = 64 * 1024

# Nome de icone da biblioteca da interface. `PascalCase` porque e assim que o
# lucide exporta, e a tela procura por esse nome exato num mapa dela.
LUCIDE = re.compile(r"^lucide:[A-Z][A-Za-z0-9]{0,40}$")

_DATA_URI = re.compile(r"^data:image/(png|jpe?g|gif|webp|bmp);base64,(.+)$", re.S)

# Formatos aceitos na ENTRADA. SVG fica de fora de proposito: ele e um documento
# executavel (script, `foreignObject`, referencia externa), e o Pillow nao o
# abre -- entao ele passaria intacto para dentro de um `<img>` na tela de todo
# mundo. Imagem que vira codigo nao entra por um campo de enfeite.
ENTRADA = ("png", "jpeg", "jpg", "gif", "webp", "bmp")


class IconeInvalido(ValueError):
    """Mensagem pronta para virar `detail` de HTTP 400."""


def normalizar(valor: str) -> str:
    """Devolve o que pode ser gravado, ou levanta `IconeInvalido`."""
    texto = (valor or "").strip()
    if not texto:
        return ""

    if texto.startswith("lucide:"):
        if not LUCIDE.match(texto):
            raise IconeInvalido(
                "nome de ícone inválido. Use `lucide:NomeDoIcone`, como `lucide:BookOpen`"
            )
        return texto

    if texto.startswith("data:"):
        return _reduzir(texto)

    # Texto curto continua valendo: e o que a 0012 gravava, e uma base que ja
    # tem emoji nao pode quebrar por causa de um formato novo.
    if len(texto) > 32:
        raise IconeInvalido(
            f"texto de ícone com {len(texto)} caracteres; o limite é 32. "
            "Para imagem, envie um `data:image/...;base64,`"
        )
    if any(c in texto for c in "\n\r\t"):
        raise IconeInvalido("o ícone não pode ter quebra de linha")
    return texto


def _reduzir(data_uri: str) -> str:
    achado = _DATA_URI.match(data_uri)
    if not achado:
        raise IconeInvalido(
            "imagem em formato não aceito. Envie PNG, JPEG, GIF, WebP ou BMP "
            "como `data:image/<tipo>;base64,`"
        )
    try:
        bruto = base64.b64decode(achado.group(2), validate=True)
    except (binascii.Error, ValueError):
        raise IconeInvalido("o base64 da imagem está corrompido") from None

    # Teto na ENTRADA tambem, e nao so na saida: decodificar 50 MB de base64
    # para descobrir que era grande demais ja custou os 50 MB de memoria.
    if len(bruto) > 8 * 1024 * 1024:
        raise IconeInvalido("imagem acima de 8 MB. Reduza antes de enviar")

    try:
        with Image.open(io.BytesIO(bruto)) as imagem:
            if (imagem.format or "").lower() not in ENTRADA:
                raise IconeInvalido(f"formato {imagem.format} não aceito para ícone")
            # `RGBA` sempre: PNG com transparencia sobre fundo escuro precisa
            # dela, e converter para RGB pintaria o transparente de preto.
            quadro = imagem.convert("RGBA")
            # `thumbnail` preserva a proporcao. Esticar para 96x96 deformaria
            # logo retangular, que e justamente o caso comum aqui.
            quadro.thumbnail((LADO, LADO), Image.LANCZOS)
            saida = io.BytesIO()
            quadro.save(saida, format="WEBP", quality=85, method=6)
    except IconeInvalido:
        raise
    except (UnidentifiedImageError, OSError, ValueError):
        raise IconeInvalido("não consegui ler esta imagem. Ela pode estar corrompida") from None

    pronto = "data:image/webp;base64," + base64.b64encode(saida.getvalue()).decode("ascii")
    if len(pronto) > MAX_BYTES:
        # Improvavel em 96x96, mas o teto e do BANCO: passar daqui viraria erro
        # de constraint com mensagem de Postgres em vez de mensagem util.
        raise IconeInvalido("a imagem ficou grande demais mesmo reduzida. Use uma mais simples")
    return pronto

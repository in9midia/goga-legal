#!/usr/bin/env python
"""Desenha um icone PROVISORIO para o servidor MCP, com a marca que a UI ja usa.

⚠ ESTE SCRIPT E UM ANDAIME, NAO A FONTE DO ICONE

`src/kb_api/assets/icon.png` existe para ser SUBSTITUIDO pelo arquivo de quem
tem a marca certa. O runtime le o arquivo e deriva dele o tipo e a dimensao --
nao ha nada aqui de que o servidor dependa.

Por isso o script se RECUSA a sobrescrever um arquivo existente sem `--force`:
rodar sem querer depois da troca apagaria o icone de verdade em silencio, e o
unico sintoma seria o logotipo errado voltando num deploy.

A MARCA E O FAVICON DA UI, DE PROPOSITO

`services/kb-ui/index.html` ja embute o livro do lucide como favicon. Reusar o
mesmo desenho e o que faz o conector no editor e a aba do navegador parecerem a
mesma coisa. Copiar os dois caminhos SVG a mao seria frageis; eles estao abaixo
em coordenadas, com a origem do lucide (24x24).

POR QUE PNG, E NAO O SVG QUE A UI USA

Mesma regra de `icons.py`: SVG e documento executavel, e aqui ele iria para
dentro da interface de terceiros. A spec do MCP exige que todo cliente aceite
PNG e so RECOMENDA SVG -- PNG e o formato que funciona em todo lugar e nao
carrega script.

    uv run python scripts/gerar_icone_mcp.py            # so se nao existir
    uv run python scripts/gerar_icone_mcp.py --force    # refaz o provisorio
"""

from __future__ import annotations

import math
import pathlib
import sys

from PIL import Image, ImageDraw

# Paleta da UI (`services/kb-ui/src/styles.css`). O ladrilho e `ink-600`, e nao
# o `ink-900` do fundo da aplicacao, por um motivo pratico: a lista de conectores
# pode ser clara ou escura, e o `ink-900` (quase preto) desaparece na escura. O
# `ink-600` tem contraste contra branco E contra o cinza da interface escura.
FUNDO = "#2c2c31"
TRACO = "#ededee"

LADO = 512
# Supersampling: `ImageDraw` nao suavia arco nem linha. Desenhar em 4x e reduzir
# com LANCZOS e o que tira a escada do traco curvo.
SS = 4

# 2.0 em vez do 1.75 do favicon: o favicon vive em 16px num fundo escuro, este
# icone precisa sobreviver a 24px numa lista. Traco fino some antes da forma.
ESPESSURA = 2.0
# A marca ocupa 56% do ladrilho; o resto e respiro, na proporcao de icone de
# aplicativo. Menos que isso some numa lista de 24px, mais encosta na borda.
OCUPACAO = 0.56


def gerar(destino: pathlib.Path) -> None:
    lado = LADO * SS
    imagem = Image.new("RGBA", (lado, lado), (0, 0, 0, 0))
    desenho = ImageDraw.Draw(imagem)

    desenho.rounded_rectangle(
        [0, 0, lado - 1, lado - 1], radius=round(lado * 0.225), fill=FUNDO
    )

    # A marca do lucide vive em y 2..22 (altura 20) e x 4..20, centrada em 12,12.
    k = OCUPACAO * lado / 20
    espessura = max(1, round(ESPESSURA * k))

    def p(x: float, y: float) -> tuple[float, float]:
        return (lado / 2 + (x - 12) * k, lado / 2 + (y - 12) * k)

    def arco(cx: float, cy: float, r: float, inicio: float, fim: float) -> list:
        """Um quarto de circulo do lucide, ja em PONTOS.

        Angulos em graus a partir das 3h, sentido horario, y para baixo -- a
        convencao do SVG e a do Pillow sao a mesma, entao os graus saem diretos.
        """
        passos = max(8, int(abs(fim - inicio) / 2))
        pontos = []
        for i in range(passos + 1):
            angulo = math.radians(inicio + (fim - inicio) * i / passos)
            pontos.append(p(cx + r * math.cos(angulo), cy + r * math.sin(angulo)))
        return pontos

    def tracar(caminho: list) -> None:
        """Desenha a polilinha carimbando um circulo do diametro do traco.

        POR QUE NAO `ImageDraw.line`: com `joint="curve"` o Pillow emite farpas
        radiais nos trechos curvos (segmentos curtos + junta preenchida), e sem
        ele a ponta de cada primitiva fica reta e a junta com a proxima aparece
        como degrau. Carimbar circulo da de graca o `stroke-linecap="round"` e o
        `stroke-linejoin="round"` do SVG original, sem caso especial nenhum.
        Sao alguns milhares de elipses numa tela de 4x -- custo irrelevante para
        um arquivo gerado uma vez.
        """
        raio = espessura / 2
        for (x1, y1), (x2, y2) in zip(caminho, caminho[1:], strict=False):
            distancia = math.hypot(x2 - x1, y2 - y1)
            for i in range(max(1, int(distancia)) + 1):
                t = i / max(1, int(distancia))
                cx, cy = x1 + (x2 - x1) * t, y1 + (y2 - y1) * t
                desenho.ellipse([cx - raio, cy - raio, cx + raio, cy + raio], fill=TRACO)

    # Contorno: `M6.5 2 H20 v20 H6.5 A2.5..4,19.5 v-15 A2.5..6.5,2 z`
    tracar(
        [p(6.5, 2), p(20, 2), p(20, 22), p(6.5, 22)]
        + arco(6.5, 19.5, 2.5, 90, 180)      # canto inferior esquerdo
        + [p(4, 4.5)]
        + arco(6.5, 4.5, 2.5, 180, 270)      # canto superior esquerdo
    )

    # Vinco da lombada: `M4 19.5 A2.5..6.5,17 H20`. Mesmo centro e mesmo raio do
    # canto inferior esquerdo -- juntos os dois formam a meia-lua da lombada.
    tracar(arco(6.5, 19.5, 2.5, 180, 270) + [p(20, 17)])

    imagem.resize((LADO, LADO), Image.LANCZOS).save(destino, "PNG", optimize=True)
    print(f"{destino} ({destino.stat().st_size} bytes)")


if __name__ == "__main__":
    raiz = pathlib.Path(__file__).resolve().parent.parent
    destino = raiz / "src" / "kb_api" / "assets" / "icon.png"
    if destino.exists() and "--force" not in sys.argv:
        raise SystemExit(
            f"{destino} ja existe e NAO foi tocado.\n"
            "Se for o icone definitivo, e para ficar como esta. Para refazer o "
            "provisorio mesmo assim: --force"
        )
    gerar(destino)

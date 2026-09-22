/**
 * O ícone da base, do lado do navegador.
 *
 * Três formas, e a coluna do banco guarda as três como texto:
 *
 * - `''` — sem ícone; a lista cai para a inicial do rótulo;
 * - `lucide:<Nome>` — ícone da biblioteca da interface;
 * - `data:image/webp;base64,…` — imagem enviada, já reduzida.
 */

/** Lado do ícone gravado. Ele é desenhado em 44px; 96 cobre tela 2x sem
 *  guardar o dobro do necessário. O servidor reduz para o mesmo número — se
 *  este mudar, o de lá muda junto (`icons.LADO`). */
export const LADO = 96;

/** Teto do arquivo ESCOLHIDO, antes de reduzir.
 *
 *  Existe para o navegador recusar cedo, com mensagem clara, em vez de gastar
 *  memória decodificando uma foto de 40 MP para descobrir depois. O servidor
 *  tem o seu próprio teto: este aqui é conveniência, não controle. */
export const MAX_ARQUIVO = 8 * 1024 * 1024;

export const TIPOS_ACEITOS = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'];

export function ehImagem(icone: string): boolean {
  return icone.startsWith('data:');
}

export function nomeLucide(icone: string): string {
  return icone.startsWith('lucide:') ? icone.slice('lucide:'.length) : '';
}

/**
 * Reduz a imagem escolhida para um `data:` pequeno.
 *
 * POR QUE REDUZIR AQUI SE O SERVIDOR REDUZ DE NOVO
 *
 * Para não subir o arquivo inteiro. Uma foto de celular tem 4 MB; o ícone
 * gravado tem poucos kB. Sem isto, cada troca de ícone mandaria a foto inteira
 * pela rede para o servidor jogar 99% fora.
 *
 * O servidor reduz mesmo assim porque este passo é do NAVEGADOR — quem chama a
 * API não é obrigado a ser esta tela.
 *
 * `image/webp` com queda para PNG: o canvas de todo navegador atual exporta
 * WebP, mas quando não exporta ele devolve um PNG em silêncio, com o
 * `data:image/png` no começo. Detectar pelo prefixo é mais honesto que confiar
 * no `toDataURL` ter feito o que se pediu.
 */
export async function reduzirParaIcone(arquivo: File): Promise<string> {
  if (!TIPOS_ACEITOS.includes(arquivo.type)) {
    throw new Error(
      `${arquivo.type || 'este tipo'} não serve como ícone. Use PNG, JPEG, GIF ou WebP`,
    );
  }
  if (arquivo.size > MAX_ARQUIVO) {
    throw new Error(`a imagem tem ${(arquivo.size / 1024 / 1024).toFixed(1)} MB; o limite é 8 MB`);
  }

  const bitmap = await carregar(arquivo);
  try {
    // `Math.min(1, …)`: imagem menor que 96px não é AMPLIADA. Esticar um
    // favicon de 16px para 96 entrega um borrão que parece defeito da tela.
    const escala = Math.min(1, LADO / Math.max(bitmap.width, bitmap.height));
    const largura = Math.max(1, Math.round(bitmap.width * escala));
    const altura = Math.max(1, Math.round(bitmap.height * escala));

    const canvas = document.createElement('canvas');
    canvas.width = largura;
    canvas.height = altura;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('não consegui preparar a imagem neste navegador');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, largura, altura);
    return canvas.toDataURL('image/webp', 0.85);
  } finally {
    // Sem isto, cada imagem experimentada fica presa na memória da aba.
    if ('close' in bitmap) (bitmap as ImageBitmap).close();
  }
}

async function carregar(arquivo: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(arquivo);
    } catch {
      // Cai para o `<img>`: alguns navegadores recusam GIF animado aqui.
    }
  }
  const url = URL.createObjectURL(arquivo);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('não consegui ler esta imagem'));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

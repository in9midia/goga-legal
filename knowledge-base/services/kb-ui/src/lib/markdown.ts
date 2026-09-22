/**
 * Markdown do canônico, convertido em ÁRVORE — não em HTML.
 *
 * POR QUE ESCREVER EM VEZ DE INSTALAR
 *
 * O canônico não é markdown arbitrário da internet: quem escreve é o nosso
 * pipeline (docling e os fallbacks), então o subconjunto é conhecido e pequeno.
 * Uma biblioteca completa traria CommonMark inteiro, HTML embutido e a
 * necessidade de um sanitizador junto — porque renderizar markdown de terceiro
 * com `dangerouslySetInnerHTML` é o caminho clássico de XSS num visualizador de
 * documento enviado por outra pessoa.
 *
 * Devolvendo árvore, o React monta os elementos e NENHUMA string vira HTML.
 * Um `<script>` dentro do documento aparece como texto, que é o certo: ele faz
 * parte do conteúdo, não da página.
 *
 * O QUE FICA DE FORA, de propósito: HTML embutido, listas aninhadas, notas de
 * rodapé e referências de link no fim do arquivo. Nada disso sai do nosso
 * pipeline. Aparecendo, cai como texto — feio, nunca quebrado.
 */

export type Inline =
  | { t: 'texto'; valor: string }
  | { t: 'forte'; valor: string }
  | { t: 'enfase'; valor: string }
  | { t: 'codigo'; valor: string }
  | { t: 'link'; texto: string; href: string }
  | { t: 'imagem'; alt: string; src: string };

export type Bloco =
  | { t: 'titulo'; nivel: number; conteudo: Inline[] }
  | { t: 'paragrafo'; conteudo: Inline[] }
  | { t: 'lista'; ordenada: boolean; itens: Inline[][] }
  | { t: 'codigo'; lingua: string; valor: string }
  | { t: 'citacao'; conteudo: Inline[] }
  | { t: 'tabela'; cabecalho: Inline[][]; linhas: Inline[][][] }
  | { t: 'pagina'; numero: number }
  | { t: 'imagem'; alt: string; src: string }
  | { t: 'regua' };

/** A marca de página que a ingestão grava. É o que liga o trecho à página do
 *  original, e no formatado ela vira separador em vez de sumir: sem ela, quem
 *  lê perde a referência que a busca devolve. */
const PAGINA = /^<!--\s*pagina\s+(\d+)\s*-->$/i;
const TITULO = /^(#{1,6})\s+(.*)$/;
const ITEM = /^[-*+]\s+(.*)$/;
const ITEM_NUM = /^(\d+)[.)]\s+(.*)$/;
const CERCA = /^```\s*([A-Za-z0-9_+-]*)\s*$/;
const CITACAO = /^>\s?(.*)$/;
const REGUA = /^(\s*[-*_]\s*){3,}$/;
const SO_IMAGEM = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;
/** Linha de separação de tabela: `|---|:--:|`. */
const SEPARADOR_TABELA = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/;

const INLINE =
  /(!?)\[([^\]]*)\]\(([^)\s]*)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|`([^`]+)`/;

/** Divide uma linha em pedaços de formatação. Sem recursão: negrito dentro de
 *  link é raridade no canônico e resolver isso custaria um parser de verdade. */
export function inline(texto: string): Inline[] {
  const saida: Inline[] = [];
  let resto = texto;
  for (;;) {
    const m = INLINE.exec(resto);
    if (!m || m.index === undefined) break;
    if (m.index > 0) saida.push({ t: 'texto', valor: resto.slice(0, m.index) });
    if (m[3] !== undefined) {
      if (m[1] === '!') saida.push({ t: 'imagem', alt: m[2], src: m[3] });
      else saida.push({ t: 'link', texto: m[2] || m[3], href: m[3] });
    } else if (m[4] !== undefined || m[5] !== undefined) {
      saida.push({ t: 'forte', valor: (m[4] ?? m[5]) as string });
    } else if (m[6] !== undefined || m[7] !== undefined) {
      saida.push({ t: 'enfase', valor: (m[6] ?? m[7]) as string });
    } else if (m[8] !== undefined) {
      saida.push({ t: 'codigo', valor: m[8] });
    }
    resto = resto.slice(m.index + m[0].length);
  }
  if (resto) saida.push({ t: 'texto', valor: resto });
  return saida.length ? saida : [{ t: 'texto', valor: '' }];
}

function celulas(linha: string): Inline[][] {
  const cru = linha.trim().replace(/^\|/, '').replace(/\|$/, '');
  return cru.split('|').map((c) => inline(c.trim()));
}

export function parse(markdown: string): Bloco[] {
  const linhas = (markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocos: Bloco[] = [];
  let i = 0;

  while (i < linhas.length) {
    const linha = linhas[i];
    const cru = linha.trim();

    if (!cru) {
      i += 1;
      continue;
    }

    const pagina = PAGINA.exec(cru);
    if (pagina) {
      blocos.push({ t: 'pagina', numero: Number(pagina[1]) });
      i += 1;
      continue;
    }

    const cerca = CERCA.exec(cru);
    if (cerca) {
      const corpo: string[] = [];
      i += 1;
      while (i < linhas.length && !CERCA.test(linhas[i].trim())) {
        corpo.push(linhas[i]);
        i += 1;
      }
      i += 1; // a cerca de fechamento
      blocos.push({ t: 'codigo', lingua: cerca[1] ?? '', valor: corpo.join('\n') });
      continue;
    }

    if (REGUA.test(cru) && !ITEM.test(cru)) {
      blocos.push({ t: 'regua' });
      i += 1;
      continue;
    }

    const titulo = TITULO.exec(cru);
    if (titulo) {
      blocos.push({ t: 'titulo', nivel: titulo[1].length, conteudo: inline(titulo[2]) });
      i += 1;
      continue;
    }

    const imagem = SO_IMAGEM.exec(cru);
    if (imagem) {
      blocos.push({ t: 'imagem', alt: imagem[1], src: imagem[2] });
      i += 1;
      continue;
    }

    // TABELA: só conta como tabela se a SEGUNDA linha for o separador. Sem essa
    // checagem, uma frase com pipe ("a | b") viraria uma tabela de uma linha.
    if (cru.includes('|') && i + 1 < linhas.length && SEPARADOR_TABELA.test(linhas[i + 1].trim())) {
      const cabecalho = celulas(cru);
      i += 2;
      const corpo: Inline[][][] = [];
      while (i < linhas.length && linhas[i].includes('|') && linhas[i].trim()) {
        corpo.push(celulas(linhas[i]));
        i += 1;
      }
      blocos.push({ t: 'tabela', cabecalho, linhas: corpo });
      continue;
    }

    if (CITACAO.test(cru)) {
      const partes: string[] = [];
      while (i < linhas.length && CITACAO.test(linhas[i].trim())) {
        partes.push((CITACAO.exec(linhas[i].trim()) as RegExpExecArray)[1]);
        i += 1;
      }
      blocos.push({ t: 'citacao', conteudo: inline(partes.join(' ')) });
      continue;
    }

    if (ITEM.test(cru) || ITEM_NUM.test(cru)) {
      const ordenada = ITEM_NUM.test(cru);
      const itens: Inline[][] = [];
      while (i < linhas.length) {
        const atual = linhas[i].trim();
        const m = ordenada ? ITEM_NUM.exec(atual) : ITEM.exec(atual);
        if (!m) break;
        itens.push(inline(ordenada ? m[2] : m[1]));
        i += 1;
      }
      blocos.push({ t: 'lista', ordenada, itens });
      continue;
    }

    // Parágrafo: junta até a linha em branco ou até algo que comece outro bloco.
    const partes: string[] = [];
    while (i < linhas.length) {
      const atual = linhas[i].trim();
      if (
        !atual ||
        TITULO.test(atual) ||
        ITEM.test(atual) ||
        ITEM_NUM.test(atual) ||
        CERCA.test(atual) ||
        PAGINA.test(atual) ||
        SO_IMAGEM.test(atual) ||
        CITACAO.test(atual)
      ) {
        break;
      }
      partes.push(atual);
      i += 1;
    }
    if (partes.length) blocos.push({ t: 'paragrafo', conteudo: inline(partes.join(' ')) });
  }

  return blocos;
}

/** O `ref` da figura, quando a imagem é servida pela nossa API.
 *
 *  A imagem do canônico aponta para `/v1/documents/{id}/figures/{ref}/image`, e
 *  essa rota exige `Authorization: Bearer` — `<img src>` não manda header, e o
 *  caminho direto daria 401. Quem reconhece a forma aqui decide buscar por
 *  fetch autenticado em vez de deixar o navegador tentar sozinho. */
export function refDaFigura(src: string): string | null {
  const m = /\/documents\/\d+\/figures\/([^/]+)\/image$/.exec(src);
  return m ? m[1] : null;
}

/**
 * Separa o frontmatter YAML do corpo, para o arquivo OKF.
 *
 * A página da wiki É um arquivo OKF: metadado estruturado em cima, prosa
 * embaixo. Formatar tudo junto faria o `---` virar régua e `type: Política`
 * virar parágrafo — o metadado perderia a forma justamente onde a forma é o
 * conteúdo. Separando, cada metade é mostrada como o que é.
 */
export function separarFrontmatter(texto: string): { frontmatter: string; corpo: string } {
  const limpo = (texto ?? '').replace(/\r\n?/g, '\n');
  if (!limpo.startsWith('---\n')) return { frontmatter: '', corpo: limpo };
  const fim = limpo.indexOf('\n---', 3);
  if (fim < 0) return { frontmatter: '', corpo: limpo };
  return {
    frontmatter: limpo.slice(4, fim),
    corpo: limpo.slice(limpo.indexOf('\n', fim + 1) + 1),
  };
}

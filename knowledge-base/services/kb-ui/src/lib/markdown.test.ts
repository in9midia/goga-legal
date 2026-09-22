import { describe, expect, it } from 'vitest';
import { inline, parse, refDaFigura, separarFrontmatter } from './markdown';

describe('parse', () => {
  it('lê a marca de página que a ingestão grava', () => {
    // Ela é o que liga o trecho à página do original. Some no formatado = some
    // a referência que a busca devolve.
    const b = parse('<!-- pagina 3 -->\n## Título');
    expect(b[0]).toEqual({ t: 'pagina', numero: 3 });
    expect(b[1]).toMatchObject({ t: 'titulo', nivel: 2 });
  });

  it('não confunde frase com pipe com uma tabela', () => {
    // Sem exigir a linha separadora, "entrada | saída" viraria uma tabela de
    // uma linha só e a frase sumiria dentro de uma célula.
    const b = parse('compara entrada | saída no relatório');
    expect(b[0].t).toBe('paragrafo');
  });

  it('lê tabela quando há linha separadora', () => {
    const b = parse('| Campo | Valor |\n|---|---|\n| Prazo | 30 dias |\n| Multa | 2% |');
    expect(b[0]).toMatchObject({ t: 'tabela' });
    const tabela = b[0] as Extract<(typeof b)[0], { t: 'tabela' }>;
    expect(tabela.cabecalho).toHaveLength(2);
    expect(tabela.linhas).toHaveLength(2);
    expect(tabela.linhas[1][0]).toEqual([{ t: 'texto', valor: 'Multa' }]);
  });

  it('separa imagem sozinha em bloco próprio', () => {
    const b = parse('![fluxo](/v1/documents/80/figures/fig-1/image)');
    expect(b[0]).toEqual({
      t: 'imagem',
      alt: 'fluxo',
      src: '/v1/documents/80/figures/fig-1/image',
    });
  });

  it('não trata o conteúdo do bloco de código como markdown', () => {
    const b = parse('```python\n# isto não é um título\n```');
    expect(b[0]).toEqual({ t: 'codigo', lingua: 'python', valor: '# isto não é um título' });
  });

  it('junta linhas soltas num parágrafo só', () => {
    const b = parse('primeira linha\nsegunda linha\n\noutro parágrafo');
    expect(b).toHaveLength(2);
    expect(b[0]).toMatchObject({ t: 'paragrafo' });
  });

  it('lê lista com marcador e lista numerada', () => {
    expect(parse('- um\n- dois')[0]).toMatchObject({ t: 'lista', ordenada: false });
    expect(parse('1. um\n2. dois')[0]).toMatchObject({ t: 'lista', ordenada: true });
  });

  it('aguenta entrada vazia sem estourar', () => {
    expect(parse('')).toEqual([]);
  });
});

describe('inline', () => {
  it('separa negrito, itálico, código e link', () => {
    expect(inline('a **b** c `d` [e](http://x)')).toEqual([
      { t: 'texto', valor: 'a ' },
      { t: 'forte', valor: 'b' },
      { t: 'texto', valor: ' c ' },
      { t: 'codigo', valor: 'd' },
      { t: 'texto', valor: ' ' },
      { t: 'link', texto: 'e', href: 'http://x' },
    ]);
  });

  it('trata script como TEXTO, não como marcação', () => {
    // O canônico vem de documento que outra pessoa enviou. A árvore vira
    // elemento React, nunca HTML, então isto é conteúdo — não página.
    const pedacos = inline('<script>alert(1)</script>');
    expect(pedacos).toEqual([{ t: 'texto', valor: '<script>alert(1)</script>' }]);
  });
});

describe('refDaFigura', () => {
  it('reconhece a imagem servida pela nossa API', () => {
    // Essa rota exige bearer: `<img src>` não manda header e daria 401.
    expect(refDaFigura('/v1/documents/80/figures/fig-1/image')).toBe('fig-1');
  });

  it('devolve null para imagem externa', () => {
    expect(refDaFigura('https://exemplo.com/a.png')).toBeNull();
  });
});

describe('separarFrontmatter', () => {
  it('separa o metadado OKF da prosa', () => {
    const { frontmatter, corpo } = separarFrontmatter(
      '---\ntype: Política\nstatus: vigente\n---\n\n## Férias\n\nTexto.',
    );
    expect(frontmatter).toBe('type: Política\nstatus: vigente');
    expect(corpo.trim()).toBe('## Férias\n\nTexto.');
  });

  it('devolve tudo como corpo quando não há frontmatter', () => {
    const { frontmatter, corpo } = separarFrontmatter('## Só prosa');
    expect(frontmatter).toBe('');
    expect(corpo).toBe('## Só prosa');
  });

  it('não engole o documento quando o frontmatter não fecha', () => {
    // Um `---` de abertura sem o de fechamento cortaria o arquivo inteiro se a
    // busca pelo fim falhasse em silêncio.
    const { frontmatter, corpo } = separarFrontmatter('---\ntype: X\n\n## Título');
    expect(frontmatter).toBe('');
    expect(corpo).toContain('## Título');
  });
});

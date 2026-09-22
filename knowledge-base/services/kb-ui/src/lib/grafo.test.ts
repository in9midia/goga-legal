import { describe, expect, it } from 'vitest';
import { rotuloCurto, rotuloDoNo, trechoDoNo } from './grafo';

const no = (p: Partial<Parameters<typeof rotuloDoNo>[0]>) => ({
  id: 34,
  label: 'Chunk',
  name: '',
  ref: 58,
  ...p,
});

describe('rotuloDoNo', () => {
  it('usa o nome quando existe', () => {
    expect(rotuloDoNo(no({ label: 'Entity', name: 'gestor direto' }))).toBe('gestor direto');
  });

  it('nomeia o trecho pelo id de domínio, e nunca pelo id interno do grafo', () => {
    // Regressão: a tela mostrava "34", que é `id(n)` no Memgraph e não existe
    // em lugar nenhum fora do desenho. O trecho de verdade é o 58.
    expect(rotuloDoNo(no({}))).toBe('trecho #58');
  });

  it('cai no rótulo quando não há nome nem id de domínio', () => {
    expect(rotuloDoNo(no({ label: 'Term', ref: null }))).toBe('Term');
  });

  it('corta nome longo para não cobrir os vizinhos no desenho', () => {
    const longo = 'política de férias e afastamentos remunerados';
    expect(rotuloCurto(no({ label: 'Entity', name: longo })).length).toBe(28);
  });
});

describe('trechoDoNo', () => {
  it('só o nó de trecho tem texto para buscar', () => {
    expect(trechoDoNo(no({}))).toBe(58);
    expect(trechoDoNo(no({ label: 'Document' }))).toBeNull();
    expect(trechoDoNo(no({ ref: null }))).toBeNull();
  });
});

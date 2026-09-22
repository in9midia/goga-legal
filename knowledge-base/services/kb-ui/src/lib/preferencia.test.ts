// @vitest-environment jsdom
//
// Este arquivo precisa de DOM: ele testa `localStorage` de verdade, inclusive
// o caso em que ele levanta. Os outros testes do projeto são lógica pura e
// rodam no ambiente `node` padrão, que é mais rápido.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gravarPreferencia, lerPreferencia } from './preferencia';

describe('preferência de leitura', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('usa o inicial quando não há nada guardado', () => {
    expect(lerPreferencia('x', true)).toBe(true);
    expect(lerPreferencia('x', false)).toBe(false);
  });

  it('lembra o que foi escolhido, inclusive o false', () => {
    // O `false` é o caso que um `guardado || inicial` estragaria: ele leria
    // como ausência e voltaria para o padrão a cada F5.
    gravarPreferencia('x', false);
    expect(lerPreferencia('x', true)).toBe(false);
    gravarPreferencia('x', true);
    expect(lerPreferencia('x', false)).toBe(true);
  });

  it('cai para o inicial quando a leitura levanta', () => {
    // Aba anônima e cookie bloqueado por política fazem isto LEVANTAR, não
    // devolver vazio. Sem o try/catch a tela cairia por uma preferência de
    // layout — e só para algumas pessoas.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage bloqueado');
    });
    expect(lerPreferencia('x', true)).toBe(true);
  });

  it('não levanta quando a escrita falha', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('cota estourada');
    });
    expect(() => gravarPreferencia('x', true)).not.toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { fmtBytes, fmtMs, fmtNumber, fmtUsd } from './format';

describe('fmtMs', () => {
  it('mostra milissegundos abaixo de um segundo', () => {
    expect(fmtMs(0)).toBe('0 ms');
    expect(fmtMs(999)).toBe('999 ms');
  });

  it('vira segundos com vírgula decimal, não ponto', () => {
    // O separador é de idioma: "2.6" num texto em pt-BR se lê como milhar.
    expect(fmtMs(2565)).toBe('2,6 s');
    expect(fmtMs(1000)).toBe('1,0 s');
  });

  it('trata ausência sem quebrar', () => {
    expect(fmtMs(null)).toBe('—');
    expect(fmtMs(undefined)).toBe('—');
  });
});

describe('fmtNumber', () => {
  it('agrupa milhar no padrão pt-BR', () => {
    expect(fmtNumber(2119)).toBe('2.119');
  });

  it('distingue zero de ausente', () => {
    // Zero é um número válido: um painel que mostrasse "—" no lugar de "0"
    // faria "nenhum gasto" parecer "não medido".
    expect(fmtNumber(0)).toBe('0');
    expect(fmtNumber(null)).toBe('—');
  });
});

describe('fmtBytes', () => {
  it('escala a unidade', () => {
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(1024)).toBe('1.0 KB');
    expect(fmtBytes(1024 * 1024 * 5)).toBe('5.0 MB');
  });
});

describe('fmtUsd', () => {
  it('não achata gasto pequeno em zero', () => {
    // O preço é por MILHÃO de tokens: uso real de uma base pequena cai nos
    // centésimos de centavo, e duas casas fixas mostrariam "US$ 0,00" onde
    // houve gasto — mentindo para quem foi conferir se estava gastando.
    expect(fmtUsd(0.0004)).toBe('US$ 0.0004');
    expect(fmtUsd(0.25)).toBe('US$ 0.250');
  });

  it('usa duas casas a partir de um dólar', () => {
    expect(fmtUsd(1234.5)).toBe('US$ 1.234,50');
  });

  it('zero é zero, sem casas decimais inventadas', () => {
    expect(fmtUsd(0)).toBe('US$ 0');
    expect(fmtUsd(null)).toBe('US$ 0');
    expect(fmtUsd(undefined)).toBe('US$ 0');
  });
});

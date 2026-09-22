export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  // Vírgula decimal: `toFixed` devolve "2.6", que num texto em pt-BR se lê
  // como milhar. O separador é o de idioma, não de código.
  return `${(ms / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
}

export function fmtBytes(bytes: number | null | undefined): string {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('pt-BR');
}

export function fmtNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toLocaleString('pt-BR');
}

/** Os scores gravados no historico vem crus do Postgres; sem cortar, uma linha
 *  de evidencia viraria `0.3503983829959453`. */
export function fmtScore(value: number | null | undefined, digits = 6): string {
  return value === null || value === undefined ? '—' : Number(value).toFixed(digits);
}

/** Ordem do pipeline. O JSONB volta na ordem do banco, que nao e a do fluxo —
 *  ler "fusao" antes de "vetorial" confunde quem esta auditando a busca. */
const STAGE_ORDER = ['escopo', 'vetorial', 'lexical', 'fusao', 'expansao_pai'];

export function orderedStages<T>(stages: Record<string, T> | null | undefined): [string, T][] {
  const entries = Object.entries(stages ?? {});
  return entries.sort((a, b) => {
    const ia = STAGE_ORDER.indexOf(a[0]);
    const ib = STAGE_ORDER.indexOf(b[0]);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

/**
 * Dólar, com casas suficientes para o número não sumir.
 *
 * Duas casas fixas transformariam um dia inteiro de embedding em "US$ 0,00":
 * o preço é por MILHÃO de tokens, então uso real de uma base pequena cai na
 * casa dos centésimos de centavo. Mostrar zero onde houve gasto faz a tela
 * mentir justamente para quem foi conferir se estava gastando.
 */
export function fmtUsd(value: number | null | undefined): string {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  if (n === 0) return 'US$ 0';
  if (n < 0.01) return `US$ ${n.toFixed(4)}`;
  if (n < 1) return `US$ ${n.toFixed(3)}`;
  return `US$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

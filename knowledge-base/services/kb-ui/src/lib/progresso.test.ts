import { describe, expect, it } from 'vitest';
import { progressoDaIngestao } from './progresso';
import type { IngestRun } from './types';

const base = {
  id: 0,
  space: 'rh',
  filename: 'x.pdf',
  document_id: 1,
  extractor: 'docling',
  size_bytes: 1,
  pages: 1,
  figures: 0,
  parents: 1,
  children: 1,
  embed_tokens: 0,
  chunk_engine: 'markdown',
  error: '',
  principal: 'p',
  finished_at: null,
} as const;

const run = (i: number, inicioMs: number, duracaoMs: number, status = 'indexed') =>
  ({
    ...base,
    id: i,
    status,
    started_at: new Date(inicioMs).toISOString(),
    total_ms: duracaoMs,
  }) as IngestRun;

describe('progressoDaIngestao', () => {
  const AGORA = 1_000_000;

  it('não inventa total quando a carga vem de fora', () => {
    // Script ou MCP: o servidor processa um arquivo por requisição e não sabe
    // quantos virão. Uma barra com total chutado andaria para trás.
    const runs = [run(1, AGORA - 300_000, 60_000), run(2, AGORA - 200_000, 60_000)];
    const p = progressoDaIngestao(runs, null, AGORA)!;
    expect(p.faltam).toBeNull();
    expect(p.restante_ms).toBeNull();
    expect(p.concluidos).toBe(2);
  });

  it('prevê o término quando a fila é local', () => {
    const runs = [run(1, AGORA - 120_000, 60_000), run(2, AGORA - 60_000, 60_000)];
    const p = progressoDaIngestao(runs, { total: 10, indice: 2 }, AGORA)!;
    // 10 na fila, o de índice 2 está em voo: sobram os índices 3..9.
    expect(p.faltam).toBe(7);
    expect(p.restante_ms).toBeGreaterThan(0);
  });

  it('conta o que falta igual à própria fila, com ou sem execução no log', () => {
    // O painel mostra "faltam total - indice - 1" ao lado deste número. Se este
    // dependesse de já existir uma execução `running` no servidor, os dois
    // discordariam nos segundos entre o POST sair e a execução aparecer.
    const comRunning = [run(1, AGORA - 60_000, 0, 'running')];
    const semRunning = [run(1, AGORA - 60_000, 60_000)];
    const fila = { total: 10, indice: 2 };
    expect(progressoDaIngestao(comRunning, fila, AGORA)!.faltam).toBe(7);
    expect(progressoDaIngestao(semRunning, fila, AGORA)!.faltam).toBe(7);
  });

  it('mede a média pelo TEMPO DE PAREDE, não pela soma das durações', () => {
    // Dois arquivos sobrepostos, 60s cada, mas 90s de relógio. Somar daria 60s
    // por arquivo; a parede diz 45s — e é a parede que prevê o fim.
    const runs = [run(1, AGORA - 90_000, 60_000), run(2, AGORA - 60_000, 60_000)];
    const p = progressoDaIngestao(runs, null, AGORA)!;
    expect(p.media_ms).toBeCloseTo(45_000, -2);
  });

  it('separa rodadas distantes no tempo', () => {
    // Uma carga de ontem não entra na média da de agora.
    const runs = [
      run(1, AGORA - 60_000, 30_000),
      run(2, AGORA - 30_000, 30_000),
      run(9, AGORA - 5_000_000, 30_000),
    ];
    const p = progressoDaIngestao(runs, null, AGORA)!;
    expect(p.concluidos).toBe(2);
  });

  it('sem execução nenhuma, não há progresso a mostrar', () => {
    expect(progressoDaIngestao([], null, AGORA)).toBeNull();
  });
});

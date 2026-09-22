import type { IngestRun } from './types';

/**
 * Quanto já andou, quanto falta, e quanto tempo isso deve levar.
 *
 * O QUE O SERVIDOR SABE E O QUE ELE NÃO SABE
 *
 * A ingestão é síncrona e sem fila no servidor: ele processa UM arquivo por
 * requisição e não faz ideia de quantos virão depois. Quem tem a fila é quem
 * envia — a tela, quando o envio sai daqui; um script ou o MCP, quando vem de
 * fora.
 *
 * Daí as duas leituras, e a diferença entre elas é honestidade:
 *
 * - **fila local**: dá para dizer "faltam 12" e prever o término, porque a
 *   lista inteira está aqui;
 * - **carga externa**: dá para dizer quantos já passaram, a que ritmo e há
 *   quanto tempo — e NÃO dá para dizer quantos faltam. Inventar um total seria
 *   uma barra de progresso que anda para trás quando chega mais arquivo.
 */

/** Uma sequência contígua de processamento. Duas cargas separadas por meia hora
 *  são duas rodadas, e misturar as médias delas dá um número que não descreve
 *  nenhuma. */
const INTERVALO_DA_RODADA_MS = 10 * 60 * 1000;

export type Progresso = {
  /** Quantos arquivos esta rodada já processou (inclui falhas: elas gastaram tempo). */
  concluidos: number;
  /** Só quando a fila é local. `null` quando a carga vem de fora. */
  faltam: number | null;
  /** Desde o início da rodada, em ms. */
  decorrido_ms: number;
  /** Média por arquivo nesta rodada, em ms. `null` sem amostra. */
  media_ms: number | null;
  /** Previsão do que falta, em ms. `null` quando não há fila local ou amostra. */
  restante_ms: number | null;
  /** Há algo rodando agora. */
  ativo: boolean;
};

export function progressoDaIngestao(
  runs: IngestRun[],
  fila: { total: number; indice: number } | null,
  agora: number = Date.now(),
): Progresso | null {
  const ordenadas = [...runs].sort((a, b) => {
    const ta = a.started_at ? Date.parse(a.started_at) : 0;
    const tb = b.started_at ? Date.parse(b.started_at) : 0;
    return tb - ta;
  });
  if (!ordenadas.length) return null;

  // A rodada corrente: caminha do mais novo para trás enquanto o intervalo
  // entre execuções for curto. O primeiro buraco grande fecha a rodada.
  const rodada: IngestRun[] = [];
  let anterior: number | null = null;
  for (const run of ordenadas) {
    const inicio = run.started_at ? Date.parse(run.started_at) : 0;
    if (!inicio) continue;
    const fim = inicio + (run.total_ms || 0);
    if (anterior !== null && anterior - fim > INTERVALO_DA_RODADA_MS) break;
    rodada.push(run);
    anterior = inicio;
  }
  if (!rodada.length) return null;

  const ativo = rodada.some((r) => r.status === 'running');
  const terminadas = rodada.filter((r) => r.status !== 'running' && r.total_ms > 0);
  const inicioDaRodada = Math.min(
    ...rodada.map((r) => (r.started_at ? Date.parse(r.started_at) : agora)),
  );

  // A média é do TEMPO DE PAREDE por arquivo, e não da soma dos `total_ms`
  // dividida pelo número deles. Com duas cargas concorrentes os arquivos se
  // sobrepõem, e somar as durações contaria o mesmo minuto duas vezes — a
  // previsão sairia o dobro do que a realidade entrega.
  const ultimoFim = Math.max(
    ...rodada.map((r) => {
      const i = r.started_at ? Date.parse(r.started_at) : 0;
      return r.status === 'running' ? agora : i + (r.total_ms || 0);
    }),
  );
  const paredeConcluida = Math.max(1, ultimoFim - inicioDaRodada);
  const media_ms = terminadas.length ? paredeConcluida / terminadas.length : null;

  // O arquivo de `indice` esta em voo por definicao: a fila local so existe
  // enquanto o `POST` dele nao voltou. Descontar com base no `ativo` do
  // servidor faria este numero discordar do "faltam" que a propria fila mostra,
  // por alguns segundos, toda vez que a execucao ainda nao apareceu no log.
  const faltam = fila ? Math.max(0, fila.total - fila.indice - 1) : null;
  const restante_ms = faltam !== null && media_ms !== null ? faltam * media_ms : null;

  return {
    concluidos: terminadas.length,
    faltam,
    decorrido_ms: agora - inicioDaRodada,
    media_ms,
    restante_ms,
    ativo,
  };
}

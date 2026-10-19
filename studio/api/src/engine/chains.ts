// Encadeamentos entre especialistas (aresta especialista -> especialista, ex.:
// 15 -> 23, 54 -> 29 -> 52). Cada no encadeado roda no maximo uma vez por turno,
// depois que TODAS as suas origens deste turno terminaram, e recebe o parecer de
// todas as que concluiram — nao so o da primeira que chegou nele. Nos do mesmo
// nivel (origens ja prontas) rodam em paralelo.

export interface ChainResult {
  nodeId: string;
  ok: boolean;
}

export interface ChainOptions<R extends ChainResult> {
  /** Primeira rodada, ja concluida (os escolhidos pelo Classificador). */
  first: R[];
  /** Destinos das arestas que saem do no. */
  outs: (id: string) => string[];
  /** So especialista encadeia; arestas para Consolidador etc. nao contam. */
  isSpecialist: (id: string) => boolean;
  /**
   * Roda um no encadeado com os resultados das origens que concluiram. So deve
   * rejeitar por erro que encerra o turno (teto de custo, cancelamento); falha
   * do especialista volta como `ok: false`.
   */
  run: (id: string, priors: R[]) => Promise<R>;
}

/** Nos alcancaveis a partir da primeira rodada por arestas entre especialistas, na ordem em que sao descobertos. */
export function chainClosure(firstIds: string[], outs: (id: string) => string[], isSpecialist: (id: string) => boolean): string[] {
  const seen = new Set(firstIds);
  const order = [...firstIds];
  for (let i = 0; i < order.length; i++) {
    for (const t of outs(order[i])) {
      if (!isSpecialist(t) || seen.has(t)) continue;
      seen.add(t);
      order.push(t);
    }
  }
  return order;
}

/** Executa os encadeamentos por niveis e devolve os resultados na ordem em que rodaram (sem a primeira rodada). */
export async function runChains<R extends ChainResult>({ first, outs, isSpecialist, run }: ChainOptions<R>): Promise<R[]> {
  const closure = chainClosure(
    first.map((r) => r.nodeId),
    outs,
    isSpecialist,
  );
  const inClosure = new Set(closure);
  // Origens de cada no: quem, dentro do fecho deste turno, aponta para ele.
  const sources = new Map<string, string[]>(closure.map((id) => [id, []]));
  for (const s of closure) for (const t of outs(s)) if (t !== s && inClosure.has(t) && !sources.get(t)!.includes(s)) sources.get(t)!.push(s);

  const done = new Map<string, R>(first.map((r) => [r.nodeId, r]));
  const skipped = new Set<string>();
  const settled = (id: string) => done.has(id) || skipped.has(id);
  let pending = closure.filter((id) => !done.has(id));
  const results: R[] = [];

  while (pending.length) {
    let level = pending.filter((t) => sources.get(t)!.every(settled));
    // Ciclo entre especialistas (a validacao recusa, mas fluxo antigo pode ter):
    // roda quem ja tem ao menos uma origem pronta em vez de travar.
    if (!level.length) level = pending.filter((t) => sources.get(t)!.some(settled));
    if (!level.length) break;
    pending = pending.filter((t) => !level.includes(t));

    const toRun: { id: string; priors: R[] }[] = [];
    for (const t of level) {
      const priors = sources
        .get(t)!
        .map((s) => done.get(s))
        .filter((r): r is R => !!r?.ok);
      // Nenhuma origem concluiu: nao ha parecer para encadear.
      if (priors.length) toRun.push({ id: t, priors });
      else skipped.add(t);
    }
    const settledRuns = await Promise.allSettled(toRun.map((x) => run(x.id, x.priors)));
    const fatal = settledRuns.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (fatal) throw fatal.reason;
    for (const r of settledRuns as PromiseFulfilledResult<R>[]) {
      done.set(r.value.nodeId, r.value);
      results.push(r.value);
    }
  }
  return results;
}

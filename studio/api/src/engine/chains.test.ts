import { describe, expect, it } from "vitest";
import { chainClosure, runChains, type ChainResult } from "./chains.js";

type R = ChainResult & { priors: string[] };

// Grafo de teste: arestas entre especialistas; "consolidator" nao e especialista.
const graphOf = (edges: [string, string][]) => {
  const outs = (id: string) => edges.filter(([s]) => s === id).map(([, t]) => t);
  const isSpecialist = (id: string) => id !== "consolidator";
  return { outs, isSpecialist };
};

// Executor falso: registra quem rodou em paralelo com quem e o que recebeu.
const recorder = (fail: string[] = []) => {
  const calls: { id: string; priors: string[] }[] = [];
  let running = 0;
  let maxRunning = 0;
  const run = async (id: string, priors: R[]): Promise<R> => {
    calls.push({ id, priors: priors.map((p) => p.nodeId) });
    running++;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return { nodeId: id, ok: !fail.includes(id), priors: priors.map((p) => p.nodeId) };
  };
  return { run, calls, maxRunning: () => maxRunning };
};
const ok = (id: string): R => ({ nodeId: id, ok: true, priors: [] });

describe("chainClosure", () => {
  it("segue só arestas entre especialistas, na ordem de descoberta", () => {
    const g = graphOf([["a", "b"], ["a", "consolidator"], ["b", "c"], ["c", "b"]]);
    expect(chainClosure(["a"], g.outs, g.isSpecialist)).toEqual(["a", "b", "c"]);
  });
});

describe("runChains", () => {
  it("nó com duas origens espera as duas e recebe os dois pareceres", async () => {
    // 58 -> 56 -> 61 -> 71 e 58 -> 71: o 71 audita o 58 e o 61, não só quem chegou primeiro.
    const g = graphOf([["58", "56"], ["56", "61"], ["61", "71"], ["58", "71"]]);
    const rec = recorder();
    const out = await runChains({ first: [ok("58")], ...g, run: rec.run });
    expect(out.map((r) => r.nodeId)).toEqual(["56", "61", "71"]);
    expect(rec.calls.find((c) => c.id === "71")?.priors).toEqual(["58", "61"]);
  });

  it("nós do mesmo nível rodam em paralelo", async () => {
    const g = graphOf([["14", "23"], ["14", "56"], ["15", "23"], ["15", "56"], ["56", "65"]]);
    const rec = recorder();
    const out = await runChains({ first: [ok("14"), ok("15")], ...g, run: rec.run });
    expect(out.map((r) => r.nodeId)).toEqual(["23", "56", "65"]);
    expect(rec.maxRunning()).toBe(2);
    expect(rec.calls.find((c) => c.id === "23")?.priors).toEqual(["14", "15"]);
    expect(rec.calls.find((c) => c.id === "65")?.priors).toEqual(["56"]);
  });

  it("origem que falhou não entra; sem nenhuma origem concluída o nó não roda", async () => {
    const g = graphOf([["a", "c"], ["b", "c"], ["x", "y"]]);
    const rec = recorder();
    const out = await runChains({ first: [ok("a"), { nodeId: "b", ok: false, priors: [] }, { nodeId: "x", ok: false, priors: [] }], ...g, run: rec.run });
    expect(out.map((r) => r.nodeId)).toEqual(["c"]);
    expect(rec.calls.find((c) => c.id === "c")?.priors).toEqual(["a"]);
  });

  it("descendente de nó que falhou também não roda", async () => {
    const g = graphOf([["a", "b"], ["b", "c"]]);
    const rec = recorder(["b"]);
    const out = await runChains({ first: [ok("a")], ...g, run: rec.run });
    expect(out.map((r) => [r.nodeId, r.ok])).toEqual([["b", false]]);
  });

  it("sem encadeamento não roda nada", async () => {
    const g = graphOf([["a", "consolidator"]]);
    const rec = recorder();
    expect(await runChains({ first: [ok("a")], ...g, run: rec.run })).toEqual([]);
    expect(rec.calls).toEqual([]);
  });

  it("ciclo entre especialistas não trava: cada nó roda uma vez", async () => {
    const g = graphOf([["a", "b"], ["b", "c"], ["c", "b"]]);
    const rec = recorder();
    const out = await runChains({ first: [ok("a")], ...g, run: rec.run });
    expect(out.map((r) => r.nodeId).sort()).toEqual(["b", "c"]);
  });

  it("erro fatal (teto de custo) encerra depois que o nível termina", async () => {
    const g = graphOf([["a", "b"], ["a", "c"], ["b", "d"]]);
    const started: string[] = [];
    const run = async (id: string): Promise<R> => {
      started.push(id);
      if (id === "b") throw new Error("teto");
      await new Promise((r) => setTimeout(r, 5));
      return ok(id);
    };
    await expect(runChains({ first: [ok("a")], ...g, run })).rejects.toThrow("teto");
    expect(started.sort()).toEqual(["b", "c"]);
  });
});

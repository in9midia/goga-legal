import { describe, expect, it } from "vitest";
import { buildFlow, FULL_CHAINS, FULL_FLOW } from "../seed/flows.js";
import { graphWarnings, validateGraph } from "./graph.js";

const codes = (ws: { code: string }[]) => ws.map((w) => w.code);

describe("graphWarnings", () => {
  it("fluxo seed (com Retriagem, fallback distinto): sem avisos", () => {
    const g = buildFlow(FULL_FLOW, FULL_CHAINS, "modelo-a");
    expect(graphWarnings(g)).toEqual([]);
  });

  it("encadeamentos sem Retriagem: um aviso, que não vira erro de validação", () => {
    const base = buildFlow(FULL_FLOW, FULL_CHAINS, "modelo-a");
    const retriagem = base.nodes.find((n) => n.type === "retriagem")!.id;
    const g = {
      ...base,
      nodes: base.nodes.filter((n) => n.id !== retriagem),
      edges: base.edges.filter((e) => e.source !== retriagem && e.target !== retriagem),
    };
    expect(codes(graphWarnings(g))).toEqual(["chains_without_retriagem"]);
    expect(graphWarnings(g)[0].message).toContain(`${FULL_CHAINS.length} encadeamento`);
    expect(codes(validateGraph(g))).not.toContain("chains_without_retriagem");
  });

  it("fallback igual ao principal (inclusive herdado do padrão do fluxo) avisa por nó", () => {
    const base = buildFlow(FULL_FLOW, FULL_CHAINS, "modelo-a");
    const g = {
      ...base,
      nodes: base.nodes.map((n) =>
        n.id === "classifier"
          ? { ...n, data: { ...n.data, model: { ...n.data.model, modelId: "modelo-b", fallbackModelId: "modelo-b" } } }
          : n.id === "sp-15"
            ? { ...n, data: { ...n.data, model: { ...n.data.model, modelId: null, fallbackModelId: "modelo-a" } } }
            : n,
      ),
    };
    const ws = graphWarnings(g);
    expect(ws.map((w) => [w.code, w.nodeId])).toEqual([
      ["fallback_same_model", "classifier"],
      ["fallback_same_model", "sp-15"],
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { validateGraph } from "../shared/graph.js";
import { emptyGraph } from "../seed/flows.js";
import { applyFlowOps, deepMerge } from "./flowOps.js";
import { diffPaths } from "./tools.js";

const meta = { name: "F", description: "" };
const spec = { number: 7, name: "Bancário", scope: "bancos", defaultPrompt: "Você é bancário.", defaultSpaces: ["bancario"], defaultSkills: ["calcular_prazo"], escalationRules: ["fraude"], zone: "amarela" };

describe("applyFlowOps", () => {
  it("adiciona especialista do catálogo ligado ao classificador e ao consolidador", () => {
    const g = emptyGraph(null);
    const out = applyFlowOps(g, [{ op: "adicionar_no", tipo: "specialist", especialidade: 7, conectar: true, dados: { model: { temperature: 0.1 } } }], meta, [spec]);
    const n = out.graph.nodes.find((x) => x.id === "sp-7")!;
    expect(n.data.prompt.system).toBe("Você é bancário.");
    expect(n.data.tools.skills).toEqual(["buscar_kb", "verificar_citacao", "calcular_prazo"]);
    expect(n.data.rules.zone).toBe("amarela");
    expect(n.data.model.temperature).toBe(0.1);
    expect(n.data.model.maxTokens).toBe(2000);
    const cls = out.graph.nodes.find((x) => x.type === "classifier")!.id;
    const con = out.graph.nodes.find((x) => x.type === "consolidator")!.id;
    expect(out.graph.edges.some((e) => e.source === cls && e.target === "sp-7")).toBe(true);
    expect(out.graph.edges.some((e) => e.source === "sp-7" && e.target === con)).toBe(true);
    expect(validateGraph(out.graph).filter((e) => e.code === "unreachable")).toEqual([]);
  });

  it("altera por merge profundo, remove nó com arestas e não muda o grafo de entrada", () => {
    const g = emptyGraph(null);
    const withSp = applyFlowOps(g, [{ op: "adicionar_no", tipo: "specialist", id: "x", conectar: true }], meta, []).graph;
    const out = applyFlowOps(
      withSp,
      [
        { op: "alterar_no", no: "x", dados: { knowledge: { spaces: ["consumidor"] }, name: "X" } },
        { op: "alterar_configuracoes", dados: { tone: "cordial" } },
        { op: "renomear_fluxo", nome: "Novo" },
      ],
      meta,
      [],
    );
    const x = out.graph.nodes.find((n) => n.id === "x")!;
    expect(x.data.name).toBe("X");
    expect(x.data.knowledge.spaces).toEqual(["consumidor"]);
    expect(x.data.knowledge.topK).toBe(6);
    expect(out.graph.settings.tone).toBe("cordial");
    expect(out.name).toBe("Novo");
    expect(withSp.nodes.find((n) => n.id === "x")!.data.name).toBe("Novo especialista");

    const removed = applyFlowOps(out.graph, [{ op: "remover_no", no: "x" }], meta, []).graph;
    expect(removed.nodes.some((n) => n.id === "x")).toBe(false);
    expect(removed.edges.some((e) => e.source === "x" || e.target === "x")).toBe(false);
  });

  it("aponta a operação que falhou", () => {
    expect(() => applyFlowOps(emptyGraph(null), [{ op: "renomear_fluxo", nome: "ok" }, { op: "remover_no", no: "nao-existe" }], meta, [])).toThrow(/operação 2 \(remover_no\): nó "nao-existe" não existe/);
    expect(() => applyFlowOps(emptyGraph(null), [{ op: "alterar_no", no: "entry", dados: { model: { temperature: 9 } } }], meta, [])).toThrow(/model.temperature/);
  });

  it("substitui trecho exato, acrescenta texto e recusa trecho ausente ou repetido", () => {
    const g = emptyGraph(null);
    g.nodes.find((n) => n.id === "entry")!.data.prompt.system = "A. Peça o CPF. B. Peça o CPF.";
    g.settings.globalRules = "Regra 1.";
    const out = applyFlowOps(
      g,
      [
        { op: "substituir_texto", no: "entry", campo: "prompt.system", trecho: "A. Peça o CPF.", novo: "A. Peça o nome." },
        { op: "acrescentar_texto", no: "configuracoes", campo: "globalRules", texto: "Regra 2.", posicao: "fim" },
      ],
      meta,
      [],
    );
    expect(out.graph.nodes.find((n) => n.id === "entry")!.data.prompt.system).toBe("A. Peça o nome. B. Peça o CPF.");
    expect(out.graph.settings.globalRules).toBe("Regra 1.\n\nRegra 2.");
    expect(() => applyFlowOps(g, [{ op: "substituir_texto", no: "entry", campo: "prompt.system", trecho: "Peça o CPF.", novo: "x" }], meta, [])).toThrow(/aparece 2 vezes/);
    expect(() => applyFlowOps(g, [{ op: "substituir_texto", no: "entry", campo: "prompt.system", trecho: "nada", novo: "x" }], meta, [])).toThrow(/não encontrado/);
    expect(() => applyFlowOps(g, [{ op: "substituir_texto", no: "entry", campo: "model", trecho: "a", novo: "x" }], meta, [])).toThrow(/não é um campo de texto/);
  });

  it("definir_campo aplica um valor em todos os nós de um tipo, validando", () => {
    const g = applyFlowOps(emptyGraph(null), [{ op: "adicionar_no", tipo: "specialist", id: "a", conectar: true }, { op: "adicionar_no", tipo: "specialist", id: "b", conectar: true }], meta, []).graph;
    const out = applyFlowOps(g, [{ op: "definir_campo", nos: ["tipo:specialist"], caminho: "model.maxTokens", valor: 3500 }], meta, []);
    expect(out.graph.nodes.filter((n) => n.type === "specialist").map((n) => n.data.model.maxTokens)).toEqual([3500, 3500]);
    expect(out.graph.nodes.find((n) => n.type === "classifier")!.data.model.maxTokens).not.toBe(3500);
    expect(out.log).toEqual(["model.maxTokens = 3500 em 2 nó(s)"]);
    expect(() => applyFlowOps(g, [{ op: "definir_campo", nos: ["a"], caminho: "model.maxTokens", valor: 10 }], meta, [])).toThrow(/maxTokens/);
  });

  it("deepMerge substitui listas e aceita null", () => {
    expect(deepMerge({ a: { b: 1, c: [1, 2] }, m: "x" }, { a: { c: [3] }, m: null })).toEqual({ a: { b: 1, c: [3] }, m: null });
  });
});

describe("diffPaths", () => {
  it("casa nós por id e lista só o que mudou", () => {
    const before = { name: "A", graph: { nodes: [{ id: "n1", data: { t: 1 } }, { id: "n2", data: { t: 2 } }] } };
    const after = { name: "A", graph: { nodes: [{ id: "n2", data: { t: 3 } }, { id: "n1", data: { t: 1 } }] } };
    expect(diffPaths(before, after)).toEqual([{ campo: "graph.nodes[n2].data.t", antes: 2, depois: 3 }]);
  });
});

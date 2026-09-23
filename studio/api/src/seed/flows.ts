import { nodeDataSchema, type FlowEdge, type FlowGraph, type FlowNode, type NodeData } from "../shared/graph.js";
import { readSeed } from "./files.js";

export interface SpecialtySeed {
  number: number;
  name: string;
  area: string;
  cluster: string;
  role: string;
  routable: boolean;
  scope: string;
  default_prompt: string;
  default_spaces: string[];
  default_skills: string[];
  routing_hints: { keywords: string[]; examples: string[] };
  escalation_rules: string[];
  phase: number;
  zone: "verde" | "amarela";
}

interface Preset {
  name: string;
  prompt: string;
  config: Record<string, unknown>;
}

interface GlobalRules {
  regras_absolutas: { id: string; titulo?: string; texto: string }[];
  regra_mae?: string;
  neutralidade?: string;
  sem_promessa?: string;
  premissa_fatica?: string;
  exclusao?: string;
  anti_alucinacao?: string;
  zonas?: unknown;
  disclaimer?: string;
  idioma?: string;
  tom?: string;
}

export const specialtySeeds = () => readSeed<SpecialtySeed[]>("specialties.json", []);
const presets = () => readSeed<Record<string, Preset>>("presets.json", {});
const globalRules = () => readSeed<GlobalRules | null>("global_rules.json", null);

const data = (d: Partial<NodeData> & { name: string }): NodeData => nodeDataSchema.parse(d);

export function flowSettings(defaultModelId: string | null) {
  const g = globalRules();
  const asText = (v: unknown) => (typeof v === "string" ? v : v ? JSON.stringify(v, null, 1) : "");
  const rules = g
    ? [
        ...g.regras_absolutas.map((r) => r.texto),
        g.regra_mae && `REGRA-MÃE: ${g.regra_mae}`,
        g.neutralidade && `NEUTRALIDADE: ${g.neutralidade}`,
        g.sem_promessa && `SEM PROMESSA DE RESULTADO: ${g.sem_promessa}`,
        g.premissa_fatica && `PREMISSA FÁTICA: ${g.premissa_fatica}`,
        g.anti_alucinacao && `ANTI-ALUCINAÇÃO: ${g.anti_alucinacao}`,
        g.exclusao && `EXCLUSÃO: ${g.exclusao}`,
        g.zonas && `ZONAS: ${asText(g.zonas)}`,
      ]
        .filter(Boolean)
        .join("\n\n")
    : "";
  return {
    globalRules: rules,
    disclaimer: g?.disclaimer ?? "",
    language: g?.idioma ?? "pt-BR",
    tone: g?.tom ?? "",
    defaultModelId,
    maxRunCostUsd: 0.5,
  };
}

export function emptyGraph(defaultModelId: string | null = null): FlowGraph {
  const p = presets();
  const nodes: FlowNode[] = [
    { id: "entry", type: "entry", position: { x: 0, y: 200 }, data: data({ name: "Entrada", prompt: { system: p.entry?.prompt ?? "", outputFormat: "livre", examples: "" } }) },
    classifierNode({ x: 280, y: 200 }),
    consolidatorNode({ x: 900, y: 200 }),
    complianceNode({ x: 1180, y: 200 }),
    { id: "output", type: "output", position: { x: 1460, y: 200 }, data: data({ name: "Saída" }) },
  ];
  const edges: FlowEdge[] = [e("entry", "classifier"), e("consolidator", "compliance"), e("compliance", "consolidator"), e("compliance", "output")];
  return { nodes, edges, settings: flowSettings(defaultModelId) };
}

const e = (source: string, target: string): FlowEdge => ({ id: `${source}->${target}`, source, target });

function classifierNode(position: { x: number; y: number }): FlowNode {
  const p = presets().classifier;
  const c = (p?.config ?? {}) as Record<string, unknown>;
  return {
    id: "classifier",
    type: "classifier",
    position,
    data: data({
      name: p?.name ?? "Classificador",
      prompt: { system: p?.prompt ?? "", outputFormat: "livre", examples: "" },
      model: { modelId: null, temperature: 0, maxTokens: 4000, timeoutMs: 60000, maxCostUsd: 0.02, fallbackModelId: null },
      routing: {
        routingThreshold: Number(c.routing_threshold ?? 0.55),
        clarifyThreshold: Number(c.clarify_threshold ?? 0.35),
        maxSpecialists: Number(c.max_specialists ?? 3),
        exclusionTriggers: (c.exclusion_triggers as string[]) ?? ["familia", "penal"],
        defendantFastPath: c.defendant_fast_path !== false,
      },
    }),
  };
}

function consolidatorNode(position: { x: number; y: number }): FlowNode {
  const p = presets().consolidator;
  return {
    id: "consolidator",
    type: "consolidator",
    position,
    data: data({
      name: p?.name ?? "Consolidador",
      prompt: { system: p?.prompt ?? "", outputFormat: "livre", examples: "" },
      model: { modelId: null, temperature: 0.3, maxTokens: 4000, timeoutMs: 120000, maxCostUsd: 0.05, fallbackModelId: null },
      tools: { skills: ["gerar_documento", "verificar_citacao"], mcp: [] },
    }),
  };
}

function complianceNode(position: { x: number; y: number }): FlowNode {
  const p = presets().compliance;
  const c = (p?.config ?? {}) as Record<string, unknown>;
  return {
    id: "compliance",
    type: "compliance",
    position,
    data: data({
      name: p?.name ?? "Compliance",
      prompt: { system: p?.prompt ?? "", outputFormat: "livre", examples: "" },
      model: { modelId: null, temperature: 0, maxTokens: 1500, timeoutMs: 90000, maxCostUsd: 0.03, fallbackModelId: null },
      tools: { skills: ["checar_compliance", "verificar_citacao"], mcp: [] },
      rules: { guardrails: ((c.forbidden_terms as string[]) ?? []).map((t) => `Proibido: "${t}"`), checks: (c.required_checks as string[]) ?? [], escalation: [], zone: "amarela" },
      cycle: { maxCycles: Number(c.max_cycles ?? 2), requiredChecks: (c.required_checks as string[]) ?? ["disclaimer", "sem_promessa", "citacoes_verificadas", "zona", "lgpd"], safeResponse: String(c.safe_response ?? "") },
    }),
  };
}

export function specialistNode(s: SpecialtySeed, id: string, position: { x: number; y: number }): FlowNode {
  // Toda especialista busca na KB e confere citacao: sao as duas skills que
  // sustentam "nao inventa fundamento", entao entram mesmo que o catalogo omita.
  const skills = [...new Set(["buscar_kb", "verificar_citacao", ...s.default_skills])];
  return {
    id,
    type: "specialist",
    position,
    data: data({
      name: `${s.number} · ${s.name}`,
      description: s.scope,
      specialtyNumber: s.number,
      prompt: { system: s.default_prompt, outputFormat: "parecer", examples: "" },
      knowledge: { spaces: s.default_spaces, topK: 6, minTrust: "", asOf: "", verifiedOnly: true },
      tools: { skills, mcp: [] },
      rules: { guardrails: [], checks: [], escalation: s.escalation_rules, zone: s.zone },
    }),
  };
}

/** Fluxo com os especialistas dados, em layout de colunas legivel (a UI refaz com dagre). */
export function buildFlow(numbers: number[], chains: [number, number][], defaultModelId: string | null): FlowGraph {
  const g = emptyGraph(defaultModelId);
  const all = specialtySeeds();
  const specs = numbers.map((n) => all.find((s) => s.number === n)).filter((s): s is SpecialtySeed => !!s);
  const rowH = 90;
  const top = 200 - ((specs.length - 1) * rowH) / 2;
  const chainedTargets = new Set(chains.map(([, t]) => t));
  specs.forEach((s, i) => {
    // Especialista que so entra por encadeamento fica numa coluna a direita.
    const x = chainedTargets.has(s.number) && !s.routable ? 740 : 580;
    g.nodes.push(specialistNode(s, `sp-${s.number}`, { x, y: top + i * rowH }));
  });
  for (const s of specs) {
    if (s.routable) g.edges.push(e("classifier", `sp-${s.number}`));
    g.edges.push(e(`sp-${s.number}`, "consolidator"));
  }
  for (const [a, b] of chains) {
    if (specs.some((s) => s.number === a) && specs.some((s) => s.number === b)) g.edges.push(e(`sp-${a}`, `sp-${b}`));
  }
  return g;
}

// §5.2 do plano: 26 especialistas de merito + 5 (Encaminhamento).
export const FULL_FLOW = [5, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 45, 46, 47, 48, 50, 52, 53, 54];
export const FULL_CHAINS: [number, number][] = [
  [53, 52],
  [54, 29],
  [29, 52],
  [15, 23],
  [14, 23],
];
// Fase 1 da pesquisa (MAP §6): zona verde, modo orientacao.
export const PHASE1_FLOW = [14, 15, 16, 17, 19, 23, 52];
export const PHASE1_CHAINS: [number, number][] = [
  [15, 23],
  [14, 23],
];

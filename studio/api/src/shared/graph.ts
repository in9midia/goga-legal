// Contrato do grafo de agentes, compartilhado entre studio-api e studio-ui (a UI
// importa este arquivo pelo alias `@shared`). Tipos e schemas moram juntos para
// que o salvar do editor e a validacao do servidor nao possam divergir.
import { z } from "zod";

export const NODE_TYPES = ["entry", "classifier", "specialist", "consolidator", "compliance", "output"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const NODE_TYPE_LABEL: Record<NodeType, string> = {
  entry: "Entrada",
  classifier: "Classificador",
  specialist: "Especialista",
  consolidator: "Consolidador",
  compliance: "Compliance",
  output: "Saída",
};

export const DETERMINISTIC_CHECKS = [
  "disclaimer",
  "sem_promessa",
  "citacoes_verificadas",
  "zona",
  "lgpd",
] as const;

export const modelConfigSchema = z.object({
  // null = modelo padrao do fluxo. Deixar o no sem modelo proprio e o que
  // permite trocar o modelo de um fluxo de 30 nos num lugar so.
  modelId: z.string().uuid().nullable().default(null),
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().min(64).max(64000).default(2000),
  timeoutMs: z.number().int().min(1000).max(600000).default(90000),
  maxCostUsd: z.number().min(0).default(0.05),
  fallbackModelId: z.string().uuid().nullable().default(null),
});

export const nodeDataSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  specialtyNumber: z.number().int().nullable().default(null),
  model: modelConfigSchema.default(modelConfigSchema.parse({})),
  prompt: z
    .object({
      system: z.string().default(""),
      outputFormat: z.enum(["parecer", "livre"]).default("parecer"),
      examples: z.string().default(""),
    })
    .default({ system: "", outputFormat: "parecer", examples: "" }),
  knowledge: z
    .object({
      spaces: z.array(z.string()).default([]),
      topK: z.number().int().min(1).max(50).default(6),
      minTrust: z.string().default(""),
      asOf: z.string().default(""),
      verifiedOnly: z.boolean().default(true),
    })
    .default({ spaces: [], topK: 6, minTrust: "", asOf: "", verifiedOnly: true }),
  tools: z
    .object({
      skills: z.array(z.string()).default([]),
      // "servidor:tool", ex.: "goga-kb:search"
      mcp: z.array(z.string()).default([]),
    })
    .default({ skills: [], mcp: [] }),
  rules: z
    .object({
      guardrails: z.array(z.string()).default([]),
      checks: z.array(z.string()).default([]),
      escalation: z.array(z.string()).default([]),
      zone: z.enum(["verde", "amarela"]).default("verde"),
    })
    .default({ guardrails: [], checks: [], escalation: [], zone: "verde" }),
  routing: z
    .object({
      routingThreshold: z.number().min(0).max(1).default(0.55),
      clarifyThreshold: z.number().min(0).max(1).default(0.35),
      maxSpecialists: z.number().int().min(1).max(10).default(3),
      exclusionTriggers: z.array(z.string()).default(["familia", "penal"]),
      defendantFastPath: z.boolean().default(true),
    })
    .optional(),
  cycle: z
    .object({
      maxCycles: z.number().int().min(0).max(5).default(2),
      requiredChecks: z.array(z.string()).default([...DETERMINISTIC_CHECKS]),
      safeResponse: z.string().default(""),
    })
    .optional(),
});
export type NodeData = z.infer<typeof nodeDataSchema>;

export const flowNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(NODE_TYPES),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  data: nodeDataSchema,
});
export type FlowNode = z.infer<typeof flowNodeSchema>;

export const flowEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
});
export type FlowEdge = z.infer<typeof flowEdgeSchema>;

export const flowSettingsSchema = z.object({
  globalRules: z.string().default(""),
  disclaimer: z.string().default(""),
  language: z.string().default("pt-BR"),
  tone: z.string().default(""),
  defaultModelId: z.string().uuid().nullable().default(null),
  maxRunCostUsd: z.number().min(0).default(0.5),
});
export type FlowSettings = z.infer<typeof flowSettingsSchema>;

export const flowGraphSchema = z.object({
  nodes: z.array(flowNodeSchema),
  edges: z.array(flowEdgeSchema),
  settings: flowSettingsSchema.default(flowSettingsSchema.parse({})),
});
export type FlowGraph = z.infer<typeof flowGraphSchema>;

export interface GraphError {
  code: string;
  nodeId?: string;
  message: string;
}

export interface GraphContext {
  activeChatModelIds?: Set<string>;
  kbSpaces?: Set<string> | null; // null = KB fora do ar; nao valida bases
  skills?: Set<string>;
}

/** Validacao estrutural (padrao `{errors:[{code,nodeId,message}]}` do agentic-sdlc). */
export function validateGraph(graph: FlowGraph, ctx: GraphContext = {}): GraphError[] {
  const errors: GraphError[] = [];
  const byType = (t: NodeType) => graph.nodes.filter((n) => n.type === t);
  const ids = new Set(graph.nodes.map((n) => n.id));

  for (const [type, label] of [
    ["entry", "Entrada"],
    ["classifier", "Classificador"],
    ["consolidator", "Consolidador"],
    ["output", "Saída"],
  ] as const) {
    const count = byType(type).length;
    if (count !== 1) {
      errors.push({ code: `${type}_count`, message: `O fluxo precisa de exatamente 1 nó ${label} (tem ${count}).` });
    }
  }
  if (byType("compliance").length > 1) {
    errors.push({ code: "compliance_count", message: "No máximo 1 nó Compliance." });
  }
  if (byType("specialist").length === 0) {
    errors.push({ code: "no_specialist", message: "O fluxo precisa de ao menos 1 Especialista." });
  }

  const seenIds = new Set<string>();
  for (const n of graph.nodes) {
    if (seenIds.has(n.id)) errors.push({ code: "dup_node", nodeId: n.id, message: `Id de nó repetido: ${n.id}` });
    seenIds.add(n.id);
  }
  for (const e of graph.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) {
      errors.push({ code: "dangling_edge", message: `Aresta ${e.id} aponta para nó inexistente.` });
    }
  }

  // Alcancabilidade a partir da Entrada.
  const out = new Map<string, string[]>();
  for (const e of graph.edges) out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
  const entry = byType("entry")[0];
  const reach = new Set<string>();
  if (entry) {
    const stack = [entry.id];
    while (stack.length) {
      const id = stack.pop()!;
      if (reach.has(id)) continue;
      reach.add(id);
      stack.push(...(out.get(id) ?? []));
    }
  }
  for (const n of graph.nodes) {
    if (entry && !reach.has(n.id)) {
      errors.push({ code: "unreachable", nodeId: n.id, message: `"${n.data.name}" não é alcançável a partir da Entrada.` });
    }
  }

  // Ciclos: o unico permitido e Consolidador <-> Compliance.
  const typeOf = new Map(graph.nodes.map((n) => [n.id, n.type]));
  const allowedBack = (s: string, t: string) =>
    (typeOf.get(s) === "compliance" && typeOf.get(t) === "consolidator") ||
    (typeOf.get(s) === "consolidator" && typeOf.get(t) === "compliance");
  const color = new Map<string, number>();
  const dfs = (id: string): boolean => {
    color.set(id, 1);
    for (const t of out.get(id) ?? []) {
      if (allowedBack(id, t)) continue;
      const c = color.get(t) ?? 0;
      if (c === 1) {
        errors.push({ code: "cycle", nodeId: t, message: `Ciclo envolvendo "${nameOf(graph, t)}".` });
        return true;
      }
      if (c === 0 && dfs(t)) return true;
    }
    color.set(id, 2);
    return false;
  };
  for (const n of graph.nodes) if (!color.get(n.id)) dfs(n.id);

  for (const n of graph.nodes) {
    const m = n.data.model;
    if (ctx.activeChatModelIds) {
      for (const mid of [m.modelId, m.fallbackModelId]) {
        if (mid && !ctx.activeChatModelIds.has(mid)) {
          errors.push({ code: "model_inactive", nodeId: n.id, message: `"${n.data.name}": modelo inexistente ou inativo.` });
        }
      }
      const needsModel = ["classifier", "specialist", "consolidator", "compliance"].includes(n.type);
      if (needsModel && !m.modelId && !graph.settings.defaultModelId) {
        errors.push({ code: "model_missing", nodeId: n.id, message: `"${n.data.name}": sem modelo e o fluxo não tem modelo padrão.` });
      }
    }
    if (ctx.kbSpaces) {
      for (const s of n.data.knowledge.spaces) {
        if (!ctx.kbSpaces.has(s)) {
          errors.push({ code: "kb_space_missing", nodeId: n.id, message: `"${n.data.name}": base "${s}" não existe na KB.` });
        }
      }
    }
    if (ctx.skills) {
      for (const s of n.data.tools.skills) {
        if (!ctx.skills.has(s)) errors.push({ code: "skill_missing", nodeId: n.id, message: `"${n.data.name}": skill "${s}" desconhecida.` });
      }
    }
  }
  return errors;
}

function nameOf(graph: FlowGraph, id: string) {
  return graph.nodes.find((n) => n.id === id)?.data.name ?? id;
}

// ── Eventos do trace (SSE) ────────────────────────────────────────────────
export interface SpanRecord {
  id: string;
  runId: string;
  parentId: string | null;
  nodeId: string | null;
  kind: "run" | "agent" | "llm" | "tool" | "mcp" | "kb" | "guardrail" | "route";
  name: string;
  input: unknown;
  output: unknown;
  status: "running" | "ok" | "error" | "skipped";
  error: string | null;
  startedAt: string;
  ms: number | null;
  modelId: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  seq: number;
}

export type RunEvent =
  | { type: "span.start"; span: SpanRecord }
  | { type: "span.end"; span: SpanRecord }
  | { type: "token"; nodeId: string; text: string }
  | { type: "done"; runId: string; status: string; messageId?: string };

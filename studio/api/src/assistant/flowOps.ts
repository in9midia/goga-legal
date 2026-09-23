import { z } from "zod";
import { flowGraphSchema, nodeDataSchema, NODE_TYPES, type FlowGraph, type FlowNode } from "../shared/graph.js";

// Edicao de fluxo por operacoes, e nao "mande o grafo inteiro": um fluxo de 30
// nos com prompts longos passa de 100 mil caracteres, e o modelo reescrevendo
// tudo para mudar um campo erra (ou trunca) o resto. Cada operacao e pequena e
// o resultado passa pelo mesmo schema/validacao do editor.

export interface SpecialtyLike {
  number: number;
  name: string;
  scope: string;
  defaultPrompt: string;
  defaultSpaces: string[];
  defaultSkills: string[];
  escalationRules: string[];
  zone: string;
}

const patch = z.record(z.string(), z.unknown());

export const flowOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("adicionar_no"),
    tipo: z.enum(NODE_TYPES),
    id: z.string().optional().describe("id do nó; se omitido, é gerado"),
    especialidade: z.number().int().optional().describe("nº da especialidade do catálogo: preenche nome, prompt, bases, skills e regras a partir dela"),
    dados: patch.optional().describe("campos de data do nó (mesmo formato de ler_no), aplicados por cima dos padrões"),
    conectar: z.boolean().default(true).describe("especialista: liga Classificador → nó → Consolidador automaticamente"),
  }),
  z.object({
    op: z.literal("alterar_no"),
    no: z.string().describe("id do nó"),
    dados: patch.describe("merge profundo em data: objetos se mesclam, listas e textos são substituídos"),
  }),
  z.object({ op: z.literal("remover_no"), no: z.string() }),
  z.object({ op: z.literal("ligar"), de: z.string(), para: z.string() }),
  z.object({ op: z.literal("desligar"), de: z.string(), para: z.string() }),
  z.object({
    op: z.literal("substituir_texto"),
    no: z.string().describe('id do nó, ou "configuracoes" para as configurações do fluxo'),
    campo: z.string().describe('caminho do texto, ex.: "prompt.system", "description"; em configuracoes: "globalRules", "disclaimer", "tone"'),
    trecho: z.string().min(1).describe("texto atual EXATO a trocar (copie de ler_no); precisa aparecer uma única vez"),
    novo: z.string().describe("texto que entra no lugar (vazio = apagar o trecho)"),
  }),
  z.object({
    op: z.literal("acrescentar_texto"),
    no: z.string().describe('id do nó, ou "configuracoes"'),
    campo: z.string().describe('ex.: "prompt.system", "globalRules"'),
    texto: z.string().min(1),
    posicao: z.enum(["fim", "inicio"]).default("fim"),
  }),
  z.object({
    op: z.literal("definir_campo"),
    nos: z.array(z.string()).min(1).describe('ids de nós; aceita também "tipo:specialist" (todos de um tipo) e "*" (todos)'),
    caminho: z.string().describe('caminho em data, ex.: "model.maxTokens", "model.temperature", "knowledge.topK", "rules.zone"'),
    valor: z.unknown(),
  }),
  z.object({ op: z.literal("alterar_configuracoes"), dados: patch.describe("merge em settings: globalRules, disclaimer, language, tone, defaultModelId, maxRunCostUsd") }),
  z.object({ op: z.literal("renomear_fluxo"), nome: z.string().optional(), descricao: z.string().optional() }),
]);
export type FlowOp = z.infer<typeof flowOpSchema>;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function deepMerge(base: unknown, p: unknown): unknown {
  if (!isObj(base) || !isObj(p)) return p;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(p)) out[k] = deepMerge(base[k], v);
  return out;
}

const pathGet = (obj: unknown, path: string) => path.split(".").reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), obj);

function pathSet(obj: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isObj(cur[k])) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}

const count = (hay: string, needle: string) => hay.split(needle).length - 1;

export function applyFlowOps(
  input: FlowGraph,
  ops: FlowOp[],
  meta: { name: string; description: string },
  specialties: SpecialtyLike[],
): { graph: FlowGraph; name: string; description: string; log: string[] } {
  const g: FlowGraph = structuredClone(input);
  let { name, description } = meta;
  const log: string[] = [];
  const node = (id: string) => {
    const n = g.nodes.find((x) => x.id === id);
    if (!n) throw new Error(`nó "${id}" não existe (ids: ${g.nodes.map((x) => x.id).join(", ")})`);
    return n;
  };
  const link = (source: string, target: string) => {
    if (!g.edges.some((e) => e.source === source && e.target === target)) g.edges.push({ id: `${source}->${target}`, source, target });
  };

  ops.forEach((op, i) => {
    const at = `operação ${i + 1} (${op.op})`;
    try {
      switch (op.op) {
        case "adicionar_no": {
          const s = op.especialidade !== undefined ? specialties.find((x) => x.number === op.especialidade) : undefined;
          if (op.especialidade !== undefined && !s) throw new Error(`especialidade nº ${op.especialidade} não existe`);
          let id = op.id ?? (s ? `sp-${s.number}` : `${op.tipo}-${Math.random().toString(36).slice(2, 7)}`);
          if (g.nodes.some((n) => n.id === id)) {
            if (op.id) throw new Error(`já existe nó com id "${id}"`);
            id = `${id}-${Math.random().toString(36).slice(2, 5)}`;
          }
          const base = s
            ? {
                name: `${s.number} · ${s.name}`,
                description: s.scope,
                specialtyNumber: s.number,
                prompt: { system: s.defaultPrompt, outputFormat: "parecer", examples: "" },
                knowledge: { spaces: s.defaultSpaces },
                tools: { skills: [...new Set(["buscar_kb", "verificar_citacao", ...s.defaultSkills])], mcp: [] },
                rules: { escalation: s.escalationRules, zone: s.zone === "amarela" ? "amarela" : "verde" },
              }
            : {
                name: op.tipo === "specialist" ? "Novo especialista" : op.tipo === "compliance" ? "Compliance" : "Novo nó",
                cycle: op.tipo === "compliance" ? {} : undefined,
                routing: op.tipo === "classifier" ? {} : undefined,
              };
          const data = nodeDataSchema.parse(deepMerge(base, op.dados ?? {}));
          const cls = g.nodes.find((n) => n.type === "classifier");
          const position = { x: (cls?.position.x ?? 300) + 300, y: (cls?.position.y ?? 200) + 90 * (g.nodes.filter((n) => n.type === "specialist").length % 8) - 200 };
          g.nodes.push({ id, type: op.tipo, position, data });
          if (op.tipo === "specialist" && op.conectar) {
            const consolidator = g.nodes.find((n) => n.type === "consolidator");
            if (cls) link(cls.id, id);
            if (consolidator) link(id, consolidator.id);
          }
          log.push(`nó "${data.name}" (${id}) adicionado`);
          break;
        }
        case "alterar_no": {
          const n = node(op.no);
          n.data = nodeDataSchema.parse(deepMerge(n.data, op.dados));
          log.push(`nó "${n.data.name}" (${n.id}) alterado: ${Object.keys(op.dados).join(", ")}`);
          break;
        }
        case "remover_no": {
          const n = node(op.no);
          g.nodes = g.nodes.filter((x) => x.id !== n.id);
          g.edges = g.edges.filter((e) => e.source !== n.id && e.target !== n.id);
          log.push(`nó "${n.data.name}" (${n.id}) removido com suas ligações`);
          break;
        }
        case "ligar":
          node(op.de);
          node(op.para);
          link(op.de, op.para);
          log.push(`ligação ${op.de} → ${op.para}`);
          break;
        case "desligar": {
          const before = g.edges.length;
          g.edges = g.edges.filter((e) => !(e.source === op.de && e.target === op.para));
          if (g.edges.length === before) throw new Error(`não há ligação ${op.de} → ${op.para}`);
          log.push(`ligação ${op.de} → ${op.para} removida`);
          break;
        }
        case "substituir_texto":
        case "acrescentar_texto": {
          const target = op.no === "configuracoes" ? (g.settings as Record<string, unknown>) : (node(op.no).data as Record<string, unknown>);
          const label = op.no === "configuracoes" ? "configurações" : `nó "${node(op.no).data.name}"`;
          const cur = pathGet(target, op.campo);
          if (typeof cur !== "string") throw new Error(`${label}: "${op.campo}" não é um campo de texto`);
          let next: string;
          if (op.op === "acrescentar_texto") {
            next = op.posicao === "inicio" ? `${op.texto}\n\n${cur}` : `${cur.replace(/\s+$/, "")}\n\n${op.texto}`;
          } else {
            const n = count(cur, op.trecho);
            if (n === 0) throw new Error(`${label}: trecho não encontrado em "${op.campo}" (copie-o exatamente como está em ler_no, com a mesma pontuação e quebras de linha)`);
            if (n > 1) throw new Error(`${label}: o trecho aparece ${n} vezes em "${op.campo}"; inclua mais contexto para ficar único`);
            next = cur.replace(op.trecho, () => op.novo);
          }
          pathSet(target, op.campo, next);
          if (op.no === "configuracoes") g.settings = flowGraphSchema.shape.settings.parse(target);
          else node(op.no).data = nodeDataSchema.parse(target);
          log.push(`${label}: ${op.campo} ${op.op === "acrescentar_texto" ? "recebeu texto" : "teve um trecho substituído"} (${cur.length} → ${next.length} caracteres)`);
          break;
        }
        case "definir_campo": {
          const ids = new Set<string>();
          for (const sel of op.nos) {
            if (sel === "*") g.nodes.forEach((n) => ids.add(n.id));
            else if (sel.startsWith("tipo:")) {
              const hits = g.nodes.filter((n) => n.type === sel.slice(5));
              if (!hits.length) throw new Error(`nenhum nó do tipo "${sel.slice(5)}"`);
              hits.forEach((n) => ids.add(n.id));
            } else ids.add(node(sel).id);
          }
          for (const id of ids) {
            const n = node(id);
            const data = structuredClone(n.data) as Record<string, unknown>;
            pathSet(data, op.caminho, op.valor);
            n.data = nodeDataSchema.parse(data);
          }
          log.push(`${op.caminho} = ${JSON.stringify(op.valor)} em ${ids.size} nó(s)`);
          break;
        }
        case "alterar_configuracoes":
          g.settings = flowGraphSchema.shape.settings.parse(deepMerge(g.settings, op.dados));
          log.push(`configurações alteradas: ${Object.keys(op.dados).join(", ")}`);
          break;
        case "renomear_fluxo":
          if (op.nome) name = op.nome;
          if (op.descricao !== undefined) description = op.descricao;
          log.push("nome/descrição alterados");
          break;
      }
    } catch (err) {
      const msg = err instanceof z.ZodError ? err.issues.slice(0, 5).map((x) => `${x.path.join(".")}: ${x.message}`).join("; ") : (err as Error).message;
      throw new Error(`${at}: ${msg}`);
    }
  });
  return { graph: flowGraphSchema.parse(g), name, description, log };
}

/** Visao compacta do fluxo: o bastante para decidir o que mudar, sem os prompts inteiros. */
export function flowSummary(graph: FlowGraph, modelLabel: (id: string | null) => string) {
  const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n)}… (${s.length} caracteres)` : s);
  return {
    configuracoes: {
      ...graph.settings,
      defaultModel: modelLabel(graph.settings.defaultModelId),
      globalRules: clip(graph.settings.globalRules, 400),
      disclaimer: clip(graph.settings.disclaimer, 200),
    },
    nos: graph.nodes.map((n: FlowNode) => ({
      id: n.id,
      tipo: n.type,
      nome: n.data.name,
      especialidade: n.data.specialtyNumber,
      modelo: n.data.model.modelId ? modelLabel(n.data.model.modelId) : "(padrão do fluxo)",
      temperatura: n.data.model.temperature,
      maxTokens: n.data.model.maxTokens,
      prompt: clip(n.data.prompt.system),
      bases: n.data.knowledge.spaces,
      skills: n.data.tools.skills,
      mcp: n.data.tools.mcp,
      guardrails: n.data.rules.guardrails.length,
      zona: n.data.rules.zone,
      ...(n.data.routing ? { roteamento: n.data.routing } : {}),
      ...(n.data.cycle ? { ciclo: { ...n.data.cycle, safeResponse: clip(n.data.cycle.safeResponse, 120) } } : {}),
    })),
    ligacoes: graph.edges.map((e) => `${e.source} → ${e.target}`),
  };
}

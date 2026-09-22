import { jsonSchema, tool, type ToolSet } from "ai";
import { z } from "zod";
import type { FlowNode } from "../shared/graph.js";
import type { RunContext } from "../engine/context.js";
import * as kb from "../kb/client.js";
import { callTool } from "../mcp/client.js";
import { seedChecklists, seedTemplates } from "../seed/files.js";
import { saveFile } from "../files/storage.js";
import { renderTemplate, toDocx, toPdf } from "../files/documents.js";
import { calcularCorrecao, calcularPrazo, elegibilidadeJuizado, PRAZOS, type TipoPrazo } from "./legal.js";
import { getIndices, latest } from "./indices.js";
import { verifyCitations } from "./citations.js";
import { checkCompliance } from "./compliance.js";

export interface SkillEnv {
  ctx: RunContext;
  node: FlowNode;
  parentId: string | null;
}

interface SkillDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  id: string;
  name: string;
  description: string;
  input: S;
  /** Pode ser oferecida ao modelo como tool. As demais o motor chama sozinho. */
  llmTool: boolean;
  run(input: z.infer<S>, env: SkillEnv): Promise<unknown>;
}

const def = <S extends z.ZodTypeAny>(d: SkillDef<S>) => d as unknown as SkillDef;

/** Espacos efetivos: o que o modelo pediu, recortado pelo que o no permite. */
function scopeSpaces(requested: string[] | undefined, node: FlowNode): string[] {
  const allowed = node.data.knowledge.spaces;
  if (!requested?.length) return allowed;
  const r = requested.filter((s) => allowed.includes(s));
  // Pedido fora do escopo do no NAO amplia: cai para o escopo inteiro do no.
  return r.length ? r : allowed;
}

export const SKILLS: SkillDef[] = [
  def({
    id: "buscar_kb",
    name: "Buscar na KB",
    description: "Busca híbrida na base de conhecimento, restrita às bases configuradas no nó. Devolve trechos com documento, página e score.",
    input: z.object({ consulta: z.string().min(2), bases: z.array(z.string()).optional(), top_k: z.number().int().min(1).max(20).optional() }),
    llmTool: true,
    async run(i, { node }) {
      const k = node.data.knowledge;
      const spaces = scopeSpaces(i.bases, node);
      if (!spaces.length) return { resultados: [], aviso: "nó sem bases de conhecimento configuradas" };
      const r = await kb.search({ query: i.consulta, spaces, top_k: i.top_k ?? k.topK, min_trust: k.minTrust || undefined, as_of: k.asOf || undefined });
      return {
        resultados: r.results.map((p) => ({
          document_id: p.document_id,
          base: p.space,
          titulo: p.title,
          pagina: p.page,
          score: p.score,
          armadilha: p.armadilha ?? null,
          trecho: p.content.slice(0, 1500),
        })),
      };
    },
  }),
  def({
    id: "buscar_documento_kb",
    name: "Abrir documento da KB",
    description: "Abre o documento completo da KB pelo id devolvido por buscar_kb.",
    input: z.object({ document_id: z.number().int() }),
    llmTool: true,
    async run(i, { node }) {
      const doc = await kb.fetchDocument(i.document_id);
      const space = String(doc.space ?? doc.space_slug ?? "");
      if (space && node.data.knowledge.spaces.length && !node.data.knowledge.spaces.includes(space)) {
        return { erro: `documento pertence à base "${space}", fora do escopo deste agente` };
      }
      const content = String(doc.content ?? doc.canonical ?? doc.markdown ?? "");
      return { ...doc, content: content.slice(0, 12000), truncado: content.length > 12000 };
    },
  }),
  def({
    id: "verificar_citacao",
    name: "Verificar citações",
    description: "Extrai citações (lei, súmula, tema, REsp…) do texto e confere se estão VERIFICADAS na auditoria/KB. Bloqueia as EM VERIFICAÇÃO.",
    input: z.object({ texto: z.string() }),
    llmTool: false,
    async run(i, { node }) {
      return { citacoes: await verifyCitations(i.texto, node.data.knowledge.spaces) };
    },
  }),
  def({
    id: "calcular_prazo",
    name: "Calcular prazo",
    description: `Prescrição/decadência a partir da data de início. Tipos: ${Object.keys(PRAZOS).join(", ")}.`,
    input: z.object({ tipo: z.enum(Object.keys(PRAZOS) as [TipoPrazo, ...TipoPrazo[]]), data_inicio: z.string().describe("AAAA-MM-DD") }),
    llmTool: true,
    async run(i) {
      return calcularPrazo(i);
    },
  }),
  def({
    id: "calcular_correcao",
    name: "Calcular correção e juros",
    description: "Correção monetária pelo IPCA e juros pela taxa legal (Selic − IPCA, Lei 14.905/2024), com tabela oficial do BCB.",
    input: z.object({
      valor: z.number().positive(),
      data_inicial: z.string().describe("AAAA-MM-DD"),
      data_final: z.string().optional(),
      juros: z.boolean().default(true),
      data_juros: z.string().optional().describe("início dos juros, AAAA-MM-DD (citação/evento danoso)"),
    }),
    llmTool: true,
    async run(i) {
      return calcularCorrecao(i, await getIndices());
    },
  }),
  def({
    id: "elegibilidade_juizado",
    name: "Elegibilidade de juizado",
    description: "Diz se a causa cabe no JEC (40 SM), JEF (60 SM) ou Juizado da Fazenda (60 SM), pelo valor e pelo réu. Salário mínimo vigente vem do BCB.",
    input: z.object({ valor_causa: z.number().nonnegative(), reu: z.enum(["particular", "empresa", "uniao_autarquia_federal", "estado_municipio"]) }),
    llmTool: true,
    async run(i) {
      const sm = latest((await getIndices()).salarioMinimo);
      return elegibilidadeJuizado({ ...i, salario_minimo: sm.value, sm_referencia: sm.month });
    },
  }),
  def({
    id: "ler_anexo",
    name: "Ler anexo",
    description: "Texto extraído de um anexo enviado na conversa (por id ou nome).",
    input: z.object({ anexo: z.string().describe("id ou nome do arquivo") }),
    llmTool: true,
    async run(i, { ctx }) {
      const f = ctx.files.find((x) => x.id === i.anexo || x.name === i.anexo) ?? ctx.files.find((x) => x.name.toLowerCase().includes(i.anexo.toLowerCase()));
      if (!f) return { erro: "anexo não encontrado", disponiveis: ctx.files.map((x) => x.name) };
      return { nome: f.name, texto: f.text.slice(0, 20000), truncado: f.text.length > 20000 };
    },
  }),
  def({
    id: "checklist_documental",
    name: "Checklist documental",
    description: "Lista de documentos necessários por tipo de caso.",
    input: z.object({ tipo_caso: z.string() }),
    llmTool: true,
    async run(i) {
      const all = seedChecklists();
      const c = all[i.tipo_caso];
      if (!c) return { erro: "tipo de caso desconhecido", tipos: Object.keys(all) };
      return c;
    },
  }),
  def({
    id: "gerar_documento",
    name: "Gerar documento",
    description: "Gera DOCX e PDF a partir de um modelo (reclamação, notificação, resumo do caso, parecer) e dos campos preenchidos.",
    input: z.object({
      modelo: z.string(),
      campos: z.record(z.string(), z.string()).default({}),
      formato: z.enum(["docx", "pdf", "ambos"]).default("ambos"),
    }),
    llmTool: false,
    async run(i, { ctx }) {
      const tpl = seedTemplates().find((t) => t.slug === i.modelo);
      if (!tpl) return { erro: "modelo desconhecido", modelos: seedTemplates().map((t) => t.slug) };
      const { text, missing } = renderTemplate(tpl.corpo_markdown, { data: new Date().toLocaleDateString("pt-BR"), ...i.campos });
      const base = tpl.slug;
      const out: { fileId: string; name: string }[] = [];
      if (i.formato !== "pdf") {
        const f = await saveFile({ sessionId: ctx.sessionId, runId: ctx.runId, direction: "out", name: `${base}.docx`, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data: await toDocx(text), extractedText: text });
        ctx.generated.push({ fileId: f.id, name: f.name, mime: f.mime, template: base });
        out.push({ fileId: f.id, name: f.name });
      }
      if (i.formato !== "docx") {
        const f = await saveFile({ sessionId: ctx.sessionId, runId: ctx.runId, direction: "out", name: `${base}.pdf`, mime: "application/pdf", data: await toPdf(text), extractedText: text });
        ctx.generated.push({ fileId: f.id, name: f.name, mime: f.mime, template: base });
        out.push({ fileId: f.id, name: f.name });
      }
      return { modelo: tpl.titulo, arquivos: out, campos_faltantes: missing };
    },
  }),
  def({
    id: "checar_compliance",
    name: "Checar compliance",
    description: "Checagens determinísticas: disclaimer presente, sem promessa de resultado nem percentual de êxito, zona, LGPD.",
    input: z.object({ texto: z.string(), checks: z.array(z.string()).optional() }),
    llmTool: false,
    async run(i, { ctx, node }) {
      const checks = i.checks ?? node.data.cycle?.requiredChecks ?? ["disclaimer", "sem_promessa", "zona", "lgpd"];
      return { resultados: checkCompliance(i.texto, { disclaimer: ctx.graph.settings.disclaimer, checks }) };
    },
  }),
];

export const skillById = new Map(SKILLS.map((s) => [s.id, s]));

/** Executa uma skill como span `tool` do trace. */
export async function runSkill(id: string, input: unknown, env: SkillEnv): Promise<unknown> {
  const s = skillById.get(id);
  if (!s) throw new Error(`skill desconhecida: ${id}`);
  return env.ctx.tracer.wrap({ kind: id.includes("kb") ? "kb" : "tool", name: `skill · ${s.name}`, parentId: env.parentId, nodeId: env.node.id, input }, async () => s.run(s.input.parse(input), env));
}

/** Tools para o modelo: skills marcadas como `llmTool` + tools MCP do no. */
export function toolsFor(env: SkillEnv, mcpTools: { server: string; name: string; description?: string; inputSchema: Record<string, unknown> }[] = []): ToolSet {
  const set: ToolSet = {};
  for (const id of env.node.data.tools.skills) {
    const s = skillById.get(id);
    if (!s?.llmTool) continue;
    set[id] = tool({
      description: s.description,
      inputSchema: s.input,
      execute: async (input: unknown) => {
        try {
          return await runSkill(id, input, env);
        } catch (err) {
          // Erro volta ao modelo como resultado, nao como excecao: ele pode
          // corrigir o argumento (data em formato errado e o caso tipico).
          return { erro: (err as Error).message };
        }
      },
    });
  }
  for (const t of mcpTools) {
    const key = `${t.server.replace(/[^a-z0-9]/gi, "_")}__${t.name}`;
    set[key] = tool({
      description: `[MCP ${t.server}] ${t.description ?? t.name}`,
      inputSchema: jsonSchemaOf(t.inputSchema),
      execute: async (args: unknown) =>
        env.ctx.tracer
          .wrap({ kind: "mcp", name: `mcp · ${t.server}.${t.name}`, parentId: env.parentId, nodeId: env.node.id, input: args }, () =>
            callTool(t.server, t.name, restrictMcpArgs(t, args as Record<string, unknown>, env.node)),
          )
          .catch((err: Error) => ({ erro: err.message })),
    });
  }
  return set;
}

// A busca do MCP da KB aceita `spaces`; sem este recorte o modelo poderia
// buscar em qualquer base, e o escopo configurado no no viraria sugestao.
function restrictMcpArgs(t: { server: string; name: string }, args: Record<string, unknown>, node: FlowNode) {
  if (t.server === "goga-kb" && t.name === "search") {
    return { ...args, spaces: scopeSpaces(args.spaces as string[] | undefined, node) };
  }
  return args;
}

function jsonSchemaOf(s: Record<string, unknown>) {
  return jsonSchema(s as never);
}

export function skillCatalog() {
  return SKILLS.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    inputSchema: z.toJSONSchema(s.input, { unrepresentable: "any" }),
    kind: "builtin",
    llmTool: s.llmTool,
  }));
}

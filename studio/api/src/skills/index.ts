import { jsonSchema, tool, type ToolSet } from "ai";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { flowNodeSchema, flowSettingsSchema, type FlowNode } from "../shared/graph.js";
import type { RunContext } from "../engine/context.js";
import { decrypt } from "../lib/crypto.js";
import * as kb from "../kb/client.js";
import { callTool } from "../mcp/client.js";
import { seedChecklists } from "../seed/files.js";
import { activeTemplates } from "../files/templates.js";
import { saveFile } from "../files/storage.js";
import { renderTemplate, toDocx, toPdf } from "../files/documents.js";
import { calcularCorrecao, calcularPrazo, elegibilidadeJuizado, PRAZOS, type TipoPrazo } from "./legal.js";
import { getIndices, latest } from "./indices.js";
import { verifyCitations } from "./citations.js";
import { checkCompliance } from "./compliance.js";

export type SkillRow = typeof schema.skill.$inferSelect;

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

/** Skills com implementacao no codigo ("builtin"). Texto e liga/desliga vem do banco. */
export const SKILLS: SkillDef[] = [
  def({
    id: "buscar_kb",
    name: "Buscar na KB",
    description: "Busca híbrida na base de conhecimento, restrita às bases configuradas no nó. Devolve trechos com documento, página e score.",
    input: z.object({ consulta: z.string().min(2), bases: z.array(z.string()).optional(), top_k: z.number().int().min(1).max(20).optional() }),
    llmTool: true,
    async run(i, { node, ctx }) {
      const k = node.data.knowledge;
      const spaces = scopeSpaces(i.bases, node);
      if (!spaces.length) return { resultados: [], aviso: "nó sem bases de conhecimento configuradas" };
      const r = await kb.search({ query: i.consulta, spaces, top_k: i.top_k ?? k.topK, min_trust: k.minTrust || undefined, as_of: k.asOf || undefined });
      ctx.kbDocIds ??= new Set();
      for (const p of r.results) ctx.kbDocIds.add(p.document_id);
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
    description: "Abre o documento completo da KB. Use SOMENTE um document_id que apareceu nas evidências ou num resultado de buscar_kb; nunca invente um id.",
    input: z.object({ document_id: z.number().int() }),
    llmTool: true,
    async run(i, { node, ctx }) {
      // O modelo inventa id (0, 1...) quando a busca veio vazia: recusa aqui,
      // sem ir a KB, e diz o que fazer.
      if (!ctx.kbDocIds?.has(i.document_id)) {
        return { erro: `document_id ${i.document_id} não veio de nenhuma busca nesta execução. Chame buscar_kb primeiro e use um id dos resultados; se não houver resultado útil, siga sem abrir documento.` };
      }
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
      const all = await activeTemplates();
      const tpl = all.find((t) => t.slug === i.modelo);
      if (!tpl) return { erro: "modelo desconhecido ou desativado", modelos: all.map((t) => t.slug) };
      const { text, missing } = renderTemplate(tpl.body, { data: new Date().toLocaleDateString("pt-BR"), ...i.campos });
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
      return { modelo: tpl.title, arquivos: out, campos_faltantes: missing };
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
export const BUILTIN_IDS = new Set(SKILLS.map((s) => s.id));

/** Precisam de uma execucao de verdade (anexos, arquivos gerados): nao testam isoladas. */
export const UNTESTABLE = new Set(["ler_anexo", "gerar_documento"]);

export async function loadSkills(): Promise<Map<string, SkillRow>> {
  return new Map((await db.select().from(schema.skill)).map((r) => [r.id, r]));
}

async function rowsOf(ctx: RunContext) {
  ctx.skills ??= await loadSkills();
  return ctx.skills;
}

/** Skills do no que existem e estao ligadas. Desligar uma skill a tira de todos os agentes. */
export async function activeSkills(ctx: RunContext, node: FlowNode): Promise<SkillRow[]> {
  const rows = await rowsOf(ctx);
  return node.data.tools.skills.map((id) => rows.get(id)).filter((r): r is SkillRow => !!r?.enabled);
}

export async function hasSkill(ctx: RunContext, node: FlowNode, id: string) {
  return (await activeSkills(ctx, node)).some((r) => r.id === id);
}

/** Bloco do prompt com as instrucoes das skills ativas do no (corpo das skills "prompt"). */
export async function skillsPrompt(ctx: RunContext, node: FlowNode): Promise<string> {
  const parts = (await activeSkills(ctx, node))
    .filter((r) => r.instructions.trim())
    .map((r) => `### ${r.name} (${r.id})\n${r.instructions.trim()}`);
  return parts.length ? `\n\n## Skills\n${parts.join("\n\n")}` : "";
}

/** Executa a skill sem trace. `runSkill` e o teste isolado passam por aqui. */
async function execSkill(row: SkillRow | undefined, id: string, input: unknown, env: SkillEnv): Promise<unknown> {
  const code = skillById.get(id);
  if (code && (!row || row.kind === "builtin")) return code.run(code.input.parse(input), env);
  if (!row) throw new Error(`skill desconhecida: ${id}`);
  if (row.kind === "http") return callHttpSkill(row, input);
  // Skill de instrucoes nao executa: o texto dela vai no prompt.
  return { instrucoes: row.instructions };
}

export function skillHeaders(row: Pick<SkillRow, "secretEnc">): Record<string, string> {
  return row.secretEnc ? (JSON.parse(decrypt(row.secretEnc)) as Record<string, string>) : {};
}

async function callHttpSkill(row: SkillRow, input: unknown): Promise<unknown> {
  const cfg = row.config as { url?: string; method?: string; timeoutMs?: number };
  if (!cfg.url) throw new Error(`skill "${row.id}" sem URL configurada`);
  const method = (cfg.method ?? "POST").toUpperCase();
  const url = new URL(cfg.url);
  if (method === "GET") for (const [k, v] of Object.entries((input ?? {}) as Record<string, unknown>)) url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
  const res = await fetch(url, {
    method,
    headers: { ...(method === "GET" ? {} : { "content-type": "application/json" }), ...skillHeaders(row) },
    body: method === "GET" ? undefined : JSON.stringify(input ?? {}),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 20_000);
  }
}

/** Executa uma skill como span `tool` do trace. */
export async function runSkill(id: string, input: unknown, env: SkillEnv): Promise<unknown> {
  const row = (await rowsOf(env.ctx)).get(id);
  if (!row && !skillById.has(id)) throw new Error(`skill desconhecida: ${id}`);
  // O nome do span leva o id, e nao o nome de exibicao: o nome e editavel e as
  // estatisticas de uso agregam por ele.
  return env.ctx.tracer.wrap({ kind: id.includes("kb") ? "kb" : "tool", name: `skill · ${id}`, parentId: env.parentId, nodeId: env.node.id, input }, async () => execSkill(row, id, input, env));
}

/** Teste isolado (tela de skills): no ficticio com as bases pedidas, sem trace nem arquivos. */
export async function testSkill(row: SkillRow, input: unknown, spaces: string[]) {
  if (UNTESTABLE.has(row.id)) throw new Error("esta skill depende de uma conversa (anexos ou arquivos gerados); teste pelo Simulador");
  const node = flowNodeSchema.parse({ id: "teste", type: "specialist", data: { name: "Teste de skill", knowledge: { spaces }, tools: { skills: [row.id] } } });
  const ctx = { skills: new Map([[row.id, row]]), files: [], generated: [], graph: { nodes: [node], edges: [], settings: flowSettingsSchema.parse({}) } } as unknown as RunContext;
  return execSkill(row, row.id, input, { ctx, node, parentId: null });
}

/** Tools para o modelo: skills ligadas com `llmTool` + tools MCP do no. */
export async function toolsFor(env: SkillEnv, mcpTools: { server: string; name: string; description?: string; inputSchema: Record<string, unknown> }[] = []): Promise<ToolSet> {
  const set: ToolSet = {};
  for (const row of await activeSkills(env.ctx, env.node)) {
    if (!row.llmTool || row.kind === "prompt") continue;
    const code = skillById.get(row.id);
    if (row.kind === "builtin" && !code) continue;
    set[row.id] = tool({
      description: row.description,
      inputSchema: row.kind === "builtin" ? code!.input : jsonSchemaOf(row.inputSchema as Record<string, unknown>),
      execute: async (input: unknown) => {
        try {
          return await runSkill(row.id, input, env);
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
    kind: "builtin" as const,
    llmTool: s.llmTool,
  }));
}

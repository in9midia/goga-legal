import type { FastifyInstance } from "fastify";
import { asc, eq, inArray, sql, and } from "drizzle-orm";
import { z, ZodError } from "zod";
import { db, schema } from "../db/index.js";
import { audit } from "../lib/audit.js";
import { requireAdmin, requireUser } from "../lib/auth.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { encrypt } from "../lib/crypto.js";
import { flowsUsing, spanStats } from "../lib/usage.js";
import { BUILTIN_IDS, skillHeaders, testSkill, UNTESTABLE, type SkillRow } from "../skills/index.js";

// Skills sao cadastro: as "builtin" tem codigo por tras (so texto e liga/desliga
// mudam), as "prompt" sao instrucoes injetadas no prompt (formato SKILL.md) e
// as "http" chamam um endpoint com o JSON que o modelo montar.

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const EMPTY_SCHEMA = { type: "object", properties: {}, additionalProperties: false };

const objectSchema = z
  .record(z.string(), z.unknown())
  .refine((s) => s.type === "object", "o esquema de entrada precisa ser um JSON Schema com type: \"object\"");

const httpConfig = z.object({
  url: z.string().url(),
  method: z.enum(["POST", "GET", "PUT"]).default("POST"),
  timeoutMs: z.number().int().min(1000).max(120_000).default(15_000),
});

const createBody = z.object({
  id: z.string().regex(ID_RE, "id: minúsculas, números, _ ou -, de 2 a 63 caracteres"),
  kind: z.enum(["prompt", "http"]),
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  instructions: z.string().default(""),
  inputSchema: objectSchema.optional(),
  llmTool: z.boolean().default(true),
  enabled: z.boolean().default(true),
  config: httpConfig.optional(),
  headers: z.record(z.string(), z.string()).optional(),
  source: z.string().default("criada no Studio"),
});

const updateBody = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    instructions: z.string(),
    enabled: z.boolean(),
    llmTool: z.boolean(),
    inputSchema: objectSchema,
    config: httpConfig,
    // undefined = mantem; {} = remove todos.
    headers: z.record(z.string(), z.string()),
  })
  .partial();

type CreateBody = z.infer<typeof createBody>;

/** O que sai da API: sem o segredo, so os nomes dos cabecalhos. */
function publicSkill(r: SkillRow) {
  const { secretEnc, ...rest } = r;
  let headerNames: string[] = [];
  try {
    headerNames = Object.keys(skillHeaders(r));
  } catch {
    headerNames = secretEnc ? ["(ilegível — chave STUDIO_SECRET_KEY mudou?)"] : [];
  }
  return { ...rest, headerNames, testable: !UNTESTABLE.has(r.id) };
}

function valuesFor(b: CreateBody) {
  if (b.kind === "http" && !b.config) throw badRequest("skill HTTP precisa de URL");
  if (b.kind === "prompt" && !b.instructions.trim()) throw badRequest("skill de instruções precisa de um corpo (as instruções)");
  return {
    id: b.id,
    kind: b.kind,
    name: b.name,
    description: b.description,
    instructions: b.instructions,
    inputSchema: b.kind === "http" ? (b.inputSchema ?? EMPTY_SCHEMA) : EMPTY_SCHEMA,
    llmTool: b.kind === "http" ? b.llmTool : false,
    enabled: b.enabled,
    config: b.kind === "http" ? b.config! : {},
    secretEnc: b.kind === "http" && filled(b.headers) ? encrypt(JSON.stringify(filled(b.headers))) : "",
    source: b.source,
  };
}

/** Cabecalhos com valor; nenhum = null. */
function filled(h: Record<string, string> | undefined) {
  const f = Object.fromEntries(Object.entries(h ?? {}).filter(([, v]) => v));
  return Object.keys(f).length ? f : null;
}

const usesSkill = (id: string) => (n: { data: { tools: { skills: string[] } } }) => n.data.tools.skills.includes(id);

// ── Instalacao: SKILL.md (formato Agent Skills) ou pacote JSON ────────────

function slug(s: string) {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

const humanize = (s: string) => {
  const t = s.replace(/[-_]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** Frontmatter YAML simples (chave: valor, aspas opcionais, `>`/`|` em bloco). */
export function parseSkillMd(text: string): { name: string; description: string; body: string; meta: Record<string, string> } {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw badRequest("SKILL.md sem frontmatter (--- name / description ---)");
  const meta: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v === ">" || v === "|" || v === ">-" || v === "|-") {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S|^\s*$/.test(lines[i + 1])) block.push(lines[++i].trim());
      v = block.join(v.startsWith(">") ? " " : "\n").trim();
    }
    meta[kv[1]] = unquote(v);
  }
  if (!meta.name || !meta.description) throw badRequest("o frontmatter do SKILL.md precisa de name e description");
  return { name: meta.name, description: meta.description, body: m[2].trim(), meta };
}

/** Escalar YAML entre aspas: duplas seguem os escapes do JSON; simples dobram a aspa. */
function unquote(v: string) {
  if (/^"[\s\S]*"$/.test(v)) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  if (/^'[\s\S]*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

function parsePackage(content: string): CreateBody[] {
  const t = content.trim();
  if (t.startsWith("---")) {
    const md = parseSkillMd(t);
    return [createBody.parse({ id: slug(md.name), kind: "prompt", name: humanize(md.name), description: md.description, instructions: md.body, source: "instalada de SKILL.md" })];
  }
  let data: unknown;
  try {
    data = JSON.parse(t);
  } catch {
    throw badRequest("conteúdo não é um SKILL.md nem um JSON válido");
  }
  const list = Array.isArray(data) ? data : (data as { skills?: unknown[] }).skills ?? [data];
  return list.map((raw, i) => {
    const r = raw as Record<string, unknown>;
    if (r.kind === "builtin") throw badRequest(`item ${i + 1}: skills do sistema não se instalam, só se editam`);
    // Pacote exportado de uma skill de instrucoes traz `config: {}`.
    const b = createBody.safeParse({ ...r, config: r.kind === "http" ? r.config : undefined, source: r.source ?? "instalada de pacote JSON" });
    if (!b.success) throw badRequest(`item ${i + 1} inválido`, b.error.issues);
    return b.data;
  });
}

export function exportSkill(r: SkillRow) {
  return {
    format: "goga-skill/v1",
    id: r.id,
    kind: r.kind,
    name: r.name,
    description: r.description,
    instructions: r.instructions,
    inputSchema: r.inputSchema,
    llmTool: r.llmTool,
    config: r.config,
    // Valores de cabecalho nao saem (podem ser token): so os nomes, em branco.
    headers: Object.fromEntries(Object.keys(safeHeaders(r)).map((k) => [k, ""])),
  };
}

function safeHeaders(r: SkillRow) {
  try {
    return skillHeaders(r);
  } catch {
    return {};
  }
}

export function toSkillMd(r: SkillRow) {
  const desc = r.description.replace(/\n/g, " ");
  return `---\nname: ${r.id}\ndescription: ${JSON.stringify(desc)}\n---\n\n${r.instructions.trim()}\n`;
}

export async function skillRoutes(app: FastifyInstance) {
  const get = async (id: string) => {
    const [r] = await db.select().from(schema.skill).where(eq(schema.skill.id, id));
    if (!r) throw notFound("skill");
    return r;
  };

  app.get("/api/v1/skills", async (req) => {
    requireUser(req);
    const rows = await db.select().from(schema.skill).orderBy(asc(schema.skill.kind), asc(schema.skill.name));
    // Uso dos ultimos 30 dias numa consulta so, agregado por nome de span.
    const since = new Date(Date.now() - 30 * 86_400_000);
    const usage = await db
      .select({ name: schema.span.name, calls: sql<number>`count(*)::int`, errors: sql<number>`count(*) filter (where ${schema.span.status} = 'error')::int` })
      .from(schema.span)
      .where(and(sql`${schema.span.startedAt} >= ${since}`, inArray(schema.span.kind, ["tool", "kb"]), sql`${schema.span.name} like 'skill · %'`))
      .groupBy(schema.span.name);
    const byName = new Map(usage.map((u) => [u.name, u]));
    const allFlows = await db.select({ graph: schema.flow.graph }).from(schema.flow);
    const count = (id: string) => allFlows.filter((f) => ((f.graph as { nodes?: { data: { tools: { skills: string[] } } }[] }).nodes ?? []).some(usesSkill(id))).length;
    return {
      skills: rows.map((r) => {
        const names = spanNames(r);
        const u = names.map((n) => byName.get(n)).filter(Boolean) as { calls: number; errors: number }[];
        return { ...publicSkill(r), usage30d: { calls: u.reduce((a, x) => a + x.calls, 0), errors: u.reduce((a, x) => a + x.errors, 0) }, flowCount: count(r.id) };
      }),
    };
  });

  app.get<{ Params: { id: string } }>("/api/v1/skills/:id", async (req) => {
    requireUser(req);
    const r = await get(req.params.id);
    return { skill: publicSkill(r), flows: await flowsUsing(usesSkill(r.id)) };
  });

  app.post("/api/v1/skills", async (req) => {
    const me = requireAdmin(req);
    const b = createBody.safeParse(req.body);
    if (!b.success) throw badRequest("dados inválidos", b.error.issues);
    const r = await insertSkill(b.data);
    await audit(me, "create", "skill", r.id, null, r);
    return { skill: publicSkill(r) };
  });

  app.post("/api/v1/skills/import", async (req) => {
    const me = requireAdmin(req);
    const b = z.object({ content: z.string().min(1), overwrite: z.boolean().default(false) }).safeParse(req.body);
    if (!b.success) throw badRequest("envie o conteúdo do SKILL.md ou do pacote JSON");
    const items = parsePackage(b.data.content);
    const out: { id: string; action: "criada" | "atualizada" }[] = [];
    for (const it of items) {
      if (BUILTIN_IDS.has(it.id)) throw conflict(`"${it.id}" é o id de uma skill do sistema; renomeie antes de instalar`);
      const [exists] = await db.select().from(schema.skill).where(eq(schema.skill.id, it.id));
      if (exists && !b.data.overwrite) throw conflict(`já existe a skill "${it.id}"; marque "substituir" para atualizar`, { id: it.id });
      if (exists) {
        const v = valuesFor(it);
        // Pacote exportado nao traz valor de cabecalho: nao apaga os atuais.
        const keepSecret = !filled(it.headers);
        const [after] = await db
          .update(schema.skill)
          .set({ ...v, secretEnc: keepSecret ? exists.secretEnc : v.secretEnc, version: exists.version + 1, updatedAt: new Date() })
          .where(eq(schema.skill.id, it.id))
          .returning();
        await audit(me, "import", "skill", it.id, exists, after);
        out.push({ id: it.id, action: "atualizada" });
      } else {
        const r = await insertSkill(it);
        await audit(me, "import", "skill", r.id, null, r);
        out.push({ id: it.id, action: "criada" });
      }
    }
    return { imported: out };
  });

  app.put<{ Params: { id: string } }>("/api/v1/skills/:id", async (req) => {
    const me = requireAdmin(req);
    const b = updateBody.safeParse(req.body);
    if (!b.success) throw badRequest("dados inválidos", b.error.issues);
    const before = await get(req.params.id);
    const d = b.data;
    const set: Partial<typeof schema.skill.$inferInsert> = {};
    if (d.name !== undefined) set.name = d.name;
    if (d.description !== undefined) set.description = d.description;
    if (d.instructions !== undefined) set.instructions = d.instructions;
    if (d.enabled !== undefined) set.enabled = d.enabled;
    if (before.kind === "builtin") {
      // Esquema e execucao sao do codigo; mudar aqui nao teria efeito.
      if (d.inputSchema || d.config || d.headers || d.llmTool !== undefined) throw badRequest("skill do sistema: só nome, descrição, instruções e ativação são editáveis");
    } else {
      if (before.kind === "prompt" && set.instructions !== undefined && !set.instructions.trim()) throw badRequest("skill de instruções precisa de um corpo");
      if (before.kind === "http") {
        if (d.inputSchema) set.inputSchema = d.inputSchema;
        if (d.config) set.config = d.config;
        if (d.llmTool !== undefined) set.llmTool = d.llmTool;
        if (d.headers) set.secretEnc = Object.keys(d.headers).length ? encrypt(JSON.stringify(mergeHeaders(before, d.headers))) : "";
      }
    }
    const [after] = await db
      .update(schema.skill)
      .set({ ...set, version: before.version + 1, updatedAt: new Date() })
      .where(eq(schema.skill.id, before.id))
      .returning();
    await audit(me, "update", "skill", before.id, before, after);
    return { skill: publicSkill(after) };
  });

  app.post<{ Params: { id: string } }>("/api/v1/skills/:id/reset", async (req) => {
    const me = requireAdmin(req);
    const before = await get(req.params.id);
    const def = before.defaults as { name: string; description: string } | null;
    if (before.kind !== "builtin" || !def) throw badRequest("só skills do sistema têm padrão para restaurar");
    const [after] = await db
      .update(schema.skill)
      .set({ name: def.name, description: def.description, instructions: "", enabled: true, version: before.version + 1, updatedAt: new Date() })
      .where(eq(schema.skill.id, before.id))
      .returning();
    await audit(me, "reset", "skill", before.id, before, after);
    return { skill: publicSkill(after) };
  });

  app.post<{ Params: { id: string } }>("/api/v1/skills/:id/duplicate", async (req) => {
    const me = requireAdmin(req);
    const src = await get(req.params.id);
    if (src.kind === "builtin") throw badRequest("skill do sistema não se duplica (a execução é código); crie uma skill de instruções ou HTTP");
    let id = `${src.id}_copia`.slice(0, 63);
    for (let i = 2; (await db.select({ id: schema.skill.id }).from(schema.skill).where(eq(schema.skill.id, id))).length; i++) id = `${src.id}_copia${i}`.slice(0, 63);
    const [r] = await db
      .insert(schema.skill)
      .values({ ...src, id, name: `${src.name} (cópia)`, enabled: false, defaults: null, source: `cópia de ${src.id}`, version: 1, updatedAt: new Date() })
      .returning();
    await audit(me, "create", "skill", id, null, r);
    return { skill: publicSkill(r) };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/skills/:id", async (req) => {
    const me = requireAdmin(req);
    const before = await get(req.params.id);
    if (before.kind === "builtin") throw badRequest("skill do sistema não pode ser excluída; desative-a");
    const flows = await flowsUsing(usesSkill(before.id));
    if (flows.length) throw conflict(`skill em uso em ${flows.length} fluxo(s); tire-a dos nós antes de excluir`, { flows });
    await db.delete(schema.skill).where(eq(schema.skill.id, before.id));
    await audit(me, "delete", "skill", before.id, before, null);
    return { ok: true };
  });

  app.get<{ Params: { id: string }; Querystring: { format?: string } }>("/api/v1/skills/:id/export", async (req, reply) => {
    requireUser(req);
    const r = await get(req.params.id);
    if (req.query.format === "md") {
      if (r.kind !== "prompt") throw badRequest("SKILL.md só para skills de instruções");
      return reply.header("content-type", "text/markdown; charset=utf-8").header("content-disposition", `attachment; filename="${r.id}-SKILL.md"`).send(toSkillMd(r));
    }
    return reply.header("content-disposition", `attachment; filename="${r.id}.skill.json"`).send(exportSkill(r));
  });

  app.post<{ Params: { id: string } }>("/api/v1/skills/:id/test", async (req) => {
    requireAdmin(req);
    const b = z.object({ input: z.unknown().default({}), spaces: z.array(z.string()).default([]) }).safeParse(req.body);
    if (!b.success) throw badRequest("entrada inválida");
    const r = await get(req.params.id);
    if (r.kind === "prompt") {
      return { ok: true, ms: 0, output: { trecho_do_prompt: `### ${r.name} (${r.id})\n${r.instructions.trim()}` } };
    }
    const t0 = Date.now();
    try {
      const output = await testSkill(r, b.data.input, b.data.spaces);
      return { ok: true, ms: Date.now() - t0, output };
    } catch (err) {
      if (err instanceof ZodError) {
        return { ok: false, ms: Date.now() - t0, error: `argumentos inválidos: ${err.issues.map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`).join("; ")}`, details: err.issues };
      }
      return { ok: false, ms: Date.now() - t0, error: (err as Error).message };
    }
  });

  app.get<{ Params: { id: string }; Querystring: { days?: string } }>("/api/v1/skills/:id/stats", async (req) => {
    requireUser(req);
    const r = await get(req.params.id);
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    return spanStats(and(inArray(schema.span.kind, ["tool", "kb"]), inArray(schema.span.name, spanNames(r)))!, days);
  });
}

async function insertSkill(b: CreateBody) {
  if (BUILTIN_IDS.has(b.id)) throw conflict(`"${b.id}" é reservado para uma skill do sistema`);
  const [dup] = await db.select({ id: schema.skill.id }).from(schema.skill).where(eq(schema.skill.id, b.id));
  if (dup) throw conflict(`já existe a skill "${b.id}"`);
  const [r] = await db.insert(schema.skill).values(valuesFor(b)).returning();
  return r;
}

/** Cabecalho enviado em branco = manter o valor atual (a tela nunca recebe o valor). */
function mergeHeaders(before: SkillRow, next: Record<string, string>) {
  const cur = safeHeaders(before);
  return Object.fromEntries(Object.entries(next).map(([k, v]) => [k, v || cur[k] || ""]).filter(([, v]) => v));
}

/** Nomes de span desta skill: o atual (`skill · id`) e os antigos (nome de exibicao). */
function spanNames(r: SkillRow) {
  const def = r.defaults as { name?: string } | null;
  return [...new Set([`skill · ${r.id}`, `skill · ${r.name}`, def?.name ? `skill · ${def.name}` : ""].filter(Boolean))];
}

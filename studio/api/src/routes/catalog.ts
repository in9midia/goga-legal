import type { FastifyInstance } from "fastify";
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { audit } from "../lib/audit.js";
import { requireAdmin, requireUser } from "../lib/auth.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { flowsUsing } from "../lib/usage.js";
import * as kb from "../kb/client.js";
import { config } from "../config.js";
import { seedChecklists, seedTemplates } from "../seed/files.js";
import { specialtySeeds } from "../seed/flows.js";
import { placeholders, type DocTemplate } from "../files/templates.js";
import { renderTemplate, toDocx, toPdf } from "../files/documents.js";

// Especialidades e modelos de documento sao cadastro. Os que vieram do seed
// ("sistema") nao se excluem, porque o proximo boot os recriaria: desativam-se
// (roteavel = nao / modelo desativado) e tem "restaurar padrao" lendo o seed.

type SpecialtyRow = typeof schema.specialty.$inferSelect;

const specOrigin = (number: number) => (specialtySeeds().some((s) => s.number === number) ? "system" : "custom");
const publicSpecialty = (r: SpecialtyRow) => ({ ...r, origin: specOrigin(r.number) });

const tplOrigin = (slug: string) => (seedTemplates().some((t) => t.slug === slug) ? "system" : "custom");
const publicTemplate = (r: DocTemplate) => ({ ...r, origin: tplOrigin(r.slug), placeholders: placeholders(r.body) });

const usesSpecialty = (number: number) => (n: { data: { specialtyNumber?: number | null } }) => n.data.specialtyNumber === number;

const specFields = z.object({
  name: z.string().trim().min(1),
  area: z.string(),
  cluster: z.string(),
  role: z.enum(["specialist", "support"]),
  scope: z.string(),
  defaultPrompt: z.string(),
  defaultSpaces: z.array(z.string()),
  defaultSkills: z.array(z.string()),
  routingHints: z.object({ keywords: z.array(z.string()), examples: z.array(z.string()) }),
  escalationRules: z.array(z.string()),
  zone: z.enum(["verde", "amarela"]),
  phase: z.number().int().min(1),
  routable: z.boolean(),
});
const specCreate = specFields.partial().extend({ name: z.string().trim().min(1), number: z.number().int().min(1).max(9999).optional() });

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const tplField = z.object({ nome: z.string().regex(/^[a-z0-9_]+$/i, "nome do campo: letras, números e _"), rotulo: z.string().trim().min(1), obrigatorio: z.boolean().optional() });
const tplFields = z.object({
  title: z.string().trim().min(1),
  description: z.string(),
  fields: z.array(tplField),
  body: z.string().refine((b) => b.trim().length > 0, "o corpo do modelo não pode ficar vazio"),
  enabled: z.boolean(),
});
const tplCreate = tplFields.partial({ description: true, fields: true, enabled: true }).extend({
  slug: z.string().regex(SLUG_RE, "identificador: minúsculas, números e -, de 2 a 63 caracteres"),
});

function uniqueFields(f: { nome: string }[] | undefined) {
  const names = (f ?? []).map((x) => x.nome);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw badRequest(`campo repetido: ${dup}`);
}

export async function catalogRoutes(app: FastifyInstance) {
  // ── Especialidades ──────────────────────────────────────────────────

  const getSpec = async (id: number) => {
    const [r] = await db.select().from(schema.specialty).where(eq(schema.specialty.id, id));
    if (!r) throw notFound("especialidade");
    return r;
  };

  app.get("/api/v1/catalog/specialties", async (req) => {
    requireUser(req);
    return { specialties: (await db.select().from(schema.specialty).orderBy(asc(schema.specialty.number))).map(publicSpecialty) };
  });

  app.get<{ Params: { id: string } }>("/api/v1/catalog/specialties/:id", async (req) => {
    requireUser(req);
    const r = await getSpec(Number(req.params.id));
    return { specialty: publicSpecialty(r), flows: await flowsUsing(usesSpecialty(r.number)) };
  });

  app.post("/api/v1/catalog/specialties", async (req) => {
    const me = requireAdmin(req);
    const b = specCreate.safeParse(req.body);
    if (!b.success) throw badRequest("dados inválidos", b.error.issues);
    // Numero livre: o do pedido ou o proximo depois do maior (cadastrado ou do seed).
    const [{ max }] = await db.select({ max: sql<number>`coalesce(max(${schema.specialty.number}), 0)::int` }).from(schema.specialty);
    const number = b.data.number ?? Math.max(max, ...specialtySeeds().map((s) => s.number)) + 1;
    if (specOrigin(number) === "system") throw conflict(`o nº ${number} é reservado para uma especialidade do sistema`);
    const [dup] = await db.select({ id: schema.specialty.id }).from(schema.specialty).where(eq(schema.specialty.number, number));
    if (dup) throw conflict(`já existe especialidade com o nº ${number}`);
    const [after] = await db.insert(schema.specialty).values({ ...b.data, number }).returning();
    await audit(me, "create", "specialty", String(after.id), null, after);
    return { specialty: publicSpecialty(after) };
  });

  app.put<{ Params: { id: string } }>("/api/v1/catalog/specialties/:id", async (req) => {
    const me = requireAdmin(req);
    const b = specFields.partial().safeParse(req.body);
    if (!b.success) throw badRequest("dados inválidos", b.error.issues);
    const before = await getSpec(Number(req.params.id));
    const [after] = await db.update(schema.specialty).set(b.data).where(eq(schema.specialty.id, before.id)).returning();
    await audit(me, "update", "specialty", String(before.id), before, after);
    return { specialty: publicSpecialty(after) };
  });

  app.post<{ Params: { id: string } }>("/api/v1/catalog/specialties/:id/reset", async (req) => {
    const me = requireAdmin(req);
    const before = await getSpec(Number(req.params.id));
    const s = specialtySeeds().find((x) => x.number === before.number);
    if (!s) throw badRequest("só especialidades do sistema têm padrão para restaurar");
    const [after] = await db
      .update(schema.specialty)
      .set({
        name: s.name,
        area: s.area,
        cluster: s.cluster,
        role: s.role,
        routable: s.routable,
        scope: s.scope,
        defaultPrompt: s.default_prompt,
        defaultSpaces: s.default_spaces,
        defaultSkills: s.default_skills,
        routingHints: s.routing_hints,
        escalationRules: s.escalation_rules,
        phase: s.phase,
        zone: s.zone,
      })
      .where(eq(schema.specialty.id, before.id))
      .returning();
    await audit(me, "reset", "specialty", String(before.id), before, after);
    return { specialty: publicSpecialty(after) };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/catalog/specialties/:id", async (req) => {
    const me = requireAdmin(req);
    const before = await getSpec(Number(req.params.id));
    if (specOrigin(before.number) === "system") throw badRequest("especialidade do sistema não pode ser excluída; marque-a como não roteável");
    const flows = await flowsUsing(usesSpecialty(before.number));
    if (flows.length) throw conflict(`especialidade em uso em ${flows.length} fluxo(s); desvincule os nós antes de excluir`, { flows });
    await db.delete(schema.specialty).where(eq(schema.specialty.id, before.id));
    await audit(me, "delete", "specialty", String(before.id), before, null);
    return { ok: true };
  });

  // ── Modelos de documento ────────────────────────────────────────────

  const getTpl = async (slug: string) => {
    const [r] = await db.select().from(schema.docTemplate).where(eq(schema.docTemplate.slug, slug));
    if (!r) throw notFound("modelo de documento");
    return r;
  };

  app.get("/api/v1/catalog/templates", async (req) => {
    requireUser(req);
    const rows = await db.select().from(schema.docTemplate).orderBy(asc(schema.docTemplate.slug));
    return { templates: rows.map(publicTemplate), checklists: Object.keys(seedChecklists()) };
  });

  app.post("/api/v1/catalog/templates", async (req) => {
    const me = requireAdmin(req);
    const b = tplCreate.safeParse(req.body);
    if (!b.success) throw badRequest("dados inválidos", b.error.issues);
    uniqueFields(b.data.fields);
    const [dup] = await db.select({ slug: schema.docTemplate.slug }).from(schema.docTemplate).where(eq(schema.docTemplate.slug, b.data.slug));
    if (dup || tplOrigin(b.data.slug) === "system") throw conflict(`já existe o modelo "${b.data.slug}"`);
    const [after] = await db.insert(schema.docTemplate).values(b.data).returning();
    await audit(me, "create", "doc_template", after.slug, null, after);
    return { template: publicTemplate(after) };
  });

  app.put<{ Params: { slug: string } }>("/api/v1/catalog/templates/:slug", async (req) => {
    const me = requireAdmin(req);
    const b = tplFields.partial().safeParse(req.body);
    if (!b.success) throw badRequest("dados inválidos", b.error.issues);
    uniqueFields(b.data.fields);
    const before = await getTpl(req.params.slug);
    const [after] = await db.update(schema.docTemplate).set({ ...b.data, updatedAt: new Date() }).where(eq(schema.docTemplate.slug, before.slug)).returning();
    await audit(me, "update", "doc_template", before.slug, before, after);
    return { template: publicTemplate(after) };
  });

  app.post<{ Params: { slug: string } }>("/api/v1/catalog/templates/:slug/reset", async (req) => {
    const me = requireAdmin(req);
    const before = await getTpl(req.params.slug);
    const t = seedTemplates().find((x) => x.slug === before.slug);
    if (!t) throw badRequest("só modelos do sistema têm padrão para restaurar");
    const [after] = await db
      .update(schema.docTemplate)
      .set({ title: t.titulo, description: t.descricao ?? "", fields: t.campos, body: t.corpo_markdown, enabled: true, updatedAt: new Date() })
      .where(eq(schema.docTemplate.slug, before.slug))
      .returning();
    await audit(me, "reset", "doc_template", before.slug, before, after);
    return { template: publicTemplate(after) };
  });

  app.delete<{ Params: { slug: string } }>("/api/v1/catalog/templates/:slug", async (req) => {
    const me = requireAdmin(req);
    const before = await getTpl(req.params.slug);
    if (tplOrigin(before.slug) === "system") throw badRequest("modelo do sistema não pode ser excluído; desative-o");
    await db.delete(schema.docTemplate).where(eq(schema.docTemplate.slug, before.slug));
    await audit(me, "delete", "doc_template", before.slug, before, null);
    return { ok: true };
  });

  // Previa do que o gerar_documento produziria, com os campos de exemplo (os
  // que faltarem saem como [CAMPO]). Recebe o corpo para previsualizar antes de salvar.
  app.post("/api/v1/catalog/templates/preview", async (req, reply) => {
    requireUser(req);
    const b = z
      .object({ body: z.string().min(1), values: z.record(z.string(), z.string()).default({}), format: z.enum(["pdf", "docx"]).default("pdf") })
      .safeParse(req.body);
    if (!b.success) throw badRequest("envie o corpo do modelo");
    const { text } = renderTemplate(b.data.body, { data: new Date().toLocaleDateString("pt-BR"), ...b.data.values });
    if (b.data.format === "docx") {
      return reply.header("content-type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document").header("content-disposition", 'inline; filename="previa.docx"').send(await toDocx(text));
    }
    return reply.header("content-type", "application/pdf").header("content-disposition", 'inline; filename="previa.pdf"').send(await toPdf(text));
  });

  app.get("/api/v1/kb/spaces", async (req) => {
    requireUser(req);
    try {
      return { available: true, uiUrl: config.kbUiUrl, spaces: await kb.listSpaces(true) };
    } catch (err) {
      return { available: false, uiUrl: config.kbUiUrl, error: (err as Error).message, spaces: [] };
    }
  });

  app.post("/api/v1/kb/search", async (req) => {
    requireUser(req);
    const b = z.object({ query: z.string().min(1), spaces: z.array(z.string()).default([]), top_k: z.number().int().optional() }).safeParse(req.body);
    if (!b.success) throw badRequest("consulta inválida");
    return kb.search(b.data);
  });
}

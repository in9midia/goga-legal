import type { FastifyInstance } from "fastify";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { audit } from "../lib/audit.js";
import { requireAdmin, requireUser } from "../lib/auth.js";
import { badRequest, notFound } from "../lib/errors.js";
import * as kb from "../kb/client.js";
import { listTools } from "../mcp/client.js";
import { config } from "../config.js";
import { seedChecklists, seedTemplates } from "../seed/files.js";

export async function catalogRoutes(app: FastifyInstance) {
  app.get("/api/v1/catalog/specialties", async (req) => {
    requireUser(req);
    return { specialties: await db.select().from(schema.specialty).orderBy(asc(schema.specialty.number)) };
  });

  const specBody = z.object({
    name: z.string().min(1),
    scope: z.string(),
    defaultPrompt: z.string(),
    defaultSpaces: z.array(z.string()),
    defaultSkills: z.array(z.string()),
    routingHints: z.object({ keywords: z.array(z.string()), examples: z.array(z.string()) }),
    escalationRules: z.array(z.string()),
    zone: z.enum(["verde", "amarela"]),
    phase: z.number().int(),
    routable: z.boolean(),
  }).partial();

  app.put<{ Params: { id: string } }>("/api/v1/catalog/specialties/:id", async (req) => {
    const me = requireAdmin(req);
    const b = specBody.safeParse(req.body);
    if (!b.success) throw badRequest("dados inválidos", b.error.issues);
    const id = Number(req.params.id);
    const [before] = await db.select().from(schema.specialty).where(eq(schema.specialty.id, id));
    if (!before) throw notFound("especialidade");
    const [after] = await db.update(schema.specialty).set(b.data).where(eq(schema.specialty.id, id)).returning();
    await audit(me, "update", "specialty", String(id), before, after);
    return { specialty: after };
  });

  app.get("/api/v1/catalog/skills", async (req) => {
    requireUser(req);
    return { skills: await db.select().from(schema.skill).orderBy(asc(schema.skill.id)) };
  });

  app.get("/api/v1/catalog/mcp", async (req) => {
    requireUser(req);
    const servers = await db.select().from(schema.mcpServer).orderBy(asc(schema.mcpServer.id));
    // Atualiza a lista de tools dos servidores ativos, sem travar a tela se um
    // deles estiver fora: fica o cache da ultima vez.
    await Promise.all(servers.filter((s) => s.enabled).map((s) => listTools(s.id).then((t) => (s.toolsCache = t)).catch(() => undefined)));
    return { servers };
  });

  app.get("/api/v1/catalog/templates", async (req) => {
    requireUser(req);
    return { templates: seedTemplates().map(({ corpo_markdown, ...t }) => ({ ...t, tamanho: corpo_markdown.length })), checklists: Object.keys(seedChecklists()) };
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

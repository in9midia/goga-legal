import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { audit } from "../lib/audit.js";
import { requireAdmin, requireUser } from "../lib/auth.js";
import { badRequest, conflict, HttpError, notFound } from "../lib/errors.js";
import { flowGraphSchema, validateGraph, type FlowGraph } from "../shared/graph.js";
import { spaceSlugs } from "../kb/client.js";
import { SKILLS } from "../skills/index.js";
import { emptyGraph } from "../seed/flows.js";
import { defaultModelId } from "../llm/models.js";

async function graphContext() {
  const models = await db
    .select({ id: schema.model.id, active: schema.model.active, pActive: schema.provider.active, purpose: schema.model.purpose })
    .from(schema.model)
    .innerJoin(schema.provider, eq(schema.model.providerId, schema.provider.id));
  return {
    activeChatModelIds: new Set(models.filter((m) => m.active && m.pActive && m.purpose === "chat").map((m) => m.id)),
    kbSpaces: await spaceSlugs(),
    skills: new Set(SKILLS.map((s) => s.id)),
  };
}

export async function validateFull(graph: FlowGraph) {
  return validateGraph(graph, await graphContext());
}

async function productionRelease() {
  const [p] = await db
    .select({ release: schema.flowRelease })
    .from(schema.production)
    .innerJoin(schema.flowRelease, eq(schema.production.flowReleaseId, schema.flowRelease.id))
    .where(eq(schema.production.id, 1));
  return p?.release ?? null;
}

// Divergencia = o rascunho mudou depois da release. Comparar o JSON do grafo, e
// nao so a revisao, evita o falso alarme de "salvou sem mudar nada".
const diverges = (draft: unknown, release: unknown) => JSON.stringify(draft) !== JSON.stringify(release);

export async function flowRoutes(app: FastifyInstance) {
  app.get("/api/v1/flows", async (req) => {
    requireUser(req);
    const flows = await db.select().from(schema.flow).orderBy(desc(schema.flow.updatedAt));
    const prod = await productionRelease();
    const releases = await db.select({ flowId: schema.flowRelease.flowId, revision: schema.flowRelease.revision, publishedAt: schema.flowRelease.publishedAt }).from(schema.flowRelease).orderBy(desc(schema.flowRelease.publishedAt));
    return {
      flows: flows.map((f) => {
        const g = f.graph as FlowGraph;
        const lastRelease = releases.find((r) => r.flowId === f.id);
        const isProduction = prod?.flowId === f.id;
        return {
          id: f.id,
          name: f.name,
          description: f.description,
          revision: f.revision,
          updatedAt: f.updatedAt,
          createdAt: f.createdAt,
          nodeCount: g.nodes?.length ?? 0,
          specialistCount: g.nodes?.filter((n) => n.type === "specialist").length ?? 0,
          isProduction,
          productionRevision: isProduction ? prod!.revision : null,
          lastPublishedRevision: lastRelease?.revision ?? null,
          unpublishedChanges: isProduction ? diverges(f.graph, prod!.graph) : false,
        };
      }),
    };
  });

  app.get("/api/v1/production", async (req) => {
    requireUser(req);
    const r = await productionRelease();
    if (!r) return { production: null };
    const [f] = await db.select({ name: schema.flow.name }).from(schema.flow).where(eq(schema.flow.id, r.flowId));
    return { production: { releaseId: r.id, flowId: r.flowId, flowName: f?.name ?? "", revision: r.revision, publishedAt: r.publishedAt } };
  });

  app.get<{ Params: { id: string } }>("/api/v1/flows/:id", async (req) => {
    requireUser(req);
    const [f] = await db.select().from(schema.flow).where(eq(schema.flow.id, req.params.id));
    if (!f) throw notFound("fluxo");
    const prod = await productionRelease();
    const graph = flowGraphSchema.parse(f.graph);
    return {
      flow: { ...f, graph },
      isProduction: prod?.flowId === f.id,
      unpublishedChanges: prod?.flowId === f.id ? diverges(f.graph, prod.graph) : false,
      errors: await validateFull(graph),
    };
  });

  app.post("/api/v1/flows", async (req) => {
    const me = requireAdmin(req);
    const b = z.object({ name: z.string().min(1), description: z.string().default(""), graph: z.unknown().optional() }).safeParse(req.body);
    if (!b.success) throw badRequest("dados inválidos");
    const graph = b.data.graph ? flowGraphSchema.parse(b.data.graph) : emptyGraph(await defaultModelId("chat"));
    const [f] = await db.insert(schema.flow).values({ name: b.data.name, description: b.data.description, graph, createdBy: me.id }).returning();
    await audit(me, "create", "flow", f.id, null, { name: f.name, description: f.description });
    return { flow: f };
  });

  app.put<{ Params: { id: string } }>("/api/v1/flows/:id", async (req) => {
    const me = requireAdmin(req);
    const b = z.object({ name: z.string().min(1).optional(), description: z.string().optional(), graph: z.unknown().optional(), expectedRevision: z.number().int() }).safeParse(req.body);
    if (!b.success) throw badRequest("dados inválidos (expectedRevision é obrigatório)");
    const parsed = b.data.graph === undefined ? null : flowGraphSchema.safeParse(b.data.graph);
    if (parsed && !parsed.success) throw badRequest("grafo inválido", { errors: parsed.error.issues.slice(0, 20).map((i) => ({ code: "schema", message: `${i.path.join(".")}: ${i.message}` })) });
    const [before] = await db.select().from(schema.flow).where(eq(schema.flow.id, req.params.id));
    if (!before) throw notFound("fluxo");
    // Controle otimista: dois admins editando o mesmo fluxo nao podem se
    // sobrescrever em silencio.
    if (before.revision !== b.data.expectedRevision) {
      throw conflict(`o fluxo foi alterado por outra pessoa (revisão ${before.revision}); recarregue`, { revision: before.revision });
    }
    const set = {
      name: b.data.name ?? before.name,
      description: b.data.description ?? before.description,
      graph: parsed?.data ?? before.graph,
      revision: before.revision + 1,
      updatedAt: new Date(),
    };
    const [f] = await db.update(schema.flow).set(set).where(eq(schema.flow.id, req.params.id)).returning();
    await audit(me, "update", "flow", f.id, { name: before.name, description: before.description, revision: before.revision, graph: before.graph }, { name: f.name, description: f.description, revision: f.revision, graph: f.graph });
    return { flow: f, errors: await validateFull(flowGraphSchema.parse(f.graph)) };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/flows/:id", async (req) => {
    const me = requireAdmin(req);
    const prod = await productionRelease();
    if (prod?.flowId === req.params.id) throw badRequest("este fluxo está em produção; publique outro antes de excluir");
    const [before] = await db.delete(schema.flow).where(eq(schema.flow.id, req.params.id)).returning();
    if (!before) throw notFound("fluxo");
    await audit(me, "delete", "flow", before.id, { name: before.name, revision: before.revision, graph: before.graph }, null);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/v1/flows/:id/duplicate", async (req) => {
    const me = requireAdmin(req);
    const b = z.object({ name: z.string().min(1).optional() }).safeParse(req.body ?? {});
    const [src] = await db.select().from(schema.flow).where(eq(schema.flow.id, req.params.id));
    if (!src) throw notFound("fluxo");
    const name = (b.success && b.data.name) || `${src.name} (cópia)`;
    const [f] = await db.insert(schema.flow).values({ name, description: src.description, graph: src.graph, createdBy: me.id }).returning();
    await audit(me, "duplicate", "flow", f.id, { from: src.id, name: src.name, revision: src.revision }, { name: f.name });
    return { flow: f };
  });

  app.post<{ Params: { id: string } }>("/api/v1/flows/:id/validate", async (req) => {
    requireUser(req);
    const g = flowGraphSchema.safeParse((req.body as { graph?: unknown })?.graph);
    if (!g.success) return { errors: g.error.issues.slice(0, 20).map((i) => ({ code: "schema", message: `${i.path.join(".")}: ${i.message}` })) };
    return { errors: await validateFull(g.data) };
  });

  app.post<{ Params: { id: string } }>("/api/v1/flows/:id/publish", async (req) => {
    const me = requireAdmin(req);
    const b = z.object({ expectedRevision: z.number().int() }).safeParse(req.body);
    if (!b.success) throw badRequest("expectedRevision é obrigatório");
    const [f] = await db.select().from(schema.flow).where(eq(schema.flow.id, req.params.id));
    if (!f) throw notFound("fluxo");
    if (f.revision !== b.data.expectedRevision) throw conflict(`o fluxo mudou (revisão ${f.revision}); salve e revise antes de publicar`);
    const graph = flowGraphSchema.parse(f.graph);
    const errors = await validateFull(graph);
    if (errors.length) throw new HttpError(422, "o fluxo tem erros de validação", { errors });
    const before = await productionRelease();
    const release = await db.transaction(async (tx) => {
      const [r] = await tx.insert(schema.flowRelease).values({ flowId: f.id, revision: f.revision, graph, publishedBy: me.id }).returning();
      await tx.update(schema.production).set({ flowReleaseId: r.id, updatedAt: new Date() }).where(eq(schema.production.id, 1));
      return r;
    });
    let beforeName: string | null = null;
    if (before) [{ name: beforeName }] = await db.select({ name: schema.flow.name }).from(schema.flow).where(eq(schema.flow.id, before.flowId)).then((r) => (r.length ? r : [{ name: "(excluído)" }]));
    await audit(
      me,
      "publish",
      "production",
      release.id,
      before ? { flowId: before.flowId, flowName: beforeName, revision: before.revision, graph: before.graph } : null,
      { flowId: f.id, flowName: f.name, revision: f.revision, graph },
    );
    return { release };
  });

  app.get<{ Params: { id: string } }>("/api/v1/flows/:id/releases", async (req) => {
    requireUser(req);
    const rows = await db
      .select({ id: schema.flowRelease.id, revision: schema.flowRelease.revision, publishedAt: schema.flowRelease.publishedAt, publishedBy: schema.appUser.email })
      .from(schema.flowRelease)
      .leftJoin(schema.appUser, eq(schema.flowRelease.publishedBy, schema.appUser.id))
      .where(eq(schema.flowRelease.flowId, req.params.id))
      .orderBy(desc(schema.flowRelease.publishedAt));
    return { releases: rows };
  });
}

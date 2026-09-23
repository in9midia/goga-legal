import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { requireUser, requireAdmin } from "../lib/auth.js";
import { badRequest, notFound } from "../lib/errors.js";
import * as kb from "../kb/client.js";
import { spanRecord } from "./sessions.js";

const dateRange = (from?: string, to?: string) => ({
  from: from ? new Date(`${from}T00:00:00`) : new Date(Date.now() - 30 * 864e5),
  to: to ? new Date(`${to}T23:59:59.999`) : new Date(),
});

export async function runRoutes(app: FastifyInstance) {
  app.get("/api/v1/runs", async (req) => {
    requireUser(req);
    const q = z
      .object({
        flowId: z.string().uuid().optional(),
        userId: z.string().uuid().optional(),
        status: z.string().optional(),
        production: z.enum(["true", "false"]).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        q: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query);
    const { from, to } = dateRange(q.from, q.to);
    const where: SQL[] = [gte(schema.run.startedAt, from), lte(schema.run.startedAt, to)];
    if (q.flowId) where.push(eq(schema.run.flowId, q.flowId));
    if (q.userId) where.push(eq(schema.run.userId, q.userId));
    if (q.status) where.push(eq(schema.run.status, q.status as "ok"));
    if (q.production) where.push(eq(schema.run.isProduction, q.production === "true"));
    if (q.q) where.push(sql`${schema.run.question} ILIKE ${"%" + q.q + "%"}`);
    const rows = await db
      .select({
        id: schema.run.id,
        question: schema.run.question,
        flowId: schema.run.flowId,
        flowName: schema.run.flowName,
        flowRevision: schema.run.flowRevision,
        isProduction: schema.run.isProduction,
        status: schema.run.status,
        error: schema.run.error,
        startedAt: schema.run.startedAt,
        endedAt: schema.run.endedAt,
        costUsd: schema.run.costUsd,
        tokensIn: schema.run.tokensIn,
        tokensOut: schema.run.tokensOut,
        rating: schema.run.rating,
        sessionId: schema.run.sessionId,
        userEmail: schema.appUser.email,
        userId: schema.run.userId,
      })
      .from(schema.run)
      .leftJoin(schema.appUser, eq(schema.run.userId, schema.appUser.id))
      .where(and(...where))
      .orderBy(desc(schema.run.startedAt))
      .limit(q.limit);
    return { runs: rows };
  });

  app.get<{ Params: { id: string } }>("/api/v1/runs/:id", async (req) => {
    requireUser(req);
    const [r] = await db.select({ run: schema.run, userEmail: schema.appUser.email }).from(schema.run).leftJoin(schema.appUser, eq(schema.run.userId, schema.appUser.id)).where(eq(schema.run.id, req.params.id));
    if (!r) throw notFound("execução");
    const spans = await db.select().from(schema.span).where(eq(schema.span.runId, r.run.id)).orderBy(asc(schema.span.seq));
    const files = await db.select({ id: schema.file.id, name: schema.file.name, mime: schema.file.mime, direction: schema.file.direction }).from(schema.file).where(eq(schema.file.runId, r.run.id));
    return { run: { ...r.run, userEmail: r.userEmail }, spans: spans.map(spanRecord), files };
  });

  app.post<{ Params: { id: string } }>("/api/v1/runs/:id/rating", async (req) => {
    requireUser(req);
    const b = z.object({ rating: z.union([z.literal(1), z.literal(-1), z.literal(0)]), comment: z.string().max(2000).default("") }).safeParse(req.body);
    if (!b.success) throw badRequest("avaliação inválida");
    const [r] = await db.update(schema.run).set({ rating: b.data.rating || null, ratingComment: b.data.comment || null }).where(eq(schema.run.id, req.params.id)).returning({ id: schema.run.id });
    if (!r) throw notFound("execução");
    return { ok: true };
  });

  // ── Custos ──────────────────────────────────────────────────────────
  app.get("/api/v1/costs", async (req) => {
    requireUser(req);
    const q = z.object({ from: z.string().optional(), to: z.string().optional(), groupBy: z.enum(["provider", "model", "user", "flow", "agent"]).default("model") }).parse(req.query);
    const { from, to } = dateRange(q.from, q.to);
    const u = schema.usage;
    const inRange = and(gte(u.createdAt, from), lte(u.createdAt, to));

    const totals = await db
      .select({ cost: sql<number>`coalesce(sum(${u.costUsd}),0)`, tin: sql<number>`coalesce(sum(${u.tokensIn}),0)`, tout: sql<number>`coalesce(sum(${u.tokensOut}),0)`, calls: sql<number>`count(*)` })
      .from(u)
      .where(inRange);
    const runsAgg = await db
      .select({ runs: sql<number>`count(*)`, cost: sql<number>`coalesce(sum(${schema.run.costUsd}),0)` })
      .from(schema.run)
      .where(and(gte(schema.run.startedAt, from), lte(schema.run.startedAt, to)));

    const byDay = await db
      .select({ day: sql<string>`to_char(${u.createdAt}, 'YYYY-MM-DD')`, provider: sql<string>`coalesce(${schema.provider.name}, '—')`, cost: sql<number>`sum(${u.costUsd})`, tokens: sql<number>`sum(${u.tokensIn} + ${u.tokensOut})` })
      .from(u)
      .leftJoin(schema.provider, eq(u.providerId, schema.provider.id))
      .where(inRange)
      .groupBy(sql`1`, sql`2`)
      .orderBy(sql`1`);

    const byModel = await db
      .select({ key: sql<string>`coalesce(${schema.model.label}, '—')`, cost: sql<number>`sum(${u.costUsd})`, calls: sql<number>`count(*)` })
      .from(u)
      .leftJoin(schema.model, eq(u.modelId, schema.model.id))
      .where(inRange)
      .groupBy(sql`1`)
      .orderBy(sql`2 desc`);

    const keyExpr = {
      provider: sql<string>`coalesce(${schema.provider.name}, '—')`,
      model: sql<string>`coalesce(${schema.model.label}, '—')`,
      user: sql<string>`coalesce(${schema.appUser.email}, '—')`,
      flow: sql<string>`coalesce(${schema.flow.name}, '—')`,
      agent: sql<string>`coalesce(${u.nodeName}, '—')`,
    }[q.groupBy];
    const table = await db
      .select({
        key: keyExpr,
        calls: sql<number>`count(*)`,
        runs: sql<number>`count(distinct ${u.runId})`,
        tokensIn: sql<number>`sum(${u.tokensIn})`,
        tokensOut: sql<number>`sum(${u.tokensOut})`,
        tokensCache: sql<number>`sum(${u.tokensCache})`,
        cost: sql<number>`sum(${u.costUsd})`,
      })
      .from(u)
      .leftJoin(schema.provider, eq(u.providerId, schema.provider.id))
      .leftJoin(schema.model, eq(u.modelId, schema.model.id))
      .leftJoin(schema.appUser, eq(u.userId, schema.appUser.id))
      .leftJoin(schema.flow, eq(u.flowId, schema.flow.id))
      .where(inRange)
      .groupBy(sql`1`)
      .orderBy(sql`7 desc`);

    // Custo de embedding e da KB (outro servico, outro banco). Vem com a
    // origem marcada: o numero do Studio e medido aqui, o da KB e o que ela diz.
    let kbUsage: { available: boolean; costUsd: number; tokens: number; error?: string } = { available: false, costUsd: 0, tokens: 0 };
    try {
      const days = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 864e5));
      const r = (await kb.aiUsage(Math.min(365, days))) as { totals?: { cost_usd?: number; tokens?: number } };
      kbUsage = { available: true, costUsd: Number(r.totals?.cost_usd ?? 0), tokens: Number(r.totals?.tokens ?? 0) };
    } catch (err) {
      kbUsage.error = (err as Error).message.slice(0, 200);
    }

    const num = (x: unknown) => Number(x ?? 0);
    const t = totals[0];
    const runs = num(runsAgg[0].runs);
    return {
      range: { from: from.toISOString(), to: to.toISOString() },
      kpis: { costUsd: num(t.cost), calls: num(t.calls), tokensIn: num(t.tin), tokensOut: num(t.tout), runs, avgRunCostUsd: runs ? num(runsAgg[0].cost) / runs : 0 },
      byDay: byDay.map((r) => ({ ...r, cost: num(r.cost), tokens: num(r.tokens) })),
      byModel: byModel.map((r) => ({ ...r, cost: num(r.cost), calls: num(r.calls) })),
      table: table.map((r) => ({ key: r.key, calls: num(r.calls), runs: num(r.runs), tokensIn: num(r.tokensIn), tokensOut: num(r.tokensOut), tokensCache: num(r.tokensCache), cost: num(r.cost) })),
      groupBy: q.groupBy,
      kb: kbUsage,
    };
  });

  // ── Auditoria ───────────────────────────────────────────────────────
  app.get("/api/v1/audit", async (req) => {
    requireAdmin(req);
    const q = z.object({ entity: z.string().optional(), entityId: z.string().optional(), actor: z.string().optional(), from: z.string().optional(), to: z.string().optional(), limit: z.coerce.number().int().max(500).default(200) }).parse(req.query);
    const { from, to } = dateRange(q.from, q.to);
    const a = schema.auditLog;
    const where: SQL[] = [gte(a.at, from), lte(a.at, to)];
    if (q.entity) where.push(eq(a.entity, q.entity));
    if (q.entityId) where.push(eq(a.entityId, q.entityId));
    if (q.actor) where.push(sql`${a.actorEmail} ILIKE ${"%" + q.actor + "%"}`);
    const rows = await db.select().from(a).where(and(...where)).orderBy(desc(a.at)).limit(q.limit);
    return { entries: rows };
  });
}

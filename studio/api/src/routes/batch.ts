import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { desc, eq, inArray, sql } from "drizzle-orm";
import YAML from "yaml";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { requireAdmin, requireUser, type SessionUser } from "../lib/auth.js";
import { badRequest, notFound } from "../lib/errors.js";
import { flowGraphSchema } from "../shared/graph.js";
import { runOnce } from "../engine/run.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// Os conjuntos de avaliacao sao da KB (content/evaluation). Em dev leio direto
// do repositorio; na imagem, o Dockerfile copia a pasta para /app/evaluation.
const evalDir = () => process.env.STUDIO_EVAL_DIR || path.resolve(here, "../../../../knowledge-base/content/evaluation");

interface Question {
  question: string;
  space: string | null;
  kind?: string;
}

async function loadSets(): Promise<Record<string, Question[]>> {
  const out: Record<string, Question[]> = {};
  let files: string[] = [];
  try {
    files = (await fs.readdir(evalDir())).filter((f) => f.endsWith(".yaml"));
  } catch {
    return out;
  }
  for (const f of files) {
    const doc = YAML.parse(await fs.readFile(path.join(evalDir(), f), "utf8")) as { space?: string; questions?: { question: string; kind?: string }[] };
    out[f.replace(/\.yaml$/, "")] = (doc.questions ?? []).map((q) => ({ question: q.question, space: doc.space ?? null, kind: q.kind }));
  }
  return out;
}

const cancelled = new Set<string>();

export async function batchRoutes(app: FastifyInstance) {
  app.get("/api/v1/eval/sets", async (req) => {
    requireUser(req);
    const sets = await loadSets();
    return { sets: Object.entries(sets).map(([id, qs]) => ({ id, count: qs.length, space: qs[0]?.space ?? null })) };
  });

  app.get("/api/v1/eval/batches", async (req) => {
    requireUser(req);
    const rows = await db
      .select({ id: schema.evalBatch.id, name: schema.evalBatch.name, status: schema.evalBatch.status, flowIds: schema.evalBatch.flowIds, total: sql<number>`jsonb_array_length(${schema.evalBatch.questions}) * jsonb_array_length(${schema.evalBatch.flowIds})`, done: sql<number>`jsonb_array_length(${schema.evalBatch.results})`, createdAt: schema.evalBatch.createdAt, endedAt: schema.evalBatch.endedAt })
      .from(schema.evalBatch)
      .orderBy(desc(schema.evalBatch.createdAt))
      .limit(50);
    return { batches: rows };
  });

  app.get<{ Params: { id: string } }>("/api/v1/eval/batches/:id", async (req) => {
    requireUser(req);
    const [b] = await db.select().from(schema.evalBatch).where(eq(schema.evalBatch.id, req.params.id));
    if (!b) throw notFound("lote");
    const flows = await db.select({ id: schema.flow.id, name: schema.flow.name }).from(schema.flow).where(inArray(schema.flow.id, b.flowIds));
    return { batch: b, flows };
  });

  app.post<{ Params: { id: string } }>("/api/v1/eval/batches/:id/cancel", async (req) => {
    requireAdmin(req);
    cancelled.add(req.params.id);
    return { ok: true };
  });

  app.post("/api/v1/eval/batches", async (req) => {
    const me = requireAdmin(req);
    const b = z
      .object({
        name: z.string().default("Lote"),
        flowIds: z.array(z.string().uuid()).min(1).max(2),
        sets: z.array(z.string()).default([]),
        questions: z.array(z.object({ question: z.string().min(1), space: z.string().nullable().default(null) })).default([]),
        perSet: z.number().int().min(1).max(100).default(5),
      })
      .safeParse(req.body);
    if (!b.success) throw badRequest("dados inválidos", b.error.issues);
    const all = await loadSets();
    const questions: Question[] = [...b.data.questions];
    for (const s of b.data.sets) questions.push(...(all[s] ?? []).slice(0, b.data.perSet));
    if (!questions.length) throw badRequest("nenhuma pergunta selecionada");
    if (questions.length * b.data.flowIds.length > 500) throw badRequest("lote grande demais (máx. 500 execuções)");
    const flows = await db.select().from(schema.flow).where(inArray(schema.flow.id, b.data.flowIds));
    if (flows.length !== b.data.flowIds.length) throw notFound("fluxo");
    const [batch] = await db.insert(schema.evalBatch).values({ name: b.data.name, flowIds: b.data.flowIds, questions, createdBy: me.id }).returning();
    void runBatch(batch.id, flows, questions, me);
    return { batch };
  });
}

// Concorrencia 2: o suficiente para o lote nao levar horas, pouco o bastante
// para nao estourar limite de taxa do provedor com 3 especialistas por pergunta.
const CONCURRENCY = 2;

async function runBatch(batchId: string, flows: (typeof schema.flow.$inferSelect)[], questions: Question[], user: SessionUser) {
  const jobs = questions.flatMap((q, qi) => flows.map((f) => ({ q, qi, f })));
  let next = 0;
  const worker = async () => {
    while (next < jobs.length && !cancelled.has(batchId)) {
      const { q, qi, f } = jobs[next++];
      const graph = flowGraphSchema.parse(f.graph);
      const r = await runOnce({ user, graph, flowId: f.id, flowName: f.name, revision: f.revision, message: q.question });
      const selected = r.outcome?.especialistas ?? [];
      const selectedSpaces = new Set(selected.flatMap((s) => graph.nodes.find((n) => n.id === s.nodeId)?.data.knowledge.spaces ?? []));
      const result = {
        qi,
        flowId: f.id,
        runId: r.runId,
        question: q.question,
        expectedSpace: q.space,
        status: r.outcome?.status ?? "error",
        error: r.error,
        specialists: selected.map((s) => s.name),
        routedOk: q.space ? selectedSpaces.has(q.space) : null,
        complianceApproved: r.outcome?.compliance?.aprovado ?? null,
        complianceCycles: r.outcome?.compliance?.ciclos ?? null,
        costUsd: r.costUsd,
      };
      await db.update(schema.evalBatch).set({ results: sql`${schema.evalBatch.results} || ${JSON.stringify([result])}::jsonb` }).where(eq(schema.evalBatch.id, batchId));
    }
  };
  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    await db.update(schema.evalBatch).set({ status: cancelled.has(batchId) ? "cancelled" : "done", endedAt: new Date() }).where(eq(schema.evalBatch.id, batchId));
  } catch (err) {
    await db.update(schema.evalBatch).set({ status: "error", error: (err as Error).message, endedAt: new Date() }).where(eq(schema.evalBatch.id, batchId));
  } finally {
    cancelled.delete(batchId);
  }
}

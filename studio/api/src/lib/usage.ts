import { and, desc, eq, gte, sql, type SQL } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { FlowGraph, FlowNode } from "../shared/graph.js";

export interface FlowUse {
  id: string;
  name: string;
  nodes: string[];
  /** A release em producao deste fluxo usa o item. */
  production: boolean;
}

/**
 * Fluxos (rascunho ou release em producao) com algum no que satisfaz `uses`.
 * Serve para impedir exclusao de skill/MCP em uso e para mostrar o alcance de
 * uma alteracao antes de salvar.
 */
export async function flowsUsing(uses: (n: FlowNode) => boolean): Promise<FlowUse[]> {
  const flows = await db.select({ id: schema.flow.id, name: schema.flow.name, graph: schema.flow.graph }).from(schema.flow);
  const [prod] = await db
    .select({ flowId: schema.flowRelease.flowId, graph: schema.flowRelease.graph })
    .from(schema.production)
    .innerJoin(schema.flowRelease, eq(schema.production.flowReleaseId, schema.flowRelease.id))
    .where(eq(schema.production.id, 1));
  const nodesOf = (g: unknown) => ((g as FlowGraph | null)?.nodes ?? []).filter(uses).map((n) => n.data.name);
  const prodNodes = prod ? nodesOf(prod.graph) : [];
  const out: FlowUse[] = [];
  for (const f of flows) {
    const production = prod?.flowId === f.id && prodNodes.length > 0;
    const nodes = [...new Set([...nodesOf(f.graph), ...(prod?.flowId === f.id ? prodNodes : [])])];
    if (nodes.length) out.push({ id: f.id, name: f.name, nodes, production });
  }
  return out.sort((a, b) => Number(b.production) - Number(a.production) || a.name.localeCompare(b.name));
}

const num = (v: unknown) => (v == null ? null : Number(v));

/** Chamadas, erros e latencia dos spans que casam com `match`, nos ultimos `days` dias. */
export async function spanStats(match: SQL, days: number) {
  const s = schema.span;
  const since = new Date(Date.now() - days * 86_400_000);
  const where = and(gte(s.startedAt, since), match);
  const [tot] = await db
    .select({
      calls: sql<number>`count(*)::int`,
      errors: sql<number>`count(*) filter (where ${s.status} = 'error')::int`,
      avgMs: sql<number | null>`avg(${s.ms})`,
      p95Ms: sql<number | null>`percentile_cont(0.95) within group (order by ${s.ms})`,
      lastAt: sql<Date | null>`max(${s.startedAt})`.mapWith(s.startedAt),
      runs: sql<number>`count(distinct ${s.runId})::int`,
    })
    .from(s)
    .where(where);
  const daily = await db
    .select({ day: sql<string>`to_char(date_trunc('day', ${s.startedAt}), 'YYYY-MM-DD')`, calls: sql<number>`count(*)::int`, errors: sql<number>`count(*) filter (where ${s.status} = 'error')::int` })
    .from(s)
    .where(where)
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  const byName = await db
    .select({ name: s.name, calls: sql<number>`count(*)::int`, errors: sql<number>`count(*) filter (where ${s.status} = 'error')::int`, avgMs: sql<number | null>`avg(${s.ms})` })
    .from(s)
    .where(where)
    .groupBy(s.name)
    .orderBy(desc(sql`2`));
  const recentErrors = await db
    .select({ runId: s.runId, name: s.name, error: s.error, input: s.input, at: s.startedAt })
    .from(s)
    .where(and(where, eq(s.status, "error")))
    .orderBy(desc(s.startedAt))
    .limit(8);
  return {
    days,
    calls: tot.calls,
    errors: tot.errors,
    runs: tot.runs,
    avgMs: num(tot.avgMs),
    p95Ms: num(tot.p95Ms),
    lastAt: tot.lastAt,
    daily,
    byName: byName.map((r) => ({ ...r, avgMs: num(r.avgMs) })),
    recentErrors,
  };
}

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { RunEvent, SpanRecord } from "../shared/graph.js";

// Barramento em memoria por execucao. O cliente abre o SSE DEPOIS de receber o
// runId do POST, entao os eventos ficam num buffer ate a execucao terminar (+1
// min): sem ele, os primeiros spans (Entrada, Classificador) se perdiam entre a
// resposta do POST e a conexao do EventSource.
interface Channel {
  emitter: EventEmitter;
  buffer: RunEvent[];
  done: boolean;
}
const channels = new Map<string, Channel>();

export function channel(runId: string): Channel {
  let ch = channels.get(runId);
  if (!ch) {
    ch = { emitter: new EventEmitter(), buffer: [], done: false };
    ch.emitter.setMaxListeners(50);
    channels.set(runId, ch);
  }
  return ch;
}

export function hasChannel(runId: string) {
  return channels.has(runId);
}

export function publish(runId: string, event: RunEvent) {
  const ch = channel(runId);
  ch.buffer.push(event);
  ch.emitter.emit("event", event);
  if (event.type === "done") {
    ch.done = true;
    setTimeout(() => channels.delete(runId), 60_000).unref();
  }
}

export interface SpanStart {
  kind: SpanRecord["kind"];
  name: string;
  parentId?: string | null;
  nodeId?: string | null;
  input?: unknown;
  modelId?: string | null;
}

export interface SpanEnd {
  output?: unknown;
  status?: SpanRecord["status"];
  error?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  modelId?: string | null;
}

export class Span {
  private t0 = Date.now();
  constructor(
    private tracer: RunTracer,
    public record: SpanRecord,
  ) {}
  get id() {
    return this.record.id;
  }
  async end(e: SpanEnd = {}) {
    const r = this.record;
    Object.assign(r, {
      output: e.output ?? r.output,
      status: e.status ?? "ok",
      error: e.error ?? null,
      ms: Date.now() - this.t0,
      tokensIn: e.tokensIn ?? r.tokensIn,
      tokensOut: e.tokensOut ?? r.tokensOut,
      costUsd: e.costUsd ?? r.costUsd,
      modelId: e.modelId ?? r.modelId,
    });
    await db
      .update(schema.span)
      .set({
        output: toJson(r.output),
        status: r.status,
        error: r.error,
        ms: r.ms,
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
        costUsd: r.costUsd,
        modelId: r.modelId,
      })
      .where(eq(schema.span.id, r.id));
    publish(r.runId, { type: "span.end", span: { ...r } });
  }
  async fail(err: unknown, output?: unknown) {
    await this.end({ status: "error", error: errorMessage(err), output });
  }
}

export class RunTracer {
  private seq = 0;
  constructor(public runId: string) {}

  async start(s: SpanStart): Promise<Span> {
    const record: SpanRecord = {
      id: randomUUID(),
      runId: this.runId,
      parentId: s.parentId ?? null,
      nodeId: s.nodeId ?? null,
      kind: s.kind,
      name: s.name,
      input: s.input ?? null,
      output: null,
      status: "running",
      error: null,
      startedAt: new Date().toISOString(),
      ms: null,
      modelId: s.modelId ?? null,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      seq: ++this.seq,
    };
    await db.insert(schema.span).values({
      id: record.id,
      runId: record.runId,
      parentId: record.parentId,
      nodeId: record.nodeId,
      kind: record.kind,
      name: record.name,
      input: toJson(record.input),
      status: "running",
      startedAt: new Date(record.startedAt),
      modelId: record.modelId,
      seq: record.seq,
    });
    publish(this.runId, { type: "span.start", span: { ...record } });
    return new Span(this, record);
  }

  /** Atalho: abre, roda, fecha. Erro fecha o span como erro e propaga. */
  async wrap<T>(s: SpanStart, fn: (span: Span) => Promise<T>, toOutput: (r: T) => unknown = (r) => r): Promise<T> {
    const span = await this.start(s);
    try {
      const result = await fn(span);
      if (span.record.status === "running") await span.end({ output: toOutput(result) });
      return result;
    } catch (err) {
      if (span.record.status === "running") await span.fail(err);
      throw err;
    }
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// jsonb nao aceita undefined nem ciclos; Error vira objeto vazio no JSON.stringify.
function toJson(v: unknown): unknown {
  if (v === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(v, (_k, val) => (val instanceof Error ? { error: val.message } : val)));
  } catch {
    return { unserializable: String(v) };
  }
}

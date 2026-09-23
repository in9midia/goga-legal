import { and, asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { flowGraphSchema, type FlowGraph } from "../shared/graph.js";
import { HttpError, notFound } from "../lib/errors.js";
import type { SessionUser } from "../lib/auth.js";
import type { RunContext } from "./context.js";
import { executeTurn, type TurnInput, type TurnOutcome } from "./executor.js";
import { RunTracer, errorMessage, publish } from "./tracer.js";

export interface RunTarget {
  flowId: string | null;
  useProduction: boolean;
}

/** Resolve o grafo que vai rodar: o rascunho atual do fluxo ou a release de producao. */
export async function resolveTarget(t: RunTarget) {
  if (t.useProduction) {
    const [p] = await db
      .select({ release: schema.flowRelease, flowName: schema.flow.name })
      .from(schema.production)
      .innerJoin(schema.flowRelease, eq(schema.production.flowReleaseId, schema.flowRelease.id))
      .innerJoin(schema.flow, eq(schema.flowRelease.flowId, schema.flow.id))
      .where(eq(schema.production.id, 1));
    if (!p) throw new HttpError(400, "Nenhum fluxo publicado em produção.");
    return { flowId: p.release.flowId, flowName: p.flowName, revision: p.release.revision, releaseId: p.release.id, graph: flowGraphSchema.parse(p.release.graph), isProduction: true };
  }
  if (!t.flowId) throw new HttpError(400, "Escolha um fluxo.");
  const [f] = await db.select().from(schema.flow).where(eq(schema.flow.id, t.flowId));
  if (!f) throw notFound("fluxo");
  return { flowId: f.id, flowName: f.name, revision: f.revision, releaseId: null, graph: flowGraphSchema.parse(f.graph), isProduction: false };
}

export async function startTurn(args: {
  user: SessionUser;
  sessionId: string;
  message: string;
  fileIds: string[];
  target: RunTarget;
}): Promise<{ runId: string; messageId: string }> {
  const target = await resolveTarget(args.target);
  const rows = await db
    .select({ role: schema.message.role, content: schema.message.content, payload: schema.message.payload, attachments: schema.message.attachments })
    .from(schema.message)
    .where(eq(schema.message.sessionId, args.sessionId))
    .orderBy(asc(schema.message.createdAt));
  // Anexo vale para a conversa inteira, nao so para o turno em que foi enviado:
  // o usuario manda o PDF, o Goga pergunta algo e so a resposta seguinte chega
  // ao especialista que precisa ler o arquivo.
  const priorIds = rows.filter((m) => m.role === "user").flatMap((m) => m.attachments ?? []);
  const allIds = [...new Set([...priorIds, ...args.fileIds])];
  const sessionFiles = allIds.length
    ? await db
        .select()
        .from(schema.file)
        .where(and(inArray(schema.file.id, allIds), eq(schema.file.sessionId, args.sessionId)))
    : [];
  const nameOf = new Map(sessionFiles.map((f) => [f.id, f.name]));
  const history = rows.map(({ payload, attachments, ...m }) => ({
    ...m,
    status: (payload as { status?: string } | null)?.status ?? null,
    anexos: m.role === "user" ? (attachments ?? []).flatMap((id) => nameOf.get(id) ?? []) : [],
  }));
  const files = sessionFiles.filter((f) => args.fileIds.includes(f.id));

  const [runRow] = await db
    .insert(schema.run)
    .values({
      flowId: target.flowId,
      flowName: target.flowName,
      flowRevision: target.revision,
      flowReleaseId: target.releaseId,
      graph: target.graph,
      isProduction: target.isProduction,
      sessionId: args.sessionId,
      userId: args.user.id,
      question: args.message,
    })
    .returning();
  const [msg] = await db
    .insert(schema.message)
    .values({ sessionId: args.sessionId, role: "user", content: args.message, attachments: files.map((f) => f.id), runId: runRow.id })
    .returning();
  if (history.length === 0) {
    await db.update(schema.chatSession).set({ title: args.message.slice(0, 80) }).where(eq(schema.chatSession.id, args.sessionId));
  }

  const ctx: RunContext = {
    runId: runRow.id,
    userId: args.user.id,
    flowId: target.flowId,
    sessionId: args.sessionId,
    graph: target.graph,
    tracer: new RunTracer(runRow.id),
    aborted: false,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    maxRunCostUsd: target.graph.settings.maxRunCostUsd || 0.5,
    files: sessionFiles.map((f) => ({ id: f.id, name: f.name, mime: f.mime, text: f.extractedText ?? "" })),
    generated: [],
  };

  // Execucao EM PROCESSO, sem fila (decisao de arquitetura do MVP). O POST
  // devolve o runId na hora e o progresso sai pelo SSE.
  void runInBackground(ctx, { message: args.message, history }, msg.id);
  return { runId: runRow.id, messageId: msg.id };
}

async function runInBackground(ctx: RunContext, input: TurnInput, _userMsgId: string) {
  let outcome: TurnOutcome | null = null;
  let error: string | null = null;
  try {
    outcome = await executeTurn(ctx, input);
  } catch (err) {
    error = errorMessage(err);
  }
  const status = outcome?.status ?? "error";
  await db
    .update(schema.run)
    .set({ status, error, outcome: outcome ?? null, endedAt: new Date(), costUsd: ctx.costUsd, tokensIn: ctx.tokensIn, tokensOut: ctx.tokensOut })
    .where(eq(schema.run.id, ctx.runId));
  const [assistant] = await db
    .insert(schema.message)
    .values({
      sessionId: ctx.sessionId!,
      role: "assistant",
      content: outcome?.resposta_simples ?? `Falha na execução: ${error}`,
      payload: outcome ?? { error },
      attachments: (outcome?.documentos ?? []).map((d) => d.fileId),
      runId: ctx.runId,
    })
    .returning();
  publish(ctx.runId, { type: "done", runId: ctx.runId, status, messageId: assistant.id });
}

/** Execucao sem sessao de chat (lote de avaliacao, teste de integracao). */
export async function runOnce(args: { user: SessionUser | null; graph: FlowGraph; flowId: string | null; flowName: string; revision: number; message: string }) {
  const [runRow] = await db
    .insert(schema.run)
    .values({ flowId: args.flowId, flowName: args.flowName, flowRevision: args.revision, graph: args.graph, userId: args.user?.id ?? null, question: args.message })
    .returning();
  const ctx: RunContext = {
    runId: runRow.id,
    userId: args.user?.id ?? null,
    flowId: args.flowId,
    sessionId: null,
    graph: args.graph,
    tracer: new RunTracer(runRow.id),
    aborted: false,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    maxRunCostUsd: args.graph.settings.maxRunCostUsd || 0.5,
    files: [],
    generated: [],
  };
  let outcome: TurnOutcome | null = null;
  let error: string | null = null;
  try {
    outcome = await executeTurn(ctx, { message: args.message, history: [] });
  } catch (err) {
    error = errorMessage(err);
  }
  await db
    .update(schema.run)
    .set({ status: outcome?.status ?? "error", error, outcome, endedAt: new Date(), costUsd: ctx.costUsd, tokensIn: ctx.tokensIn, tokensOut: ctx.tokensOut })
    .where(eq(schema.run.id, ctx.runId));
  publish(ctx.runId, { type: "done", runId: ctx.runId, status: outcome?.status ?? "error" });
  return { runId: runRow.id, outcome, error, costUsd: ctx.costUsd };
}

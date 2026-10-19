import { and, asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { flowGraphSchema, type FlowGraph } from "../shared/graph.js";
import { HttpError, notFound } from "../lib/errors.js";
import type { SessionUser } from "../lib/auth.js";
import type { RunContext } from "./context.js";
import { executeTurn, readCase, type TurnInput, type TurnOutcome } from "./executor.js";
import { RunTracer, errorMessage, publish } from "./tracer.js";
import { CancelledError } from "../llm/call.js";

/** Execucoes em andamento neste processo: o pedido de parar chega por aqui. */
const live = new Map<string, { ctx: RunContext; abort: AbortController }>();

function track(ctx: RunContext) {
  const abort = new AbortController();
  ctx.signal = abort.signal;
  live.set(ctx.runId, { ctx, abort });
}

/**
 * Pedido de parar: a chamada a modelo em curso e abortada e a proxima e
 * recusada. O turno fecha como erro "interrompida pelo usuario", com o que ja
 * rodou no trace. Devolve false se a execucao nao esta rodando neste processo.
 */
export function cancelRun(runId: string): boolean {
  const r = live.get(runId);
  if (!r) return false;
  r.ctx.aborted = true;
  r.abort.abort(new CancelledError());
  return true;
}

export function isLive(runId: string) {
  return live.has(runId);
}

/**
 * Execucao e em processo: o reinicio do pod (deploy, OOM) deixava o run em
 * `running` para sempre e a conversa esperando uma resposta que nunca vem. No
 * boot, antes de aceitar requisicoes, todo run ainda `running` vira erro e a
 * conversa ganha a mensagem de falha. Uma replica so (chart): nenhum outro
 * processo pode estar executando estes runs.
 */
export async function reapOrphanRuns(): Promise<number> {
  const error = "Execução interrompida: o servidor reiniciou durante o turno. Envie a mensagem de novo.";
  const rows = await db.update(schema.run).set({ status: "error", error, endedAt: new Date() }).where(eq(schema.run.status, "running")).returning({ id: schema.run.id, sessionId: schema.run.sessionId });
  for (const r of rows) {
    if (!r.sessionId) continue;
    const [answered] = await db.select({ id: schema.message.id }).from(schema.message).where(and(eq(schema.message.runId, r.id), eq(schema.message.role, "assistant")));
    if (!answered) await db.insert(schema.message).values({ sessionId: r.sessionId, role: "assistant", content: `Falha na execução: ${error}`, payload: { error }, runId: r.id });
  }
  return rows.length;
}

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
  const history = rows.map(({ payload, attachments, ...m }) => {
    const p = payload as { status?: string; pendencia?: string } | null;
    return {
      ...m,
      // Pergunta por campo de documento nao e esclarecimento do caso: nao
      // entra na contagem nem na lista de perguntas do classificador.
      status: p?.pendencia === "documento" ? "clarify_documento" : (p?.status ?? null),
      anexos: m.role === "user" ? (attachments ?? []).flatMap((id) => nameOf.get(id) ?? []) : [],
    };
  });
  // Estado do caso: o do ultimo turno que o salvou (turno com erro nao tem).
  const caso = rows.filter((m) => m.role === "assistant").map((m) => readCase(m.payload)).filter((c) => c !== null).at(-1) ?? null;
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
  track(ctx);
  void runInBackground(ctx, { message: args.message, history, caso }, msg.id);
  return { runId: runRow.id, messageId: msg.id };
}

/** O motivo da falha. Pedido de parar ganha a mesma mensagem, qualquer que seja o erro que ele provocou. */
const failureOf = (ctx: RunContext, err: unknown) => (ctx.aborted ? new CancelledError().message : errorMessage(err));

async function runInBackground(ctx: RunContext, input: TurnInput, _userMsgId: string) {
  let outcome: TurnOutcome | null = null;
  let error: string | null = null;
  let status: string = "error";
  let messageId: string | undefined;
  try {
    try {
      outcome = await executeTurn(ctx, input);
    } catch (err) {
      error = failureOf(ctx, err);
    }
    status = outcome?.status ?? "error";
    await db
      .update(schema.run)
      .set({ status: status as TurnOutcome["status"], error, outcome: outcome ?? null, endedAt: new Date(), costUsd: ctx.costUsd, tokensIn: ctx.tokensIn, tokensOut: ctx.tokensOut })
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
    messageId = assistant.id;
  } catch (err) {
    // Banco fora no fim do turno: o `done` ainda sai, senao a tela espera para sempre.
    console.error(`[run ${ctx.runId}] falha ao gravar o desfecho: ${errorMessage(err)}`);
    status = "error";
  } finally {
    live.delete(ctx.runId);
    publish(ctx.runId, { type: "done", runId: ctx.runId, status, ...(messageId ? { messageId } : {}) });
  }
}

/** Execucao sem sessao de chat (lote de avaliacao, teste de integracao). */
export async function runOnce(args: { user: SessionUser | null; graph: FlowGraph; flowId: string | null; flowName: string; revision: number; message: string; history?: TurnInput["history"]; caso?: TurnInput["caso"] }) {
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
  track(ctx);
  try {
    outcome = await executeTurn(ctx, { message: args.message, history: args.history ?? [], caso: args.caso ?? null });
  } catch (err) {
    error = failureOf(ctx, err);
  } finally {
    live.delete(ctx.runId);
  }
  await db
    .update(schema.run)
    .set({ status: outcome?.status ?? "error", error, outcome, endedAt: new Date(), costUsd: ctx.costUsd, tokensIn: ctx.tokensIn, tokensOut: ctx.tokensOut })
    .where(eq(schema.run.id, ctx.runId));
  publish(ctx.runId, { type: "done", runId: ctx.runId, status: outcome?.status ?? "error" });
  return { runId: runRow.id, outcome, error, costUsd: ctx.costUsd };
}

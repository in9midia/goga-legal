import type { FastifyInstance } from "fastify";
import { streamText, stepCountIs, type ModelMessage, type ToolModelMessage, type UserContent } from "ai";
import { asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { SessionUser } from "../lib/auth.js";
import { HttpError } from "../lib/errors.js";
import { costOf, resolveModel } from "../llm/models.js";
import { readFileData } from "../files/storage.js";
import { errorMessage } from "../engine/tracer.js";
import { assistantSystem } from "./prompt.js";
import { ASK_TOOL, SENSITIVE, StudioApi, buildTools, clipStr, type ToolCtx } from "./tools.js";

// Um turno do Assistente: resolve o que ficou pendente no turno anterior
// (resposta a uma pergunta, aprovacao de acao sensivel), grava a mensagem do
// usuario e roda o laco de ferramentas em streaming. Cada evento vai para a UI
// como uma linha NDJSON; o que fica no banco e o estado final.

export type Part =
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; input: unknown; status: "running" | "ok" | "error"; output?: string; error?: string }
  | { type: "ask"; id: string; pergunta: string; opcoes: { rotulo: string; descricao?: string }[]; multipla: boolean; permitirOutro: boolean; status: "pending" | "answered" | "skipped"; resposta?: string[] }
  | { type: "approval"; id: string; name: string; input: unknown; resumo: string; status: "pending" | "approved" | "denied" | "skipped"; output?: string; error?: string }
  | { type: "display"; id: string; input: Record<string, unknown> }
  | { type: "error"; text: string };

export type TurnEvent =
  | { type: "user"; message: unknown }
  | { type: "resolved"; messageId: string; parts: Part[] }
  | { type: "text"; text: string }
  | { type: "part"; part: Part }
  | { type: "done"; message: unknown }
  | { type: "error"; error: string };

export interface Resolution {
  id: string;
  resposta?: string[];
  aprovado?: boolean;
}

type MsgRow = typeof schema.assistantMessage.$inferSelect;

const MAX_STEPS = 30;
const ATTACH_CHARS = 20_000;
const UI_OUTPUT_CHARS = 6_000;
const IMAGE_REF = "studio-file:";

const show = (v: unknown) => clipStr(typeof v === "string" ? v : JSON.stringify(v, null, 2), UI_OUTPUT_CHARS);

export const publicMessage = ({ llm: _llm, ...m }: MsgRow) => m;

/** Historico de um turno que nao terminou: o que foi dito e o que ja foi executado, para o modelo nao refazer nem ignorar. */
function interruptedSummary(parts: Part[], reason: string): ModelMessage[] {
  const said = parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("");
  const done = parts
    .filter((p): p is Extract<Part, { type: "tool" }> => p.type === "tool" && p.status === "ok")
    .map((p) => `- ${p.name} ${clipStr(JSON.stringify(p.input), 300)}`);
  return [{ role: "assistant", content: `${said}\n\n[turno interrompido: ${reason}. Ações já executadas (confira o estado antes de repetir):\n${done.join("\n") || "- nenhuma"}]` }];
}

/** No boot: respostas que ficaram "running" pertenciam a um processo que morreu. */
export async function recoverInterruptedTurns(): Promise<number> {
  const rows = await db.select().from(schema.assistantMessage).where(eq(schema.assistantMessage.status, "running"));
  for (const r of rows) {
    const parts = (r.parts as Part[]).map((p) =>
      p.type === "tool" && p.status === "running" ? { ...p, status: "error" as const, error: "interrompido" } : (p.type === "ask" || p.type === "approval") && p.status === "pending" ? { ...p, status: "skipped" as const } : p,
    );
    const reason = "a API reiniciou no meio do turno";
    await db
      .update(schema.assistantMessage)
      .set({ status: "done", parts: [...parts, { type: "error", text: reason }], llm: interruptedSummary(parts, reason), content: parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n\n") })
      .where(eq(schema.assistantMessage.id, r.id));
  }
  return rows.length;
}

/** Troca a referencia de imagem gravada no historico pelo conteudo do arquivo (ou a remove, se o modelo nao ve imagem). */
async function hydrate(messages: ModelMessage[], vision: boolean): Promise<ModelMessage[]> {
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role !== "user" || typeof m.content === "string") {
      out.push(m);
      continue;
    }
    const parts: UserContent = [];
    for (const p of m.content) {
      if (p.type === "image" && typeof p.image === "string" && p.image.startsWith(IMAGE_REF)) {
        if (!vision) continue;
        const [f] = await db.select().from(schema.file).where(eq(schema.file.id, p.image.slice(IMAGE_REF.length)));
        if (f) parts.push({ type: "image", image: await readFileData(f), mediaType: f.mime });
      } else parts.push(p);
    }
    out.push({ ...m, content: parts });
  }
  return out;
}

export async function runAssistantTurn(args: {
  app: FastifyInstance;
  cookie: string;
  user: SessionUser;
  sessionId: string;
  content: string;
  fileIds: string[];
  resolutions: Resolution[];
  signal: AbortSignal;
  emit: (e: TurnEvent) => void;
}): Promise<void> {
  const { user, emit } = args;
  const [session] = await db.select().from(schema.assistantSession).where(eq(schema.assistantSession.id, args.sessionId));
  if (!session) throw new HttpError(404, "conversa não encontrada");
  if (!session.modelId) throw new HttpError(400, "Escolha um modelo para o assistente.");
  const resolved = await resolveModel(session.modelId);
  if (resolved.row.purpose === "embedding") throw new HttpError(400, "Modelo de embedding não conversa; escolha um modelo de chat.");
  const vision = resolved.provider.kind === "gemini" || resolved.row.purpose === "vision";
  const ctx: ToolCtx = { api: new StudioApi(args.app, args.cookie), user };

  const rows = await db.select().from(schema.assistantMessage).where(eq(schema.assistantMessage.sessionId, session.id)).orderBy(asc(schema.assistantMessage.createdAt));

  // 1. Pendencias do turno anterior viram resultado de ferramenta.
  const last = [...rows].reverse().find((r) => r.role === "assistant");
  const answered = new Set(
    ((last?.llm ?? []) as ModelMessage[]).flatMap((m) => (m.role === "tool" ? m.content.filter((c) => c.type === "tool-result").map((c) => c.toolCallId) : [])),
  );
  const pending = ((last?.parts ?? []) as Part[]).filter(
    (p): p is Extract<Part, { type: "ask" | "approval" }> => (p.type === "ask" || p.type === "approval") && p.status === "pending" && !answered.has(p.id),
  );
  if (last && pending.length) {
    const results: ToolModelMessage["content"] = [];
    for (const p of pending) {
      const r = args.resolutions.find((x) => x.id === p.id);
      let value: unknown;
      if (p.type === "ask") {
        if (r?.resposta?.length) {
          p.status = "answered";
          p.resposta = r.resposta;
          value = { resposta: r.resposta };
        } else {
          p.status = "skipped";
          value = { resposta: null, observacao: "o usuário não escolheu; seguiu com outra mensagem" };
        }
      } else if (r?.aprovado) {
        p.status = "approved";
        try {
          const out = await SENSITIVE[p.name].run(p.input as Record<string, unknown>, ctx);
          p.output = show(out);
          value = { aprovado: true, resultado: out };
        } catch (err) {
          p.error = errorMessage(err);
          value = { aprovado: true, erro: p.error };
        }
      } else {
        p.status = r ? "denied" : "skipped";
        value = { aprovado: false, observacao: r ? "o usuário NEGOU esta ação; não a repita por outro caminho" : "o usuário não decidiu; seguiu com outra mensagem" };
      }
      results.push({ type: "tool-result", toolCallId: p.id, toolName: p.type === "ask" ? ASK_TOOL : p.name, output: { type: "json", value: JSON.parse(JSON.stringify(value ?? null)) } });
    }
    const llm = [...(last.llm as ModelMessage[]), { role: "tool", content: results } satisfies ToolModelMessage];
    await db.update(schema.assistantMessage).set({ parts: last.parts, llm }).where(eq(schema.assistantMessage.id, last.id));
    last.llm = llm;
    emit({ type: "resolved", messageId: last.id, parts: last.parts as Part[] });
  }

  // 2. Mensagem do usuario (texto + anexos).
  const text = args.content.trim();
  if (text || args.fileIds.length) {
    const files = args.fileIds.length ? await db.select().from(schema.file).where(inArray(schema.file.id, args.fileIds)) : [];
    let body = text || "(anexos)";
    const content: UserContent = [];
    for (const f of files) {
      const extracted = f.extractedText?.trim();
      body += `\n\n### Anexo: ${f.name} (fileId: ${f.id}, ${f.mime})\n${extracted ? clipStr(extracted, ATTACH_CHARS) : "(sem texto extraído)"}`;
      if (f.mime.startsWith("image/")) content.push({ type: "image", image: `${IMAGE_REF}${f.id}`, mediaType: f.mime });
    }
    content.unshift({ type: "text", text: body });
    const [u] = await db
      .insert(schema.assistantMessage)
      .values({ sessionId: session.id, role: "user", content: text, attachments: files.map((f) => f.id), llm: [{ role: "user", content }] })
      .returning();
    rows.push(u);
    emit({ type: "user", message: publicMessage(u) });
    if (session.title === "Nova conversa" && text) {
      await db.update(schema.assistantSession).set({ title: text.replace(/\s+/g, " ").slice(0, 70) }).where(eq(schema.assistantSession.id, session.id));
    }
  } else if (!pending.length) {
    throw new HttpError(400, "mensagem vazia");
  }
  await db.update(schema.assistantSession).set({ updatedAt: new Date() }).where(eq(schema.assistantSession.id, session.id));

  // 3. Laco do agente. A resposta ja nasce no banco ("running") e e gravada
  // aos poucos: se a API cair no meio, o que foi feito continua visivel.
  const history = await hydrate(rows.flatMap((r) => r.llm as ModelMessage[]), vision);
  const [row] = await db.insert(schema.assistantMessage).values({ sessionId: session.id, role: "assistant", status: "running", modelId: resolved.row.id }).returning({ id: schema.assistantMessage.id });
  const parts: Part[] = [];
  const byId = new Map<string, Part>();
  let saving: Promise<unknown> = Promise.resolve();
  let lastSave = 0;
  const persist = (force = false) => {
    if (!force && Date.now() - lastSave < 1500) return;
    lastSave = Date.now();
    const snapshot = JSON.parse(JSON.stringify(parts)) as Part[];
    saving = saving.then(() => db.update(schema.assistantMessage).set({ parts: snapshot }).where(eq(schema.assistantMessage.id, row.id))).catch(() => undefined);
  };
  const put = (p: Part) => {
    parts.push(p);
    if ("id" in p) byId.set(p.id, p);
    emit({ type: "part", part: p });
    persist(true);
  };
  let usage = { in: 0, out: 0, cache: 0 };
  let failure: string | null = null;
  const result = streamText({
    model: resolved.model,
    system: assistantSystem(user, resolved.row.label),
    messages: history,
    tools: buildTools(ctx),
    stopWhen: stepCountIs(MAX_STEPS),
    maxRetries: 1,
    abortSignal: args.signal,
  });
  try {
    for await (const ev of result.fullStream) {
      switch (ev.type) {
        case "text-delta": {
          const tail = parts[parts.length - 1];
          if (tail?.type === "text") tail.text += ev.text;
          else parts.push({ type: "text", text: ev.text });
          emit({ type: "text", text: ev.text });
          persist();
          break;
        }
        case "tool-call": {
          const input = ev.input as Record<string, unknown>;
          if (ev.toolName === ASK_TOOL) {
            put({ type: "ask", id: ev.toolCallId, pergunta: String(input.pergunta ?? ""), opcoes: (input.opcoes as { rotulo: string }[]) ?? [], multipla: !!input.multipla, permitirOutro: input.permitirOutro !== false, status: "pending" });
          } else if (SENSITIVE[ev.toolName]) {
            put({ type: "approval", id: ev.toolCallId, name: ev.toolName, input, resumo: SENSITIVE[ev.toolName].resumo(input), status: "pending" });
          } else if (ev.toolName === "exibir") {
            put({ type: "display", id: ev.toolCallId, input });
          } else {
            put({ type: "tool", id: ev.toolCallId, name: ev.toolName, input, status: "running" });
          }
          break;
        }
        case "tool-result": {
          const p = byId.get(ev.toolCallId);
          if (p?.type === "tool") {
            p.status = "ok";
            p.output = show(ev.output);
            emit({ type: "part", part: p });
            persist(true);
          }
          break;
        }
        case "tool-error": {
          const p = byId.get(ev.toolCallId);
          const msg = errorMessage(ev.error);
          if (p?.type === "tool") {
            p.status = "error";
            p.error = msg;
            emit({ type: "part", part: p });
            persist(true);
          } else if (p?.type === "display") {
            put({ type: "error", text: `exibir: ${msg}` });
          } else if (p?.type === "ask" || p?.type === "approval") {
            // Entrada invalida: o SDK ja gravou o erro como resultado; nao pode
            // ficar "pending", senao o proximo turno responde a chamada de novo.
            p.status = "skipped";
            emit({ type: "part", part: p });
            persist(true);
          }
          break;
        }
        case "finish":
          usage = { in: ev.totalUsage.inputTokens ?? 0, out: ev.totalUsage.outputTokens ?? 0, cache: ev.totalUsage.inputTokenDetails?.cacheReadTokens ?? 0 };
          break;
        case "abort":
          failure = "interrompido pelo usuário";
          break;
        case "error":
          failure = errorMessage(ev.error);
          break;
      }
    }
  } catch (err) {
    failure = args.signal.aborted ? "interrompido pelo usuário" : errorMessage(err);
  }

  let llm: ModelMessage[] = [];
  if (!failure) {
    try {
      llm = (await result.responseMessages) as ModelMessage[];
    } catch (err) {
      failure = errorMessage(err);
    }
  }
  if (failure) {
    // Historico parcial (chamada de ferramenta sem resultado) quebraria o
    // proximo turno; no lugar dele fica um resumo do que chegou a acontecer.
    for (const p of parts) if (p.type === "tool" && p.status === "running") p.status = "error";
    for (const p of parts) if (p.type === "ask" || p.type === "approval") p.status = "skipped";
    llm = interruptedSummary(parts, failure);
    parts.push({ type: "error", text: failure });
  }

  const cost = costOf(resolved.row, usage.in, usage.out, usage.cache);
  if (usage.in || usage.out) {
    await db.insert(schema.usage).values({
      userId: user.id,
      providerId: resolved.provider.id,
      modelId: resolved.row.id,
      operation: "assistente",
      nodeName: "Assistente do Studio",
      tokensIn: usage.in,
      tokensOut: usage.out,
      tokensCache: usage.cache,
      costUsd: cost,
    });
  }
  await saving;
  const [saved] = await db
    .update(schema.assistantMessage)
    .set({
      status: "done",
      content: parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n\n"),
      parts,
      llm,
      costUsd: cost,
      tokensIn: usage.in,
      tokensOut: usage.out,
    })
    .where(eq(schema.assistantMessage.id, row.id))
    .returning();
  emit({ type: "done", message: publicMessage(saved) });
}

import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { requireUser } from "../lib/auth.js";
import { badRequest, notFound } from "../lib/errors.js";
import { saveFile, readFileData } from "../files/storage.js";
import { extractText } from "../files/extract.js";
import { startTurn } from "../engine/run.js";
import { channel, hasChannel } from "../engine/tracer.js";
import type { RunEvent, SpanRecord } from "../shared/graph.js";

const MAX_UPLOAD = 25 * 1024 * 1024;
const ALLOWED = /^(application\/pdf|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|text\/.*|image\/(png|jpe?g|webp))$/;

export async function sessionRoutes(app: FastifyInstance) {
  app.get("/api/v1/sessions", async (req) => {
    const me = requireUser(req);
    const rows = await db
      .select({ s: schema.chatSession, flowName: schema.flow.name })
      .from(schema.chatSession)
      .leftJoin(schema.flow, eq(schema.chatSession.flowId, schema.flow.id))
      .where(eq(schema.chatSession.userId, me.id))
      .orderBy(desc(schema.chatSession.createdAt))
      .limit(100);
    return { sessions: rows.map((r) => ({ ...r.s, flowName: r.flowName })) };
  });

  app.post("/api/v1/sessions", async (req) => {
    const me = requireUser(req);
    const b = z.object({ flowId: z.string().uuid().nullable().default(null), useProduction: z.boolean().default(false), title: z.string().optional() }).safeParse(req.body ?? {});
    if (!b.success) throw badRequest("dados inválidos");
    const [s] = await db.insert(schema.chatSession).values({ userId: me.id, flowId: b.data.flowId, useProduction: b.data.useProduction, title: b.data.title ?? "Nova conversa" }).returning();
    return { session: s };
  });

  const ownSession = async (id: string, userId: string) => {
    const [s] = await db.select().from(schema.chatSession).where(and(eq(schema.chatSession.id, id), eq(schema.chatSession.userId, userId)));
    if (!s) throw notFound("conversa");
    return s;
  };

  app.get<{ Params: { id: string } }>("/api/v1/sessions/:id", async (req) => {
    const me = requireUser(req);
    const s = await ownSession(req.params.id, me.id);
    const messages = await db.select().from(schema.message).where(eq(schema.message.sessionId, s.id)).orderBy(asc(schema.message.createdAt));
    const files = await db.select({ id: schema.file.id, name: schema.file.name, mime: schema.file.mime, size: schema.file.size, direction: schema.file.direction, extracted: schema.file.extractedText }).from(schema.file).where(eq(schema.file.sessionId, s.id));
    const runIds = messages.map((m) => m.runId).filter(Boolean) as string[];
    const runs = runIds.length ? await db.select({ id: schema.run.id, status: schema.run.status, costUsd: schema.run.costUsd, flowName: schema.run.flowName, flowRevision: schema.run.flowRevision, isProduction: schema.run.isProduction }).from(schema.run).where(inArray(schema.run.id, runIds)) : [];
    return { session: s, messages, files: files.map(({ extracted, ...f }) => ({ ...f, extractedChars: extracted?.length ?? 0 })), runs };
  });

  app.put<{ Params: { id: string } }>("/api/v1/sessions/:id", async (req) => {
    const me = requireUser(req);
    await ownSession(req.params.id, me.id);
    const b = z.object({ title: z.string().min(1).optional(), flowId: z.string().uuid().nullable().optional(), useProduction: z.boolean().optional() }).safeParse(req.body);
    if (!b.success) throw badRequest("dados inválidos");
    const [s] = await db.update(schema.chatSession).set(b.data).where(eq(schema.chatSession.id, req.params.id)).returning();
    return { session: s };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/sessions/:id", async (req) => {
    const me = requireUser(req);
    await ownSession(req.params.id, me.id);
    await db.delete(schema.chatSession).where(eq(schema.chatSession.id, req.params.id));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/v1/sessions/:id/files", async (req) => {
    const me = requireUser(req);
    const s = await ownSession(req.params.id, me.id);
    const part = await req.file({ limits: { fileSize: MAX_UPLOAD } });
    if (!part) throw badRequest("nenhum arquivo enviado");
    const data = await part.toBuffer();
    const mime = part.mimetype === "application/octet-stream" && part.filename.toLowerCase().endsWith(".docx") ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : part.mimetype;
    if (!ALLOWED.test(mime)) throw badRequest(`tipo de arquivo não aceito: ${mime} (PDF, DOCX, imagem ou texto)`);
    const ex = await extractText(data, mime, part.filename, me.id);
    const f = await saveFile({ sessionId: s.id, direction: "in", name: part.filename, mime, data, extractedText: ex.text });
    return { file: { id: f.id, name: f.name, mime: f.mime, size: f.size, direction: "in", extractedChars: ex.text.length, method: ex.method, warning: ex.warning } };
  });

  app.get<{ Params: { id: string } }>("/api/v1/files/:id", async (req, reply) => {
    const me = requireUser(req);
    const [f] = await db.select({ f: schema.file, owner: schema.chatSession.userId }).from(schema.file).leftJoin(schema.chatSession, eq(schema.file.sessionId, schema.chatSession.id)).where(eq(schema.file.id, req.params.id));
    // Arquivo de conversa so para o dono ou admin; arquivo de lote (sem
    // sessao) para qualquer usuario logado do Studio.
    if (!f || (f.owner && f.owner !== me.id && me.role !== "admin")) throw notFound("arquivo");
    const data = await readFileData(f.f);
    const q = req.query as { inline?: string };
    reply.header("content-type", f.f.mime);
    reply.header("content-disposition", `${q.inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.f.name)}`);
    return reply.send(data);
  });

  app.get<{ Params: { id: string } }>("/api/v1/files/:id/text", async (req) => {
    requireUser(req);
    const [f] = await db.select().from(schema.file).where(eq(schema.file.id, req.params.id));
    if (!f) throw notFound("arquivo");
    return { name: f.name, text: f.extractedText ?? "" };
  });

  app.post<{ Params: { id: string } }>("/api/v1/sessions/:id/messages", async (req) => {
    const me = requireUser(req);
    const s = await ownSession(req.params.id, me.id);
    const b = z
      .object({
        content: z.string().min(1).max(20000),
        fileIds: z.array(z.string().uuid()).default([]),
        // Permite "reexecutar com outro fluxo" sem trocar o fluxo da conversa.
        flowId: z.string().uuid().nullable().optional(),
        useProduction: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!b.success) throw badRequest("mensagem inválida");
    const target = {
      flowId: b.data.flowId !== undefined ? b.data.flowId : s.flowId,
      useProduction: b.data.useProduction ?? (b.data.flowId ? false : s.useProduction),
    };
    return startTurn({ user: me, sessionId: s.id, message: b.data.content, fileIds: b.data.fileIds, target });
  });

  // Reexecuta a mesma pergunta (e anexos) numa conversa NOVA com outro fluxo,
  // para comparar lado a lado sem contaminar o historico da original.
  app.post<{ Params: { id: string } }>("/api/v1/runs/:id/rerun", async (req) => {
    const me = requireUser(req);
    const b = z.object({ flowId: z.string().uuid().nullable().default(null), useProduction: z.boolean().default(false) }).safeParse(req.body);
    if (!b.success) throw badRequest("dados inválidos");
    const [r] = await db.select().from(schema.run).where(eq(schema.run.id, req.params.id));
    if (!r) throw notFound("execução");
    const [userMsg] = await db.select().from(schema.message).where(and(eq(schema.message.runId, r.id), eq(schema.message.role, "user")));
    const [s] = await db.insert(schema.chatSession).values({ userId: me.id, flowId: b.data.flowId, useProduction: b.data.useProduction, title: `Comparação: ${r.question.slice(0, 60)}` }).returning();
    // Anexos sao copiados por referencia de texto (novo registro, mesmo arquivo).
    const fileIds: string[] = [];
    for (const fid of userMsg?.attachments ?? []) {
      const [f] = await db.select().from(schema.file).where(eq(schema.file.id, fid));
      if (!f) continue;
      const [c] = await db.insert(schema.file).values({ ...f, id: undefined, sessionId: s.id, createdAt: undefined }).returning();
      fileIds.push(c.id);
    }
    const started = await startTurn({ user: me, sessionId: s.id, message: r.question, fileIds, target: b.data });
    return { sessionId: s.id, ...started };
  });

  app.get<{ Params: { id: string } }>("/api/v1/runs/:id/stream", async (req, reply) => {
    requireUser(req);
    const runId = req.params.id;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    const send = (e: RunEvent) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);

    if (!hasChannel(runId)) {
      // Execucao antiga (ou de outro processo): reproduz do banco e encerra.
      const [r] = await db.select().from(schema.run).where(eq(schema.run.id, runId));
      const spans = await db.select().from(schema.span).where(eq(schema.span.runId, runId)).orderBy(asc(schema.span.seq));
      for (const s of spans) send({ type: "span.end", span: spanRecord(s) });
      send({ type: "done", runId, status: r?.status ?? "error" });
      res.end();
      return;
    }
    const ch = channel(runId);
    for (const e of ch.buffer) send(e);
    if (ch.done) {
      res.end();
      return;
    }
    const onEvent = (e: RunEvent) => {
      send(e);
      if (e.type === "done") cleanup();
    };
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    const cleanup = () => {
      clearInterval(ping);
      ch.emitter.off("event", onEvent);
      res.end();
    };
    ch.emitter.on("event", onEvent);
    req.raw.on("close", cleanup);
  });
}

export function spanRecord(s: typeof schema.span.$inferSelect): SpanRecord {
  return { ...s, startedAt: s.startedAt.toISOString(), status: s.status, kind: s.kind } as SpanRecord;
}

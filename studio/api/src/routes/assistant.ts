import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { requireUser } from "../lib/auth.js";
import { badRequest, conflict, HttpError, notFound } from "../lib/errors.js";
import { defaultModelId } from "../llm/models.js";
import { readFileData, saveUpload } from "../files/storage.js";
import { config } from "../config.js";
import { extractText } from "../files/extract.js";
import { errorMessage } from "../engine/tracer.js";
import { publicMessage, runAssistantTurn, type TurnEvent } from "../assistant/agent.js";
import { isBusy, liveTurn, startLiveTurn } from "../assistant/live.js";
import { credentialsOf } from "../assistant/tools.js";

// Anexo pode ser um PDF grande a caminho da KB; a extracao de texto (que pode
// chamar o modelo de visao) so roda ate MAX_EXTRACT.
const MAX_UPLOAD = config.maxUploadMb * 1024 * 1024;
const MAX_EXTRACT = 25 * 1024 * 1024;
const ALLOWED = /^(application\/(pdf|json|x-yaml|yaml)|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|text\/.*|image\/(png|jpe?g|webp|gif))$/;

async function chatModels() {
  const rows = await db
    .select({ model: schema.model, providerName: schema.provider.name, providerKind: schema.provider.kind, providerActive: schema.provider.active, hasKey: schema.provider.apiKeyEnc })
    .from(schema.model)
    .innerJoin(schema.provider, eq(schema.model.providerId, schema.provider.id))
    .where(inArray(schema.model.purpose, ["chat", "vision"]))
    .orderBy(asc(schema.model.label));
  return rows.map((r) => ({
    id: r.model.id,
    label: r.model.label,
    modelId: r.model.modelId,
    purpose: r.model.purpose,
    providerName: r.providerName,
    providerKind: r.providerKind,
    isDefault: r.model.isDefault && r.model.purpose === "chat",
    supportsTools: r.model.supportsTools,
    vision: r.providerKind === "gemini" || r.model.purpose === "vision",
    priceInPer1m: r.model.priceInPer1m,
    priceOutPer1m: r.model.priceOutPer1m,
    usable: r.model.active && r.providerActive && (r.providerKind === "mock" || !!r.hasKey),
  }));
}

export async function assistantRoutes(app: FastifyInstance) {
  const own = async (id: string, userId: string) => {
    const [s] = await db.select().from(schema.assistantSession).where(and(eq(schema.assistantSession.id, id), eq(schema.assistantSession.userId, userId)));
    if (!s) throw notFound("conversa");
    return s;
  };

  app.get("/api/v1/assistant/models", async (req) => {
    requireUser(req);
    return { models: await chatModels() };
  });

  app.get("/api/v1/assistant/sessions", async (req) => {
    const me = requireUser(req);
    const rows = await db.select().from(schema.assistantSession).where(eq(schema.assistantSession.userId, me.id)).orderBy(desc(schema.assistantSession.updatedAt)).limit(100);
    return { sessions: rows };
  });

  app.post("/api/v1/assistant/sessions", async (req) => {
    const me = requireUser(req);
    const b = z.object({ modelId: z.string().uuid().nullable().optional() }).safeParse(req.body ?? {});
    if (!b.success) throw badRequest("dados inválidos");
    const modelId = b.data.modelId ?? (await defaultModelId("chat"));
    const [s] = await db.insert(schema.assistantSession).values({ userId: me.id, modelId }).returning();
    return { session: s };
  });

  app.get<{ Params: { id: string } }>("/api/v1/assistant/sessions/:id", async (req) => {
    const me = requireUser(req);
    const s = await own(req.params.id, me.id);
    const messages = await db.select().from(schema.assistantMessage).where(eq(schema.assistantMessage.sessionId, s.id)).orderBy(asc(schema.assistantMessage.createdAt));
    const ids = [...new Set(messages.flatMap((m) => m.attachments))];
    const files = ids.length ? await db.select({ id: schema.file.id, name: schema.file.name, mime: schema.file.mime, size: schema.file.size }).from(schema.file).where(inArray(schema.file.id, ids)) : [];
    return { session: s, messages: messages.map(publicMessage), files, busy: isBusy(s.id) };
  });

  app.put<{ Params: { id: string } }>("/api/v1/assistant/sessions/:id", async (req) => {
    const me = requireUser(req);
    await own(req.params.id, me.id);
    const b = z.object({ title: z.string().trim().min(1).max(200).optional(), modelId: z.string().uuid().optional() }).safeParse(req.body);
    if (!b.success) throw badRequest("dados inválidos");
    const [s] = await db.update(schema.assistantSession).set(b.data).where(eq(schema.assistantSession.id, req.params.id)).returning();
    return { session: s };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/assistant/sessions/:id", async (req) => {
    const me = requireUser(req);
    await own(req.params.id, me.id);
    await db.delete(schema.assistantSession).where(eq(schema.assistantSession.id, req.params.id));
    return { ok: true };
  });

  // Anexo do assistente: sem sessao do simulador (o arquivo nao entra em
  // nenhuma execucao do Goga). O texto e extraido no upload, como no simulador.
  app.post("/api/v1/assistant/files", async (req) => {
    const me = requireUser(req);
    const part = await req.file({ limits: { fileSize: MAX_UPLOAD } });
    if (!part) throw badRequest("nenhum arquivo enviado");
    const lower = part.filename.toLowerCase();
    let mime = part.mimetype;
    if (mime === "application/octet-stream") {
      if (lower.endsWith(".docx")) mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      else if (/\.(md|txt|csv|yaml|yml|json)$/.test(lower)) mime = "text/plain";
    }
    if (!ALLOWED.test(mime)) {
      part.file.resume();
      throw badRequest(`tipo de arquivo não aceito: ${mime} (PDF, DOCX, imagem, texto, JSON ou YAML)`);
    }
    // Grava em streaming; so le de volta para extrair o texto quando e pequeno.
    // Arquivo grande serve para ir para a KB, que extrai do jeito dela.
    const f = await saveUpload(part, { sessionId: null, mime }, MAX_UPLOAD);
    if (f.size > MAX_EXTRACT) {
      const warning = `arquivo grande (${Math.round(f.size / 1048576)} MB): o texto não foi extraído aqui; dá para enviá-lo à base de conhecimento`;
      return { file: { id: f.id, name: f.name, mime: f.mime, size: f.size, extractedChars: 0, method: "nenhum", warning } };
    }
    const data = await readFileData(f);
    const ex = mime.startsWith("application/") && !mime.includes("pdf") && !mime.includes("wordprocessing") ? { text: data.toString("utf8").slice(0, 200_000), method: "texto" } : await extractText(data, mime, part.filename, me.id);
    await db.update(schema.file).set({ extractedText: ex.text }).where(eq(schema.file.id, f.id));
    return { file: { id: f.id, name: f.name, mime: f.mime, size: f.size, extractedChars: ex.text.length, method: ex.method, warning: "warning" in ex ? ex.warning : undefined } };
  });

  // Dispara o turno e responde na hora; os eventos vem pelo /stream. Assim o
  // turno sobrevive a troca de tela, a recarga da pagina e a queda da conexao.
  app.post<{ Params: { id: string } }>("/api/v1/assistant/sessions/:id/turn", async (req, reply) => {
    const me = requireUser(req);
    const s = await own(req.params.id, me.id);
    const b = z
      .object({
        content: z.string().max(100_000).default(""),
        fileIds: z.array(z.string().uuid()).max(20).default([]),
        resolutions: z.array(z.object({ id: z.string(), resposta: z.array(z.string()).optional(), aprovado: z.boolean().optional() })).default([]),
        modelId: z.string().uuid().optional(),
      })
      .safeParse(req.body);
    if (!b.success) throw badRequest("mensagem inválida", b.error.issues);
    if (isBusy(s.id)) throw conflict("o assistente ainda está respondendo nesta conversa");
    if (b.data.modelId && b.data.modelId !== s.modelId) await db.update(schema.assistantSession).set({ modelId: b.data.modelId }).where(eq(schema.assistantSession.id, s.id));
    const auth = credentialsOf(req.headers);
    startLiveTurn(s.id, (emit, signal) =>
      runAssistantTurn({ app, auth, user: me, sessionId: s.id, content: b.data.content, fileIds: b.data.fileIds, resolutions: b.data.resolutions, signal, emit }).catch((err) => {
        emit({ type: "error", error: err instanceof HttpError ? err.message : errorMessage(err) });
      }),
    );
    return reply.status(202).send({ ok: true });
  });

  app.post<{ Params: { id: string } }>("/api/v1/assistant/sessions/:id/stop", async (req) => {
    const me = requireUser(req);
    await own(req.params.id, me.id);
    liveTurn(req.params.id)?.abort.abort();
    return { ok: true };
  });

  // NDJSON: reproduz os eventos do turno atual desde o inicio e segue ao vivo
  // ate o fim. Sem turno em andamento, devolve `idle` e fecha.
  app.get<{ Params: { id: string } }>("/api/v1/assistant/sessions/:id/stream", async (req, reply) => {
    const me = requireUser(req);
    await own(req.params.id, me.id);
    const t = liveTurn(req.params.id);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" });
    const send = (e: TurnEvent | { type: "idle" }) => {
      if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(e)}\n`);
    };
    if (!t) {
      send({ type: "idle" });
      res.end();
      return;
    }
    for (const e of t.events) send(e);
    if (t.done) {
      res.end();
      return;
    }
    const ping = setInterval(() => send({ type: "text", text: "" }), 15_000);
    const cleanup = () => {
      clearInterval(ping);
      t.emitter.off("event", send);
      t.emitter.off("end", finish);
    };
    const finish = () => {
      cleanup();
      res.end();
    };
    t.emitter.on("event", send);
    t.emitter.on("end", finish);
    res.on("close", cleanup);
  });
}

// Teste de integracao do WhatsApp: um Evolution falso (HTTP local), o fluxo
// seed com o modelo SIMULADO e o Postgres de dev. Cobre o ciclo inteiro:
// conectar (QR) → webhook autenticado → turno → resposta enviada; comandos;
// documento recebido; sessao travada; envio com o Evolution fora; reinicio
// do Studio no meio do turno. Sem banco, pula.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import pg from "pg";

process.env.STUDIO_SECRET_KEY ||= "teste-integracao-chave-de-32-caracteres";
process.env.STUDIO_ADMIN_PASSWORD ||= "teste-integracao";
process.env.KB_URL ||= "http://127.0.0.1:9";
process.env.EVOLUTION_API_KEY = "chave-global-de-teste";
process.env.WHATSAPP_WORKER = "0";

const url = process.env.DATABASE_URL ?? "postgres://studio:studio@localhost:5442/studio";
const dbUp = await new pg.Client({ connectionString: url }).connect().then(() => true, () => false);

type Call = { method: string; path: string; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Evolution falso: guarda as chamadas e responde como o v2.3. */
function fakeEvolution() {
  const calls: Call[] = [];
  const state = { connection: "close" as string, exists: false, sendError: null as null | { status: number; message: string }, down: false, seq: 0 };
  const server: Server = createServer(async (req: IncomingMessage, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const path = req.url ?? "";
    calls.push({ method: req.method ?? "", path, body });
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (req.headers.apikey !== "chave-global-de-teste") return send(401, { response: { message: "Unauthorized" } });
    if (state.down) return send(503, { response: { message: "indisponível" } });
    if (path.startsWith("/instance/connectionState/")) return state.exists ? send(200, { instance: { state: state.connection } }) : send(404, { response: { message: "instance not found" } });
    if (path === "/instance/create") {
      state.exists = true;
      return send(201, { instance: { instanceName: body.instanceName } });
    }
    if (path.startsWith("/webhook/set/")) return send(201, {});
    if (path.startsWith("/instance/connect/")) {
      state.connection = "connecting";
      return send(200, { base64: "data:image/png;base64,QR", pairingCode: null });
    }
    if (path.startsWith("/message/send")) {
      if (state.sendError) return send(state.sendError.status, { response: { message: state.sendError.message } });
      return send(201, { key: { id: `OUT${++state.seq}` } });
    }
    if (path.startsWith("/chat/getBase64FromMediaMessage/")) return send(200, { base64: Buffer.from("CONTRATO DE ADESÃO - cláusula 7: multa de 50%").toString("base64"), mimetype: "text/plain" });
    if (path.startsWith("/chat/")) return send(200, {});
    if (path.startsWith("/instance/logout/") || path.startsWith("/instance/delete/")) return send(200, {});
    send(404, { response: { message: `rota falsa desconhecida ${path}` } });
  });
  return { calls, state, server };
}

describe.skipIf(!dbUp)("WhatsApp: Evolution falso + fluxo simulado", () => {
  const evo = fakeEvolution();
  let m: {
    db: typeof import("../db/index.js");
    svc: typeof import("./service.js");
    worker: typeof import("./worker.js");
    ev: typeof import("./evolution.js");
    flows: typeof import("../seed/flows.js");
    app: Awaited<ReturnType<typeof import("../app.js").buildApp>>;
  };
  let numberId: string;
  let flowId: string;
  const jid = "5511912345678@s.whatsapp.net";
  let seq = 0;

  const sent = () => evo.calls.filter((c) => c.path.startsWith("/message/send"));
  const webhook = (event: string, data: unknown, opts: { token?: string; apikey?: string } = {}) =>
    m.app.inject({
      method: "POST",
      url: `/api/v1/whatsapp/webhook/${numberId}`,
      headers: { [m.ev.WEBHOOK_TOKEN_HEADER]: opts.token ?? m.ev.webhookTokenOf("chave-global-de-teste", numberId), "content-type": "application/json" },
      payload: { event, instance: `goga-${numberId.slice(0, 8)}`, apikey: opts.apikey ?? m.ev.instanceTokenOf("chave-global-de-teste", numberId), data },
    });
  const say = (text: string) => webhook("messages.upsert", { key: { id: `IN${Date.now()}${++seq}`, remoteJid: jid, fromMe: false }, pushName: "Cliente Teste", message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000) });
  /** Roda a fila ate `done` (ou 25 s). */
  const until = async (done: () => boolean | Promise<boolean>, ms = 25_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await m.worker.tick();
      if (await done()) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("tempo esgotado esperando a fila");
  };
  const contact = async () => (await m.db.db.select().from(m.db.schema.whatsappContact).where(and(eq(m.db.schema.whatsappContact.numberId, numberId), eq(m.db.schema.whatsappContact.jid, jid))))[0]!;

  beforeAll(async () => {
    await new Promise<void>((r) => evo.server.listen(0, "127.0.0.1", r));
    process.env.EVOLUTION_API_URL = `http://127.0.0.1:${(evo.server.address() as AddressInfo).port}`;
    const db = await import("../db/index.js");
    await db.runMigrations();
    await (await import("../seed/index.js")).seed(() => undefined);
    const { buildApp } = await import("../app.js");
    m = { db, svc: await import("./service.js"), worker: await import("./worker.js"), ev: await import("./evolution.js"), flows: await import("../seed/flows.js"), app: await buildApp() };
    const { schema } = db;
    const [model] = await db.db.select().from(schema.model).where(eq(schema.model.modelId, "goga-simulado"));
    const graph = m.flows.buildFlow(m.flows.FULL_FLOW, m.flows.FULL_CHAINS, model.id);
    const [f] = await db.db.insert(schema.flow).values({ name: "teste whatsapp", graph }).returning();
    flowId = f.id;
    const id = crypto.randomUUID();
    await db.db.insert(schema.whatsappNumber).values({ id, name: "teste", instanceName: `goga-${id.slice(0, 8)}`, useProduction: false, flowId });
    numberId = id;
  });

  afterAll(async () => {
    if (m) {
      await m.db.db.delete(m.db.schema.chatSession).where(eq(m.db.schema.chatSession.flowId, flowId));
      await m.db.db.delete(m.db.schema.whatsappNumber).where(eq(m.db.schema.whatsappNumber.id, numberId));
      await m.db.db.delete(m.db.schema.run).where(eq(m.db.schema.run.flowId, flowId));
      await m.db.db.delete(m.db.schema.flow).where(eq(m.db.schema.flow.id, flowId));
      await m.app.close();
    }
    evo.server.close();
  });

  it("conecta: cria a instância com webhook autenticado e mostra o QR", async () => {
    const n = await m.svc.connect(numberId);
    expect(n.state).toBe("connecting");
    expect(n.qrCode).toBe("data:image/png;base64,QR");
    const create = evo.calls.find((c) => c.path === "/instance/create")!;
    expect(create.body.webhook.url).toMatch(new RegExp(`/api/v1/whatsapp/webhook/${numberId}$`));
    expect(create.body.webhook.headers[m.ev.WEBHOOK_TOKEN_HEADER]).toBe(m.ev.webhookTokenOf("chave-global-de-teste", numberId));
    expect(create.body.token).toBe(m.ev.instanceTokenOf("chave-global-de-teste", numberId));
  });

  it("recusa webhook sem o token certo", async () => {
    expect((await webhook("connection.update", { state: "open" }, { token: "errado" })).statusCode).toBe(401);
    expect((await webhook("connection.update", { state: "open" }, { apikey: "errado" })).statusCode).toBe(401);
  });

  it("CONNECTION_UPDATE open marca conectado", async () => {
    evo.state.connection = "open";
    expect((await webhook("connection.update", { state: "open", wuid: "5511900000000@s.whatsapp.net", statusReason: 200 })).statusCode).toBe(200);
    const n = await m.svc.loadNumber(numberId);
    expect(n.state).toBe("open");
    expect(n.number).toBe("5511900000000");
    expect(n.qrCode).toBeNull();
  });

  it("mensagem vira turno do fluxo e a resposta sai pelo WhatsApp (uma vez, mesmo com webhook repetido)", async () => {
    const id = `DUP${Date.now()}`;
    const body = { key: { id, remoteJid: jid, fromMe: false }, pushName: "Cliente Teste", message: { conversation: "O banco fez um empréstimo no meu nome que eu não contratei e agora estou negativado" } };
    await webhook("messages.upsert", body);
    await webhook("messages.upsert", body); // reentrega do Evolution
    const before = sent().length;
    await until(async () => sent().length > before && !(await contact()).busyRunId);
    const replies = sent().slice(before);
    expect(replies[0]!.body.number).toBe("5511912345678");
    expect(replies.map((r) => r.body.text).join("\n")).toMatch(/Dica: envie \/ajuda/);
    const c = await contact();
    expect(c.name).toBe("Cliente Teste");
    expect(c.phone).toBe("+5511912345678");
    const runs = await m.db.db.select().from(m.db.schema.run).where(eq(m.db.schema.run.sessionId, c.sessionId!));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.userId).toBeNull();
    // lido + digitando
    expect(evo.calls.some((x) => x.path.startsWith("/chat/markMessageAsRead/"))).toBe(true);
  }, 40_000);

  it("/ajuda responde a lista de comandos sem rodar o fluxo", async () => {
    const before = sent().length;
    await say("/ajuda");
    await until(() => sent().length > before);
    expect(sent().at(-1)!.body.text).toMatch(/\/limpar/);
  }, 30_000);

  it("/ajuda responde na hora mesmo com um turno longo em andamento", async () => {
    const c = await contact();
    const [run] = await m.db.db.insert(m.db.schema.run).values({ flowId, flowRevision: 1, graph: {}, sessionId: c.sessionId, status: "running", question: "turno longo" }).returning();
    await m.db.db.update(m.db.schema.whatsappContact).set({ busyRunId: run.id }).where(eq(m.db.schema.whatsappContact.id, c.id));
    const before = sent().length;
    await say("/ajuda");
    await until(() => sent().length > before);
    expect(sent().at(-1)!.body.text).toMatch(/\/limpar/);
    expect((await contact()).busyRunId).toBe(run.id);
    await m.db.db.update(m.db.schema.run).set({ status: "ok" }).where(eq(m.db.schema.run.id, run.id));
    await m.db.db.update(m.db.schema.whatsappContact).set({ busyRunId: null }).where(eq(m.db.schema.whatsappContact.id, c.id));
  }, 30_000);

  it("documento recebido é baixado, lido e anexado ao turno", async () => {
    const before = sent().length;
    await webhook("messages.upsert", {
      key: { id: `DOC${Date.now()}`, remoteJid: jid, fromMe: false },
      message: { documentMessage: { mimetype: "text/plain", fileName: "contrato.txt", caption: "esse é o contrato, a multa é abusiva?" } },
    });
    await until(async () => sent().length > before && !(await contact()).busyRunId);
    const dl = evo.calls.filter((x) => x.path.startsWith("/chat/getBase64FromMediaMessage/")).at(-1)!;
    expect(dl.body.message.message.documentMessage.fileName).toBe("contrato.txt");
    const c = await contact();
    const files = await m.db.db.select().from(m.db.schema.file).where(eq(m.db.schema.file.sessionId, c.sessionId!));
    expect(files.some((f) => f.name === "contrato.txt" && f.extractedText?.includes("cláusula 7"))).toBe(true);
    const [msg] = await m.db.db.select().from(m.db.schema.message).where(and(eq(m.db.schema.message.sessionId, c.sessionId!), eq(m.db.schema.message.content, "esse é o contrato, a multa é abusiva?")));
    expect(msg!.attachments).toHaveLength(1);
  }, 40_000);

  it("/nova abre outra conversa e guarda a anterior", async () => {
    const old = (await contact()).sessionId;
    await say("/nova");
    await until(async () => (await contact()).sessionId === null);
    await say("Oi, bom dia");
    await until(async () => !!(await contact()).sessionId && !(await contact()).busyRunId);
    expect((await contact()).sessionId).not.toBe(old);
    const sessions = await m.db.db.select().from(m.db.schema.chatSession).where(eq(m.db.schema.chatSession.whatsappContactId, (await contact()).id));
    expect(sessions.length).toBe(2);
  }, 40_000);

  it("/limpar pede confirmação e apaga tudo", async () => {
    await say("/limpar");
    await until(async () => (await contact()).pendingCommand === "limpar");
    expect(sent().at(-1)!.body.text).toMatch(/\*1\.\* Sim, apagar tudo/);
    await say("1");
    await until(async () => (await m.db.db.select().from(m.db.schema.chatSession).where(eq(m.db.schema.chatSession.whatsappContactId, (await contact()).id))).length === 0);
    await until(() => /apaguei todas/.test(sent().at(-1)?.body.text ?? ""));
    expect((await contact()).sessionId).toBeNull();
  }, 40_000);

  it("Evolution fora do ar: a resposta espera na fila e sai quando ele volta", async () => {
    evo.state.down = true;
    await say("/ajuda");
    await until(async () => (await m.db.db.select().from(m.db.schema.whatsappOutbound).where(and(eq(m.db.schema.whatsappOutbound.numberId, numberId), eq(m.db.schema.whatsappOutbound.status, "pending")))).some((o) => o.attempts > 0));
    evo.state.down = false;
    await m.db.db.update(m.db.schema.whatsappOutbound).set({ nextAttemptAt: new Date() }).where(eq(m.db.schema.whatsappOutbound.status, "pending"));
    const before = sent().length;
    await until(() => sent().length > before && sent().at(-1)!.body.text?.includes("/limpar"));
  }, 40_000);

  it("sessão travada (open, mas envio diz Connection Closed) vira desconectada com motivo 428", async () => {
    evo.state.sendError = { status: 400, message: "Connection Closed" };
    await say("/ajuda");
    await until(async () => (await m.svc.loadNumber(numberId)).state === "close");
    const n = await m.svc.loadNumber(numberId);
    expect(n.statusReason).toBe(m.svc.STALE_SESSION_REASON);
    // A mensagem nao se perde: espera o numero voltar.
    const pending = await m.db.db.select().from(m.db.schema.whatsappOutbound).where(and(eq(m.db.schema.whatsappOutbound.numberId, numberId), eq(m.db.schema.whatsappOutbound.status, "pending")));
    expect(pending.length).toBeGreaterThan(0);
    evo.state.sendError = null;
    await webhook("connection.update", { state: "open" });
    await m.db.db.update(m.db.schema.whatsappOutbound).set({ nextAttemptAt: new Date() }).where(eq(m.db.schema.whatsappOutbound.status, "pending"));
    await until(async () => (await m.db.db.select().from(m.db.schema.whatsappOutbound).where(and(eq(m.db.schema.whatsappOutbound.numberId, numberId), eq(m.db.schema.whatsappOutbound.status, "pending")))).length === 0);
  }, 40_000);

  it("Studio reiniciou no meio do turno: as mensagens voltam para a fila e rodam de novo", async () => {
    const c = await contact();
    const [s] = await m.db.db.insert(m.db.schema.chatSession).values({ whatsappContactId: c.id, flowId }).returning();
    const [run] = await m.db.db
      .insert(m.db.schema.run)
      .values({ flowId, flowRevision: 1, graph: {}, sessionId: s.id, status: "error", error: "Execução interrompida: o servidor reiniciou durante o turno. Envie a mensagem de novo.", question: "x" })
      .returning();
    await m.db.db.insert(m.db.schema.message).values({ sessionId: s.id, role: "user", content: "meu aluguel subiu 40%, pode?", runId: run.id });
    await m.db.db.insert(m.db.schema.whatsappInbound).values({ numberId, contactId: c.id, externalId: `RST${Date.now()}`, kind: "text", text: "meu aluguel subiu 40%, pode?", status: "processing", runId: run.id });
    await m.db.db.update(m.db.schema.whatsappContact).set({ sessionId: s.id, busyRunId: run.id, lastInboundAt: new Date(Date.now() - 10_000) }).where(eq(m.db.schema.whatsappContact.id, c.id));
    const before = sent().length;
    await until(async () => sent().length > before && !(await contact()).busyRunId);
    const msgs = await m.db.db.select().from(m.db.schema.message).where(eq(m.db.schema.message.sessionId, s.id));
    expect(msgs.filter((x) => x.runId === run.id)).toHaveLength(0); // turno quebrado saiu do historico
    expect(msgs.filter((x) => x.role === "user" && x.content.includes("aluguel"))).toHaveLength(1);
    expect(msgs.some((x) => x.role === "assistant")).toBe(true);
  }, 40_000);
});

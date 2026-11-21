// Agente de conversa (fica na frente do fluxo): resposta na hora no
// Simulador, decisao responder/fluxo, e o contexto acrescentado a um turno em
// andamento chegando as chamadas a modelo. Modelo SIMULADO + Postgres de dev.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import pg from "pg";
import { withAddenda } from "../llm/call.js";

process.env.STUDIO_SECRET_KEY ||= "teste-integracao-chave-de-32-caracteres";
process.env.STUDIO_ADMIN_PASSWORD ||= "teste-integracao";
process.env.KB_URL ||= "http://127.0.0.1:9";
process.env.WHATSAPP_WORKER = "0";

const url = process.env.DATABASE_URL ?? "postgres://studio:studio@localhost:5442/studio";
const dbUp = await new pg.Client({ connectionString: url }).connect().then(() => true, () => false);

describe("withAddenda", () => {
  it("acrescenta os complementos na última mensagem do usuário", () => {
    const out = withAddenda([{ role: "user", content: "relato" }, { role: "assistant", content: "ok" }, { role: "user", content: "ficha" }], [{ text: "O carro é de 2008." }]);
    expect(out[0]).toEqual({ role: "user", content: "relato" });
    expect(String(out[2]!.content)).toMatch(/^ficha\n\n<complementos_da_pessoa>[\s\S]*- O carro é de 2008\.\n<\/complementos_da_pessoa>$/);
  });
});

describe.skipIf(!dbUp)("agente de conversa", () => {
  let m: {
    db: typeof import("../db/index.js");
    run: typeof import("./run.js");
    front: typeof import("./frontdesk.js");
    app: Awaited<ReturnType<typeof import("../app.js").buildApp>>;
  };
  let flowId: string;
  let auth: string;
  let tokenId: string;
  let before: { enabled: boolean; modelId: string | null };

  const post = (path: string, payload: unknown) => m.app.inject({ method: "POST", url: `/api/v1${path}`, headers: { authorization: auth }, payload: payload as object });
  const waitRun = async (runId: string) => {
    for (let i = 0; i < 100; i++) {
      const [r] = await m.db.db.select().from(m.db.schema.run).where(eq(m.db.schema.run.id, runId));
      if (r && r.status !== "running" && !m.run.isLive(runId)) return r;
      await new Promise((res) => setTimeout(res, 200));
    }
    throw new Error("turno não terminou");
  };

  beforeAll(async () => {
    const db = await import("../db/index.js");
    await db.runMigrations();
    await (await import("../seed/index.js")).seed(() => undefined);
    const { buildApp } = await import("../app.js");
    m = { db, run: await import("./run.js"), front: await import("./frontdesk.js"), app: await buildApp() };
    const { schema } = db;
    const [model] = await db.db.select().from(schema.model).where(eq(schema.model.modelId, "goga-simulado"));
    const flows = await import("../seed/flows.js");
    const [f] = await db.db.insert(schema.flow).values({ name: "teste agente de conversa", graph: flows.buildFlow(flows.FULL_FLOW, flows.FULL_CHAINS, model.id) }).returning();
    flowId = f.id;
    const [admin] = await db.db.select().from(schema.appUser).where(eq(schema.appUser.role, "admin")).limit(1);
    const { newToken } = await import("../lib/auth.js");
    const t = newToken();
    const [row] = await db.db.insert(schema.apiToken).values({ userId: admin!.id, name: "teste agente", tokenHash: t.hash, prefix: t.prefix }).returning();
    tokenId = row.id;
    auth = `Bearer ${t.token}`;
    before = await m.front.frontConfig(true);
    await m.front.saveFrontConfig({ enabled: true, modelId: model.id }, "teste");
  });

  afterAll(async () => {
    if (!m) return;
    await m.front.saveFrontConfig(before, "teste");
    await m.db.db.delete(m.db.schema.chatSession).where(eq(m.db.schema.chatSession.flowId, flowId));
    await m.db.db.delete(m.db.schema.run).where(eq(m.db.schema.run.flowId, flowId));
    await m.db.db.delete(m.db.schema.flow).where(eq(m.db.schema.flow.id, flowId));
    await m.db.db.delete(m.db.schema.apiToken).where(eq(m.db.schema.apiToken.id, tokenId));
    await m.app.close();
  });

  const newSession = async () => (await post("/sessions", { flowId })).json().session.id as string;

  it("saudação: o agente responde na hora, sem rodar o fluxo", async () => {
    const sid = await newSession();
    const r = (await post(`/sessions/${sid}/messages`, { content: "oi" })).json();
    expect(r.runId).toBeNull();
    expect(r.frente.content).toMatch(/Me conte o que aconteceu/);
    const msgs = await m.db.db.select().from(m.db.schema.message).where(eq(m.db.schema.message.sessionId, sid)).orderBy(asc(m.db.schema.message.createdAt));
    expect(msgs.map((x) => x.role)).toEqual(["user", "assistant"]);
    expect((await m.db.db.select().from(m.db.schema.run).where(eq(m.db.schema.run.sessionId, sid))).length).toBe(0);
  });

  it("relato: resposta imediata + fluxo iniciado; durante o turno, cobrança e fato novo também respondem na hora", async () => {
    const sid = await newSession();
    const first = (await post(`/sessions/${sid}/messages`, { content: "Bati meu carro num cruzamento e o outro motorista fugiu sem pagar" })).json();
    expect(first.runId).toBeTruthy();
    expect(first.frente.content).toMatch(/Vou analisar/);
    // Logo em seguida (o turno ainda esta no comeco): o fato novo entra no turno.
    const add = (await post(`/sessions/${sid}/messages`, { content: "meu carro é de 2008" })).json();
    expect(add.frente.content).toMatch(/Anotado|Vou analisar/);
    await waitRun(first.runId);
    if (add.complementedRunId) {
      expect(add.complementedRunId).toBe(first.runId);
      const spans = await m.db.db.select().from(m.db.schema.span).where(and(eq(m.db.schema.span.runId, first.runId), eq(m.db.schema.span.kind, "llm")));
      expect(spans.some((sp) => JSON.stringify(sp.input).includes("meu carro é de 2008"))).toBe(true);
    } else expect(add.runId).toBeTruthy(); // o turno ja tinha acabado: virou um turno novo
  }, 40_000);

  it("contexto acrescentado logo após iniciar chega às chamadas do turno", async () => {
    const [s] = await m.db.db.insert(m.db.schema.chatSession).values({ flowId }).returning();
    const { runId } = await m.run.startTurn({ user: null, sessionId: s.id, message: "O banco cobrou uma tarifa que eu não contratei", fileIds: [], target: { flowId, useProduction: false } });
    expect(m.run.addContext(runId, { id: "a1", text: "A cobrança foi de R$ 89,90 em março." })).toBe(true);
    expect(m.run.runInfo(runId)?.addenda).toEqual(["A cobrança foi de R$ 89,90 em março."]);
    await waitRun(runId);
    const spans = await m.db.db.select().from(m.db.schema.span).where(and(eq(m.db.schema.span.runId, runId), eq(m.db.schema.span.kind, "llm")));
    const withIt = spans.filter((sp) => JSON.stringify(sp.input).includes("R$ 89,90"));
    expect(withIt.length).toBeGreaterThan(0);
    expect(withIt.every((sp) => sp.name !== "Guarda")).toBe(true);
    expect(m.run.takeUnseenAddenda(runId)).toEqual([]);
    // Turno encerrado nao aceita mais contexto.
    expect(m.run.addContext(runId, { id: "a2", text: "tarde demais" })).toBe(false);
  }, 40_000);

  it("agente desligado: volta ao comportamento antigo (fluxo direto)", async () => {
    await m.front.saveFrontConfig({ enabled: false }, "teste");
    const sid = await newSession();
    const r = (await post(`/sessions/${sid}/messages`, { content: "oi" })).json();
    expect(r.runId).toBeTruthy();
    await waitRun(r.runId);
    await m.front.saveFrontConfig({ enabled: true }, "teste");
  }, 40_000);
});

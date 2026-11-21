import type { FastifyInstance } from "fastify";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { config } from "../config.js";
import { requireAdmin } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { badRequest, notFound } from "../lib/errors.js";
import { evolutionConfigured, instanceTokenOf, restartConfigured, safeEqual, webhookTokenOf, WEBHOOK_TOKEN_HEADER } from "../whatsapp/evolution.js";
import { parseEnvelope, parseWebhook } from "../whatsapp/parse.js";
import { applySignal, connect, loadNumber, logout, refresh, removeNumber, touch, webhookUrl } from "../whatsapp/service.js";
import { kick, receive } from "../whatsapp/worker.js";

const numberBody = z.object({
  name: z.string().trim().min(1).max(80),
  useProduction: z.boolean().default(true),
  flowId: z.string().uuid().nullable().default(null),
  enabled: z.boolean().default(true),
});

/** Sem o QR quando a sessao ja esta aberta (o QR velho nao serve para nada). */
const dto = (n: typeof schema.whatsappNumber.$inferSelect) => ({ ...n, qrCode: n.state === "connecting" ? n.qrCode : null, pairingCode: n.state === "connecting" ? n.pairingCode : null });

export async function whatsappRoutes(app: FastifyInstance) {
  app.get("/api/v1/whatsapp/status", async (req) => {
    requireAdmin(req);
    return { configured: evolutionConfigured(), autoRestart: restartConfigured(), evolutionUrl: config.evolutionUrl, webhookExample: webhookUrl("<id>") };
  });

  app.get("/api/v1/whatsapp/numbers", async (req) => {
    requireAdmin(req);
    const rows = await db
      .select({ n: schema.whatsappNumber, flowName: schema.flow.name })
      .from(schema.whatsappNumber)
      .leftJoin(schema.flow, eq(schema.whatsappNumber.flowId, schema.flow.id))
      .orderBy(schema.whatsappNumber.createdAt);
    const ids = rows.map((r) => r.n.id);
    const contacts = ids.length ? await db.select({ id: schema.whatsappContact.numberId, n: count() }).from(schema.whatsappContact).where(inArray(schema.whatsappContact.numberId, ids)).groupBy(schema.whatsappContact.numberId) : [];
    const queue = ids.length
      ? await db
          .select({ id: schema.whatsappOutbound.numberId, status: schema.whatsappOutbound.status, n: count() })
          .from(schema.whatsappOutbound)
          .where(and(inArray(schema.whatsappOutbound.numberId, ids), inArray(schema.whatsappOutbound.status, ["pending", "failed"])))
          .groupBy(schema.whatsappOutbound.numberId, schema.whatsappOutbound.status)
      : [];
    const [prod] = await db
      .select({ flowName: schema.flow.name, revision: schema.flowRelease.revision })
      .from(schema.production)
      .innerJoin(schema.flowRelease, eq(schema.production.flowReleaseId, schema.flowRelease.id))
      .innerJoin(schema.flow, eq(schema.flowRelease.flowId, schema.flow.id));
    return {
      production: prod ?? null,
      numbers: rows.map(({ n, flowName }) => ({
        ...dto(n),
        flowName,
        contacts: contacts.find((c) => c.id === n.id)?.n ?? 0,
        pendingOut: queue.find((q) => q.id === n.id && q.status === "pending")?.n ?? 0,
        failedOut: queue.find((q) => q.id === n.id && q.status === "failed")?.n ?? 0,
      })),
    };
  });

  app.post("/api/v1/whatsapp/numbers", async (req) => {
    const me = requireAdmin(req);
    const b = numberBody.parse(req.body ?? {});
    if (!b.useProduction && !b.flowId) throw badRequest("Escolha o fluxo de atendimento.");
    const id = crypto.randomUUID();
    const [n] = await db
      .insert(schema.whatsappNumber)
      .values({ id, name: b.name, useProduction: b.useProduction, flowId: b.useProduction ? null : b.flowId, enabled: b.enabled, instanceName: `goga-${id.slice(0, 8)}`, createdBy: me.id })
      .returning();
    await audit(me, "create", "whatsapp_number", n.id, null, { name: n.name, useProduction: n.useProduction, flowId: n.flowId });
    return { number: dto(n) };
  });

  app.get<{ Params: { id: string } }>("/api/v1/whatsapp/numbers/:id", async (req) => {
    requireAdmin(req);
    let n = await loadNumber(req.params.id);
    // Estado ao vivo enquanto espera o QR (caso o webhook se perca).
    if (n.state === "connecting") n = await refresh(n.id).catch(() => n);
    return { number: dto(n) };
  });

  app.put<{ Params: { id: string } }>("/api/v1/whatsapp/numbers/:id", async (req) => {
    const me = requireAdmin(req);
    const before = await loadNumber(req.params.id);
    const b = numberBody.partial().parse(req.body ?? {});
    const useProduction = b.useProduction ?? before.useProduction;
    const flowId = useProduction ? null : (b.flowId !== undefined ? b.flowId : before.flowId);
    if (!useProduction && !flowId) throw badRequest("Escolha o fluxo de atendimento.");
    const [n] = await db
      .update(schema.whatsappNumber)
      .set({ ...(b.name && { name: b.name }), ...(b.enabled !== undefined && { enabled: b.enabled }), useProduction, flowId, updatedAt: new Date() })
      .where(eq(schema.whatsappNumber.id, before.id))
      .returning();
    await audit(me, "update", "whatsapp_number", n.id, { name: before.name, useProduction: before.useProduction, flowId: before.flowId, enabled: before.enabled }, { name: n.name, useProduction: n.useProduction, flowId: n.flowId, enabled: n.enabled });
    return { number: dto(n) };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/whatsapp/numbers/:id", async (req) => {
    const me = requireAdmin(req);
    const n = await loadNumber(req.params.id);
    await removeNumber(n.id);
    await audit(me, "delete", "whatsapp_number", n.id, { name: n.name, number: n.number }, null);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/v1/whatsapp/numbers/:id/connect", async (req) => {
    const me = requireAdmin(req);
    const n = await connect(req.params.id);
    await audit(me, "connect", "whatsapp_number", n.id, null, { instance: n.instanceName });
    return { number: dto(n) };
  });

  app.post<{ Params: { id: string } }>("/api/v1/whatsapp/numbers/:id/logout", async (req) => {
    const me = requireAdmin(req);
    const n = await logout(req.params.id);
    await audit(me, "logout", "whatsapp_number", n.id, null, { instance: n.instanceName });
    return { number: dto(n) };
  });

  app.get<{ Params: { id: string } }>("/api/v1/whatsapp/numbers/:id/contacts", async (req) => {
    requireAdmin(req);
    await loadNumber(req.params.id);
    const rows = await db
      .select({
        c: schema.whatsappContact,
        sessions: sql<number>`(select count(*)::int from session s where s.whatsapp_contact_id = ${schema.whatsappContact.id})`,
        lastText: sql<string | null>`(select i.text from whatsapp_inbound i where i.contact_id = ${schema.whatsappContact.id} order by i.received_at desc limit 1)`,
      })
      .from(schema.whatsappContact)
      .where(eq(schema.whatsappContact.numberId, req.params.id))
      .orderBy(desc(schema.whatsappContact.lastInboundAt))
      .limit(200);
    return { contacts: rows.map((r) => ({ ...r.c, sessions: r.sessions, lastText: r.lastText })) };
  });

  app.get<{ Params: { id: string } }>("/api/v1/whatsapp/numbers/:id/failed", async (req) => {
    requireAdmin(req);
    const rows = await db
      .select()
      .from(schema.whatsappOutbound)
      .where(and(eq(schema.whatsappOutbound.numberId, req.params.id), eq(schema.whatsappOutbound.status, "failed")))
      .orderBy(desc(schema.whatsappOutbound.createdAt))
      .limit(50);
    return { messages: rows };
  });

  app.post<{ Params: { id: string } }>("/api/v1/whatsapp/outbound/:id/retry", async (req) => {
    requireAdmin(req);
    const [o] = await db.update(schema.whatsappOutbound).set({ status: "pending", nextAttemptAt: new Date(), createdAt: new Date(), attempts: 0, error: null }).where(eq(schema.whatsappOutbound.id, req.params.id)).returning();
    if (!o) throw notFound("mensagem");
    kick();
    return { ok: true };
  });

  // Webhook do Evolution. Sem sessao do Studio: autentica pelo cabecalho
  // derivado da chave, pelo nome da instancia e pelo token da instancia. So
  // responde 200 depois de gravar (o Evolution reenvia o que nao foi aceito).
  app.post<{ Params: { numberId: string } }>("/api/v1/whatsapp/webhook/:numberId", async (req, reply) => {
    if (!evolutionConfigured()) return reply.status(503).send({ error: "Evolution não configurado" });
    const [n] = await db.select().from(schema.whatsappNumber).where(eq(schema.whatsappNumber.id, req.params.numberId)).catch(() => []);
    if (!n) return reply.status(404).send({ error: "número desconhecido" });
    const header = req.headers[WEBHOOK_TOKEN_HEADER];
    if (typeof header !== "string" || !safeEqual(header, webhookTokenOf(config.evolutionApiKey, n.id))) return reply.status(401).send({ error: "token inválido" });
    let env;
    try {
      env = parseEnvelope(req.body);
    } catch {
      return reply.status(400).send({ error: "corpo inválido" });
    }
    const token = env.apikey ?? "";
    if (env.instance !== n.instanceName || !(safeEqual(token, instanceTokenOf(config.evolutionApiKey, n.id)) || safeEqual(token, config.evolutionApiKey))) {
      return reply.status(401).send({ error: "instância inválida" });
    }
    const parsed = parseWebhook(env);
    await touch(n.id);
    if (parsed.signal) await applySignal(n.id, parsed.signal);
    if (parsed.messages.length) await receive(n, parsed.messages);
    return { ok: true };
  });
}

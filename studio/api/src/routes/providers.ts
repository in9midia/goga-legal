import type { FastifyInstance } from "fastify";
import { asc, eq } from "drizzle-orm";
import { generateText, embed } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { audit } from "../lib/audit.js";
import { requireAdmin, requireUser } from "../lib/auth.js";
import { encrypt, decrypt } from "../lib/crypto.js";
import { badRequest, notFound } from "../lib/errors.js";
import { buildLanguageModel } from "../llm/models.js";
import { discoverModels, lookupPrice } from "../llm/catalog.js";

type ProviderRow = typeof schema.provider.$inferSelect;
// A chave nunca sai da API: so os 4 ultimos caracteres (ADR-0009 da KB).
const view = (p: ProviderRow) => ({ id: p.id, name: p.name, kind: p.kind, baseUrl: p.baseUrl, apiKeyTail: p.apiKeyTail, hasKey: !!p.apiKeyEnc, active: p.active, createdAt: p.createdAt });

const providerBody = z.object({
  name: z.string().min(1),
  kind: z.enum(["deepseek", "gemini", "openai_compat", "mock"]),
  baseUrl: z.string().default(""),
  apiKey: z.string().optional(),
  active: z.boolean().default(true),
});

const modelBody = z.object({
  providerId: z.string().uuid(),
  modelId: z.string().min(1),
  label: z.string().min(1),
  purpose: z.enum(["chat", "embedding", "vision"]),
  priceInPer1m: z.number().min(0).default(0),
  priceOutPer1m: z.number().min(0).default(0),
  priceCachePer1m: z.number().min(0).default(0),
  contextWindow: z.number().int().min(0).default(0),
  supportsTools: z.boolean().default(true),
  supportsJson: z.boolean().default(true),
  active: z.boolean().default(true),
  isDefault: z.boolean().default(false),
});

export async function providerRoutes(app: FastifyInstance) {
  app.get("/api/v1/providers", async (req) => {
    requireUser(req);
    const providers = await db.select().from(schema.provider).orderBy(asc(schema.provider.createdAt));
    const models = await db.select().from(schema.model).orderBy(asc(schema.model.label));
    return { providers: providers.map((p) => ({ ...view(p), models: models.filter((m) => m.providerId === p.id) })) };
  });

  app.post("/api/v1/providers", async (req) => {
    const me = requireAdmin(req);
    const b = providerBody.safeParse(req.body);
    if (!b.success) throw badRequest("dados inválidos", b.error.issues);
    const key = b.data.apiKey?.trim() ?? "";
    const [p] = await db
      .insert(schema.provider)
      .values({ name: b.data.name, kind: b.data.kind, baseUrl: b.data.baseUrl.trim().replace(/\/$/, ""), apiKeyEnc: encrypt(key), apiKeyTail: key.slice(-4), active: b.data.active })
      .returning();
    await audit(me, "create", "provider", p.id, null, view(p));
    return { provider: view(p) };
  });

  app.put<{ Params: { id: string } }>("/api/v1/providers/:id", async (req) => {
    const me = requireAdmin(req);
    const b = providerBody.partial().safeParse(req.body);
    if (!b.success) throw badRequest("dados inválidos", b.error.issues);
    const [before] = await db.select().from(schema.provider).where(eq(schema.provider.id, req.params.id));
    if (!before) throw notFound("provedor");
    const set: Partial<ProviderRow> = {};
    if (b.data.name) set.name = b.data.name;
    if (b.data.kind) set.kind = b.data.kind;
    if (b.data.baseUrl !== undefined) set.baseUrl = b.data.baseUrl.trim().replace(/\/$/, "");
    if (b.data.active !== undefined) set.active = b.data.active;
    // Campo de chave vazio no formulario = manter a atual.
    const key = b.data.apiKey?.trim();
    if (key) {
      set.apiKeyEnc = encrypt(key);
      set.apiKeyTail = key.slice(-4);
    }
    const [p] = await db.update(schema.provider).set(set).where(eq(schema.provider.id, req.params.id)).returning();
    await audit(me, key ? "update_key" : "update", "provider", p.id, view(before), view(p));
    return { provider: view(p) };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/providers/:id", async (req) => {
    const me = requireAdmin(req);
    const [before] = await db.delete(schema.provider).where(eq(schema.provider.id, req.params.id)).returning();
    if (!before) throw notFound("provedor");
    await audit(me, "delete", "provider", before.id, view(before), null);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/v1/providers/:id/test", async (req) => {
    requireAdmin(req);
    const [p] = await db.select().from(schema.provider).where(eq(schema.provider.id, req.params.id));
    if (!p) throw notFound("provedor");
    const models = await db.select().from(schema.model).where(eq(schema.model.providerId, p.id));
    const chat = models.find((m) => m.purpose === "chat" || m.purpose === "vision");
    const emb = models.find((m) => m.purpose === "embedding");
    const t0 = Date.now();
    try {
      if (chat) {
        const r = await generateText({ model: buildLanguageModel(p, chat.modelId), prompt: "Responda apenas: ok", maxOutputTokens: 5, maxRetries: 0, timeout: 20000 });
        return { ok: true, ms: Date.now() - t0, model: chat.label, sample: r.text.slice(0, 40) };
      }
      if (emb && p.kind === "gemini") {
        const g = createGoogleGenerativeAI({ apiKey: decrypt(p.apiKeyEnc), baseURL: p.baseUrl || undefined });
        const r = await embed({ model: g.embedding(emb.modelId), value: "teste", maxRetries: 0 });
        return { ok: true, ms: Date.now() - t0, model: emb.label, sample: `${r.embedding.length} dimensões` };
      }
      return { ok: false, ms: 0, error: "provedor sem modelo cadastrado para testar" };
    } catch (err) {
      return { ok: false, ms: Date.now() - t0, error: (err as Error).message.slice(0, 400) };
    }
  });

  // Os modelos que a chave gravada alcanca, com preco do catalogo do LiteLLM.
  // Usa sempre o endpoint do PROPRIO cadastro: aceitar outro faria desta rota
  // um vazador da chave cifrada.
  app.get<{ Params: { id: string } }>("/api/v1/providers/:id/available-models", async (req) => {
    requireAdmin(req);
    const [p] = await db.select().from(schema.provider).where(eq(schema.provider.id, req.params.id));
    if (!p) throw notFound("provedor");
    const { models, priceSource } = await discoverModels(p);
    const existing = new Set((await db.select({ modelId: schema.model.modelId }).from(schema.model).where(eq(schema.model.providerId, p.id))).map((m) => m.modelId));
    return { priceSource, models: models.map((m) => ({ ...m, registered: existing.has(m.modelId) })) };
  });

  // Preco de um modelo avulso, para o formulario preencher. Nao grava nada.
  app.post("/api/v1/models/price-lookup", async (req) => {
    requireAdmin(req);
    const b = z.object({ providerId: z.string().uuid(), modelId: z.string().min(1) }).safeParse(req.body);
    if (!b.success) throw badRequest("dados inválidos", b.error.issues);
    const [p] = await db.select().from(schema.provider).where(eq(schema.provider.id, b.data.providerId));
    if (!p) throw notFound("provedor");
    return lookupPrice(p.kind, b.data.modelId);
  });

  // Cadastra de uma vez os modelos escolhidos na lista detectada.
  app.post<{ Params: { id: string } }>("/api/v1/providers/:id/models/import", async (req) => {
    const me = requireAdmin(req);
    const b = z.object({ models: z.array(modelBody.omit({ providerId: true, isDefault: true })).min(1) }).safeParse(req.body);
    if (!b.success) throw badRequest("dados inválidos", b.error.issues);
    const [p] = await db.select().from(schema.provider).where(eq(schema.provider.id, req.params.id));
    if (!p) throw notFound("provedor");
    const existing = new Set((await db.select({ modelId: schema.model.modelId }).from(schema.model).where(eq(schema.model.providerId, p.id))).map((m) => m.modelId));
    const fresh = b.data.models.filter((m) => !existing.has(m.modelId));
    if (!fresh.length) return { models: [] };
    const created = await db.insert(schema.model).values(fresh.map((m) => ({ ...m, providerId: p.id }))).returning();
    await audit(me, "import", "model", p.id, null, { provider: p.name, models: created.map((m) => m.modelId) });
    return { models: created };
  });

  app.get("/api/v1/models", async (req) => {
    requireUser(req);
    const rows = await db
      .select({ model: schema.model, providerName: schema.provider.name, providerKind: schema.provider.kind, providerActive: schema.provider.active })
      .from(schema.model)
      .innerJoin(schema.provider, eq(schema.model.providerId, schema.provider.id))
      .orderBy(asc(schema.model.label));
    return { models: rows.map((r) => ({ ...r.model, providerName: r.providerName, providerKind: r.providerKind, usable: r.model.active && r.providerActive })) };
  });

  const unsetOtherDefaults = async (purpose: string, keep: string) => {
    const others = await db.select().from(schema.model).where(eq(schema.model.purpose, purpose as "chat"));
    for (const o of others) if (o.id !== keep && o.isDefault) await db.update(schema.model).set({ isDefault: false }).where(eq(schema.model.id, o.id));
  };

  app.post("/api/v1/models", async (req) => {
    const me = requireAdmin(req);
    const b = modelBody.safeParse(req.body);
    if (!b.success) throw badRequest("dados inválidos", b.error.issues);
    const [m] = await db.insert(schema.model).values(b.data).returning();
    if (m.isDefault) await unsetOtherDefaults(m.purpose, m.id);
    await audit(me, "create", "model", m.id, null, m);
    return { model: m };
  });

  app.put<{ Params: { id: string } }>("/api/v1/models/:id", async (req) => {
    const me = requireAdmin(req);
    const b = modelBody.partial().safeParse(req.body);
    if (!b.success) throw badRequest("dados inválidos", b.error.issues);
    const [before] = await db.select().from(schema.model).where(eq(schema.model.id, req.params.id));
    if (!before) throw notFound("modelo");
    const [m] = await db.update(schema.model).set(b.data).where(eq(schema.model.id, req.params.id)).returning();
    if (m.isDefault) await unsetOtherDefaults(m.purpose, m.id);
    const priceChanged = before.priceInPer1m !== m.priceInPer1m || before.priceOutPer1m !== m.priceOutPer1m || before.priceCachePer1m !== m.priceCachePer1m;
    await audit(me, priceChanged ? "update_price" : "update", "model", m.id, before, m);
    return { model: m };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/models/:id", async (req) => {
    const me = requireAdmin(req);
    const [before] = await db.delete(schema.model).where(eq(schema.model.id, req.params.id)).returning();
    if (!before) throw notFound("modelo");
    await audit(me, "delete", "model", before.id, before, null);
    return { ok: true };
  });
}

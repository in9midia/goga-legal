import { and, eq } from "drizzle-orm";
import type { LanguageModel } from "ai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { db, schema } from "../db/index.js";
import { decrypt } from "../lib/crypto.js";
import { HttpError } from "../lib/errors.js";
import { mockModel } from "./mock.js";

export type ModelRow = typeof schema.model.$inferSelect;
export type ProviderRow = typeof schema.provider.$inferSelect;

export interface ResolvedModel {
  row: ModelRow;
  provider: ProviderRow;
  model: LanguageModel;
}

export function buildLanguageModel(provider: ProviderRow, modelId: string): LanguageModel {
  const apiKey = provider.apiKeyEnc ? decrypt(provider.apiKeyEnc) : "";
  const baseURL = provider.baseUrl || undefined;
  if (provider.kind !== "mock" && !apiKey) {
    throw new HttpError(400, `Provedor "${provider.name}" está sem chave de API. Cadastre em Administração › Provedores.`);
  }
  switch (provider.kind) {
    case "deepseek":
      return createDeepSeek({ apiKey, baseURL })(modelId);
    case "gemini":
      return createGoogleGenerativeAI({ apiKey, baseURL })(modelId);
    case "openai_compat":
      if (!baseURL) throw new HttpError(400, `Provedor "${provider.name}" precisa de endpoint.`);
      return createOpenAICompatible({ name: provider.name, baseURL, apiKey })(modelId);
    case "mock":
      return mockModel(modelId);
  }
}

export async function resolveModel(modelRowId: string): Promise<ResolvedModel> {
  const [r] = await db
    .select()
    .from(schema.model)
    .innerJoin(schema.provider, eq(schema.model.providerId, schema.provider.id))
    .where(eq(schema.model.id, modelRowId));
  if (!r) throw new HttpError(400, "modelo não encontrado");
  if (!r.model.active || !r.provider.active) {
    throw new HttpError(400, `Modelo "${r.model.label}" ou seu provedor está inativo.`);
  }
  return { row: r.model, provider: r.provider, model: buildLanguageModel(r.provider, r.model.modelId) };
}

export async function defaultModelId(purpose: "chat" | "embedding" | "vision"): Promise<string | null> {
  const [r] = await db
    .select({ id: schema.model.id })
    .from(schema.model)
    .where(and(eq(schema.model.purpose, purpose), eq(schema.model.isDefault, true), eq(schema.model.active, true)));
  return r?.id ?? null;
}

export function costOf(row: ModelRow, tokensIn: number, tokensOut: number, tokensCache: number): number {
  const fresh = Math.max(0, tokensIn - tokensCache);
  return (fresh * row.priceInPer1m + tokensCache * row.priceCachePer1m + tokensOut * row.priceOutPer1m) / 1e6;
}

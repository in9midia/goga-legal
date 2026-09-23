// Catalogo de modelos e precos, para o cadastro escolher em vez de digitar.
//
// Porta do que a KB faz (kb_api/catalog.py + kb_api/precos.py):
//
// * a LISTA vem do proprio provedor (`GET /models` com a chave gravada). Errar
//   uma letra do modelId nao da erro no cadastro -- a falha aparece depois,
//   como 404 no meio de uma execucao;
// * o PRECO vem do `model_prices_and_context_window.json` do LiteLLM, a tabela
//   que o ecossistema mantem. Memorizado por 6h: muda quando o provedor
//   reajusta, semanas, nao minutos.
//
// Tres respostas de preco, e elas nao sao a mesma coisa (defeito real do
// agentic-sdlc ao junta-las): `catalogo` (achou), `nenhum` (o catalogo respondeu
// e nao conhece o modelo -- preencha a mao) e `indisponivel` (nao deu para ler o
// catalogo; sem saida para a internet, por exemplo).
import { config } from "../config.js";
import { decrypt } from "../lib/crypto.js";
import { HttpError } from "../lib/errors.js";
import type { ProviderRow } from "./models.js";

export type Purpose = "chat" | "embedding" | "vision";

export interface PriceInfo {
  source: "catalogo" | "nenhum" | "indisponivel";
  key?: string;
  priceInPer1m: number | null;
  priceOutPer1m: number | null;
  priceCachePer1m: number | null;
  contextWindow: number | null;
  purpose: Purpose | null;
  supportsTools: boolean | null;
  supportsJson: boolean | null;
}

export interface DiscoveredModel extends PriceInfo {
  modelId: string;
  label: string;
}

const TIMEOUT_MS = 20_000;
const TTL_MS = 6 * 60 * 60 * 1000;

// ---------------------------------------------------------------- precos

type PriceMap = Record<string, Record<string, unknown>>;
let cache: { url: string; at: number; map: PriceMap } | null = null;

async function priceMap(): Promise<PriceMap | null> {
  const url = config.priceCatalogUrl;
  if (!url) return null;
  if (cache && cache.url === url && Date.now() - cache.at < TTL_MS) return cache.map;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    if (!data || typeof data !== "object") return null;
    cache = { url, at: Date.now(), map: data as PriceMap };
    return cache.map;
  } catch {
    // Sem saida para a internet e o caso comum em cluster fechado; vira
    // `indisponivel`, nunca excecao.
    return null;
  }
}

// O catalogo indexa por `<provedor>/<modelo>` para alguns e pelo nome puro para
// outros, quase sempre em minusculo.
export function priceKeys(kind: ProviderRow["kind"], modelId: string): string[] {
  const id = modelId.trim().replace(/^models\//, "");
  const low = id.toLowerCase();
  const prefix = kind === "deepseek" ? "deepseek" : kind === "gemini" ? "gemini" : null;
  const keys = prefix ? [`${prefix}/${id}`, `${prefix}/${low}`, id, low] : [id, low];
  // Gateway compativel (OpenRouter, LiteLLM) costuma devolver `vendor/modelo`;
  // o nome sem o vendor tambem vale tentar.
  if (kind === "openai_compat" && id.includes("/")) {
    const tail = id.slice(id.lastIndexOf("/") + 1);
    keys.push(`openrouter/${id}`, tail, tail.toLowerCase());
  }
  return [...new Set(keys)];
}

// O catalogo guarda custo POR TOKEN. Ausencia e `null`, nao zero: zero afirmaria
// que o modelo e de graca.
function per1m(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1e6 * 1e6) / 1e6 : null;
}

const EMPTY = { priceInPer1m: null, priceOutPer1m: null, priceCachePer1m: null, contextWindow: null, purpose: null, supportsTools: null, supportsJson: null } as const;

export function priceFromEntry(key: string, e: Record<string, unknown>): PriceInfo {
  const mode = String(e.mode ?? "");
  const purpose: Purpose | null = mode === "embedding" ? "embedding" : mode === "chat" || mode === "completion" || mode === "responses" ? (e.supports_vision === true ? "vision" : "chat") : null;
  const ctx = Number(e.max_input_tokens ?? e.max_tokens);
  return {
    source: "catalogo",
    key,
    priceInPer1m: per1m(e.input_cost_per_token),
    priceOutPer1m: per1m(e.output_cost_per_token),
    priceCachePer1m: per1m(e.cache_read_input_token_cost),
    contextWindow: Number.isFinite(ctx) && ctx > 0 ? ctx : null,
    purpose,
    supportsTools: typeof e.supports_function_calling === "boolean" ? e.supports_function_calling : null,
    supportsJson: typeof e.supports_response_schema === "boolean" ? e.supports_response_schema : null,
  };
}

export function findPrice(map: PriceMap, kind: ProviderRow["kind"], modelId: string): PriceInfo {
  for (const key of priceKeys(kind, modelId)) {
    const e = map[key];
    if (!e || typeof e !== "object") continue;
    const info = priceFromEntry(key, e);
    if (info.priceInPer1m === null && info.priceOutPer1m === null) continue;
    return info;
  }
  return { source: "nenhum", ...EMPTY };
}

export async function lookupPrice(kind: ProviderRow["kind"], modelId: string): Promise<PriceInfo> {
  if (kind === "mock") return { source: "catalogo", key: "mock", ...EMPTY, priceInPer1m: 0, priceOutPer1m: 0, priceCachePer1m: 0 };
  const map = await priceMap();
  if (!map) return { source: "indisponivel", ...EMPTY };
  return findPrice(map, kind, modelId);
}

// ---------------------------------------------------------------- modelos

async function getJson(url: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new HttpError(502, `falha de rede ao contatar o provedor: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    // 401/403 e credencial; o resto e problema do outro lado.
    throw new HttpError(res.status === 401 || res.status === 403 ? 400 : 502, `o provedor respondeu HTTP ${res.status}: ${detail}`);
  }
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    throw new HttpError(502, "a resposta do provedor não é JSON válido");
  }
}

const items = (d: Record<string, unknown>, field = "data"): Record<string, unknown>[] =>
  Array.isArray(d[field]) ? (d[field] as unknown[]).filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];

interface RawModel {
  modelId: string;
  label: string;
  // Dicas do proprio provedor, quando ele informa (so o Gemini nativo).
  purpose?: Purpose;
  contextWindow?: number;
}

async function openaiStyle(baseUrl: string, apiKey: string): Promise<RawModel[]> {
  const d = await getJson(`${baseUrl.replace(/\/$/, "")}/models`, { authorization: `Bearer ${apiKey}` });
  return items(d)
    .map((m) => String(m.id ?? "").trim())
    .filter(Boolean)
    .map((id) => ({ modelId: id, label: id }));
}

async function gemini(baseUrl: string, apiKey: string): Promise<RawModel[]> {
  const base = (baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
  const out: RawModel[] = [];
  let pageToken = "";
  for (let i = 0; i < 10; i++) {
    const d = await getJson(`${base}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, { "x-goog-api-key": apiKey });
    for (const m of items(d, "models")) {
      const id = String(m.name ?? "").replace(/^models\//, "");
      if (!id) continue;
      const methods = Array.isArray(m.supportedGenerationMethods) ? (m.supportedGenerationMethods as string[]) : [];
      const purpose: Purpose | undefined = methods.includes("embedContent") ? "embedding" : methods.includes("generateContent") ? "chat" : undefined;
      // Modelo que nem gera nem vetoriza (AQA, imagem, TTS) nao serve ao Studio.
      if (!purpose) continue;
      out.push({ modelId: id, label: String(m.displayName ?? id), purpose, contextWindow: Number(m.inputTokenLimit) || undefined });
    }
    pageToken = String(d.nextPageToken ?? "");
    if (!pageToken) break;
  }
  return out;
}

async function rawModels(p: ProviderRow): Promise<RawModel[]> {
  if (p.kind === "mock") return [{ modelId: "goga-simulado", label: "Simulado (offline, sem custo)", purpose: "chat", contextWindow: 128_000 }];
  const apiKey = p.apiKeyEnc ? decrypt(p.apiKeyEnc) : "";
  if (!apiKey) throw new HttpError(400, `Provedor "${p.name}" está sem chave de API.`);
  switch (p.kind) {
    case "deepseek":
      return openaiStyle(p.baseUrl || "https://api.deepseek.com", apiKey);
    case "gemini":
      return gemini(p.baseUrl, apiKey);
    case "openai_compat":
      if (!p.baseUrl) throw new HttpError(400, `Provedor "${p.name}" precisa de endpoint.`);
      return openaiStyle(p.baseUrl, apiKey);
  }
}

/** Os modelos que a credencial do provedor alcanca, com preco quando o catalogo conhece. */
export async function discoverModels(p: ProviderRow): Promise<{ models: DiscoveredModel[]; priceSource: "ok" | "indisponivel" }> {
  const raw = await rawModels(p);
  const map = p.kind === "mock" ? {} : await priceMap();
  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const r of raw) {
    if (seen.has(r.modelId)) continue;
    seen.add(r.modelId);
    const price: PriceInfo =
      p.kind === "mock" ? await lookupPrice("mock", r.modelId) : map ? findPrice(map, p.kind, r.modelId) : { source: "indisponivel", ...EMPTY };
    models.push({
      ...price,
      modelId: r.modelId,
      label: r.label,
      // O que o provedor diz sobre si mesmo vence o catalogo, exceto visao, que
      // so o catalogo informa.
      purpose: r.purpose === "chat" && price.purpose === "vision" ? "vision" : (r.purpose ?? price.purpose),
      contextWindow: r.contextWindow ?? price.contextWindow,
    });
  }
  models.sort((a, b) => a.modelId.localeCompare(b.modelId, undefined, { sensitivity: "base" }));
  return { models, priceSource: map ? "ok" : "indisponivel" };
}

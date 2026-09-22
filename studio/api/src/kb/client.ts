import { config } from "../config.js";

// A KB roda com autenticacao desligada no MVP (modo `auth-desligada`, so rede
// local). Quando o Keycloak voltar, o token de servico do Studio entra aqui como
// header, e nada mais muda.

export interface KbSpace {
  slug: string;
  name?: string;
  description?: string;
  documents?: number;
  [k: string]: unknown;
}

export interface KbPassage {
  chunk_id: number;
  document_id: number;
  space: string;
  title: string;
  filename: string;
  content: string;
  page: number | null;
  score: number;
  armadilha?: string | null;
  representation?: string;
  [k: string]: unknown;
}

export interface KbSearchParams {
  query: string;
  spaces?: string[];
  top_k?: number;
  min_trust?: string;
  as_of?: string;
}

async function kbFetch<T>(path: string, init?: RequestInit, timeoutMs = 20000): Promise<T> {
  const res = await fetch(`${config.kbUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`KB ${res.status} em ${path}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

let spacesCache: { at: number; spaces: KbSpace[] } | null = null;

export async function listSpaces(fresh = false): Promise<KbSpace[]> {
  if (!fresh && spacesCache && Date.now() - spacesCache.at < 30_000) return spacesCache.spaces;
  const r = await kbFetch<{ spaces: KbSpace[] }>("/v1/spaces", undefined, 5000);
  spacesCache = { at: Date.now(), spaces: r.spaces };
  return r.spaces;
}

/** Slugs da KB, ou null se ela estiver fora do ar (a validacao do grafo pula). */
export async function spaceSlugs(): Promise<Set<string> | null> {
  try {
    return new Set((await listSpaces()).map((s) => s.slug));
  } catch {
    return null;
  }
}

export async function search(p: KbSearchParams): Promise<{ results: KbPassage[]; telemetry?: unknown }> {
  const body: Record<string, unknown> = { query: p.query, spaces: p.spaces ?? [], top_k: p.top_k ?? 6 };
  if (p.min_trust) body.min_trust = p.min_trust;
  if (p.as_of) body.as_of = p.as_of;
  return kbFetch("/v1/search", { method: "POST", body: JSON.stringify(body) }, 30000);
}

export async function fetchDocument(id: number): Promise<Record<string, unknown>> {
  return kbFetch(`/v1/documents/${id}?include_related=false`);
}

export async function aiUsage(days: number): Promise<unknown> {
  return kbFetch(`/v1/ai/usage?days=${days}`, undefined, 8000);
}

import { openAsBlob } from "node:fs";
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
  /** Caminho de secoes do trecho ("Título I › Capítulo IV"); vazio sem títulos. */
  section?: string;
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

/** Erro HTTP da KB com o status: 4xx e pedido errado (nao adianta repetir), 5xx e da KB. */
export class KbError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function kbFetch<T>(path: string, init?: RequestInit, timeoutMs = 20000): Promise<T> {
  const res = await fetch(`${config.kbUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new KbError(res.status, `KB ${res.status} em ${path}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

let spacesCache: { at: number; spaces: KbSpace[] } | null = null;
// A leitura em voo, compartilhada. O cache so vale depois que a primeira volta:
// 30 `ler_no` paralelos do Assistente abriam 30 GET /v1/spaces ao mesmo tempo,
// cada um com a contagem de trechos de todas as bases, e esgotavam as 8 conexoes
// do pool da KB; as buscas dos especialistas esperavam 30 s pela conexao e o
// Studio abortava ("The operation was aborted due to timeout").
let spacesInFlight: Promise<KbSpace[]> | null = null;
// Base criada ou apagada no meio de uma leitura: a resposta velha nao entra no cache.
let spacesGen = 0;

function invalidateSpaces() {
  spacesCache = null;
  spacesInFlight = null;
  spacesGen++;
}

function fetchSpaces(): Promise<KbSpace[]> {
  const gen = spacesGen;
  return kbFetch<{ spaces: KbSpace[] }>("/v1/spaces", undefined, 5000).then((r) => {
    if (gen === spacesGen) spacesCache = { at: Date.now(), spaces: r.spaces };
    return r.spaces;
  });
}

/** `fresh`: a tela de bases e as escritas, que precisam do estado de agora (nao pegam carona na leitura em voo). */
export async function listSpaces(fresh = false): Promise<KbSpace[]> {
  if (fresh) return fetchSpaces();
  if (spacesCache && Date.now() - spacesCache.at < 30_000) return spacesCache.spaces;
  if (!spacesInFlight) {
    const p = fetchSpaces().finally(() => {
      if (spacesInFlight === p) spacesInFlight = null;
    });
    spacesInFlight = p;
  }
  return spacesInFlight;
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
  const init = { method: "POST", body: JSON.stringify(body) };
  try {
    return await kbFetch("/v1/search", init, 30000);
  } catch (err) {
    // Uma retentativa: a busca e idempotente, e a KB as vezes demora no
    // primeiro acesso (embeddings frios) ou cai num restart. Pedido recusado
    // (4xx) daria o mesmo erro de novo.
    if (err instanceof KbError && err.status < 500) throw err;
    return kbFetch("/v1/search", init, 20000);
  }
}

export async function fetchDocument(id: number): Promise<Record<string, unknown>> {
  return kbFetch(`/v1/documents/${id}?include_related=false`);
}

/** Pagina da wiki inteira. Passagens da wiki voltam da busca com document_id 0
 * (a pagina pode derivar de varios documentos); o id dela e o `chunk_id`. */
export async function fetchWikiPage(id: number): Promise<Record<string, unknown>> {
  return kbFetch(`/v1/wiki/pages/${id}`);
}

export async function aiUsage(days: number): Promise<unknown> {
  return kbFetch(`/v1/ai/usage?days=${days}`, undefined, 8000);
}

// ── gestao da KB (bases e documentos) ──────────────────────────────────
// Escrita so por administradores do Studio (a rota confere). A KB enfileira a
// ingestao e responde 202: o andamento vem de /v1/ingest-runs.

export function createSpace(p: { slug: string; label?: string; description?: string }) {
  invalidateSpaces();
  return kbFetch<Record<string, unknown>>("/v1/spaces", { method: "POST", body: JSON.stringify(p) });
}

export function deleteSpace(slug: string) {
  invalidateSpaces();
  return kbFetch<{ removed: string }>(`/v1/spaces/${encodeURIComponent(slug)}`, { method: "DELETE" }, 120_000);
}

export function listDocuments(slug: string) {
  return kbFetch<{ documents: Record<string, unknown>[] } & Record<string, unknown>>(`/v1/spaces/${encodeURIComponent(slug)}/documents`);
}

export async function uploadDocument(slug: string, file: { name: string; mime: string; path: string }) {
  const form = new FormData();
  // Blob apoiado no arquivo em disco: o fetch le em streaming, sem carregar
  // centenas de MB na memoria do pod.
  form.append("file", await openAsBlob(file.path, { type: file.mime }), file.name);
  // Sem content-type manual: o fetch monta o boundary do multipart. Prazo
  // longo: a KB so responde depois de gravar o bruto no object store.
  const res = await fetch(`${config.kbUrl}/v1/spaces/${encodeURIComponent(slug)}/documents`, { method: "POST", body: form, signal: AbortSignal.timeout(30 * 60_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`KB ${res.status} ao enviar ${file.name}: ${text.slice(0, 300)}`);
  invalidateSpaces();
  return JSON.parse(text) as Record<string, unknown>;
}

export function deleteDocument(id: number) {
  invalidateSpaces();
  return kbFetch<Record<string, unknown>>(`/v1/documents/${id}`, { method: "DELETE" }, 60_000);
}

export function reprocessDocument(id: number) {
  return kbFetch<Record<string, unknown>>(`/v1/documents/${id}/reprocess`, { method: "POST", body: "{}" }, 600_000);
}

export function ingestRuns(q: { space?: string; status?: string; limit?: number }) {
  const p = new URLSearchParams();
  if (q.space) p.set("space", q.space);
  if (q.status) p.set("status", q.status);
  p.set("limit", String(q.limit ?? 30));
  return kbFetch<{ total: number; runs: Record<string, unknown>[] }>(`/v1/ingest-runs?${p}`);
}

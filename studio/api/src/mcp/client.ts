import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { decrypt } from "../lib/crypto.js";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpEndpoint {
  url: string;
  transport: "http" | "sse";
  headers: Record<string, string>;
}

type ServerRow = typeof schema.mcpServer.$inferSelect;

export function serverHeaders(srv: Pick<ServerRow, "headersEnc">): Record<string, string> {
  return srv.headersEnc ? (JSON.parse(decrypt(srv.headersEnc)) as Record<string, string>) : {};
}

// Uma sessao por servidor, reaproveitada. O handshake (initialize +
// tools/list) custa uma ida e volta a mais por chamada; num turno com tres
// especialistas isso somava latencia sem necessidade.
//
// Fechar o `Client` rejeita toda requisicao pendente com "Connection closed":
// com especialistas em paralelo no mesmo servidor, a falha de uma chamada
// derrubava as vizinhas. Por isso a sessao que falhou e aposentada (a proxima
// chamada abre outra) e so fecha quando a ultima chamada dela termina.
interface Session {
  client: Promise<Client>;
  pending: number;
  retired: boolean;
}
const sessions = new Map<string, Session>();

async function open(ep: McpEndpoint): Promise<Client> {
  const client = new Client({ name: "goga-studio", version: "0.1.0" });
  const requestInit = { headers: ep.headers };
  const url = new URL(ep.url);
  await client.connect(ep.transport === "sse" ? new SSEClientTransport(url, { requestInit }) : new StreamableHTTPClientTransport(url, { requestInit }));
  return client;
}

async function connect(serverId: string): Promise<Client> {
  const [srv] = await db.select().from(schema.mcpServer).where(eq(schema.mcpServer.id, serverId));
  if (!srv) throw new Error(`servidor MCP desconhecido: ${serverId}`);
  if (!srv.enabled) throw new Error(`servidor MCP "${srv.name}" está desabilitado`);
  return open({ url: srv.url, transport: srv.transport, headers: serverHeaders(srv) });
}

function session(serverId: string): Session {
  let s = sessions.get(serverId);
  if (!s) {
    const created: Session = { client: connect(serverId), pending: 0, retired: false };
    // Falha de conexao nao pode ficar em cache: o servidor pode subir depois.
    created.client.catch(() => {
      if (sessions.get(serverId) === created) sessions.delete(serverId);
    });
    sessions.set(serverId, created);
    s = created;
  }
  return s;
}

function retire(serverId: string, s: Session) {
  if (sessions.get(serverId) === s) sessions.delete(serverId);
  s.retired = true;
  closeIfIdle(s);
}

function closeIfIdle(s: Session) {
  if (s.retired && s.pending === 0) void s.client.then((c) => c.close()).catch(() => undefined);
}

/**
 * Erro que diz que a sessao nao serve mais: timeout, conexao fechada ou falha
 * de transporte (rede, HTTP, sessao que o servidor esqueceu ao reiniciar). Erro
 * de protocolo da propria ferramenta (parametro invalido, tool inexistente)
 * chega como `McpError` com outro codigo e nao recicla nada.
 */
export const sessionLost = (err: unknown) => !(err instanceof McpError) || err.code === ErrorCode.RequestTimeout || err.code === ErrorCode.ConnectionClosed;

/** Roda `fn` numa sessao do servidor. Conexao que caiu por baixo da chamada: uma nova tentativa, ja na sessao nova. */
async function withSession<T>(serverId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const s = session(serverId);
    s.pending++;
    try {
      return await fn(await s.client);
    } catch (err) {
      if (!sessionLost(err)) throw err;
      retire(serverId, s);
      if (attempt === 0 && err instanceof McpError && err.code === ErrorCode.ConnectionClosed) continue;
      throw err;
    } finally {
      s.pending--;
      closeIfIdle(s);
    }
  }
}

/** Descarta a sessao em cache (servidor editado, desligado ou removido). */
export function resetClient(serverId: string) {
  const s = sessions.get(serverId);
  if (s) retire(serverId, s);
}

const toTools = (r: Awaited<ReturnType<Client["listTools"]>>): McpTool[] =>
  r.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> }));

export async function listTools(serverId: string): Promise<McpTool[]> {
  try {
    const tools = toTools(await withSession(serverId, (c) => c.listTools()));
    await db.update(schema.mcpServer).set({ toolsCache: tools, lastError: null, checkedAt: new Date() }).where(eq(schema.mcpServer.id, serverId));
    return tools;
  } catch (err) {
    await db.update(schema.mcpServer).set({ lastError: (err as Error).message, checkedAt: new Date() }).where(eq(schema.mcpServer.id, serverId));
    throw err;
  }
}

/** Conecta a um endpoint ainda nao salvo, lista as tools e fecha. */
export async function probe(ep: McpEndpoint, timeoutMs = 10_000): Promise<McpTool[]> {
  const client = await withTimeout(open(ep), timeoutMs);
  try {
    return toTools(await withTimeout(client.listTools(), timeoutMs));
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`sem resposta em ${ms / 1000}s`)), ms))]);
}

export async function callTool(serverId: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const r = await withSession(serverId, (c) => c.callTool({ name: tool, arguments: args }));
  const content = (r.content as { type: string; text?: string }[] | undefined) ?? [];
  const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  let out: unknown;
  try {
    out = JSON.parse(text);
  } catch {
    out = text;
  }
  // Erro da ferramenta (isError) volta ao modelo como dado, com a marca de
  // erro: e o que deixa o motor contar a falha em vez de ler o texto como achado.
  return r.isError ? { erro: typeof out === "string" ? out.slice(0, 2000) : JSON.stringify(out).slice(0, 2000) } : out;
}

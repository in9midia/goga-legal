import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
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

// Uma conexao por servidor, reaproveitada. O handshake (initialize +
// tools/list) custa uma ida e volta a mais por chamada; num turno com tres
// especialistas isso somava latencia sem necessidade.
const clients = new Map<string, Promise<Client>>();

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

function getClient(serverId: string): Promise<Client> {
  let p = clients.get(serverId);
  if (!p) {
    p = connect(serverId);
    clients.set(serverId, p);
    // Falha de conexao nao pode ficar em cache: a KB pode subir depois.
    p.catch(() => clients.delete(serverId));
  }
  return p;
}

/** Descarta a conexao em cache (servidor editado, desligado ou removido). */
export function resetClient(serverId: string) {
  const p = clients.get(serverId);
  clients.delete(serverId);
  p?.then((c) => c.close()).catch(() => undefined);
}

const toTools = (r: Awaited<ReturnType<Client["listTools"]>>): McpTool[] =>
  r.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> }));

export async function listTools(serverId: string): Promise<McpTool[]> {
  try {
    const client = await getClient(serverId);
    const tools = toTools(await client.listTools());
    await db.update(schema.mcpServer).set({ toolsCache: tools, lastError: null, checkedAt: new Date() }).where(eq(schema.mcpServer.id, serverId));
    return tools;
  } catch (err) {
    clients.delete(serverId);
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
  try {
    const client = await getClient(serverId);
    const r = await client.callTool({ name: tool, arguments: args });
    const content = (r.content as { type: string; text?: string }[] | undefined) ?? [];
    const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (err) {
    clients.delete(serverId);
    throw err;
  }
}

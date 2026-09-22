import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

// Uma conexao por servidor, reaproveitada. O handshake (initialize +
// tools/list) custa uma ida e volta a mais por chamada; num turno com tres
// especialistas isso somava latencia sem necessidade.
const clients = new Map<string, Promise<Client>>();

async function connect(serverId: string): Promise<Client> {
  const [srv] = await db.select().from(schema.mcpServer).where(eq(schema.mcpServer.id, serverId));
  if (!srv) throw new Error(`servidor MCP desconhecido: ${serverId}`);
  if (!srv.enabled) throw new Error(`servidor MCP "${srv.name}" está desabilitado`);
  const client = new Client({ name: "goga-studio", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(srv.url)));
  return client;
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

export async function listTools(serverId: string): Promise<McpTool[]> {
  const client = await getClient(serverId);
  const r = await client.listTools();
  const tools = r.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> }));
  await db.update(schema.mcpServer).set({ toolsCache: tools }).where(eq(schema.mcpServer.id, serverId));
  return tools;
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

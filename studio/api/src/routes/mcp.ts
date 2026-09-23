import type { FastifyInstance } from "fastify";
import { and, asc, eq, like } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { audit } from "../lib/audit.js";
import { requireAdmin, requireUser } from "../lib/auth.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { encrypt } from "../lib/crypto.js";
import { flowsUsing, spanStats } from "../lib/usage.js";
import { callTool, listTools, probe, resetClient, serverHeaders, withTimeout } from "../mcp/client.js";

// Servidores MCP remotos (Streamable HTTP ou SSE). O Studio roda em container:
// servidor "stdio" (command/args) nao tem como ser iniciado daqui.

type ServerRow = typeof schema.mcpServer.$inferSelect;

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;

const serverBody = z.object({
  id: z.string().regex(ID_RE, "id: minúsculas, números, _ ou -, de 2 a 63 caracteres"),
  name: z.string().trim().min(1),
  url: z.string().url(),
  transport: z.enum(["http", "sse"]).default("http"),
  headers: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(true),
  description: z.string().default(""),
});

function headersOf(r: ServerRow) {
  try {
    return serverHeaders(r);
  } catch {
    return {};
  }
}

function publicServer(r: ServerRow) {
  const { headersEnc, ...rest } = r;
  return { ...rest, headerNames: Object.keys(headersOf(r)), hasUnreadableHeaders: !!headersEnc && !Object.keys(headersOf(r)).length };
}

const usesServer = (id: string) => (n: { data: { tools: { mcp: string[] } } }) => n.data.tools.mcp.some((m) => m.split(":")[0] === id);

/** Aceita o formato usual `{ "mcpServers": { "nome": { "url", "headers", "type" } } }` ou um servidor solto. */
function parseInstall(content: string) {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    throw badRequest("JSON inválido");
  }
  const d = data as Record<string, unknown>;
  const entries: [string, Record<string, unknown>][] = d.mcpServers
    ? Object.entries(d.mcpServers as Record<string, Record<string, unknown>>)
    : Array.isArray(data)
      ? (data as Record<string, unknown>[]).map((x) => [String(x.id ?? x.name ?? ""), x])
      : [[String(d.id ?? d.name ?? ""), d]];
  const ok: z.infer<typeof serverBody>[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const [key, v] of entries) {
    const url = (v.url ?? v.serverUrl) as string | undefined;
    if (!url) {
      skipped.push({ name: key, reason: v.command ? "servidor stdio (command) não roda no Studio; publique-o por HTTP" : "sem url" });
      continue;
    }
    const id = key
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63);
    const b = serverBody.safeParse({
      id,
      name: (v.name as string) ?? key,
      url,
      transport: v.type === "sse" || v.transport === "sse" ? "sse" : "http",
      headers: (v.headers as Record<string, string>) ?? {},
      enabled: v.enabled ?? true,
      description: (v.description as string) ?? "",
    });
    if (b.success) ok.push(b.data);
    else skipped.push({ name: key, reason: b.error.issues.map((i) => i.message).join("; ") });
  }
  return { ok, skipped };
}

export async function mcpRoutes(app: FastifyInstance) {
  const get = async (id: string) => {
    const [r] = await db.select().from(schema.mcpServer).where(eq(schema.mcpServer.id, id));
    if (!r) throw notFound("servidor MCP");
    return r;
  };
  const refresh = (id: string) => withTimeout(listTools(id), 8_000).catch(() => undefined);

  app.get<{ Querystring: { refresh?: string } }>("/api/v1/mcp", async (req) => {
    requireUser(req);
    let servers = await db.select().from(schema.mcpServer).orderBy(asc(schema.mcpServer.id));
    // Atualiza a lista de tools dos servidores ativos, sem travar a tela se um
    // deles estiver fora: fica o cache da ultima vez.
    if (req.query.refresh !== "0") {
      await Promise.all(servers.filter((s) => s.enabled).map((s) => refresh(s.id)));
      servers = await db.select().from(schema.mcpServer).orderBy(asc(schema.mcpServer.id));
    }
    const flows = await db.select({ graph: schema.flow.graph }).from(schema.flow);
    const count = (id: string) => flows.filter((f) => ((f.graph as { nodes?: { data: { tools: { mcp: string[] } } }[] }).nodes ?? []).some(usesServer(id))).length;
    return { servers: servers.map((s) => ({ ...publicServer(s), flowCount: count(s.id) })) };
  });

  app.get<{ Params: { id: string } }>("/api/v1/mcp/:id", async (req) => {
    requireUser(req);
    const r = await get(req.params.id);
    return { server: publicServer(r), flows: await flowsUsing(usesServer(r.id)) };
  });

  const insert = async (b: z.infer<typeof serverBody>) => {
    const [dup] = await db.select({ id: schema.mcpServer.id }).from(schema.mcpServer).where(eq(schema.mcpServer.id, b.id));
    if (dup) throw conflict(`já existe o servidor "${b.id}"`, { id: b.id });
    const { headers, ...rest } = b;
    const [r] = await db
      .insert(schema.mcpServer)
      .values({ ...rest, authMode: Object.keys(headers).length ? "headers" : "none", headersEnc: Object.keys(headers).length ? encrypt(JSON.stringify(headers)) : "", origin: "custom" })
      .returning();
    if (r.enabled) await refresh(r.id);
    return get(r.id);
  };

  app.post("/api/v1/mcp", async (req) => {
    const me = requireAdmin(req);
    const b = serverBody.safeParse(req.body);
    if (!b.success) throw badRequest("dados inválidos", b.error.issues);
    const r = await insert(b.data);
    await audit(me, "create", "mcp_server", r.id, null, r);
    return { server: publicServer(r) };
  });

  app.post("/api/v1/mcp/import", async (req) => {
    const me = requireAdmin(req);
    const b = z.object({ content: z.string().min(1) }).safeParse(req.body);
    if (!b.success) throw badRequest("cole a configuração JSON");
    const { ok, skipped } = parseInstall(b.data.content);
    const created: string[] = [];
    for (const s of ok) {
      try {
        const r = await insert(s);
        await audit(me, "import", "mcp_server", r.id, null, r);
        created.push(r.id);
      } catch (err) {
        skipped.push({ name: s.id, reason: (err as Error).message });
      }
    }
    return { created, skipped };
  });

  // Testa um endpoint antes de salvar. Cabecalho em branco usa o valor salvo
  // (a tela nunca recebe o valor), quando o servidor ja existe.
  app.post("/api/v1/mcp/probe", async (req) => {
    requireAdmin(req);
    const b = z.object({ id: z.string().optional(), url: z.string().url(), transport: z.enum(["http", "sse"]).default("http"), headers: z.record(z.string(), z.string()).default({}) }).safeParse(req.body);
    if (!b.success) throw badRequest("URL inválida");
    const saved = b.data.id ? await db.select().from(schema.mcpServer).where(eq(schema.mcpServer.id, b.data.id)).then((r) => (r[0] ? headersOf(r[0]) : {})) : {};
    const headers = Object.fromEntries(Object.entries(b.data.headers).map(([k, v]) => [k, v || saved[k] || ""]).filter(([, v]) => v));
    const t0 = Date.now();
    try {
      const tools = await probe({ url: b.data.url, transport: b.data.transport, headers });
      return { ok: true, ms: Date.now() - t0, tools };
    } catch (err) {
      return { ok: false, ms: Date.now() - t0, error: (err as Error).message };
    }
  });

  app.put<{ Params: { id: string } }>("/api/v1/mcp/:id", async (req) => {
    const me = requireAdmin(req);
    const b = serverBody.omit({ id: true }).partial().safeParse(req.body);
    if (!b.success) throw badRequest("dados inválidos", b.error.issues);
    const before = await get(req.params.id);
    const { headers, ...rest } = b.data;
    const set: Partial<typeof schema.mcpServer.$inferInsert> = { ...rest, updatedAt: new Date() };
    if (before.origin === "system" && before.id === "goga-kb" && rest.url && rest.url !== before.url) {
      throw badRequest("a URL do goga-kb vem de KB_URL (configuração do Studio) e é regravada a cada boot");
    }
    if (headers) {
      const cur = headersOf(before);
      const merged = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, v || cur[k] || ""]).filter(([, v]) => v));
      set.headersEnc = Object.keys(merged).length ? encrypt(JSON.stringify(merged)) : "";
      set.authMode = Object.keys(merged).length ? "headers" : "none";
    }
    const [after] = await db.update(schema.mcpServer).set(set).where(eq(schema.mcpServer.id, before.id)).returning();
    resetClient(before.id);
    if (after.enabled) await refresh(after.id);
    await audit(me, "update", "mcp_server", before.id, before, after);
    return { server: publicServer(await get(before.id)) };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/mcp/:id", async (req) => {
    const me = requireAdmin(req);
    const before = await get(req.params.id);
    if (before.origin === "system") throw badRequest("servidor do sistema não pode ser excluído; desabilite-o");
    const flows = await flowsUsing(usesServer(before.id));
    if (flows.length) throw conflict(`servidor em uso em ${flows.length} fluxo(s); tire as ferramentas dos nós antes de excluir`, { flows });
    await db.delete(schema.mcpServer).where(eq(schema.mcpServer.id, before.id));
    resetClient(before.id);
    await audit(me, "delete", "mcp_server", before.id, before, null);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/v1/mcp/:id/refresh", async (req) => {
    requireAdmin(req);
    const r = await get(req.params.id);
    if (!r.enabled) throw badRequest("servidor desabilitado");
    resetClient(r.id);
    const t0 = Date.now();
    try {
      const tools = await withTimeout(listTools(r.id), 10_000);
      return { ok: true, ms: Date.now() - t0, tools };
    } catch (err) {
      return { ok: false, ms: Date.now() - t0, error: (err as Error).message };
    }
  });

  app.post<{ Params: { id: string } }>("/api/v1/mcp/:id/call", async (req) => {
    requireAdmin(req);
    const b = z.object({ tool: z.string().min(1), args: z.record(z.string(), z.unknown()).default({}) }).safeParse(req.body);
    if (!b.success) throw badRequest("informe a ferramenta e os argumentos (objeto JSON)");
    const r = await get(req.params.id);
    if (!r.enabled) throw badRequest("servidor desabilitado");
    const t0 = Date.now();
    try {
      const output = await withTimeout(callTool(r.id, b.data.tool, b.data.args), 30_000);
      return { ok: true, ms: Date.now() - t0, output };
    } catch (err) {
      return { ok: false, ms: Date.now() - t0, error: (err as Error).message };
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/mcp/:id/export", async (req, reply) => {
    requireUser(req);
    const r = await get(req.params.id);
    const cfg = {
      mcpServers: {
        [r.id]: {
          name: r.name,
          type: r.transport === "sse" ? "sse" : "http",
          url: r.url,
          description: r.description,
          // Valores podem ser token: exporta so os nomes.
          headers: Object.fromEntries(Object.keys(headersOf(r)).map((k) => [k, ""])),
        },
      },
    };
    return reply.header("content-disposition", `attachment; filename="${r.id}.mcp.json"`).send(cfg);
  });

  app.get<{ Params: { id: string }; Querystring: { days?: string } }>("/api/v1/mcp/:id/stats", async (req) => {
    requireUser(req);
    const r = await get(req.params.id);
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    return spanStats(and(eq(schema.span.kind, "mcp"), like(schema.span.name, `mcp · ${r.id.replace(/[_%\\]/g, "\\$&")}.%`))!, days);
  });
}

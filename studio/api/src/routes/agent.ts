import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, count, desc, eq, gt, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { audit } from "../lib/audit.js";
import { config } from "../config.js";
import { hashToken, newToken, requireBrowserSession, requireUser, type SessionUser } from "../lib/auth.js";
import { badRequest, HttpError, notFound } from "../lib/errors.js";
import { ASK_TOOL, SENSITIVE, StudioApi, buildTools, credentialsOf, type ToolCtx } from "../assistant/tools.js";
import { GOGA_DOMINIO } from "../assistant/prompt.js";
import { saveUpload } from "../files/storage.js";

// Agentes externos (Claude Code, Codex, Gemini CLI) operando o Studio com as
// MESMAS ferramentas do Assistente: mesma validacao, mesmas rotas por baixo,
// mesma auditoria (a pessoa dona do token). O que muda e so quem conversa:
// - `perguntar` e `exibir` sao da UI do Assistente; la fora o agente pergunta
//   e mostra do jeito dele.
// - As ferramentas sensiveis (publicar, excluir, restaurar, lote, escrita
//   generica) exigem `confirm: true`. Sem isso a API devolve 428 com o resumo
//   do que seria feito, e a skill manda o agente pedir aprovacao ao usuario
//   antes de repetir com a confirmacao — o equivalente ao botao "Aprovar".

const UI_ONLY = new Set([ASK_TOOL, "exibir"]);

type Listed = { name: string; description: string; sensitive: boolean; inputSchema: z.ZodType };

function catalog(ctx: ToolCtx): Map<string, Listed & { execute?: (input: unknown) => Promise<unknown> }> {
  const tools = buildTools(ctx);
  const out = new Map<string, Listed & { execute?: (input: unknown) => Promise<unknown> }>();
  for (const [name, t] of Object.entries(tools)) {
    if (UI_ONLY.has(name)) continue;
    const s = SENSITIVE[name];
    if (s) {
      out.set(name, { name, description: s.description, sensitive: true, inputSchema: s.input, execute: (i) => s.run(i as Record<string, unknown>, ctx) });
      continue;
    }
    const exec = t.execute;
    out.set(name, {
      name,
      description: typeof t.description === "string" ? t.description : "",
      sensitive: false,
      inputSchema: t.inputSchema as z.ZodType,
      execute: exec ? async (i) => exec(i, { toolCallId: randomUUID(), messages: [], context: undefined as never }) : undefined,
    });
  }
  return out;
}

// ── skill para download ────────────────────────────────────────────────
// A pasta da skill vai na imagem da API (src|dist/routes -> ../../agent-skill).
// O goga.mjs sai com o endereco deste Studio embutido, para que
// `curl <studio>/skills/goga.mjs | node - instalar` nao precise de --url.
const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../agent-skill/goga-studio");
const SCRIPT = "scripts/goga.mjs";

function publicOrigin(req: FastifyRequest): string {
  return config.publicUrl || `${req.protocol}://${req.headers.host ?? req.host}`;
}

async function skillFiles(): Promise<{ path: string; content: string }[]> {
  const entries = await readdir(SKILL_DIR, { recursive: true, withFileTypes: true });
  // install.sh so faz sentido dentro do repositorio (liga links para o clone).
  const files = entries.filter((e) => e.isFile() && !e.name.startsWith(".") && e.name !== "install.sh");
  return Promise.all(
    files.map(async (e) => {
      const full = path.join(e.parentPath, e.name);
      return { path: path.relative(SKILL_DIR, full).split(path.sep).join("/"), content: await readFile(full, "utf8") };
    }),
  );
}

const withOrigin = (script: string, origin: string) => script.replace(/^const EMBEDDED_URL = null;$/m, `const EMBEDDED_URL = ${JSON.stringify(origin)};`);

// ── login pelo navegador ───────────────────────────────────────────────
const LOGIN_TTL_MS = 10 * 60_000;
// Sem 0/O, 1/I/L: o codigo e conferido a olho entre terminal e navegador.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function userCode() {
  const b = randomBytes(8);
  const c = [...b].map((x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join("");
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

const jsonSchemaOf = (s: z.ZodType) => z.toJSONSchema(s, { io: "input", unrepresentable: "any" });

export async function agentRoutes(app: FastifyInstance) {
  const ctxOf = (req: Parameters<typeof requireUser>[0]): ToolCtx => ({ api: new StudioApi(app, credentialsOf(req.headers)), user: requireUser(req) });

  // ── tokens (so pela sessao do navegador) ────────────────────────────
  app.get("/api/v1/agent/tokens", async (req) => {
    const me = requireBrowserSession(req);
    const rows = await db
      .select({ id: schema.apiToken.id, name: schema.apiToken.name, prefix: schema.apiToken.prefix, createdAt: schema.apiToken.createdAt, lastUsedAt: schema.apiToken.lastUsedAt, expiresAt: schema.apiToken.expiresAt })
      .from(schema.apiToken)
      .where(and(eq(schema.apiToken.userId, me.id), isNull(schema.apiToken.revokedAt)))
      .orderBy(desc(schema.apiToken.createdAt));
    return { tokens: rows };
  });

  app.post("/api/v1/agent/tokens", async (req) => {
    const me = requireBrowserSession(req);
    const b = z.object({ name: z.string().trim().min(1).max(80), expiresInDays: z.number().int().min(1).max(365).nullable().default(90) }).safeParse(req.body ?? {});
    if (!b.success) throw badRequest("dê um nome ao token (ex.: \"Claude Code no notebook\")", b.error.issues);
    const t = newToken();
    const expiresAt = b.data.expiresInDays ? new Date(Date.now() + b.data.expiresInDays * 864e5) : null;
    const [row] = await db.insert(schema.apiToken).values({ userId: me.id, name: b.data.name, tokenHash: t.hash, prefix: t.prefix, expiresAt }).returning();
    await audit(me, "create", "api_token", row.id, null, { name: row.name, prefix: row.prefix, expiresAt });
    // Unica vez em que o token aparece.
    return { token: t.token, info: { id: row.id, name: row.name, prefix: row.prefix, createdAt: row.createdAt, lastUsedAt: null, expiresAt } };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/agent/tokens/:id", async (req) => {
    const me = requireBrowserSession(req);
    const [row] = await db
      .update(schema.apiToken)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.apiToken.id, req.params.id), eq(schema.apiToken.userId, me.id), isNull(schema.apiToken.revokedAt)))
      .returning();
    if (!row) throw notFound("token");
    await audit(me, "revoke", "api_token", row.id, { name: row.name, prefix: row.prefix }, null);
    return { ok: true };
  });

  // ── skill (publico) ─────────────────────────────────────────────────
  const serveScript = async (req: FastifyRequest, reply: import("fastify").FastifyReply) => {
    const script = (await skillFiles()).find((f) => f.path === SCRIPT);
    if (!script) throw notFound("script da skill");
    return reply.type("text/javascript; charset=utf-8").header("cache-control", "no-store").send(withOrigin(script.content, publicOrigin(req)));
  };
  app.get("/skills/goga.mjs", serveScript);
  app.get("/api/v1/agent/skill/goga.mjs", serveScript);

  app.get("/api/v1/agent/skill/bundle", async (req) => {
    const origin = publicOrigin(req);
    const files = (await skillFiles()).map((f) => (f.path === SCRIPT ? { ...f, content: withOrigin(f.content, origin) } : f));
    return { name: path.basename(SKILL_DIR), origin, files };
  });

  // ── login do agente pelo navegador ─────────────────────────────────
  // 1. CLI: POST /login/start -> deviceCode (segredo, fica no CLI) + userCode + URL.
  // 2. Pessoa abre a URL (logando se preciso), confere o codigo e autoriza.
  // 3. CLI: POST /login/poll com o deviceCode ate vir o token.
  app.post("/api/v1/agent/login/start", async (req) => {
    const b = z.object({ client: z.string().trim().min(1).max(120) }).safeParse(req.body ?? {});
    if (!b.success) throw badRequest("informe o cliente (ex.: \"Claude Code em notebook\")");
    const now = new Date();
    await db.delete(schema.agentLogin).where(lt(schema.agentLogin.expiresAt, now));
    // Rota publica: um teto de pedidos abertos impede encher a tabela.
    const [{ n }] = await db.select({ n: count() }).from(schema.agentLogin).where(and(eq(schema.agentLogin.status, "pending"), gt(schema.agentLogin.expiresAt, now)));
    if (n >= 200) throw new HttpError(429, "muitos pedidos de login abertos; tente em alguns minutos");
    const deviceCode = randomBytes(32).toString("hex");
    const code = userCode();
    const expiresAt = new Date(now.getTime() + LOGIN_TTL_MS);
    await db.insert(schema.agentLogin).values({ deviceHash: hashToken(deviceCode), userCode: code, client: b.data.client, expiresAt });
    const origin = publicOrigin(req);
    return { deviceCode, userCode: code, verifyUrl: `${origin}/agents/autorizar?codigo=${code}`, origin, expiresAt, interval: 2 };
  });

  app.post("/api/v1/agent/login/poll", async (req, reply) => {
    const b = z.object({ deviceCode: z.string().min(10) }).safeParse(req.body ?? {});
    if (!b.success) throw badRequest("deviceCode ausente");
    const [row] = await db.select().from(schema.agentLogin).where(eq(schema.agentLogin.deviceHash, hashToken(b.data.deviceCode)));
    if (!row || row.status === "consumed") throw notFound("pedido de login");
    if (row.status === "denied") throw new HttpError(403, "login recusado no navegador");
    if (row.status === "pending") {
      if (row.expiresAt < new Date()) throw new HttpError(410, "o pedido de login expirou; rode o login de novo");
      return reply.status(202).send({ status: "pending" });
    }
    // Aprovado: o token nasce agora e o pedido nao serve mais.
    const [done] = await db.update(schema.agentLogin).set({ status: "consumed" }).where(and(eq(schema.agentLogin.id, row.id), eq(schema.agentLogin.status, "approved"))).returning();
    if (!done || !row.userId) throw notFound("pedido de login");
    const [u] = await db.select().from(schema.appUser).where(eq(schema.appUser.id, row.userId));
    if (!u?.active) throw new HttpError(403, "usuário inativo");
    const t = newToken();
    const expiresAt = row.expiresInDays ? new Date(Date.now() + row.expiresInDays * 864e5) : null;
    const [tok] = await db.insert(schema.apiToken).values({ userId: u.id, name: row.client, tokenHash: t.hash, prefix: t.prefix, expiresAt }).returning();
    const user: SessionUser = { id: u.id, email: u.email, name: u.name, role: u.role };
    await audit(user, "create", "api_token", tok.id, null, { name: tok.name, prefix: tok.prefix, expiresAt, via: "login do agente" });
    return { token: t.token, user, expiresAt };
  });

  const pendingByCode = async (code: string) => {
    const [row] = await db.select().from(schema.agentLogin).where(eq(schema.agentLogin.userCode, code.trim().toUpperCase()));
    if (!row) throw notFound("pedido de login");
    return row;
  };

  app.get<{ Params: { code: string } }>("/api/v1/agent/login/:code", async (req) => {
    requireBrowserSession(req);
    const row = await pendingByCode(req.params.code);
    const status = row.status === "pending" && row.expiresAt < new Date() ? "expired" : row.status;
    return { client: row.client, userCode: row.userCode, status, createdAt: row.createdAt, expiresAt: row.expiresAt };
  });

  app.post<{ Params: { code: string } }>("/api/v1/agent/login/:code/decide", async (req) => {
    const me = requireBrowserSession(req);
    const b = z.object({ approve: z.boolean(), expiresInDays: z.number().int().min(1).max(365).nullable().default(90) }).safeParse(req.body ?? {});
    if (!b.success) throw badRequest("dados inválidos", b.error.issues);
    const row = await pendingByCode(req.params.code);
    if (row.status !== "pending") throw new HttpError(409, "este pedido já foi decidido");
    if (row.expiresAt < new Date()) throw new HttpError(410, "o pedido expirou; rode o login de novo no terminal");
    await db
      .update(schema.agentLogin)
      .set(b.data.approve ? { status: "approved", userId: me.id, expiresInDays: b.data.expiresInDays } : { status: "denied" })
      .where(and(eq(schema.agentLogin.id, row.id), eq(schema.agentLogin.status, "pending")));
    return { ok: true, status: b.data.approve ? "approved" : "denied" };
  });

  // ── arquivos do agente ─────────────────────────────────────────────
  // O CLI sobe arquivos locais aqui e recebe fileIds, que as ferramentas usam
  // (ex.: enviar_documento_kb). Sem extracao de texto: o destino costuma ser a
  // KB, que extrai do jeito dela, e PDF grande travaria o upload.
  const MAX_AGENT_UPLOAD = config.maxUploadMb * 1024 * 1024;
  app.post("/api/v1/agent/files", async (req) => {
    requireUser(req);
    const part = await req.file({ limits: { fileSize: MAX_AGENT_UPLOAD } });
    if (!part) throw badRequest("nenhum arquivo enviado");
    const f = await saveUpload(part, { sessionId: null, mime: part.mimetype }, MAX_AGENT_UPLOAD);
    return { file: { id: f.id, name: f.name, mime: f.mime, size: f.size } };
  });

  // ── guia e ferramentas ──────────────────────────────────────────────
  app.get("/api/v1/agent/guide", async (req) => {
    const ctx = ctxOf(req);
    const tools = [...catalog(ctx).values()].map((t) => ({ name: t.name, sensitive: t.sensitive, description: t.description }));
    return { user: ctx.user, domain: GOGA_DOMINIO, tools };
  });

  app.get("/api/v1/agent/tools", async (req) => {
    const tools = [...catalog(ctxOf(req)).values()].map((t) => ({ name: t.name, sensitive: t.sensitive, description: t.description, inputSchema: jsonSchemaOf(t.inputSchema) }));
    return { tools };
  });

  app.post<{ Params: { name: string } }>("/api/v1/agent/tools/:name", async (req, reply) => {
    const ctx = ctxOf(req);
    const t = catalog(ctx).get(req.params.name);
    if (!t?.execute) throw notFound(`ferramenta "${req.params.name}"`);
    const b = z.object({ input: z.unknown().default({}), confirm: z.boolean().default(false) }).safeParse(req.body ?? {});
    if (!b.success) throw badRequest("corpo esperado: { input, confirm? }", b.error.issues);
    const parsed = t.inputSchema.safeParse(b.data.input ?? {});
    if (!parsed.success) throw badRequest(`entrada inválida para ${t.name}`, parsed.error.issues);
    if (t.sensitive && !b.data.confirm) {
      const resumo = SENSITIVE[t.name].resumo(parsed.data as Record<string, unknown>);
      return reply.status(428).send({ error: "precisa de aprovação do usuário", requiresConfirmation: true, tool: t.name, resumo });
    }
    try {
      return { tool: t.name, result: await t.execute(parsed.data) };
    } catch (err) {
      // As ferramentas repassam o erro da API interna como "HTTP 4xx: motivo".
      const msg = err instanceof Error ? err.message : String(err);
      const status = Number(/^HTTP (\d{3})/.exec(msg)?.[1] ?? 500);
      throw new HttpError(status >= 400 && status < 600 ? status : 500, msg);
    }
  });
}

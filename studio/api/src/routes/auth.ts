import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { audit } from "../lib/audit.js";
import { hashPassword, requireAdmin, requireUser, verifyPassword } from "../lib/auth.js";
import { badRequest, conflict, HttpError, notFound } from "../lib/errors.js";

const publicUser = (u: typeof schema.appUser.$inferSelect) => ({ id: u.id, name: u.name, email: u.email, role: u.role, active: u.active, createdAt: u.createdAt });

export async function authRoutes(app: FastifyInstance) {
  app.post("/api/v1/auth/login", { config: { public: true } }, async (req) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).safeParse(req.body);
    if (!body.success) throw badRequest("informe e-mail e senha");
    const [u] = await db.select().from(schema.appUser).where(eq(schema.appUser.email, body.data.email.toLowerCase()));
    // Mesma mensagem para "nao existe" e "senha errada": a diferenca diria a
    // quem tenta quais e-mails tem conta.
    if (!u || !u.active || !(await verifyPassword(u.passwordHash, body.data.password))) {
      throw new HttpError(401, "e-mail ou senha inválidos");
    }
    await req.session.regenerate();
    req.session.userId = u.id;
    return { user: publicUser(u) };
  });

  app.post("/api/v1/auth/logout", { config: { public: true } }, async (req) => {
    await req.session.destroy();
    return { ok: true };
  });

  app.get("/api/v1/auth/me", async (req) => ({ user: requireUser(req) }));

  app.post("/api/v1/auth/password", async (req) => {
    const me = requireUser(req);
    const b = z.object({ current: z.string(), password: z.string().min(8) }).safeParse(req.body);
    if (!b.success) throw badRequest("a nova senha precisa de ao menos 8 caracteres");
    const [u] = await db.select().from(schema.appUser).where(eq(schema.appUser.id, me.id));
    if (!(await verifyPassword(u.passwordHash, b.data.current))) throw new HttpError(400, "senha atual incorreta");
    await db.update(schema.appUser).set({ passwordHash: await hashPassword(b.data.password) }).where(eq(schema.appUser.id, me.id));
    await audit(me, "change_password", "user", me.id, undefined, undefined);
    return { ok: true };
  });

  // ── usuarios (admin) ────────────────────────────────────────────────
  app.get("/api/v1/users", async (req) => {
    requireAdmin(req);
    const rows = await db.select().from(schema.appUser).orderBy(schema.appUser.createdAt);
    return { users: rows.map(publicUser) };
  });

  const userBody = z.object({
    name: z.string().min(1),
    email: z.string().email(),
    role: z.enum(["admin", "operador"]),
    password: z.string().min(8).optional(),
    active: z.boolean().optional(),
  });

  app.post("/api/v1/users", async (req) => {
    const me = requireAdmin(req);
    const b = userBody.required({ password: true }).safeParse(req.body);
    if (!b.success) throw badRequest("dados inválidos", b.error.issues);
    const email = b.data.email.toLowerCase();
    const [exists] = await db.select({ id: schema.appUser.id }).from(schema.appUser).where(eq(schema.appUser.email, email));
    if (exists) throw conflict("já existe usuário com este e-mail");
    const [u] = await db.insert(schema.appUser).values({ name: b.data.name, email, role: b.data.role, passwordHash: await hashPassword(b.data.password) }).returning();
    await audit(me, "create", "user", u.id, null, publicUser(u));
    return { user: publicUser(u) };
  });

  app.put<{ Params: { id: string } }>("/api/v1/users/:id", async (req) => {
    const me = requireAdmin(req);
    const b = userBody.partial().safeParse(req.body);
    if (!b.success) throw badRequest("dados inválidos", b.error.issues);
    const [before] = await db.select().from(schema.appUser).where(eq(schema.appUser.id, req.params.id));
    if (!before) throw notFound("usuário");
    if (before.id === me.id && (b.data.active === false || (b.data.role && b.data.role !== "admin"))) {
      throw badRequest("você não pode desativar nem rebaixar a si mesmo");
    }
    const set: Partial<typeof schema.appUser.$inferInsert> = {};
    if (b.data.name) set.name = b.data.name;
    if (b.data.email) set.email = b.data.email.toLowerCase();
    if (b.data.role) set.role = b.data.role;
    if (b.data.active !== undefined) set.active = b.data.active;
    if (b.data.password) set.passwordHash = await hashPassword(b.data.password);
    const [u] = await db.update(schema.appUser).set(set).where(eq(schema.appUser.id, req.params.id)).returning();
    await audit(me, b.data.password ? "update_with_password" : "update", "user", u.id, publicUser(before), publicUser(u));
    return { user: publicUser(u) };
  });
}

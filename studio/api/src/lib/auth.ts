import type { FastifyReply, FastifyRequest } from "fastify";
import argon2 from "argon2";
import { eq, lt } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { HttpError } from "./errors.js";

export type Role = "admin" | "operador";
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

declare module "fastify" {
  interface Session {
    userId?: string;
  }
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export const hashPassword = (plain: string) => argon2.hash(plain, { type: argon2.argon2id });
export const verifyPassword = (hash: string, plain: string) => argon2.verify(hash, plain).catch(() => false);

// Store do @fastify/session no Postgres. Sessao em memoria perderia o login a
// cada restart do `tsx watch`, que em dev acontece a cada arquivo salvo.
type Cb = (err?: unknown, result?: unknown) => void;
export const pgSessionStore = {
  get(sid: string, cb: Cb) {
    db.select()
      .from(schema.appSession)
      .where(eq(schema.appSession.sid, sid))
      .then(([row]) => cb(null, row && row.expiresAt > new Date() ? row.data : null), cb);
  },
  set(sid: string, session: { cookie?: { expires?: Date | null } }, cb: Cb) {
    const expiresAt = session.cookie?.expires ? new Date(session.cookie.expires) : new Date(Date.now() + 864e5);
    const data = JSON.parse(JSON.stringify(session));
    db.insert(schema.appSession)
      .values({ sid, data, expiresAt })
      .onConflictDoUpdate({ target: schema.appSession.sid, set: { data, expiresAt } })
      .then(() => cb(), cb);
  },
  destroy(sid: string, cb: Cb) {
    db.delete(schema.appSession)
      .where(eq(schema.appSession.sid, sid))
      .then(() => cb(), cb);
  },
};

export async function pruneSessions() {
  await db.delete(schema.appSession).where(lt(schema.appSession.expiresAt, new Date()));
}

export async function loadUser(req: FastifyRequest): Promise<void> {
  req.user = null;
  const id = req.session?.userId;
  if (!id) return;
  const [u] = await db.select().from(schema.appUser).where(eq(schema.appUser.id, id));
  // Usuario desativado perde a sessao na proxima requisicao, e nao so no proximo
  // login: desativar e o jeito de cortar acesso de quem saiu.
  if (!u || !u.active) return;
  req.user = { id: u.id, email: u.email, name: u.name, role: u.role };
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw new HttpError(401, "sessão expirada ou inexistente");
  return req.user;
}

export function requireAdmin(req: FastifyRequest): SessionUser {
  const u = requireUser(req);
  if (u.role !== "admin") throw new HttpError(403, "apenas administradores");
  return u;
}

export const authHooks = {
  async preHandler(req: FastifyRequest, _reply: FastifyReply) {
    await loadUser(req);
  },
};

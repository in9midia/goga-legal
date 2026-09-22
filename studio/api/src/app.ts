import Fastify, { type FastifyError } from "fastify";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import multipart from "@fastify/multipart";
import { ZodError } from "zod";
import { config } from "./config.js";
import { loadUser, pgSessionStore } from "./lib/auth.js";
import { HttpError } from "./lib/errors.js";
import { authRoutes } from "./routes/auth.js";
import { providerRoutes } from "./routes/providers.js";
import { catalogRoutes } from "./routes/catalog.js";
import { flowRoutes } from "./routes/flows.js";
import { sessionRoutes } from "./routes/sessions.js";
import { runRoutes } from "./routes/runs.js";
import { batchRoutes } from "./routes/batch.js";

export async function buildApp() {
  const app = Fastify({ logger: { level: config.isProd ? "info" : "warn" }, bodyLimit: 5 * 1024 * 1024, trustProxy: true });
  await app.register(cookie);
  await app.register(session, {
    secret: config.sessionSecret,
    cookieName: "goga_studio",
    store: pgSessionStore as never,
    saveUninitialized: false,
    // `secure` so em producao atras de TLS; no k3d local o acesso e http e o
    // cookie seguro simplesmente nao voltaria, e o login "nao pegaria".
    cookie: { httpOnly: true, sameSite: "lax", secure: config.isProd && process.env.STUDIO_COOKIE_SECURE === "1", maxAge: 12 * 3600 * 1000, path: "/" },
  });
  await app.register(multipart);
  app.decorateRequest("user", null);
  app.addHook("preHandler", async (req) => {
    await loadUser(req);
  });

  app.setErrorHandler((err: FastifyError | HttpError | ZodError, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, details: err.details });
    if (err instanceof ZodError) return reply.status(400).send({ error: "dados inválidos", details: err.issues });
    const status = (err as FastifyError).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.status(status).send({ error: status >= 500 ? `erro interno: ${err.message}` : err.message });
  });

  app.get("/api/v1/health", async () => ({ ok: true, service: "goga-studio-api", time: new Date().toISOString() }));
  await app.register(authRoutes);
  await app.register(providerRoutes);
  await app.register(catalogRoutes);
  await app.register(flowRoutes);
  await app.register(sessionRoutes);
  await app.register(runRoutes);
  await app.register(batchRoutes);
  return app;
}

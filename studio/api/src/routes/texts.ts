import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin, requireUser } from "../lib/auth.js";
import { getText, listTexts, saveText } from "../texts/service.js";

// Textos do motor (tela Prompts). Ler: qualquer usuario. Alterar: so
// administrador, porque vale na hora para a PRODUCAO (nao ha rascunho nem
// publicacao, ao contrario do prompt de um no). Toda alteracao vai a auditoria.
export async function textRoutes(app: FastifyInstance) {
  app.get("/api/v1/texts", async (req) => {
    requireUser(req);
    return { texts: await listTexts() };
  });

  app.get<{ Params: { key: string } }>("/api/v1/texts/:key", async (req) => {
    requireUser(req);
    return getText(req.params.key);
  });

  app.put<{ Params: { key: string } }>("/api/v1/texts/:key", async (req) => {
    const u = requireAdmin(req);
    const { text } = z.object({ text: z.string().max(60_000) }).parse(req.body);
    return saveText(req.params.key, text, u);
  });

  app.delete<{ Params: { key: string } }>("/api/v1/texts/:key", async (req) => {
    const u = requireAdmin(req);
    return saveText(req.params.key, null, u);
  });
}

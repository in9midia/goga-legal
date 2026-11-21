import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin, requireUser } from "../lib/auth.js";
import { audit } from "../lib/audit.js";
import { frontConfig, saveFrontConfig } from "../engine/frontdesk.js";

// Agente de conversa (fica na frente do fluxo no Simulador e no WhatsApp).
// Ler: qualquer usuario. Alterar: administrador (vale na hora para a producao).
// O prompt e o texto do motor `conversa.agente` (rotas /texts).
export async function chatAgentRoutes(app: FastifyInstance) {
  app.get("/api/v1/chat-agent", async (req) => {
    requireUser(req);
    return { agent: await frontConfig(true) };
  });

  app.put("/api/v1/chat-agent", async (req) => {
    const me = requireAdmin(req);
    const b = z.object({ enabled: z.boolean().optional(), modelId: z.string().uuid().nullable().optional() }).parse(req.body ?? {});
    const before = await frontConfig(true);
    const agent = await saveFrontConfig(b, me.email);
    await audit(me, "update", "chat_agent", "1", before, agent);
    return { agent };
  });
}

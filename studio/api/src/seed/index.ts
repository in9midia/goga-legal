import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { config } from "../config.js";
import { hashPassword } from "../lib/auth.js";
import { encrypt } from "../lib/crypto.js";
import { audit } from "../lib/audit.js";
import { skillCatalog } from "../skills/index.js";
import { buildFlow, FULL_CHAINS, FULL_FLOW, PHASE1_CHAINS, PHASE1_FLOW, specialtySeeds } from "./flows.js";
import { config as cfg } from "../config.js";

type Log = (msg: string) => void;

// Precos conferidos nas paginas oficiais em 2026-09-22 (USD por 1M tokens).
// DeepSeek cobra preco de pico e fora de pico; o seed usa o de PICO, que e o
// teto: custo estimado acima do real e um erro que ninguem paga, abaixo e.
// O plano previa `deepseek-chat`/`deepseek-reasoner`, mas a documentacao
// atual lista `deepseek-flash` (V4.1-Flash) e `deepseek-v4-pro`.
const MODELS = {
  deepseek: [
    { modelId: "deepseek-flash", label: "DeepSeek Flash (V4.1)", purpose: "chat", priceInPer1m: 0.3, priceOutPer1m: 1.2, priceCachePer1m: 0.006, contextWindow: 1_000_000, isDefault: true },
    { modelId: "deepseek-v4-pro", label: "DeepSeek V4 Pro", purpose: "chat", priceInPer1m: 1.32, priceOutPer1m: 3.96, priceCachePer1m: 0.044, contextWindow: 1_000_000, isDefault: false },
  ],
  gemini: [
    // gemini-embedding-001 nao aparece mais na pagina de precos (so o
    // "Gemini Embedding 2"); 0,15 e o ultimo preco publicado. Editavel na tela.
    { modelId: "gemini-embedding-001", label: "Gemini Embedding 001 (3072)", purpose: "embedding", priceInPer1m: 0.15, priceOutPer1m: 0, priceCachePer1m: 0, contextWindow: 2048, isDefault: true, supportsTools: false, supportsJson: false },
    { modelId: "gemini-2.5-flash", label: "Gemini 2.5 Flash (visão)", purpose: "vision", priceInPer1m: 0.3, priceOutPer1m: 2.5, priceCachePer1m: 0.03, contextWindow: 1_048_576, isDefault: true },
  ],
  mock: [{ modelId: "goga-simulado", label: "Simulado (offline, sem custo)", purpose: "chat", priceInPer1m: 0, priceOutPer1m: 0, priceCachePer1m: 0, contextWindow: 128_000, isDefault: false }],
} as const;

async function ensureProvider(name: string, kind: "deepseek" | "gemini" | "mock", key: string, log: Log) {
  const [existing] = await db.select().from(schema.provider).where(eq(schema.provider.kind, kind));
  if (existing) return existing;
  const [p] = await db.insert(schema.provider).values({ name, kind, apiKeyEnc: encrypt(key), apiKeyTail: key.slice(-4) }).returning();
  for (const m of MODELS[kind]) await db.insert(schema.model).values({ ...m, providerId: p.id });
  await audit(null, "seed", "provider", p.id, null, { name, kind, models: MODELS[kind].map((m) => m.modelId) });
  log(`provedor ${name} criado${key ? "" : " SEM chave (cadastre em Administração › Provedores)"}`);
  return p;
}

export async function seed(log: Log = console.log) {
  // Admin inicial: so quando nao existe usuario nenhum.
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.appUser);
  if (n === 0) {
    if (!config.adminPassword) throw new Error("Primeiro boot: defina STUDIO_ADMIN_PASSWORD para criar o administrador.");
    await db.insert(schema.appUser).values({ name: "Administrador", email: config.adminEmail.toLowerCase(), passwordHash: await hashPassword(config.adminPassword), role: "admin" });
    log(`admin ${config.adminEmail} criado`);
  }

  await ensureProvider("DeepSeek", "deepseek", cfg.deepseekKey, log);
  await ensureProvider("Google Gemini", "gemini", cfg.geminiKey, log);
  await ensureProvider("Simulado", "mock", "", log);

  // Catalogos fixos: skills e MCP sao sempre regravados a partir do codigo
  // (a lista e do sistema, nao editavel). Especialidades so entram se faltarem:
  // elas SAO editaveis na tela e o seed nao pode desfazer a curadoria.
  for (const s of skillCatalog()) {
    await db.insert(schema.skill).values(s).onConflictDoUpdate({ target: schema.skill.id, set: { name: s.name, description: s.description, inputSchema: s.inputSchema } });
  }
  const mcp = [
    { id: "goga-kb", name: "Goga KB", url: `${config.kbUrl}/mcp`, enabled: true, description: "Base de conhecimento do Goga: search, fetch, list_spaces." },
    { id: "lexml", name: "LexML", url: "https://www.lexml.gov.br/", enabled: false, description: "Legislação federal (fora do MVP)." },
    { id: "stj-jurisprudencia", name: "STJ Jurisprudência", url: "https://scon.stj.jus.br/", enabled: false, description: "Pesquisa de jurisprudência do STJ (fora do MVP)." },
  ];
  for (const m of mcp) {
    await db.insert(schema.mcpServer).values(m).onConflictDoUpdate({ target: schema.mcpServer.id, set: { name: m.name, url: m.url, description: m.description } });
  }
  let added = 0;
  for (const s of specialtySeeds()) {
    const r = await db
      .insert(schema.specialty)
      .values({
        number: s.number,
        name: s.name,
        area: s.area,
        cluster: s.cluster,
        role: s.role,
        routable: s.routable,
        scope: s.scope,
        defaultPrompt: s.default_prompt,
        defaultSpaces: s.default_spaces,
        defaultSkills: s.default_skills,
        routingHints: s.routing_hints,
        escalationRules: s.escalation_rules,
        phase: s.phase,
        zone: s.zone,
      })
      .onConflictDoNothing()
      .returning({ id: schema.specialty.id });
    added += r.length;
  }
  if (added) log(`${added} especialidade(s) semeada(s)`);

  // Fluxos seed: so no banco vazio de fluxos.
  const [{ flows }] = await db.select({ flows: sql<number>`count(*)::int` }).from(schema.flow);
  if (flows === 0) {
    const [chat] = await db.select().from(schema.model).where(and(eq(schema.model.purpose, "chat"), eq(schema.model.isDefault, true)));
    const defaultModel = chat?.id ?? null;
    const [full] = await db
      .insert(schema.flow)
      .values({ name: "Goga — Atendimento padrão", description: "Entrada → Classificador → 26 especialistas de mérito + Encaminhamento → Consolidador ↔ Compliance → Saída.", graph: buildFlow(FULL_FLOW, FULL_CHAINS, defaultModel) })
      .returning();
    await db.insert(schema.flow).values({ name: "Goga — Fase 1 (zona verde)", description: "Só 14, 15, 16, 17, 19, 23 e 52 em modo orientação (roadmap da pesquisa, MAP §6).", graph: buildFlow(PHASE1_FLOW, PHASE1_CHAINS, defaultModel) });
    const [rel] = await db.insert(schema.flowRelease).values({ flowId: full.id, revision: full.revision, graph: full.graph }).returning();
    await db.update(schema.production).set({ flowReleaseId: rel.id }).where(eq(schema.production.id, 1));
    await audit(null, "seed_publish", "production", rel.id, null, { flowId: full.id, flowName: full.name, revision: full.revision });
    log("fluxos seed criados; 'Goga — Atendimento padrão' publicado em produção");
  }
}

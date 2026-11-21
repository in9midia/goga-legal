import { generateText } from "ai";
import { and, asc, desc, eq, ilike } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { costOf, defaultModelId, resolveModel } from "../llm/models.js";
import { extractJson } from "../llm/json.js";
import { loadEngineTexts } from "../texts/service.js";
import { errorMessage } from "./tracer.js";

/**
 * Agente de conversa: fica FORA do fluxo, na frente dele (Simulador e
 * WhatsApp). Toda mensagem passa por ele e ganha resposta na hora; ele decide:
 *
 *   responder  so responde (saudacao, "e ai?", agradecimento...)
 *   fluxo      inicia o fluxo ou, se ja houver um turno rodando, acrescenta o
 *              que a pessoa trouxe como contexto do turno em andamento
 *
 * Modelo rapido escolhido em Capacidades › Agente de conversa (tabela
 * chat_agent); prompt no texto do motor `conversa.agente`. Qualquer falha dele
 * (sem modelo, provedor fora, JSON ruim) cai no comportamento sem agente:
 * a mensagem vai para o fluxo e ninguem fica sem atendimento.
 */

export interface FrontDecision {
  acao: "responder" | "fluxo";
  resposta: string;
  contexto: string;
  /** Falhou e caiu no padrao (vai para o fluxo, sem resposta imediata). */
  fallback?: string;
  costUsd?: number;
}

const decisionSchema = z.object({
  acao: z.enum(["responder", "fluxo"]).catch("fluxo"),
  resposta: z.string().nullable().catch("").transform((v) => (v ?? "").trim().slice(0, 1500)),
  contexto: z.string().nullable().catch("").transform((v) => (v ?? "").trim().slice(0, 2000)),
});

const FORMAT = `<<formato:conversa>>
Responda APENAS com um objeto JSON, sem texto fora dele:
{"acao":"responder|fluxo","resposta":"o que mandar para a pessoa agora (curto)","contexto":"só com a análise em andamento e acao=fluxo: o fato novo, objetivo"}`;

export interface FrontConfig {
  enabled: boolean;
  modelId: string | null;
}

let cache: { at: number; value: FrontConfig } | null = null;

/** Modelo padrao do agente: o DeepSeek rapido, se cadastrado; senao o modelo de chat padrao. */
async function defaultFrontModel(): Promise<string | null> {
  const [flash] = await db
    .select({ id: schema.model.id })
    .from(schema.model)
    .where(and(eq(schema.model.active, true), eq(schema.model.purpose, "chat"), ilike(schema.model.modelId, "%flash%")))
    .orderBy(asc(schema.model.label))
    .limit(1);
  return flash?.id ?? (await defaultModelId("chat"));
}

export async function frontConfig(fresh = false): Promise<FrontConfig> {
  if (!fresh && cache && Date.now() - cache.at < 10_000) return cache.value;
  const [row] = await db.select().from(schema.chatAgent).where(eq(schema.chatAgent.id, 1));
  const value: FrontConfig = row ? { enabled: row.enabled, modelId: row.modelId ?? (await defaultFrontModel()) } : { enabled: true, modelId: await defaultFrontModel() };
  cache = { at: Date.now(), value };
  return value;
}

export async function saveFrontConfig(v: Partial<FrontConfig>, by: string) {
  await db
    .insert(schema.chatAgent)
    .values({ id: 1, enabled: v.enabled ?? true, modelId: v.modelId ?? null, updatedBy: by })
    .onConflictDoUpdate({ target: schema.chatAgent.id, set: { ...(v.enabled !== undefined && { enabled: v.enabled }), ...(v.modelId !== undefined && { modelId: v.modelId }), updatedBy: by, updatedAt: new Date() } });
  cache = null;
  return frontConfig(true);
}

export const frontActive = async () => {
  const c = await frontConfig();
  return c.enabled && !!c.modelId;
};

export interface FrontInput {
  channel: "simulador" | "whatsapp";
  sessionId: string | null;
  flowId: string | null;
  userId: string | null;
  /** Mensagem atual (ja com a opcao resolvida, se a pessoa respondeu "2"). */
  message: string;
  files: { name: string }[];
  running: { question: string; seconds: number; addenda: string[] } | null;
  pendingOptions?: string[];
}

const HISTORY = 12;

async function historyOf(sessionId: string | null) {
  if (!sessionId) return [];
  const rows = await db
    .select({ role: schema.message.role, content: schema.message.content, createdAt: schema.message.createdAt })
    .from(schema.message)
    .where(eq(schema.message.sessionId, sessionId))
    .orderBy(desc(schema.message.createdAt))
    .limit(HISTORY);
  return rows.reverse().map((m) => `${m.role === "user" ? "Pessoa" : "Goga"}: ${m.content.length > 1200 ? `${m.content.slice(0, 1200)}…` : m.content}`);
}

export function frontUserPrompt(i: FrontInput, history: string[]) {
  const parts = [`Canal: ${i.channel === "whatsapp" ? "WhatsApp" : "Simulador do Studio"}`];
  parts.push(history.length ? `## Conversa até aqui\n${history.join("\n\n")}` : "## Conversa até aqui\n(primeira mensagem)");
  if (i.running) {
    parts.push(
      `## Análise em andamento: SIM\nRodando há ${i.running.seconds} s, sobre: "${i.running.question.slice(0, 600)}"` +
        (i.running.addenda.length ? `\nJá acrescentado durante a análise:\n${i.running.addenda.map((a) => `- ${a}`).join("\n")}` : ""),
    );
  } else parts.push("## Análise em andamento: NÃO");
  if (i.pendingOptions?.length) parts.push(`## Opções oferecidas na última pergunta do Goga\n${i.pendingOptions.map((o, n) => `${n + 1}. ${o}`).join("\n")}`);
  parts.push(`## Mensagem atual da pessoa\n${i.message || "(sem texto)"}${i.files.length ? `\n(Arquivos enviados: ${i.files.map((f) => f.name).join(", ")})` : ""}`);
  return parts.join("\n\n");
}

/** Decide a acao e a resposta imediata. Nunca lanca: falha = `fluxo` sem resposta. */
export async function decide(i: FrontInput): Promise<FrontDecision> {
  const fail = (why: string): FrontDecision => ({ acao: "fluxo", resposta: "", contexto: "", fallback: why });
  // Arquivo e sempre conteudo para a analise: o agente so acusa o recebimento.
  const cfg = await frontConfig();
  if (!cfg.enabled || !cfg.modelId) return fail("agente desligado");
  try {
    const [T, history] = await Promise.all([loadEngineTexts(), historyOf(i.sessionId)]);
    const resolved = await resolveModel(cfg.modelId);
    const r = await generateText({
      model: resolved.model,
      system: `${T["conversa.agente"]}\n\n${FORMAT}`,
      messages: [{ role: "user", content: frontUserPrompt(i, history) }],
      temperature: 0.3,
      maxOutputTokens: 600,
      timeout: 25_000,
      maxRetries: 1,
      // DeepSeek "flash" pensa por padrao: aqui so atrasaria a resposta imediata.
      providerOptions: { deepseek: { thinking: { type: "disabled" } } },
    });
    const parsed = decisionSchema.safeParse(extractJson(r.text) ?? {});
    const tokensIn = r.usage.inputTokens ?? 0;
    const tokensOut = r.usage.outputTokens ?? 0;
    const costUsd = costOf(resolved.row, tokensIn, tokensOut, r.usage.inputTokenDetails?.cacheReadTokens ?? 0);
    await db
      .insert(schema.usage)
      .values({ userId: i.userId, flowId: i.flowId, nodeId: "agente-conversa", nodeName: "Agente de conversa", providerId: resolved.provider.id, modelId: resolved.row.id, operation: "chat", tokensIn, tokensOut, costUsd })
      .catch(() => undefined);
    if (!parsed.success) return fail("JSON inválido do agente de conversa");
    const d = parsed.data;
    if (i.files.length && d.acao === "responder") d.acao = "fluxo";
    return { ...d, costUsd };
  } catch (err) {
    console.warn(`[agente de conversa] ${errorMessage(err)}`);
    return fail(errorMessage(err));
  }
}

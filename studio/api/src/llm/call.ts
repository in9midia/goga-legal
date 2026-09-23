import { generateText, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import type { z } from "zod";
import { db, schema } from "../db/index.js";
import { HttpError } from "../lib/errors.js";
import type { RunContext } from "../engine/context.js";
import { errorMessage } from "../engine/tracer.js";
import { costOf, resolveModel } from "./models.js";
import { extractJson } from "./json.js";

export interface LlmCall {
  ctx: RunContext;
  name: string;
  parentId: string | null;
  nodeId: string | null;
  nodeName?: string;
  specialtyNumber?: number | null;
  modelId: string;
  fallbackModelId?: string | null;
  system: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  maxSteps?: number;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxCostUsd?: number;
}

export interface LlmResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  modelId: string;
  spanId: string;
  /** "length" = cortada pelo limite de tokens: o texto esta incompleto. */
  finishReason?: string;
}

export async function callLlm(c: LlmCall): Promise<LlmResult> {
  try {
    return await callOnce(c, c.modelId);
  } catch (err) {
    // Fallback so para falha do provedor. Erro de configuracao (HttpError: sem
    // chave, modelo inativo) repetido no fallback so esconderia a causa.
    if (!c.fallbackModelId || err instanceof HttpError || c.ctx.aborted) throw err;
    return callOnce({ ...c, name: `${c.name} (fallback)` }, c.fallbackModelId);
  }
}

async function callOnce(c: LlmCall, modelRowId: string): Promise<LlmResult> {
  const { ctx } = c;
  if (ctx.costUsd >= ctx.maxRunCostUsd) {
    throw new HttpError(429, `Limite de custo da execução atingido (US$ ${ctx.maxRunCostUsd.toFixed(2)}).`);
  }
  const resolved = await resolveModel(modelRowId);
  const span = await ctx.tracer.start({
    kind: "llm",
    name: c.name,
    parentId: c.parentId,
    nodeId: c.nodeId,
    modelId: modelRowId,
    input: {
      model: `${resolved.provider.name} · ${resolved.row.label}`,
      temperature: c.temperature,
      maxTokens: c.maxTokens,
      system: c.system,
      messages: c.messages,
      tools: c.tools ? Object.keys(c.tools) : [],
    },
  });
  try {
    const result = await generateText({
      model: resolved.model,
      system: c.system,
      messages: c.messages,
      tools: c.tools,
      stopWhen: stepCountIs(c.maxSteps ?? 1),
      temperature: c.temperature,
      maxOutputTokens: c.maxTokens,
      timeout: c.timeoutMs,
      maxRetries: 1,
      abortSignal: ctx.signal,
    });
    const u = result.totalUsage;
    const tokensIn = u.inputTokens ?? 0;
    const tokensOut = u.outputTokens ?? 0;
    const tokensCache = u.inputTokenDetails?.cacheReadTokens ?? 0;
    const cost = costOf(resolved.row, tokensIn, tokensOut, tokensCache);
    ctx.costUsd += cost;
    ctx.tokensIn += tokensIn;
    ctx.tokensOut += tokensOut;
    const overBudget = c.maxCostUsd !== undefined && c.maxCostUsd > 0 && cost > c.maxCostUsd;
    await span.end({
      output: {
        text: result.text,
        reasoning: result.reasoningText,
        steps: result.steps.length,
        toolCalls: result.steps.flatMap((s) => s.toolCalls.map((t) => ({ tool: t.toolName, input: t.input }))),
        finishReason: result.finishReason,
        ...(overBudget ? { alerta: `custo da chamada (US$ ${cost.toFixed(4)}) acima do limite do nó` } : {}),
      },
      tokensIn,
      tokensOut,
      costUsd: cost,
    });
    await db.insert(schema.usage).values({
      runId: ctx.runId,
      spanId: span.id,
      userId: ctx.userId,
      flowId: ctx.flowId,
      nodeId: c.nodeId,
      nodeName: c.nodeName ?? c.name,
      specialtyNumber: c.specialtyNumber ?? null,
      providerId: resolved.provider.id,
      modelId: resolved.row.id,
      operation: "chat",
      tokensIn,
      tokensOut,
      tokensCache,
      costUsd: cost,
    });
    return { text: result.text, tokensIn, tokensOut, costUsd: cost, modelId: modelRowId, spanId: span.id, finishReason: result.finishReason };
  } catch (err) {
    await span.fail(err);
    throw err;
  }
}

/**
 * Chat que devolve JSON validado por zod, com UMA rodada de reparo.
 *
 * Nao usa o modo de saida estruturada do provedor: o DeepSeek aceita
 * `json_object` mas nao schema, e com tools ligadas o modo JSON nao combina com
 * tool calling em todos os provedores. Pedir JSON no prompt e validar aqui e o
 * denominador comum, e o reparo cobre o erro tipico (cerca de markdown, virgula
 * sobrando, campo faltando).
 */
export async function generateJson<S extends z.ZodTypeAny>(
  c: LlmCall,
  schemaDef: S,
): Promise<{ value: z.infer<S>; result: LlmResult }> {
  const first = await callLlm(c);
  // Resposta cortada pelo limite de tokens nunca e aceita, mesmo que dela se
  // extraia um JSON: a varredura acharia um objeto interno (um item do
  // ranking, por exemplo) e ele passaria como se fosse a resposta inteira.
  const truncated = first.finishReason === "length";
  const parsed = truncated ? ({ ok: false, error: "resposta cortada pelo limite de tokens" } as const) : tryParse(first.text, schemaDef);
  if (parsed.ok) return { value: parsed.value, result: first };

  const repair = await callLlm({
    ...c,
    name: `${c.name} · reparo de JSON`,
    tools: undefined,
    maxSteps: 1,
    messages: [
      ...c.messages,
      { role: "assistant", content: first.text },
      {
        role: "user",
        content: truncated
          ? "Sua resposta foi cortada pelo limite de tamanho. Responda de novo APENAS com o JSON, bem mais curto: listas enxutas e textos breves, sem texto antes ou depois, sem cercas de código."
          : `Sua resposta não é um JSON válido no formato pedido (${parsed.error}). Responda de novo APENAS com o JSON, sem texto antes ou depois, sem cercas de código.`,
      },
    ],
  });
  const second = repair.finishReason === "length" ? ({ ok: false, error: "resposta cortada pelo limite de tokens de novo; aumente o maxTokens do nó" } as const) : tryParse(repair.text, schemaDef);
  if (second.ok) {
    return {
      value: second.value,
      result: { ...repair, costUsd: first.costUsd + repair.costUsd, tokensIn: first.tokensIn + repair.tokensIn, tokensOut: first.tokensOut + repair.tokensOut },
    };
  }
  throw new Error(`O modelo não devolveu JSON válido após reparo: ${second.error}`);
}

function tryParse<S extends z.ZodTypeAny>(text: string, s: S): { ok: true; value: z.infer<S> } | { ok: false; error: string } {
  const raw = extractJson(text);
  if (raw === undefined) return { ok: false, error: "nenhum objeto JSON encontrado" };
  const r = s.safeParse(raw);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, error: r.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
}

export { errorMessage };

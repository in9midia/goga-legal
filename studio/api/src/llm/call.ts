import { generateText, stepCountIs, type ModelMessage, type StepResult, type ToolSet } from "ai";
import type { z } from "zod";
import { db, schema } from "../db/index.js";
import { HttpError } from "../lib/errors.js";
import type { RunContext } from "../engine/context.js";
import { errorMessage } from "../engine/tracer.js";
import { costOf, resolveModel } from "./models.js";
import { extractJson } from "./json.js";
import { onlyToolMarkup } from "./markup.js";

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

/** Teto de custo da execucao atingido: derruba o turno inteiro, nao so o no. */
export class BudgetError extends HttpError {
  constructor(message: string) {
    super(429, message);
  }
}

/** A pessoa pediu para parar: a proxima chamada a modelo e recusada. */
export class CancelledError extends HttpError {
  constructor() {
    super(499, "Execução interrompida pelo usuário.");
  }
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

/** Prazo da chamada que escreve com o que as ferramentas trouxeram, depois do prazo do no. */
const RESCUE_MS = 45_000;

/** Uma requisicao HTTP ao provedor: o SDK repete sozinho (429, 5xx) e cada passo e uma nova. */
interface ProviderRequest {
  /** ms desde o inicio da chamada */
  at: number;
  /** ate os cabecalhos da resposta: sem streaming, e a geracao inteira */
  ms: number;
  status: number | null;
  error?: string;
}

const timedOut = (err: unknown) => err instanceof Error && (err.name === "TimeoutError" || /aborted due to timeout|timed? ?out/i.test(err.message));

async function callOnce(c: LlmCall, modelRowId: string): Promise<LlmResult> {
  const { ctx } = c;
  if (ctx.aborted) throw new CancelledError();
  if (ctx.costUsd >= ctx.maxRunCostUsd) {
    throw new BudgetError(`Limite de custo da execução atingido (US$ ${ctx.maxRunCostUsd.toFixed(2)}).`);
  }
  // Cada requisicao ao provedor entra no span: sem isso, uma repeticao por 429
  // (maxRetries) aparecia so como uma chamada lenta, igual ao modelo pensando.
  const t0 = Date.now();
  const requests: ProviderRequest[] = [];
  const measured: typeof globalThis.fetch = async (input, init) => {
    const at = Date.now() - t0;
    try {
      const res = await globalThis.fetch(input, init);
      requests.push({ at, ms: Date.now() - t0 - at, status: res.status });
      return res;
    } catch (err) {
      requests.push({ at, ms: Date.now() - t0 - at, status: null, error: errorMessage(err).slice(0, 200) });
      throw err;
    }
  };
  const resolved = await resolveModel(modelRowId, measured);
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
    const maxSteps = c.maxSteps ?? 1;
    const hasTools = !!c.tools && Object.keys(c.tools).length > 0;
    const common = {
      model: resolved.model,
      system: c.system,
      messages: c.messages,
      tools: c.tools,
      stopWhen: stepCountIs(maxSteps),
      // O ultimo passo responde sem ferramentas. Sem isso, o especialista que
      // ainda quer consultar no ultimo passo termina com texto vazio, e o
      // "reparo de JSON" e que escrevia o parecer: uma chamada a mais, com o
      // contexto inteiro e sem o que as ferramentas trouxeram.
      ...(hasTools && maxSteps > 1 ? { prepareStep: ({ stepNumber }: { stepNumber: number }) => (stepNumber >= maxSteps - 1 ? { toolChoice: "none" as const } : {}) } : {}),
      temperature: c.temperature,
      maxOutputTokens: c.maxTokens,
      timeout: c.timeoutMs,
      maxRetries: 2,
      abortSignal: ctx.signal,
    };
    // O prazo do no vale para o laco inteiro, ferramentas incluidas. Se ele
    // vencer depois de alguma ferramenta ja ter respondido, o que ela trouxe nao
    // se perde: uma ultima chamada, sem ferramentas, escreve com o que ha.
    const done: ModelMessage[] = [];
    const before: StepResult<ToolSet>[] = [];
    let rescue: string | null = null;
    const consulted = () => hasTools && done.some((m) => m.role === "tool");
    const writeWithWhatWeHave = (instruction: string) =>
      generateText({
        ...common,
        toolChoice: "none",
        prepareStep: undefined,
        stopWhen: stepCountIs(1),
        messages: [...c.messages, ...done, { role: "user", content: instruction }],
        timeout: RESCUE_MS,
      });
    let result = await generateText({
      ...common,
      onStepEnd: (st) => {
        before.push(st);
        done.push(...st.response.messages);
      },
    }).catch((err: unknown) => {
      if (ctx.aborted || !consulted() || !timedOut(err)) throw err;
      rescue = "prazo do nó vencido: resposta escrita com o que as ferramentas já trouxeram";
      return writeWithWhatWeHave(
        "O tempo para consultar ferramentas acabou. Responda agora, no formato pedido, só com o que as consultas acima já trouxeram; o que ficou sem consultar, diga que não foi verificado.",
      );
    });
    // O ultimo passo, com as ferramentas desligadas, as vezes termina em "stop"
    // sem texto. O reparo de JSON nao tem o que as ferramentas trouxeram e o
    // parecer caia; aqui ainda se escreve com elas.
    // Marcacao de ferramenta escrita como texto (ver markup.ts) e o mesmo caso:
    // o modelo queria consultar mais e nao respondeu.
    const markup = onlyToolMarkup(result.text);
    if (!rescue && (!result.text.trim() || markup) && consulted()) {
      rescue = markup
        ? "o último passo escreveu chamadas de ferramenta como texto: resposta escrita com o que as ferramentas trouxeram"
        : "o último passo terminou sem texto: resposta escrita com o que as ferramentas trouxeram";
      result = await writeWithWhatWeHave(
        "Você já consultou as ferramentas. Escreva agora a resposta, no formato pedido, com o que as consultas acima trouxeram; o que ficou sem consultar, diga que não foi verificado.",
      );
    }
    // No resgate, os passos de antes tambem foram pagos.
    const steps = rescue ? [...before, ...result.steps] : result.steps;
    const sum = (f: (u: StepResult<ToolSet>["usage"]) => number | undefined) => steps.reduce((t, st) => t + (f(st.usage) ?? 0), 0);
    const tokensIn = sum((u) => u.inputTokens);
    const tokensOut = sum((u) => u.outputTokens);
    const tokensCache = sum((u) => u.inputTokenDetails?.cacheReadTokens);
    const cost = costOf(resolved.row, tokensIn, tokensOut, tokensCache);
    ctx.costUsd += cost;
    ctx.tokensIn += tokensIn;
    ctx.tokensOut += tokensOut;
    const overBudget = c.maxCostUsd !== undefined && c.maxCostUsd > 0 && cost > c.maxCostUsd;
    const refused = requests.filter((r) => r.status === null || r.status >= 400).length;
    await span.end({
      output: {
        text: result.text,
        reasoning: result.reasoningText,
        steps: steps.length,
        toolCalls: steps.flatMap((s) => s.toolCalls.map((t) => ({ tool: t.toolName, input: t.input }))),
        finishReason: result.finishReason,
        requests,
        ...(refused ? { refused } : {}),
        ...(rescue ? { rescue } : {}),
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
    await span.fail(err, { requests });
    if (ctx.aborted) throw new CancelledError();
    throw err;
  }
}

const JSON_REQUEST = "Responda APENAS com o JSON no formato pedido, sem texto fora dele.";

/** O pedido de JSON no ultimo turno do usuario (dois turnos seguidos dele, nao). */
export function withJsonRequest(messages: ModelMessage[]): ModelMessage[] {
  const last = messages.at(-1);
  return last?.role === "user" && typeof last.content === "string"
    ? [...messages.slice(0, -1), { role: "user", content: `${last.content}\n\n${JSON_REQUEST}` }]
    : [...messages, { role: "user", content: JSON_REQUEST }];
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
    // Resposta vazia nao volta como turno do assistente: provedor recusa bloco
    // de texto vazio, e o reparo cairia por um motivo que nao e o JSON.
    messages: first.text.trim()
      ? [
          ...c.messages,
          { role: "assistant", content: first.text },
          {
            role: "user",
            content: truncated
              ? "Sua resposta foi cortada pelo limite de tamanho. Responda de novo APENAS com o JSON, bem mais curto: listas enxutas e textos breves, sem texto antes ou depois, sem cercas de código."
              : `Sua resposta não é um JSON válido no formato pedido (${parsed.error}). Responda de novo APENAS com o JSON, sem texto antes ou depois, sem cercas de código.`,
          },
        ]
      : withJsonRequest(c.messages),
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
  const found = extractJson(text);
  if (found === undefined) return { ok: false, error: "nenhum objeto JSON encontrado" };
  // O modelo as vezes embrulha o objeto numa lista (`[{...}]`): sem isto, o
  // turno inteiro cai no reparo (e, se repetir, no erro).
  const raw = Array.isArray(found) && found.length === 1 && found[0] && typeof found[0] === "object" ? found[0] : found;
  const r = s.safeParse(raw);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, error: r.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
}

export { errorMessage };

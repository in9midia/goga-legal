/**
 * Alguns gateways OpenAI-compativeis (o 9router, por exemplo, nos provedores
 * por assinatura) respondem SEMPRE em SSE, mesmo com `stream: false`. O AI SDK
 * espera JSON nessas chamadas e falha com "Invalid JSON response". Este fetch
 * junta os chunks do stream num `chat.completion` comum quando o pedido nao
 * era stream e a resposta veio como `text/event-stream`.
 */

interface ToolCallAcc {
  id?: string;
  type: "function";
  function: { name: string; arguments: string };
}

export function sseCompatFetch(base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const res = await base(input, init);
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) return res;
    if (requestedStream(init?.body)) return res;
    const json = aggregateSse(await res.text());
    const headers = new Headers(res.headers);
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(JSON.stringify(json), { status: res.status, statusText: res.statusText, headers });
  };
}

function requestedStream(body: unknown): boolean {
  if (typeof body !== "string") return false;
  try {
    return (JSON.parse(body) as { stream?: unknown }).stream === true;
  } catch {
    return false;
  }
}

export function aggregateSse(raw: string): Record<string, unknown> {
  let id = "";
  let model = "";
  let created = Math.floor(Date.now() / 1000);
  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  let usage: unknown;
  const toolCalls: ToolCallAcc[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error) throw new Error(`erro do provedor no stream: ${JSON.stringify(chunk.error).slice(0, 300)}`);
    id ||= chunk.id ?? "";
    model ||= chunk.model ?? "";
    if (typeof chunk.created === "number") created = chunk.created;
    if (chunk.usage) usage = chunk.usage;
    for (const choice of chunk.choices ?? []) {
      const d = choice.delta ?? choice.message ?? {};
      if (typeof d.content === "string") content += d.content;
      const r = d.reasoning_content ?? d.reasoning;
      if (typeof r === "string") reasoning += r;
      for (const tc of d.tool_calls ?? []) {
        const i = typeof tc.index === "number" ? tc.index : toolCalls.length;
        const acc = (toolCalls[i] ??= { type: "function", function: { name: "", arguments: "" } });
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.function.name += tc.function.name;
        if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }

  const calls = toolCalls.filter(Boolean).map((t, i) => ({ ...t, id: t.id ?? `call_${i}` }));
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(calls.length ? { tool_calls: calls } : {}),
        },
        finish_reason: finishReason ?? (calls.length ? "tool_calls" : "stop"),
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

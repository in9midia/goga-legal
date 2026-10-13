import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, tool } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { sseCompatFetch } from "./sse-compat.js";

// Gateway que, como o 9router, responde em SSE mesmo com stream:false.
const chunks = (withTool: boolean) =>
  [
    { id: "c1", model: "m", created: 1, choices: [{ index: 0, delta: { role: "assistant", content: "Olá, " } }] },
    { id: "c1", model: "m", created: 1, choices: [{ index: 0, delta: { content: "mundo" } }] },
    ...(withTool
      ? [
          { id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "soma", arguments: '{"a":' } }] } }] },
          { id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "2}" } }] } }] },
        ]
      : []),
    { id: "c1", choices: [{ index: 0, delta: {}, finish_reason: withTool ? "tool_calls" : "stop" }] },
    { id: "c1", choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
  ]
    .map((c) => `data: ${JSON.stringify(c)}\n\n`)
    .join("") + "data: [DONE]\n\n";

let server: Server;
let baseURL = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const withTool = JSON.parse(body).tools !== undefined;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(chunks(withTool));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("gateway que sempre responde em SSE", () => {
  it("sem o shim, o AI SDK falha com Invalid JSON response", async () => {
    const model = createOpenAICompatible({ name: "gw", baseURL, apiKey: "x" })("m");
    await expect(generateText({ model, prompt: "oi", maxRetries: 0 })).rejects.toThrow(/Invalid JSON response/);
  });

  it("com o shim, junta texto e uso", async () => {
    const model = createOpenAICompatible({ name: "gw", baseURL, apiKey: "x", fetch: sseCompatFetch() })("m");
    const r = await generateText({ model, prompt: "oi", maxRetries: 0 });
    expect(r.text).toBe("Olá, mundo");
    expect(r.finishReason).toBe("stop");
    expect(r.usage.inputTokens).toBe(10);
    expect(r.usage.outputTokens).toBe(3);
  });

  it("com o shim, remonta tool calls fragmentadas", async () => {
    const model = createOpenAICompatible({ name: "gw", baseURL, apiKey: "x", fetch: sseCompatFetch() })("m");
    const r = await generateText({
      model,
      prompt: "some",
      maxRetries: 0,
      tools: { soma: tool({ inputSchema: z.object({ a: z.number() }) }) },
    });
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]).toMatchObject({ toolName: "soma", input: { a: 2 } });
  });
});

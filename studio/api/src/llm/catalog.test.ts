import { describe, expect, it } from "vitest";
import { findPrice, priceKeys } from "./catalog.js";

const MAP = {
  "deepseek/deepseek-chat": { mode: "chat", input_cost_per_token: 2.7e-7, output_cost_per_token: 1.1e-6, cache_read_input_token_cost: 7e-8, max_input_tokens: 128000, supports_function_calling: true },
  "gemini/gemini-2.5-flash": { mode: "chat", input_cost_per_token: 3e-7, output_cost_per_token: 2.5e-6, supports_vision: true, max_input_tokens: 1048576 },
  "gemini/gemini-embedding-001": { mode: "embedding", input_cost_per_token: 1.5e-7, output_cost_per_token: 0 },
  "gpt-4o": { mode: "chat", input_cost_per_token: 2.5e-6, output_cost_per_token: 1e-5 },
};

describe("catalogo de precos", () => {
  it("acha pelo prefixo do provedor e converte para US$/1M", () => {
    const p = findPrice(MAP, "deepseek", "deepseek-chat");
    expect(p).toMatchObject({ source: "catalogo", key: "deepseek/deepseek-chat", priceInPer1m: 0.27, priceOutPer1m: 1.1, priceCachePer1m: 0.07, contextWindow: 128000, purpose: "chat", supportsTools: true });
  });

  it("gemini: tira o prefixo models/ e reconhece visao e embedding", () => {
    expect(findPrice(MAP, "gemini", "models/gemini-2.5-flash").purpose).toBe("vision");
    expect(findPrice(MAP, "gemini", "gemini-embedding-001")).toMatchObject({ purpose: "embedding", priceInPer1m: 0.15 });
  });

  it("gateway compativel: tenta o nome sem o vendor", () => {
    expect(priceKeys("openai_compat", "openai/gpt-4o")).toContain("gpt-4o");
    expect(findPrice(MAP, "openai_compat", "openai/gpt-4o").priceInPer1m).toBe(2.5);
  });

  it("modelo desconhecido e `nenhum`, com precos nulos (nao zero)", () => {
    expect(findPrice(MAP, "deepseek", "deepseek-inexistente")).toMatchObject({ source: "nenhum", priceInPer1m: null });
  });
});

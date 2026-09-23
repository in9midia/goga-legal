import { describe, expect, it } from "vitest";
import { classifierSchema } from "./prompts.js";
import { extractJson } from "../llm/json.js";

describe("classifierSchema", () => {
  it("aceita ranking por número de especialidade (formato do preset) e pergunta nula", () => {
    const c = classifierSchema.parse({
      ranking: [{ especialidade: 17, score: 0.8, justificativa: "atraso de voo" }, "lixo", { nodeId: "sp-14", score: "0.4" }],
      polo: "ambiguo",
      urgencia: "media",
      pergunta_esclarecimento: null,
    });
    expect(c.ranking).toEqual([
      { nodeId: "", especialidade: 17, score: 0.8, justificativa: "atraso de voo" },
      { nodeId: "sp-14", score: 0.4, justificativa: "" },
    ]);
    expect(c.pergunta_esclarecimento).toBe("");
    expect(c.polo).toBe("indefinido");
  });

  it("rejeita um item solto do ranking extraído de resposta cortada", () => {
    const cortada = '{"ranking":[{"nodeId":"sp-17","score":1.0,"justificativa":"voo"},{"nodeId":"sp-52","sco';
    expect(classifierSchema.safeParse(extractJson(cortada)).success).toBe(false);
  });
});

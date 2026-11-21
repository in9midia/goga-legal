import { describe, expect, it } from "vitest";
import { rankingEmpty } from "./executor.js";
import { shortenQuery } from "../kb/client.js";

const base = { intencao: "nova_consulta" as const, fatos_novos: true, precisa_esclarecimento: false, fora_de_escopo: false, conflito_interesse: false };
const cands = [{ nodeId: "sp-15", number: 15 }, { nodeId: "sp-14", number: 14 }];

describe("rankingEmpty", () => {
  it("ranking vazio ou sem nota em caso novo: refaz", () => {
    expect(rankingEmpty({ ...base, ranking: [] }, cands, 0.35)).toBe(true);
    expect(rankingEmpty({ ...base, ranking: [{ nodeId: "sp-15", score: 0, justificativa: "x" }] }, cands, 0.35)).toBe(true);
    expect(rankingEmpty({ ...base, ranking: [{ nodeId: "sp-99", score: 0.9, justificativa: "" }] }, cands, 0.35)).toBe(true);
  });
  it("candidato pontuado (por nodeId ou número) não refaz", () => {
    expect(rankingEmpty({ ...base, ranking: [{ nodeId: "sp-15", score: 0.8, justificativa: "" }] }, cands, 0.35)).toBe(false);
    expect(rankingEmpty({ ...base, ranking: [{ nodeId: "", especialidade: 14, score: 0.8, justificativa: "" }] }, cands, 0.35)).toBe(false);
  });
  it("esclarecimento pedido, conversa, documento e reuso não refazem", () => {
    expect(rankingEmpty({ ...base, precisa_esclarecimento: true, ranking: [] }, cands, 0.35)).toBe(false);
    expect(rankingEmpty({ ...base, intencao: "conversa", ranking: [] }, cands, 0.35)).toBe(false);
    expect(rankingEmpty({ ...base, intencao: "pedido_documento", ranking: [] }, cands, 0.35)).toBe(false);
    expect(rankingEmpty({ ...base, intencao: "continuacao", fatos_novos: false, ranking: [] }, cands, 0.35)).toBe(false);
    expect(rankingEmpty({ ...base, fora_de_escopo: true, ranking: [] }, cands, 0.35)).toBe(false);
  });
});

describe("shortenQuery", () => {
  it("fica com a primeira linha e corta no fim de uma palavra", () => {
    expect(shortenQuery("cobrança indevida de tarifa\nverifique o prazo e devolva")).toBe("cobrança indevida de tarifa");
    const q = shortenQuery("palavra ".repeat(80));
    expect(q.length).toBeLessThanOrEqual(300);
    expect(q.endsWith("palavra")).toBe(true);
  });
});

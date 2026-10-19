import { describe, expect, it } from "vitest";
import { classifierSchema, REVIEW_LABELS, reviewText } from "./prompts.js";
import { checkCompliance, checkLeak } from "../skills/compliance.js";
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

describe("reviewText", () => {
  const disclaimer = "Lembre-se: esta orientação foi gerada por Inteligência Artificial, que pode conter erros.";
  const consolidado = {
    resposta_simples: `Você pode apresentar defesa prévia no prazo indicado na notificação.\n\n${disclaimer}`,
    resposta_tecnica: "Processo administrativo de suspensão do direito de dirigir (art. 261 do CTB).",
  };

  it("separa a resposta ao usuário da versão técnica, com rótulos, nessa ordem", () => {
    const t = reviewText(consolidado);
    const iUser = t.indexOf(REVIEW_LABELS.usuario);
    const iDisclaimer = t.indexOf(disclaimer);
    const iTech = t.indexOf(REVIEW_LABELS.tecnica);
    expect(iUser).toBe(0);
    expect(iDisclaimer).toBeGreaterThan(iUser);
    // A técnica vem depois do disclaimer, mas sob o próprio rótulo: não é mais
    // "texto colado depois do aviso" na mensagem ao usuário.
    expect(iTech).toBeGreaterThan(iDisclaimer);
    expect(t.slice(iTech)).toContain("art. 261 do CTB");
    expect(t.slice(0, iTech)).not.toContain("art. 261 do CTB");
  });

  it("sem versão técnica, não traz o rótulo dela", () => {
    expect(reviewText({ ...consolidado, resposta_tecnica: "  " })).not.toContain(REVIEW_LABELS.tecnica);
  });

  it("continua passando nas checagens determinísticas", () => {
    const t = reviewText(consolidado);
    const det = [...checkCompliance(t, { disclaimer, checks: ["disclaimer", "sem_promessa", "lgpd"] }), checkLeak(t)];
    expect(det.filter((d) => !d.ok)).toEqual([]);
  });
});

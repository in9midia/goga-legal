import { describe, expect, it } from "vitest";
import { findCandidate, planConsultations, type ConsultAsk } from "./consultations.js";

const candidates = [
  { nodeId: "sp-15", name: "15 · Bancário e Financeiro", specialtyNumber: 15 },
  { nodeId: "sp-23", name: "23 · Dano Moral Consumerista (quantificação)", specialtyNumber: 23 },
  { nodeId: "sp-46", name: "46 · Contratos de Prestação de Serviços", specialtyNumber: 46 },
  { nodeId: "sp-52", name: "52 · Prazos e Prescrição", specialtyNumber: 52 },
];
const ask = (target: string, pergunta = "verifique o ponto", from = "15 · Bancário e Financeiro", origem: ConsultAsk["origem"] = "retriagem"): ConsultAsk => ({ from, parecer: "{}", target, pergunta, origem });

describe("findCandidate", () => {
  it("acha pelo nodeId, pelo nome com ou sem número e pelo número", () => {
    expect(findCandidate("sp-46", candidates)?.nodeId).toBe("sp-46");
    expect(findCandidate("46 · Contratos de Prestação de Serviços", candidates)?.nodeId).toBe("sp-46");
    expect(findCandidate("contratos de prestacao de servicos", candidates)?.nodeId).toBe("sp-46");
    expect(findCandidate("52", candidates)?.nodeId).toBe("sp-52");
    expect(findCandidate("Família", candidates)).toBeUndefined();
  });
});

describe("planConsultations", () => {
  it("descarta quem não é do fluxo, quem já rodou e o que passa do teto", () => {
    const plan = planConsultations({
      asks: [ask("Família"), ask("sp-15"), ask("sp-46"), ask("sp-52"), ask("sp-23")],
      candidates,
      ran: new Set(["sp-15"]),
      max: 2,
    });
    expect([...plan.byNode.keys()]).toEqual(["sp-46", "sp-52"]);
    expect(plan.discarded.map((d) => [d.especialista, d.motivo])).toEqual([
      ["Família", "não é especialista deste fluxo"],
      ["sp-15", "já respondeu nesta execução"],
      ["sp-23", "acima do teto de consultas"],
    ]);
  });

  it("Retriagem e o próprio especialista pedindo ao mesmo colega: um pedido, duas perguntas", () => {
    const plan = planConsultations({ asks: [ask("sp-52", "qual o prazo?"), ask("52", "conta da data do desconto?", undefined, "especialista")], candidates, ran: new Set(), max: 1 });
    const reqs = plan.byNode.get("sp-52")!;
    expect(reqs).toHaveLength(1);
    expect(reqs[0].pergunta).toBe("qual o prazo?\nconta da data do desconto?");
    expect(plan.discarded).toEqual([]);
  });

  it("teto 0: nenhuma consulta", () => {
    expect(planConsultations({ asks: [ask("sp-46")], candidates, ran: new Set(), max: 0 }).byNode.size).toBe(0);
  });
});

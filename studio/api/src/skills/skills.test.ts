import { describe, expect, it } from "vitest";
import { calcularCorrecao, calcularPrazo, elegibilidadeJuizado } from "./legal.js";
import { checkCompliance, findPromise } from "./compliance.js";
import { extractCitations, normalizeCitation } from "./citations.js";
import { extractJson } from "../llm/json.js";
import { renderTemplate } from "../files/documents.js";
import type { IndexTables } from "./indices.js";

describe("calcularPrazo", () => {
  it("CDC 26 II: 90 dias corridos a partir da entrega", () => {
    const r = calcularPrazo({ tipo: "vicio_duravel", data_inicio: "2026-01-10", hoje: "2026-03-01" });
    expect(r.data_limite).toBe("2026-04-10");
    expect(r.dias_restantes).toBe(40);
    expect(r.natureza).toBe("decadência");
  });
  it("CC 206 §3º V: 3 anos, expirado", () => {
    const r = calcularPrazo({ tipo: "reparacao_civil", data_inicio: "2020-05-01", hoje: "2026-01-01" });
    expect(r.data_limite).toBe("2023-05-01");
    expect(r.situacao).toBe("expirado");
  });
  it("recusa data malformada", () => {
    expect(() => calcularPrazo({ tipo: "regra_geral", data_inicio: "01/02/2020" })).toThrow();
  });
});

describe("calcularCorrecao", () => {
  const t: IndexTables = {
    fetchedAt: "2026-09-01T00:00:00Z",
    ipca: { "2024-08": 0, "2024-09": 1, "2024-10": 1 },
    selic: { "2024-08": 1, "2024-09": 3, "2024-10": 0.5 },
    salarioMinimo: {},
  };
  it("IPCA composto e juros Selic-IPCA com piso zero", () => {
    const r = calcularCorrecao({ valor: 1000, data_inicial: "2024-09-15", data_final: "2024-10-20", juros: true }, t);
    expect(r.fator_correcao).toBeCloseTo(1.0201, 4);
    // set: 3-1 = 2; out: 0,5-1 < 0 -> 0 (CC 406 §3º)
    expect(r.juros_percentual_acumulado).toBeCloseTo(2, 6);
    expect(r.total).toBeCloseTo(1020.1 * 1.02, 1);
  });
  it("regime anterior: 1% a.m. e ressalva", () => {
    const r = calcularCorrecao({ valor: 100, data_inicial: "2024-08-01", data_final: "2024-08-31", juros: true }, t);
    expect(r.juros_percentual_acumulado).toBe(1);
    expect(r.ressalvas.join(" ")).toMatch(/anterior/);
  });
});

describe("elegibilidadeJuizado", () => {
  it("JEC até 40 SM, advogado facultativo até 20", () => {
    const r = elegibilidadeJuizado({ valor_causa: 10000, reu: "empresa", salario_minimo: 1621, sm_referencia: "2026-09" });
    expect(r.cabe).toBe(true);
    expect(r.advogado).toMatch(/facultativo/);
  });
  it("União vai para o JEF, teto 60 SM", () => {
    const r = elegibilidadeJuizado({ valor_causa: 100 * 1621, reu: "uniao_autarquia_federal", salario_minimo: 1621, sm_referencia: "2026-09" });
    expect(r.juizado).toMatch(/Federal/);
    expect(r.cabe).toBe(false);
  });
});

describe("compliance", () => {
  const disclaimer = "Nenhum resultado é garantido: quem decide é o juiz.";
  it("não confunde o disclaimer com promessa", () => {
    const r = checkCompliance(`Você pode reclamar no Procon.\n\n${disclaimer}`, { disclaimer, checks: ["disclaimer", "sem_promessa"] });
    expect(r.every((x) => x.ok)).toBe(true);
  });
  it("pega promessa real e percentual de êxito", () => {
    expect(findPromise("Com certeza vai ganhar essa causa")).toBeTruthy();
    expect(findPromise("Você tem 90% de chance de êxito")).toBeTruthy();
    expect(findPromise("não há resultado garantido")).toBeUndefined();
  });
  it("disclaimer ausente e CPF exposto reprovam", () => {
    const r = checkCompliance("Seu CPF 123.456.789-09 foi negativado", { disclaimer, checks: ["disclaimer", "lgpd"] });
    expect(r.filter((x) => !x.ok).map((x) => x.check)).toEqual(["disclaimer", "lgpd"]);
  });
});

describe("citações", () => {
  it("extrai e normaliza", () => {
    const c = extractCitations("Conforme a Súmula 297/STJ, o Tema 210 do STF e a Lei nº 14.905/2024.");
    expect(c).toHaveLength(3);
    expect(normalizeCitation("Súmula nº 297 do STJ")).toBe(normalizeCitation("Súmula 297/STJ"));
    expect(normalizeCitation("Lei 14.905/2024")).toBe("lei-14905-2024");
  });
});

describe("extractJson", () => {
  it("acha JSON dentro de cerca e com vírgula sobrando", () => {
    expect(extractJson('Aqui está:\n```json\n{"a": [1,2,], "b": "x}"}\n```')).toEqual({ a: [1, 2], b: "x}" });
    expect(extractJson("sem json")).toBeUndefined();
  });
});

describe("renderTemplate", () => {
  it("preenche e aponta campos faltantes", () => {
    const r = renderTemplate("Eu, {{nome}}, contra {{empresa}}.", { nome: "Ana" });
    expect(r.text).toBe("Eu, Ana, contra [EMPRESA].");
    expect(r.missing).toEqual(["empresa"]);
  });
});

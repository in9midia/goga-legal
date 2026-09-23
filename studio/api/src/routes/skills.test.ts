import { describe, expect, it } from "vitest";
import { parseSkillMd, toSkillMd } from "./skills.js";

describe("parseSkillMd", () => {
  it("le frontmatter com aspas e corpo", () => {
    const r = parseSkillMd(`---\nname: linguagem-simples\ndescription: "Reescreve: sem juridiquês"\n---\n\n# Regras\n- frases curtas\n`);
    expect(r.name).toBe("linguagem-simples");
    expect(r.description).toBe("Reescreve: sem juridiquês");
    expect(r.body).toBe("# Regras\n- frases curtas");
  });
  it("aceita descricao em bloco dobrado", () => {
    const r = parseSkillMd(`---\nname: x\ndescription: >\n  linha um\n  linha dois\nlicense: MIT\n---\ncorpo`);
    expect(r.description).toBe("linha um linha dois");
    expect(r.meta.license).toBe("MIT");
  });
  it("recusa sem name/description", () => {
    expect(() => parseSkillMd(`---\nname: x\n---\ncorpo`)).toThrow();
    expect(() => parseSkillMd(`sem frontmatter`)).toThrow();
  });
  it("exporta e volta igual", () => {
    const md = toSkillMd({ id: "abc", description: 'diz "oi"', instructions: "faça X" } as never);
    const r = parseSkillMd(md);
    expect([r.name, r.description, r.body]).toEqual(["abc", 'diz "oi"', "faça X"]);
  });
});

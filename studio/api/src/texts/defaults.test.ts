import { describe, expect, it } from "vitest";
import { DEFAULT_TEXTS, TEXT_KEYS, TEXTS, textProblems } from "./defaults.js";

describe("textos do motor", () => {
  it("todo padrão é válido e não carrega o marcador de formato (o motor põe)", () => {
    for (const k of TEXT_KEYS) {
      expect(textProblems(k, DEFAULT_TEXTS[k])).toEqual([]);
      expect(DEFAULT_TEXTS[k]).not.toMatch(/<<formato:/);
    }
  });
  it("recusa texto vazio e variável obrigatória removida", () => {
    expect(textProblems("formato.parecer", "  ")).toHaveLength(1);
    expect(textProblems("retriagem.formato", "sem lista")[0]).toMatch(/\{\{colegas\}\}/);
    expect(textProblems("retriagem.formato", "use {{ colegas }}")).toEqual([]);
  });
  it("as variáveis declaradas aparecem no padrão", () => {
    for (const k of TEXT_KEYS) for (const v of (TEXTS[k] as { vars?: { name: string }[] }).vars ?? []) expect(DEFAULT_TEXTS[k]).toContain(`{{${v.name}}}`);
  });
});

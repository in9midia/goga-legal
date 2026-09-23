import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, schema: {} }));
vi.mock("../kb/client.js", () => ({
  search: vi.fn(async () => ({
    results: [
      { chunk_id: 7, document_id: 0, space: "aereo", title: "", filename: "", representation: "wiki", page: null, score: 0.03, armadilha: "",
        content: "---\ntype: Precedente\ntitle: 'Tema 210 do STF (RE 636.331)'\n---\n\n# Tema 210\ncorpo" },
      { chunk_id: 99, document_id: 2, space: "aereo", title: "Tema 210/STF", filename: "t.md", representation: "indice", page: null, score: 0.02, armadilha: "", content: "trecho" },
    ],
  })),
  fetchDocument: vi.fn(async (id: number) => ({ id, space_slug: "aereo", canonical_md: "doc" })),
  fetchWikiPage: vi.fn(async (id: number) => ({ id, space: "aereo", content: "pagina" })),
}));

const { skillById } = await import("./index.js");
const kb = await import("../kb/client.js");

const env = () => ({ parentId: "t", ctx: {} as never, node: { data: { knowledge: { spaces: ["aereo"], topK: 6 } } } as never });

describe("buscar_kb + buscar_documento_kb com paginas da wiki", () => {
  it("pagina da wiki sai com pagina_wiki_id e titulo do frontmatter, nunca document_id 0", async () => {
    const e = env();
    const r = (await skillById.get("buscar_kb")!.run({ consulta: "atraso de voo" }, e)) as { resultados: Record<string, unknown>[] };
    expect(r.resultados[0]).toMatchObject({ pagina_wiki_id: 7, titulo: "Tema 210 do STF (RE 636.331)" });
    expect(r.resultados[0]).not.toHaveProperty("document_id");
    expect(r.resultados[1]).toMatchObject({ document_id: 2 });

    const abrir = skillById.get("buscar_documento_kb")!;
    expect(await abrir.run({ pagina_wiki_id: 7 }, e)).toMatchObject({ content: "pagina" });
    expect(kb.fetchWikiPage).toHaveBeenCalledWith(7);
    expect(await abrir.run({ document_id: 2 }, e)).toMatchObject({ content: "doc" });
    const zero = (await abrir.run({ document_id: 0 }, e)) as { erro: string };
    expect(zero.erro).toMatch(/pagina_wiki_id/);
    expect(kb.fetchDocument).not.toHaveBeenCalledWith(0);
  });
});

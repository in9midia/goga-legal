import { afterEach, describe, expect, it, vi } from "vitest";

// Rajada de leituras das bases (30 `ler_no` paralelos validando o grafo) vira UMA ida a KB:
// cada GET /v1/spaces conta os trechos de todas as bases e segura uma das 8 conexoes do pool.
describe("listSpaces", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const kbFalsa = () => {
    const pendentes: ((spaces: { slug: string }[]) => void)[] = [];
    const fetch = vi.fn(
      () =>
        new Promise<Response>((ok) => {
          pendentes.push((spaces) => ok(new Response(JSON.stringify({ spaces }), { status: 200 })));
        }),
    );
    vi.stubGlobal("fetch", fetch);
    /** Responde a requisicao `i` (na ordem em que chegaram a KB). */
    return { fetch, responder: (spaces: { slug: string }[], i = 0) => pendentes[i]!(spaces) };
  };

  it("chamadas simultaneas compartilham a leitura em voo e depois usam o cache", async () => {
    const kb = kbFalsa();
    const { listSpaces, spaceSlugs } = await import("./client.js");
    const rajada = Promise.all(Array.from({ length: 30 }, () => spaceSlugs()));
    kb.responder([{ slug: "transito-veiculos" }]);
    const slugs = await rajada;
    expect(kb.fetch).toHaveBeenCalledTimes(1);
    expect([...slugs[29]!]).toEqual(["transito-veiculos"]);
    await listSpaces();
    expect(kb.fetch).toHaveBeenCalledTimes(1);
  });

  it("fresh nao pega carona e uma base criada no meio da leitura nao deixa a lista velha no cache", async () => {
    const kb = kbFalsa();
    const { listSpaces, createSpace } = await import("./client.js");
    const velha = listSpaces();
    void createSpace({ slug: "nova" });
    kb.responder([{ slug: "a" }], 0);
    await velha;
    // A lista de antes da criacao nao ficou no cache: a proxima leitura vai a KB.
    void listSpaces();
    expect(kb.fetch).toHaveBeenCalledTimes(3);
    void listSpaces(true);
    expect(kb.fetch).toHaveBeenCalledTimes(4);
  });
});

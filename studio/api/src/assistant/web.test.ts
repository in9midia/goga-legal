import { describe, expect, it } from "vitest";
import { assertPublicUrl, htmlToText, parseBing, parseDdgHtml, parseDdgLite } from "./web.js";

describe("pesquisa", () => {
  it("DuckDuckGo HTML: tira o redirecionamento e ignora anúncios", () => {
    const html = `
      <div class="result results_links result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Anúncio</a></div>
      <div class="result results_links"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.planalto.gov.br%2Fl8078.htm&amp;rut=x">CDC &amp; <b>Lei</b></a></h2>
      <a class="result__snippet" href="#">Art. 49 &quot;arrependimento&quot;</a></div>`;
    expect(parseDdgHtml(html)).toEqual([{ titulo: "CDC & Lei", url: "https://www.planalto.gov.br/l8078.htm", trecho: 'Art. 49 "arrependimento"' }]);
  });

  it("DuckDuckGo Lite: casa link e trecho seguinte", () => {
    const html = `<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fstj.jus.br%2Fa" class='result-link'>Súmula 326</a></td></tr>
      <tr><td class='result-snippet'> Na ação de <b>dano</b> moral </td></tr>
      <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fb.com" class='result-link'>B</a>`;
    expect(parseDdgLite(html)).toEqual([
      { titulo: "Súmula 326", url: "https://stj.jus.br/a", trecho: "Na ação de dano moral" },
      { titulo: "B", url: "https://b.com", trecho: "" },
    ]);
  });

  it("Bing: decodifica u=a1<base64url>", () => {
    const u = `a1${Buffer.from("https://scon.stj.jus.br/SCON/").toString("base64url")}`;
    const html = `<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;p=1&amp;u=${u}&amp;ntb=1">Súmulas STJ</a></h2><div class="b_caption"><p class="b_lineclamp2">Pesquisa de súmulas</p></div></li>`;
    expect(parseBing(html)).toEqual([{ titulo: "Súmulas STJ", url: "https://scon.stj.jus.br/SCON/", trecho: "Pesquisa de súmulas" }]);
  });
});

describe("htmlToText", () => {
  it("remove scripts, colapsa espaços do fonte e resolve links relativos", () => {
    const html = `<html><head><title>Lei &#8470; 1</title><style>p{}</style></head><body><nav>menu</nav>
      <h2>Capítulo
      I</h2><p>Art. 1º O   consumidor
      tem <a href="/art2">direito</a>.</p><script>x()</script><ul><li>um</li><li>dois</li></ul></body></html>`;
    const p = htmlToText(html, new URL("https://www.planalto.gov.br/leis/l1.htm"));
    expect(p.titulo).toBe("Lei № 1");
    expect(p.texto).toBe("## Capítulo I\n\nArt. 1º O consumidor tem direito.\n\n- um\n- dois");
    expect(p.links).toEqual([{ texto: "direito", url: "https://www.planalto.gov.br/art2" }]);
  });
});

describe("assertPublicUrl", () => {
  it.each(["http://localhost:3000", "http://127.0.0.1", "http://169.254.169.254/latest", "http://10.1.2.3", "http://192.168.0.1", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "file:///etc/passwd", "ftp://x.com"])(
    "recusa %s",
    async (u) => expect(assertPublicUrl(u)).rejects.toThrow(),
  );
  it("aceita IP público", async () => expect((await assertPublicUrl("https://1.1.1.1/")).hostname).toBe("1.1.1.1"));
});

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { extractText } from "../files/extract.js";

// Acesso a internet do Assistente: pesquisa (DuckDuckGo, sem chave) e leitura
// de paginas. So GET em http(s) publico: enderecos internos (localhost, rede
// privada, metadados de nuvem) sao recusados em cada salto de redirecionamento,
// para o Assistente nao virar uma porta para a rede do servidor.

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

// ── guarda de endereco ────────────────────────────────────────────────
function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    // IPv4 mapeado: ::ffff:127.0.0.1 ou, como o URL normaliza, ::ffff:7f00:1.
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
    if (hex) return isPrivateIp([parseInt(hex[1], 16) >> 8, parseInt(hex[1], 16) & 255, parseInt(hex[2], 16) >> 8, parseInt(hex[2], 16) & 255].join("."));
    if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
    return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || /^fe[89ab]/.test(v);
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  );
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`URL inválida: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("só http e https são permitidos");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) throw new Error("endereço interno recusado");
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => { throw new Error(`host não encontrado: ${host}`); })).map((a) => a.address);
  if (addrs.some(isPrivateIp)) throw new Error("endereço de rede interna recusado");
  return url;
}

/** Requisicao com timeout, limite de tamanho e redirecionamentos conferidos um a um. */
async function safeFetch(raw: string, init: RequestInit = {}): Promise<{ url: URL; res: Response; body: Buffer }> {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; ; hop++) {
    const res = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": UA, "accept-language": "pt-BR,pt;q=0.9,en;q=0.8", ...init.headers },
    });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      if (hop >= MAX_REDIRECTS) throw new Error("redirecionamentos demais");
      url = await assertPublicUrl(new URL(loc, url).toString());
      init = { headers: init.headers };
      continue;
    }
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_BYTES) throw new Error(`resposta grande demais (${Math.round(len / 1024)} KB)`);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const c of res.body ?? []) {
      total += c.length;
      if (total > MAX_BYTES) throw new Error(`resposta grande demais (> ${MAX_BYTES / 1024 / 1024} MB)`);
      chunks.push(Buffer.from(c));
    }
    return { url, res, body: Buffer.concat(chunks) };
  }
}

// ── HTML → texto ──────────────────────────────────────────────────────
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»", ordm: "º", ordf: "ª", sect: "§", copy: "©", reg: "®" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

export interface Page {
  titulo: string;
  texto: string;
  links: { texto: string; url: string }[];
}

/** Texto legivel (titulos em Markdown, listas, paragrafos) e os links da pagina. */
export function htmlToText(html: string, base: URL): Page {
  const titulo = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
  let h = html.replace(/<!--[\s\S]*?-->/g, "");
  h = h.replace(/<(script|style|noscript|svg|template|iframe|head|button|select)\b[\s\S]*?<\/\1>/gi, " ");
  // Prefere o conteudo principal quando a pagina o marca.
  const main = /<(main|article)\b[^>]*>([\s\S]*)<\/\1>/i.exec(h)?.[2];
  if (main && stripTags(main).length > 400) h = main;
  else h = h.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, " ");

  const links: Page["links"] = [];
  const seen = new Set<string>();
  for (const m of h.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const texto = stripTags(m[2]);
    if (!texto) continue;
    let url: string;
    try {
      url = new URL(decodeEntities(m[1]), base).toString();
    } catch {
      continue;
    }
    if (!/^https?:/.test(url) || seen.has(url)) continue;
    seen.add(url);
    links.push({ texto: texto.slice(0, 120), url });
  }

  // Espacos e quebras do codigo-fonte nao contam no HTML; so as tags quebram linha.
  const texto = decodeEntities(
    h
      .replace(/\s+/g, " ")
      .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n: string, t: string) => `\n\n${"#".repeat(Number(n))} ${stripTags(t)}\n\n`)
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<(br|hr)\b[^>]*>/gi, "\n")
      .replace(/<\/(p|div|section|tr|table|ul|ol|blockquote|pre|dd|dt)>/gi, "\n\n")
      .replace(/<\/t[dh]>/gi, " | ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { titulo, texto, links };
}

/** Charset do cabecalho ou do <meta>; sem declaracao, UTF-8 e, se nao for UTF-8 valido, windows-1252 (paginas antigas do governo). */
function decodeHtml(body: Buffer, contentType: string): string {
  const declared = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 32_768).toString("latin1"))?.[1];
  try {
    if (declared) return new TextDecoder(declared).decode(body);
  } catch {
    /* charset desconhecido: tenta os padroes abaixo */
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return new TextDecoder("windows-1252").decode(body);
  }
}

// ── navegar ───────────────────────────────────────────────────────────
export interface FetchResult {
  url: string;
  status: number;
  tipo: string;
  titulo?: string;
  total: number;
  inicio: number;
  texto: string;
  links?: { texto: string; url: string }[];
  aviso?: string;
}

export async function fetchPage(raw: string, opts: { inicio: number; tamanho: number; links: boolean; userId: string | null }): Promise<FetchResult> {
  const { url, res, body } = await safeFetch(raw);
  const tipo = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  let titulo: string | undefined;
  let texto: string;
  let links: Page["links"] | undefined;
  let aviso: string | undefined;

  if (tipo.includes("html") || (!tipo && /^\s*<(!doctype|html)/i.test(body.subarray(0, 200).toString()))) {
    const html = decodeHtml(body, res.headers.get("content-type") ?? "");
    const p = htmlToText(html, url);
    titulo = p.titulo;
    texto = p.texto;
    if (opts.links) links = p.links.slice(0, 80);
  } else if (tipo.startsWith("text/") || tipo.includes("json") || tipo.includes("xml")) {
    texto = body.toString("utf8");
  } else if (tipo === "application/pdf" || tipo.includes("officedocument") || /\.(pdf|docx)$/i.test(url.pathname)) {
    const name = url.pathname.split("/").pop() || "arquivo";
    const ex = await extractText(body, tipo, name, opts.userId);
    texto = ex.text;
    aviso = ex.warning;
  } else {
    throw new Error(`tipo de conteúdo não suportado: ${tipo || "desconhecido"}`);
  }
  if (res.status >= 400) aviso = `o servidor respondeu HTTP ${res.status}`;
  return { url: url.toString(), status: res.status, tipo, titulo, total: texto.length, inicio: opts.inicio, texto: texto.slice(opts.inicio, opts.inicio + opts.tamanho), links, aviso };
}

// ── pesquisar ─────────────────────────────────────────────────────────
// DuckDuckGo (sem chave) pelas versoes HTML e Lite, que aceitam navegadores de
// texto; com a UA de um navegador comum o DuckDuckGo responde com o desafio
// anti-robo. Se as duas falharem (limite por IP), cai no Bing.
const TEXT_UA = "Lynx/2.9.0 libwww-FM/2.14";

export interface SearchHit {
  titulo: string;
  url: string;
  trecho: string;
}

/** Links do DuckDuckGo passam por /l/?uddg=<url>; devolve o destino real. */
function unwrapDdg(href: string): string {
  try {
    const u = new URL(decodeEntities(href), "https://duckduckgo.com");
    return u.searchParams.get("uddg") ?? u.toString();
  } catch {
    return "";
  }
}

/** Links do Bing passam por /ck/a?...&u=a1<base64url>; devolve o destino real. */
function unwrapBing(href: string): string {
  try {
    const u = new URL(decodeEntities(href), "https://www.bing.com");
    const enc = u.searchParams.get("u");
    if (u.hostname.endsWith("bing.com") && enc?.startsWith("a1")) return Buffer.from(enc.slice(2), "base64url").toString("utf8");
    return u.toString();
  } catch {
    return "";
  }
}

const keep = (h: SearchHit) => /^https?:/.test(h.url) && !/duckduckgo\.com\/y\.js|bing\.com\/aclick/.test(h.url) && !!h.titulo;

export function parseDdgHtml(html: string): SearchHit[] {
  return html
    .split(/<div[^>]+class="[^"]*\bresult\b/i)
    .slice(1)
    .filter((b) => !/^[^>]*result--ad\b/.test(b))
    .map((b) => {
      const a = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(b);
      const href = a ? (/href="([^"]+)"/.exec(a[0])?.[1] ?? "") : "";
      const snip = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(a|div|td)>/i.exec(b)?.[1] ?? "";
      return { titulo: stripTags(a?.[1] ?? ""), url: unwrapDdg(href), trecho: stripTags(snip) };
    })
    .filter(keep);
}

export function parseDdgLite(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const re = /<a[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi;
  const found = [...html.matchAll(re)];
  found.forEach((m, k) => {
    const href = /href=["']([^"']+)["']/.exec(m[0])?.[1] ?? "";
    const rest = html.slice(m.index! + m[0].length, found[k + 1]?.index ?? html.length);
    const snip = /class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i.exec(rest)?.[1] ?? "";
    hits.push({ titulo: stripTags(m[1]), url: unwrapDdg(href), trecho: stripTags(snip) });
  });
  return hits.filter(keep);
}

export function parseBing(html: string): SearchHit[] {
  return html
    .split(/<li class="b_algo/)
    .slice(1)
    .map((b) => {
      const a = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(b);
      const snip = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(b)?.[1] ?? "";
      return { titulo: stripTags(a?.[2] ?? ""), url: unwrapBing(a?.[1] ?? ""), trecho: stripTags(snip).replace(/^Web\s*/, "") };
    })
    .filter(keep);
}

export interface SearchResult {
  fonte: "duckduckgo" | "duckduckgo-lite" | "bing";
  resultados: SearchHit[];
  aviso?: string;
}

export async function searchWeb(consulta: string, opts: { limite: number; regiao: string; periodo?: "d" | "w" | "m" | "y"; site?: string }): Promise<SearchResult> {
  const q = opts.site ? `${consulta} site:${opts.site}` : consulta;
  const ddg = new URLSearchParams({ q, kl: opts.regiao });
  if (opts.periodo) ddg.set("df", opts.periodo);
  const lang = opts.regiao.split("-")[1] ?? "pt";
  const cc = (opts.regiao.split("-")[0] ?? "br").toUpperCase();
  const engines: { fonte: SearchResult["fonte"]; url: string; ua?: string; parse: (h: string) => SearchHit[] }[] = [
    { fonte: "duckduckgo", url: `https://html.duckduckgo.com/html/?${ddg}`, ua: TEXT_UA, parse: parseDdgHtml },
    { fonte: "duckduckgo-lite", url: `https://lite.duckduckgo.com/lite/?${ddg}`, ua: TEXT_UA, parse: parseDdgLite },
    { fonte: "bing", url: `https://www.bing.com/search?${new URLSearchParams({ q, setlang: lang, cc: cc === "WT" ? "US" : cc, count: "20" })}`, parse: parseBing },
  ];
  const falhas: string[] = [];
  for (const e of engines) {
    try {
      const { res, body } = await safeFetch(e.url, e.ua ? { headers: { "user-agent": e.ua } } : {});
      const html = body.toString("utf8");
      const hits = e.parse(html);
      if (hits.length) {
        const aviso = falhas.length ? `usado ${e.fonte} (${falhas.join("; ")})${e.fonte === "bing" && opts.periodo ? "; filtro de período ignorado" : ""}` : undefined;
        return { fonte: e.fonte, resultados: hits.slice(0, opts.limite), aviso };
      }
      falhas.push(res.status === 200 && !/anomaly|challenge|captcha/i.test(html) ? `${e.fonte}: sem resultados` : `${e.fonte}: bloqueado (HTTP ${res.status})`);
      if (res.status === 200 && e.fonte !== "bing" && !/anomaly|challenge|captcha/i.test(html)) break;
    } catch (err) {
      falhas.push(`${e.fonte}: ${(err as Error).message}`);
    }
  }
  if (falhas.every((f) => f.endsWith("sem resultados"))) return { fonte: "duckduckgo", resultados: [], aviso: "nenhum resultado; reformule a consulta" };
  throw new Error(`pesquisa indisponível agora — ${falhas.join("; ")}. Tente de novo em alguns minutos ou abra uma fonte conhecida com navegar_web.`);
}

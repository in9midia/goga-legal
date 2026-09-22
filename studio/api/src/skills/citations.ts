import { seedCitations } from "../seed/files.js";
import * as kb from "../kb/client.js";

// Padroes de citacao que o repertorio do Goga usa. Nao pretende cobrir toda
// forma de citar direito brasileiro: cobre as que aparecem na pesquisa e na
// auditoria, que sao as que o modelo reproduz.
const PATTERNS: RegExp[] = [
  /S[úu]mula(?:\s+Vinculante)?\s+(?:n[º°o.]\s*)?\d+\s*(?:\/|\s+do\s+)\s*(?:STJ|STF|TST)/gi,
  /Tema\s+(?:n[º°o.]\s*)?\d+\s*(?:\/|\s+do\s+)\s*(?:STJ|STF|TST)/gi,
  /\b(?:REsp|AREsp|RE|ARE|ADI|ADPF|ADC|EREsp)\s+(?:n[º°o.]\s*)?\d[\d.]*(?:\/[A-Z]{2})?/g,
  /\bLei\s+(?:Complementar\s+)?(?:n[º°o.]\s*)?\d{1,2}\.?\d{3}(?:\/\d{2,4})?/gi,
  /\bDecreto(?:-Lei)?\s+(?:n[º°o.]\s*)?\d{1,2}\.?\d{3}(?:\/\d{2,4})?/gi,
];

export function normalizeCitation(c: string): string {
  return c
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\bn[º°o.]\s*/g, "")
    .replace(/\s+do\s+/g, "/")
    .replace(/(\d)\.(\d{3})/g, "$1$2")
    .replace(/[^a-z0-9/]+/g, "-")
    .replace(/\//g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function extractCitations(text: string): string[] {
  const found = new Map<string, string>();
  for (const p of PATTERNS) {
    for (const m of text.matchAll(p)) {
      const key = normalizeCitation(m[0]);
      if (!found.has(key)) found.set(key, m[0].replace(/\s+/g, " ").trim());
    }
  }
  return [...found.values()];
}

export type CitationStatus = "VERIFICADA" | "EM_VERIFICACAO" | "INCORRETA" | "NAO_ENCONTRADA" | "KB_INDISPONIVEL";

export interface CitationCheck {
  citacao: string;
  status: CitationStatus;
  bloqueada: boolean;
  fonte: string;
  nota?: string;
}

function catalogStatus(raw: string): CitationStatus | null {
  const s = raw.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (s.includes("EM VERIFICACAO") || s.includes("EM_VERIFICACAO")) return "EM_VERIFICACAO";
  if (s.includes("INCORRET") || s.includes("ERRAD") || s.includes("REMOV")) return "INCORRETA";
  if (s.includes("VERIFICAD") || s.includes("MANTID")) return "VERIFICADA";
  return null;
}

export async function verifyCitations(text: string, spaces: string[]): Promise<CitationCheck[]> {
  const cites = extractCitations(text);
  const catalog = seedCitations();
  const out: CitationCheck[] = [];
  for (const c of cites) {
    const norm = normalizeCitation(c);
    const entry = catalog.find((e) => e.normalizada === norm || normalizeCitation(e.citacao) === norm);
    const st = entry ? catalogStatus(entry.status) : null;
    if (st) {
      out.push({ citacao: c, status: st, bloqueada: st !== "VERIFICADA", fonte: "auditoria de citações", nota: entry?.nota });
      continue;
    }
    // Fora do catalogo da auditoria: vale se a KB tem conteudo CONFERIDO que a
    // cite. Busca sem `min_trust` aceitaria texto nao revisado como prova.
    try {
      const r = await kb.search({ query: c, spaces, top_k: 5, min_trust: "machine-confirmed" });
      const hit = r.results.find((p) => normalizeCitation(`${p.title} ${p.content}`).includes(norm));
      if (hit?.armadilha) {
        out.push({ citacao: c, status: "INCORRETA", bloqueada: true, fonte: `KB: ${hit.title}`, nota: String(hit.armadilha) });
      } else if (hit) {
        out.push({ citacao: c, status: "VERIFICADA", bloqueada: false, fonte: `KB: ${hit.title} (${hit.space})` });
      } else {
        out.push({ citacao: c, status: "NAO_ENCONTRADA", bloqueada: true, fonte: "", nota: "sem conteúdo conferido na KB que sustente a citação" });
      }
    } catch {
      out.push({ citacao: c, status: "KB_INDISPONIVEL", bloqueada: true, fonte: "", nota: "KB fora do ar: não foi possível conferir" });
    }
  }
  return out;
}

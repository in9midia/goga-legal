import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Os JSON de seed ficam em studio/api/seed/, fora de src/, porque sao conteudo
// (derivado da pesquisa) e nao codigo: quem revisa um prompt de especialista nao
// deveria precisar abrir TypeScript.
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../seed");

export function readSeed<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as T;
  } catch {
    return fallback;
  }
}

export interface CitationEntry {
  citacao: string;
  normalizada: string;
  status: string;
  nota?: string;
}
export interface TemplateEntry {
  slug: string;
  titulo: string;
  descricao?: string;
  campos: { nome: string; rotulo: string; obrigatorio?: boolean }[];
  corpo_markdown: string;
}
export interface ChecklistEntry {
  titulo: string;
  documentos: { item: string; obrigatorio: boolean; observacao?: string }[];
}

let citations: CitationEntry[] | null = null;
let templates: TemplateEntry[] | null = null;
let checklists: Record<string, ChecklistEntry> | null = null;

export const seedCitations = () => (citations ??= readSeed<CitationEntry[]>("citations.json", []));
export const seedTemplates = () => (templates ??= readSeed<TemplateEntry[]>("templates.json", []));
export const seedChecklists = () => (checklists ??= readSeed<Record<string, ChecklistEntry>>("checklists.json", {}));

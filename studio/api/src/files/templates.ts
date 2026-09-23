import { asc, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";

export type DocTemplate = typeof schema.docTemplate.$inferSelect;

/** Modelos ativos, lidos do cadastro. Desativar um modelo o tira do consolidador e do gerar_documento. */
export async function activeTemplates(): Promise<DocTemplate[]> {
  return db.select().from(schema.docTemplate).where(eq(schema.docTemplate.enabled, true)).orderBy(asc(schema.docTemplate.slug));
}

/** Placeholders `{{campo}}` do corpo, na ordem em que aparecem. */
export function placeholders(body: string): string[] {
  return [...new Set([...body.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)].map((m) => m[1]))];
}

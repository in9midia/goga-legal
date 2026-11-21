import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { audit } from "../lib/audit.js";
import type { SessionUser } from "../lib/auth.js";
import { badRequest, notFound } from "../lib/errors.js";
import { DEFAULT_TEXTS, TEXT_KEYS, TEXTS, isTextKey, textProblems, type EngineTexts, type TextDef, type TextKey } from "./defaults.js";

const T = schema.engineText;

/**
 * Os textos em vigor: o editado no banco ou o padrao do codigo. O motor le uma
 * vez por turno (tabela pequena); sem cache, a edicao vale no turno seguinte em
 * todas as replicas. Banco fora do ar nao derruba o turno: vale o padrao.
 */
export async function loadEngineTexts(): Promise<EngineTexts> {
  const out = { ...DEFAULT_TEXTS };
  const rows = await db.select().from(T).catch(() => []);
  for (const r of rows) if (isTextKey(r.key) && r.text.trim()) out[r.key] = r.text;
  return out;
}

export interface EngineTextView extends Omit<TextDef, "default"> {
  key: TextKey;
  text: string;
  /** O padrao do codigo; difere de `text` quando alguem editou. */
  default: string;
  edited: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export async function listTexts(): Promise<EngineTextView[]> {
  const rows = new Map((await db.select().from(T)).map((r) => [r.key, r]));
  return TEXT_KEYS.map((key) => {
    const def: TextDef = TEXTS[key];
    const r = rows.get(key);
    return {
      key,
      title: def.title,
      description: def.description,
      group: def.group,
      kind: def.kind,
      vars: def.vars ?? [],
      text: r?.text ?? def.default,
      default: def.default,
      edited: !!r && r.text !== def.default,
      updatedAt: r?.updatedAt.toISOString() ?? null,
      updatedBy: r?.updatedBy ?? null,
    };
  });
}

function requireKey(key: string): TextKey {
  if (!isTextKey(key)) throw notFound(`texto "${key}"`);
  return key;
}

export async function getText(key: string): Promise<EngineTextView> {
  const k = requireKey(key);
  return (await listTexts()).find((t) => t.key === k)!;
}

/** Grava o texto; `null` (ou igual ao padrao) volta ao padrao do codigo. */
export async function saveText(key: string, text: string | null, user: SessionUser): Promise<EngineTextView> {
  const k = requireKey(key);
  const before = await getText(k);
  if (text === null || text === TEXTS[k].default) {
    await db.delete(T).where(eq(T.key, k));
  } else {
    const problems = textProblems(k, text);
    if (problems.length) throw badRequest(problems.join("; "));
    await db
      .insert(T)
      .values({ key: k, text, updatedBy: user.email })
      .onConflictDoUpdate({ target: T.key, set: { text, updatedBy: user.email, updatedAt: new Date() } });
  }
  const after = await getText(k);
  if (after.text !== before.text) await audit(user, text === null ? "reset" : "update", "engine_text", k, { text: before.text }, { text: after.text });
  return after;
}

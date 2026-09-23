import { db, schema } from "../db/index.js";
import type { SessionUser } from "./auth.js";

// Campos que nunca entram no diff da auditoria. A chave cifrada nao e segredo em
// claro, mas o log de auditoria e lido por mais gente que o banco, e o diff so
// precisa dizer "a chave foi alterada".
const REDACT = new Set(["apiKeyEnc", "api_key_enc", "passwordHash", "password_hash", "apiKey", "secretEnc", "headersEnc"]);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT.has(k) ? (v ? "••••" : "") : redact(v);
    }
    return out;
  }
  return value;
}

export async function audit(
  actor: SessionUser | null,
  action: string,
  entity: string,
  entityId: string | null,
  before: unknown,
  after: unknown,
): Promise<void> {
  await db.insert(schema.auditLog).values({
    actorId: actor?.id ?? null,
    actorEmail: actor?.email ?? "system",
    action,
    entity,
    entityId,
    before: before === undefined ? null : redact(before),
    after: after === undefined ? null : redact(after),
  });
}

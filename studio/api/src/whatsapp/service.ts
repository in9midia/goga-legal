import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { config } from "../config.js";
import { HttpError, notFound } from "../lib/errors.js";
import { EvolutionError, evolution, instanceTokenOf, restartConfigured, restartEvolution, webhookTokenOf, WEBHOOK_TOKEN_HEADER } from "./evolution.js";
import type { ConnectionSignal, QrSignal } from "./parse.js";

export type NumberRow = typeof schema.whatsappNumber.$inferSelect;
type State = NumberRow["state"];

/** Eventos que o Studio pede ao Evolution para cada instancia. */
const WEBHOOK_EVENTS = ["MESSAGES_UPSERT", "CONNECTION_UPDATE", "QRCODE_UPDATED"];

/** Motivo gravado quando o Studio detecta a sessao travada (Evolution diz `open`, envio diz fechada). */
export const STALE_SESSION_REASON = 428;
/** Intervalo minimo entre dois reinicios automaticos do Evolution (vale para todos os numeros). */
export const RESTART_COOLDOWN_MS = 15 * 60_000;

const normalizeState = (s: string | undefined): State => (s === "open" || s === "connecting" || s === "close" ? s : "close");

export function webhookUrl(numberId: string) {
  const base = config.evolutionWebhookBase || config.publicUrl || `http://localhost:${config.port}`;
  return `${base}/api/v1/whatsapp/webhook/${numberId}`;
}

export async function loadNumber(id: string): Promise<NumberRow> {
  const [n] = await db.select().from(schema.whatsappNumber).where(eq(schema.whatsappNumber.id, id));
  if (!n) throw notFound("número de WhatsApp");
  return n;
}

const log = (n: Pick<NumberRow, "name" | "id">, msg: string) => console.warn(`[whatsapp ${n.name} ${n.id.slice(0, 8)}] ${msg}`);

/**
 * Aplica uma mudanca de estado (webhook, verificacao periodica ou acao no
 * Studio). `disconnectedAt` marca a queda: sessao que estava conectada e
 * fechou ou passou a pedir QR (sessao perdida). Reconexao rapida
 * (`connecting` → `open`, sem QR) nao conta como queda.
 */
export async function transition(
  numberId: string,
  next: { state: State; statusReason?: number | null; number?: string | null; profileName?: string | null; qr?: { base64: string | null; pairingCode: string | null }; manual?: boolean },
): Promise<NumberRow> {
  const before = await loadNumber(numberId);
  const now = new Date();
  const changed = before.state !== next.state;
  const wasConnected = !!before.connectedAt && (!before.disconnectedAt || before.disconnectedAt < before.connectedAt);
  const lost = next.state !== "open" && wasConnected && (next.state === "close" || !!next.qr);
  const [row] = await db
    .update(schema.whatsappNumber)
    .set({
      state: next.state,
      updatedAt: now,
      ...(next.statusReason !== undefined && { statusReason: next.statusReason }),
      ...(next.number && { number: next.number }),
      ...(next.profileName && { profileName: next.profileName }),
      ...(next.qr && { qrCode: next.qr.base64, pairingCode: next.qr.pairingCode, qrUpdatedAt: now }),
      ...(next.state === "open" && { qrCode: null, pairingCode: null, statusReason: null }),
      ...(changed && next.state === "open" && { connectedAt: now }),
      ...(((changed && next.state === "close") || lost) && { disconnectedAt: now }),
    })
    .where(eq(schema.whatsappNumber.id, numberId))
    .returning();
  if (changed && next.state === "open") log(row, `conectado (${row.number ?? "?"})`);
  if (lost && !next.manual) log(row, `SESSÃO CAIU (motivo ${row.statusReason ?? "—"})`);
  return row;
}

async function fetchState(n: NumberRow) {
  try {
    const res = await evolution<{ instance?: { state?: string } }>("GET", `/instance/connectionState/${encodeURIComponent(n.instanceName)}`);
    return { state: normalizeState(res.instance?.state), exists: true };
  } catch (err) {
    if (err instanceof EvolutionError && err.status === 404) return { state: "close" as State, exists: false };
    throw err;
  }
}

/** Verificacao periodica (reserva do webhook): atualiza o estado e detecta quedas. */
export async function refresh(numberId: string) {
  const n = await loadNumber(numberId);
  const { state, exists } = await fetchState(n);
  return transition(numberId, { state: exists ? state : n.state === "not_created" ? "not_created" : "close" });
}

/** Sinal do webhook (`connection.update` / `qrcode.updated`), ja autenticado. */
export async function applySignal(numberId: string, signal: ConnectionSignal | QrSignal) {
  if (signal.type === "qrcode") {
    await transition(numberId, { state: "connecting", qr: { base64: signal.base64, pairingCode: signal.pairingCode } });
    return;
  }
  await transition(numberId, {
    state: normalizeState(signal.state),
    statusReason: signal.statusReason,
    number: signal.wuid ? signal.wuid.split("@")[0]!.split(":")[0]! : undefined,
    profileName: signal.profileName ?? undefined,
  });
}

/** Sinal de vida da instancia: grava no maximo uma vez por minuto. */
export async function touch(numberId: string, at = new Date()) {
  await db
    .update(schema.whatsappNumber)
    .set({ lastEventAt: at })
    .where(and(eq(schema.whatsappNumber.id, numberId), or(isNull(schema.whatsappNumber.lastEventAt), lt(schema.whatsappNumber.lastEventAt, new Date(at.getTime() - 60_000)))));
}

/**
 * Cria a instancia (se preciso), configura o webhook autenticado e pede um QR
 * novo. Idempotente: chamar de novo renova o QR.
 */
export async function connect(numberId: string): Promise<NumberRow> {
  const n = await loadNumber(numberId);
  const webhook = {
    enabled: true,
    url: webhookUrl(n.id),
    byEvents: false,
    base64: false,
    headers: { [WEBHOOK_TOKEN_HEADER]: webhookTokenOf(config.evolutionApiKey, n.id) },
    events: WEBHOOK_EVENTS,
  };
  try {
    const { exists, state } = await fetchState(n);
    if (!exists) {
      await evolution("POST", "/instance/create", {
        instanceName: n.instanceName,
        token: instanceTokenOf(config.evolutionApiKey, n.id),
        integration: "WHATSAPP-BAILEYS",
        qrcode: false,
        groupsIgnore: true,
        alwaysOnline: false,
        readMessages: false,
        syncFullHistory: false,
        webhook,
      });
    }
    await evolution("POST", `/webhook/set/${encodeURIComponent(n.instanceName)}`, { webhook });
    if (exists && state === "open") return transition(n.id, { state: "open", manual: true });
    const qr = await evolution<{ base64?: string; pairingCode?: string | null; instance?: { state?: string } }>("GET", `/instance/connect/${encodeURIComponent(n.instanceName)}`);
    if (qr.instance?.state === "open") return transition(n.id, { state: "open", manual: true });
    return transition(n.id, { state: "connecting", qr: { base64: qr.base64 ?? null, pairingCode: qr.pairingCode ?? null }, manual: true });
  } catch (err) {
    throw providerError(err);
  }
}

/** Encerra a sessao do WhatsApp (o numero sai dos aparelhos conectados). */
export async function logout(numberId: string): Promise<NumberRow> {
  const n = await loadNumber(numberId);
  try {
    await evolution("DELETE", `/instance/logout/${encodeURIComponent(n.instanceName)}`).catch((err: EvolutionError) => {
      // Ja desconectada (ou instancia inexistente): segue para marcar como fechada.
      if (err.status !== 400 && err.status !== 404) throw err;
    });
  } catch (err) {
    throw providerError(err);
  }
  return transition(n.id, { state: "close", manual: true });
}

/** Remove o numero: desconecta e apaga a instancia no Evolution (sobra de aparelho conectado nao fica). */
export async function removeNumber(numberId: string) {
  const n = await loadNumber(numberId);
  if (n.state !== "not_created") {
    await evolution("DELETE", `/instance/logout/${encodeURIComponent(n.instanceName)}`).catch(() => undefined);
    await evolution("DELETE", `/instance/delete/${encodeURIComponent(n.instanceName)}`).catch((err: EvolutionError) => {
      if (err.status !== 404 && err.status !== 400) throw providerError(err);
    });
  }
  await db.delete(schema.whatsappNumber).where(eq(schema.whatsappNumber.id, n.id));
}

/**
 * Um envio falhou com `Connection Closed`. Se o Evolution ainda diz `open`, a
 * sessao esta travada (o WhatsApp derrubou o socket e o Evolution nao
 * reconectou nem avisou): marca o numero como caido e reinicia o Evolution,
 * que volta sem QR com a sessao em disco. Se o Evolution ja sabe da queda, so
 * sincroniza o estado.
 */
export async function markStale(numberId: string): Promise<"restarted" | "throttled" | "disabled" | "failed" | "synced" | "not_open"> {
  const n = await loadNumber(numberId);
  if (n.state !== "open") return "not_open";
  const { state } = await fetchState(n);
  if (state !== "open") {
    await transition(n.id, { state });
    return "synced";
  }
  log(n, "sessão travada: estado open, envio diz conexão fechada");
  await transition(n.id, { state: "close", statusReason: STALE_SESSION_REASON });
  return autoRestart(n.id);
}

/**
 * Reinicia o Evolution no maximo uma vez a cada {@link RESTART_COOLDOWN_MS}
 * para todos os numeros. A reserva do intervalo e um UPDATE condicional: dois
 * envios falhando juntos nao reiniciam duas vezes.
 */
export async function autoRestart(numberId: string, now = new Date()) {
  if (!restartConfigured()) return "disabled" as const;
  const since = new Date(now.getTime() - RESTART_COOLDOWN_MS);
  const claimed = await db
    .update(schema.whatsappNumber)
    .set({ restartRequestedAt: now })
    .where(and(eq(schema.whatsappNumber.id, numberId), sql`not exists (select 1 from whatsapp_number where restart_requested_at > ${since})`))
    .returning({ id: schema.whatsappNumber.id });
  if (!claimed.length) return "throttled" as const;
  try {
    await restartEvolution();
  } catch (err) {
    console.error(`[whatsapp] falha ao reiniciar o Evolution: ${(err as Error).message}`);
    return "failed" as const;
  }
  console.warn("[whatsapp] Evolution reiniciado para recuperar sessão travada");
  return "restarted" as const;
}

/** Numeros com instancia viva (para a verificacao periodica). */
export async function monitoredNumbers() {
  return db
    .select({ id: schema.whatsappNumber.id })
    .from(schema.whatsappNumber)
    .where(inArray(schema.whatsappNumber.state, ["open", "connecting"]))
    .then((r) => r.map((x) => x.id));
}

/**
 * Depois de um reinicio do Evolution (ou do Studio), um numero que estava
 * `open` e agora aparece `close` sem QR ainda pode reconectar sozinho: a
 * verificacao continua olhando numeros fechados ha pouco (30 min).
 */
export async function recentlyClosed(now = new Date()) {
  return db
    .select({ id: schema.whatsappNumber.id })
    .from(schema.whatsappNumber)
    .where(and(eq(schema.whatsappNumber.state, "close"), gt(schema.whatsappNumber.disconnectedAt, new Date(now.getTime() - 30 * 60_000))))
    .then((r) => r.map((x) => x.id));
}

function providerError(err: unknown) {
  if (err instanceof HttpError) return err;
  const e = err as EvolutionError;
  return new HttpError(502, e.message.startsWith("Evolution") ? e.message : `Evolution: ${e.message}`);
}

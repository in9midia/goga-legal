import fs from "node:fs/promises";
import { and, asc, eq, inArray, isNotNull, isNull, lte, ne, notInArray, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { config } from "../config.js";
import { saveFile, type FileRow } from "../files/storage.js";
import { extractText } from "../files/extract.js";
import { cancelRun, isLive, startTurn } from "../engine/run.js";
import { CancelledError } from "../llm/call.js";
import { EvolutionError, evolution, isConnectionClosed } from "./evolution.js";
import { chunks, HELP_TEXT, isYes, parseCommand, resolveOption, toWhatsApp, withOptions } from "./format.js";
import type { InboundMessage } from "./parse.js";
import { loadNumber, markStale, monitoredNumbers, recentlyClosed, refresh, type NumberRow } from "./service.js";

/**
 * Fila do atendimento pelo WhatsApp. Tudo passa pelo banco, para que nada se
 * perca se o Studio ou o Evolution cairem:
 *
 *   webhook → whatsapp_inbound (pending) → turno do fluxo (processing) →
 *   whatsapp_outbound (pending) → Evolution (sent)
 *
 * - Uma conversa por contato, um turno por vez: mensagens que chegam durante o
 *   turno esperam e entram juntas no proximo. Mensagens seguidas (texto + foto +
 *   documento) sao agrupadas por {@link DEBOUNCE_MS}.
 * - O Studio caiu no meio do turno: no boot o run vira erro (reapOrphanRuns) e
 *   aqui as mensagens dele voltam para a fila e rodam de novo (uma vez).
 * - O Evolution caiu ou a sessao esta fechada: a resposta espera na fila e sai
 *   quando o numero reconecta (ate {@link OUTBOUND_MAX_AGE_MS}).
 */

const DEBOUNCE_MS = 2500;
const TICK_MS = 1500;
const MONITOR_MS = 60_000;
const PRESENCE_MS = 10_000;
const OUTBOUND_MAX_AGE_MS = 24 * 3600_000;
const OUTBOUND_MAX_ATTEMPTS = 8;
const MB = 1024 * 1024;
/** Tipos que o motor sabe ler (os mesmos do anexo do Simulador). */
const READABLE = /^(application\/pdf|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|text\/.*|image\/(png|jpe?g|webp))$/;
const RESTART_ERROR = "Execução interrompida: o servidor reiniciou";
const REQUEUED = "reexecutada após reinício";

type Contact = typeof schema.whatsappContact.$inferSelect;
type Inbound = typeof schema.whatsappInbound.$inferSelect;

const destination = (jid: string) => (jid.endsWith("@s.whatsapp.net") ? jid.split("@")[0]! : jid);

// ── Recebimento ─────────────────────────────────────────────────────────

/** Grava as mensagens do webhook (idempotente pelo id do WhatsApp). Devolve quantas eram novas. */
export async function receive(n: NumberRow, msgs: InboundMessage[]): Promise<number> {
  let fresh = 0;
  for (const m of msgs) {
    const now = new Date();
    const [contact] = await db
      .insert(schema.whatsappContact)
      .values({ numberId: n.id, jid: m.jid, phone: m.phone, name: m.pushName, lastInboundAt: now })
      .onConflictDoUpdate({
        target: [schema.whatsappContact.numberId, schema.whatsappContact.jid],
        set: { lastInboundAt: now, updatedAt: now, ...(m.phone && { phone: m.phone }), ...(m.pushName && { name: m.pushName }) },
      })
      .returning();
    const cmd = m.kind === "text" ? parseCommand(m.text) : null;
    const [row] = await db
      .insert(schema.whatsappInbound)
      .values({ numberId: n.id, contactId: contact.id, externalId: m.externalId, kind: m.kind, text: m.text, raw: m.raw, media: m.media, receivedAt: m.timestamp })
      .onConflictDoNothing()
      .returning();
    if (!row) continue;
    fresh++;
    // Comandos nao esperam o turno em andamento (que pode levar minutos).
    const running = !!contact.busyRunId && isLive(contact.busyRunId);
    if (cmd === "cancelar") {
      if (running) cancelRun(contact.busyRunId!);
      await db.update(schema.whatsappInbound).set({ status: "done" }).where(eq(schema.whatsappInbound.id, row.id));
      await enqueueText(n.id, contact, running ? "Ok, interrompi a resposta. Pode mandar a mensagem de novo quando quiser." : "Não há nenhuma resposta em preparo agora.");
    } else if (cmd === "ajuda") {
      await db.update(schema.whatsappInbound).set({ status: "done" }).where(eq(schema.whatsappInbound.id, row.id));
      await enqueueText(n.id, contact, HELP_TEXT);
    } else if (cmd === "nova" || cmd === "limpar") {
      // A resposta em preparo e da conversa que vai ser trocada ou apagada:
      // interrompe, e o comando roda assim que o turno fecha (em segundos).
      if (running) cancelRun(contact.busyRunId!);
    } else if (running && !waitNoticeSent.has(contact.busyRunId!)) {
      // Mensagem durante o turno: entra no proximo, e a pessoa fica sabendo.
      waitNoticeSent.add(contact.busyRunId!);
      await enqueueText(n.id, contact, "Recebi. Ainda estou terminando a resposta anterior; em seguida considero esta mensagem também.");
    }
  }
  if (fresh) kick();
  return fresh;
}

// ── Fila ────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let running = false;
let again = false;
let lastMonitor = 0;
let lastPresence = 0;

/** Pede uma volta da fila logo (webhook recebido, turno acabou). */
export function kick() {
  if (!timer) return;
  if (running) {
    again = true;
    return;
  }
  setImmediate(() => void tick());
}

export async function startWorker() {
  // Mensagem reivindicada mas que nao chegou a virar turno (o processo caiu entre um e outro).
  await db.update(schema.whatsappInbound).set({ status: "pending" }).where(and(eq(schema.whatsappInbound.status, "processing"), isNull(schema.whatsappInbound.runId)));
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  void tick();
}

export function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function tick() {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    do {
      again = false;
      await step("turnos encerrados", finalizeTurns);
      await step("mensagens recebidas", dispatchInbound);
      await step("envios", sendDue);
      const now = Date.now();
      if (now - lastPresence >= PRESENCE_MS) {
        lastPresence = now;
        await step("digitando", presence);
      }
      if (now - lastMonitor >= MONITOR_MS) {
        lastMonitor = now;
        await step("verificação das sessões", monitor);
      }
    } while (again);
  } finally {
    running = false;
  }
}

async function step(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    console.error(`[whatsapp] falha em ${name}: ${(err as Error).message}`);
  }
}

// ── Turnos ──────────────────────────────────────────────────────────────

async function dispatchInbound() {
  const ready = new Date(Date.now() - DEBOUNCE_MS);
  const contacts = await db
    .selectDistinct({ c: schema.whatsappContact })
    .from(schema.whatsappContact)
    .innerJoin(schema.whatsappInbound, eq(schema.whatsappInbound.contactId, schema.whatsappContact.id))
    .where(and(eq(schema.whatsappInbound.status, "pending"), isNull(schema.whatsappContact.busyRunId), lte(schema.whatsappContact.lastInboundAt, ready)))
    .limit(20);
  for (const { c } of contacts) await step(`contato ${c.id.slice(0, 8)}`, () => processContact(c));
}

async function processContact(contact: Contact) {
  const n = await loadNumber(contact.numberId);
  const items = await db
    .update(schema.whatsappInbound)
    .set({ status: "processing" })
    .where(and(eq(schema.whatsappInbound.contactId, contact.id), eq(schema.whatsappInbound.status, "pending")))
    .returning();
  if (!items.length) return;
  items.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime());
  const done = (ids: string[], error?: string) => (ids.length ? db.update(schema.whatsappInbound).set({ status: "done", ...(error && { error }) }).where(inArray(schema.whatsappInbound.id, ids)) : Promise.resolve());
  if (!n.enabled) {
    await db.update(schema.whatsappInbound).set({ status: "ignored" }).where(inArray(schema.whatsappInbound.id, items.map((i) => i.id)));
    return;
  }
  markRead(n, contact, items);

  let c = contact;
  const parts: Inbound[] = [];
  for (const it of items) {
    const cmd = it.kind === "text" ? parseCommand(it.text) : null;
    if (cmd) {
      c = await runCommand(n, c, cmd, items);
      await done([it.id]);
      continue;
    }
    // Confirmacao do /limpar.
    if (c.pendingCommand === "limpar" && it.kind === "text") {
      const answer = it.text.trim();
      [c] = await db.update(schema.whatsappContact).set({ pendingCommand: null }).where(eq(schema.whatsappContact.id, c.id)).returning();
      if (isYes(answer)) {
        await wipe(n, c, items.map((x) => x.id));
        return;
      }
      if (/^\s*(2|n[aã]o|n|cancela[r]?|deixa)\b[.!]*\s*$/i.test(answer)) {
        await done([it.id]);
        await enqueueText(n.id, c, "Tudo bem, nada foi apagado.");
        continue;
      }
    }
    parts.push(it);
  }
  if (!parts.length) return;

  // Sessao do contato (a primeira, ou a nova depois do /nova).
  const firstEver = !c.sessionId && !(await db.select({ id: schema.chatSession.id }).from(schema.chatSession).where(eq(schema.chatSession.whatsappContactId, c.id)).limit(1)).length;
  let sessionId = c.sessionId;
  if (!sessionId) {
    const [s] = await db
      .insert(schema.chatSession)
      .values({ title: `WhatsApp · ${c.name ?? c.phone ?? "contato"}`, flowId: n.flowId, useProduction: n.useProduction, whatsappContactId: c.id })
      .returning();
    sessionId = s.id;
    [c] = await db.update(schema.whatsappContact).set({ sessionId }).where(eq(schema.whatsappContact.id, c.id)).returning();
  }

  const texts: string[] = [];
  const files: FileRow[] = [];
  const notes: string[] = [];
  for (const it of parts) {
    if (it.kind === "text" || it.kind === "location" || it.kind === "contact") {
      if (it.text.trim()) texts.push(it.text.trim());
      continue;
    }
    if (it.kind === "image" || it.kind === "document") {
      const r = await downloadMedia(n, it, sessionId);
      if (r.file) files.push(r.file);
      if (r.note) notes.push(r.note);
      if (it.text.trim()) texts.push(it.text.trim());
      continue;
    }
    if (it.text.trim()) texts.push(it.text.trim());
    notes.push(
      it.kind === "audio"
        ? "Ainda não consigo ouvir áudios. Pode escrever a sua mensagem?"
        : it.kind === "video"
          ? "Ainda não consigo assistir vídeos. Se for um documento, mande como foto ou PDF."
          : it.kind === "sticker"
            ? ""
            : "Não consegui ler esse tipo de mensagem. Pode escrever?",
    );
  }
  for (const note of [...new Set(notes)].filter(Boolean)) await enqueueText(n.id, c, note);

  // Resposta curta a uma pergunta com opcoes ("2") vira o texto da opcao.
  if (texts.length === 1 && c.pendingOptions.length) {
    const opt = resolveOption(texts[0]!, c.pendingOptions);
    if (opt) texts[0] = opt;
  }
  let message = texts.join("\n\n");
  if (!message && files.length) message = files.length === 1 ? `Segue o arquivo ${files[0]!.name}.` : `Seguem os arquivos: ${files.map((f) => f.name).join(", ")}.`;
  const ids = parts.map((p) => p.id);
  if (!message) {
    await done(ids);
    return;
  }

  let runId: string;
  try {
    ({ runId } = await startTurn({
      user: null,
      sessionId,
      message: message.slice(0, 20000),
      fileIds: files.map((f) => f.id),
      target: { flowId: n.flowId, useProduction: n.useProduction, preferRelease: true },
    }));
  } catch (err) {
    console.error(`[whatsapp ${n.name}] turno não começou: ${(err as Error).message}`);
    await done(ids, (err as Error).message);
    await enqueueText(n.id, c, "Desculpe, o atendimento está indisponível agora. Tente de novo em alguns minutos.");
    return;
  }
  await db.update(schema.whatsappInbound).set({ runId }).where(inArray(schema.whatsappInbound.id, ids));
  await db.update(schema.whatsappContact).set({ busyRunId: runId, pendingOptions: [], updatedAt: new Date() }).where(eq(schema.whatsappContact.id, c.id));
  if (firstEver) firstContact.add(c.id);
  sendPresence(n, c.jid);
}

/** Contatos no primeiro turno da vida: a resposta ganha a dica do /ajuda. */
const firstContact = new Set<string>();

async function finalizeTurns() {
  const busy = await db.select().from(schema.whatsappContact).where(isNotNull(schema.whatsappContact.busyRunId));
  for (const c of busy) {
    const runId = c.busyRunId!;
    if (isLive(runId)) continue;
    const [run] = await db.select().from(schema.run).where(eq(schema.run.id, runId));
    const [answer] = await db
      .select()
      .from(schema.message)
      .where(and(eq(schema.message.runId, runId), eq(schema.message.role, "assistant")));
    // Fora do processo e ainda sem resposta gravada: so se o run sumiu ou fechou.
    if (run?.status === "running") continue;
    await step(`turno ${runId.slice(0, 8)}`, () => finalize(c, run ?? null, answer ?? null));
  }
}

async function finalize(c: Contact, run: typeof schema.run.$inferSelect | null, answer: typeof schema.message.$inferSelect | null) {
  const runId = c.busyRunId!;
  const n = await loadNumber(c.numberId);
  const items = await db.select().from(schema.whatsappInbound).where(eq(schema.whatsappInbound.runId, runId));
  const release = () => db.update(schema.whatsappContact).set({ busyRunId: null, updatedAt: new Date() }).where(eq(schema.whatsappContact.id, c.id));

  // O Studio reiniciou no meio do turno: roda de novo, uma vez, sem deixar o turno quebrado no historico.
  if (run?.error?.startsWith(RESTART_ERROR) && !items.some((i) => i.error === REQUEUED)) {
    await db.delete(schema.message).where(eq(schema.message.runId, runId));
    await db.update(schema.whatsappInbound).set({ status: "pending", runId: null, error: REQUEUED }).where(eq(schema.whatsappInbound.runId, runId));
    await release();
    console.warn(`[whatsapp ${n.name}] turno ${runId.slice(0, 8)} interrompido pelo reinício: na fila de novo`);
    return;
  }

  const payload = (answer?.payload ?? null) as { resposta_simples?: string; opcoes?: string[]; status?: string; documentos?: { fileId: string; name: string }[]; error?: string } | null;
  const cancelled = run?.error === new CancelledError().message;
  let options: string[] = [];
  await db.transaction(async (tx) => {
    if (!cancelled) {
      const ok = payload?.resposta_simples && payload.status !== "error" && !payload.error;
      let text = ok
        ? toWhatsApp(payload!.resposta_simples!)
        : "Desculpe, tive um problema para preparar a resposta. Pode mandar a mensagem de novo? Se preferir recomeçar, envie /nova.";
      options = ok ? (payload!.opcoes ?? []) : [];
      text = withOptions(text, options);
      if (firstContact.delete(c.id)) text += "\n\n_Dica: envie /ajuda para ver os comandos._";
      const rows = chunks(text).map((t) => ({ numberId: n.id, contactId: c.id, jid: c.jid, text: t, runId }));
      for (const d of payload?.documentos ?? []) rows.push({ numberId: n.id, contactId: c.id, jid: c.jid, text: "", runId, fileId: d.fileId } as (typeof rows)[number]);
      await tx.insert(schema.whatsappOutbound).values(rows);
    }
    await tx.update(schema.whatsappInbound).set({ status: "done" }).where(eq(schema.whatsappInbound.runId, runId));
    await tx.update(schema.whatsappContact).set({ busyRunId: null, pendingOptions: options, updatedAt: new Date() }).where(eq(schema.whatsappContact.id, c.id));
  });
  kick();
}

// ── Comandos ────────────────────────────────────────────────────────────

async function runCommand(n: NumberRow, c: Contact, cmd: ReturnType<typeof parseCommand>, _batch: Inbound[]): Promise<Contact> {
  if (cmd === "ajuda") {
    await enqueueText(n.id, c, HELP_TEXT);
    return c;
  }
  if (cmd === "nova") {
    const [row] = await db.update(schema.whatsappContact).set({ sessionId: null, pendingOptions: [], pendingCommand: null, updatedAt: new Date() }).where(eq(schema.whatsappContact.id, c.id)).returning();
    await enqueueText(n.id, row, "Pronto, comecei uma conversa nova. A anterior ficou guardada. Me conte o que aconteceu.");
    return row;
  }
  if (cmd === "limpar") {
    const [row] = await db.update(schema.whatsappContact).set({ pendingCommand: "limpar", updatedAt: new Date() }).where(eq(schema.whatsappContact.id, c.id)).returning();
    await enqueueText(n.id, row, withOptions("Isso apaga *todas* as suas conversas e arquivos enviados aqui, e não dá para desfazer. Quer mesmo apagar?", ["Sim, apagar tudo", "Não"]));
    return row;
  }
  return c; // cancelar: tratado no recebimento
}

/** /limpar confirmado: apaga conversas, execucoes, arquivos (do disco tambem) e mensagens do contato. */
async function wipe(n: NumberRow, c: Contact, keepIds: string[]) {
  const sessions = await db.select({ id: schema.chatSession.id }).from(schema.chatSession).where(eq(schema.chatSession.whatsappContactId, c.id));
  const sids = sessions.map((s) => s.id);
  if (sids.length) {
    const files = await db.select({ path: schema.file.path }).from(schema.file).where(inArray(schema.file.sessionId, sids));
    for (const f of files) await fs.rm(f.path, { force: true });
    await db.delete(schema.run).where(inArray(schema.run.sessionId, sids));
    await db.delete(schema.chatSession).where(inArray(schema.chatSession.id, sids));
  }
  await db.delete(schema.whatsappInbound).where(and(eq(schema.whatsappInbound.contactId, c.id), notInArray(schema.whatsappInbound.id, keepIds)));
  await db.update(schema.whatsappInbound).set({ status: "done", text: "", raw: null }).where(inArray(schema.whatsappInbound.id, keepIds));
  await db.delete(schema.whatsappOutbound).where(and(eq(schema.whatsappOutbound.contactId, c.id), ne(schema.whatsappOutbound.status, "pending")));
  const [row] = await db.update(schema.whatsappContact).set({ sessionId: null, pendingOptions: [], pendingCommand: null, updatedAt: new Date() }).where(eq(schema.whatsappContact.id, c.id)).returning();
  console.warn(`[whatsapp ${n.name}] contato ${c.id.slice(0, 8)} apagou tudo (${sids.length} conversa(s))`);
  await enqueueText(n.id, row, "Pronto: apaguei todas as suas conversas e arquivos. Quando quiser, é só mandar uma mensagem para começar de novo.");
}

// ── Midia ───────────────────────────────────────────────────────────────

async function downloadMedia(n: NumberRow, it: Inbound, sessionId: string): Promise<{ file?: FileRow; note?: string }> {
  const media = it.media ?? { mime: "application/octet-stream" };
  const ext: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx" };
  let mime = media.mime;
  const name = media.filename || `${it.kind === "image" ? "foto" : "documento"}-${it.receivedAt.toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${ext[mime] ?? "bin"}`;
  if (mime === "application/octet-stream" && name.toLowerCase().endsWith(".docx")) mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (mime === "application/octet-stream" && name.toLowerCase().endsWith(".pdf")) mime = "application/pdf";
  if (!READABLE.test(mime)) return { note: `Não consigo ler o arquivo "${name}" (${mime}). Mande em PDF, Word (.docx) ou como foto.` };
  const max = config.maxAttachMb * MB;
  if (media.size && media.size > max) return { note: `O arquivo "${name}" passa do limite de ${config.maxAttachMb} MB.` };
  let data: Buffer;
  try {
    const res = await evolution<{ base64: string; mimetype?: string }>(
      "POST",
      `/chat/getBase64FromMediaMessage/${encodeURIComponent(n.instanceName)}`,
      { message: it.raw ?? { key: { id: it.externalId } }, convertToMp4: false },
      120_000,
    );
    data = Buffer.from(res.base64, "base64");
  } catch (err) {
    console.warn(`[whatsapp ${n.name}] falha ao baixar a mídia ${it.externalId}: ${(err as Error).message}`);
    return { note: `Não consegui baixar o arquivo "${name}". Pode mandar de novo?` };
  }
  if (data.length > max) return { note: `O arquivo "${name}" passa do limite de ${config.maxAttachMb} MB.` };
  const file = await saveFile({ sessionId, direction: "in", name, mime, data });
  const ex = await extractText(data, mime, name, null);
  await db.update(schema.file).set({ extractedText: ex.text }).where(eq(schema.file.id, file.id));
  return { file: { ...file, extractedText: ex.text }, ...(ex.warning && !ex.text && { note: `Recebi "${name}", mas não consegui ler o conteúdo (${ex.warning}).` }) };
}

// ── Envio ───────────────────────────────────────────────────────────────

export async function enqueueText(numberId: string, c: Pick<Contact, "id" | "jid">, text: string) {
  await db.insert(schema.whatsappOutbound).values(chunks(text).map((t) => ({ numberId, contactId: c.id, jid: c.jid, text: t })));
  kick();
}

/**
 * Envia o que esta vencido, em ordem por contato: so a mensagem mais antiga
 * pendente de cada conversa sai; se ela falhar, as seguintes esperam.
 */
async function sendDue() {
  const now = new Date();
  const due = await db
    .select()
    .from(schema.whatsappOutbound)
    .where(
      and(
        eq(schema.whatsappOutbound.status, "pending"),
        lte(schema.whatsappOutbound.nextAttemptAt, now),
        sql`not exists (select 1 from whatsapp_outbound o where o.status = 'pending' and o.number_id = ${schema.whatsappOutbound.numberId} and o.jid = ${schema.whatsappOutbound.jid} and (o.created_at, o.id) < (${schema.whatsappOutbound.createdAt}, ${schema.whatsappOutbound.id}))`,
      ),
    )
    .orderBy(asc(schema.whatsappOutbound.createdAt))
    .limit(20);
  const numbers = new Map<string, NumberRow>();
  for (const o of due) {
    const n = numbers.get(o.numberId) ?? (await loadNumber(o.numberId).catch(() => null));
    if (!n) continue;
    numbers.set(n.id, n);
    await sendOne(n, o, now);
    if (due.length > 1) kick();
  }
}

async function sendOne(n: NumberRow, o: typeof schema.whatsappOutbound.$inferSelect, now: Date) {
  const tooOld = now.getTime() - o.createdAt.getTime() > OUTBOUND_MAX_AGE_MS;
  const later = (ms: number, error: string | null, countAttempt: boolean) =>
    db
      .update(schema.whatsappOutbound)
      .set({ nextAttemptAt: new Date(now.getTime() + ms), error, ...(countAttempt && { attempts: o.attempts + 1 }) })
      .where(eq(schema.whatsappOutbound.id, o.id));
  const fail = (error: string) => db.update(schema.whatsappOutbound).set({ status: "failed", error, attempts: o.attempts + 1 }).where(eq(schema.whatsappOutbound.id, o.id));

  // Sessao fora: espera reconectar (sem gastar tentativa), ate a idade maxima.
  if (n.state !== "open") {
    if (tooOld) return fail(`número desconectado há mais de 24 h (${n.state})`);
    return later(30_000, `aguardando o número reconectar (${n.state})`, false);
  }
  const path = (p: string) => `/message/${p}/${encodeURIComponent(n.instanceName)}`;
  const number = destination(o.jid);
  try {
    let res: { key?: { id?: string } };
    if (o.fileId) {
      const [f] = await db.select().from(schema.file).where(eq(schema.file.id, o.fileId));
      if (!f) return fail("arquivo não existe mais");
      const data = await fs.readFile(f.path);
      res = await evolution(
        "POST",
        path("sendMedia"),
        { number, mediatype: f.mime.startsWith("image/") ? "image" : "document", mimetype: f.mime, media: data.toString("base64"), fileName: f.name, ...(o.text && { caption: o.text }) },
        120_000,
      );
    } else {
      res = await evolution("POST", path("sendText"), { number, text: o.text, linkPreview: false });
    }
    await db
      .update(schema.whatsappOutbound)
      .set({ status: "sent", sentAt: new Date(), externalId: res.key?.id ?? null, error: null, attempts: o.attempts + 1 })
      .where(eq(schema.whatsappOutbound.id, o.id));
  } catch (err) {
    const e = err as EvolutionError;
    if (isConnectionClosed(e)) {
      const r = await markStale(n.id).catch(() => "failed");
      console.warn(`[whatsapp ${n.name}] envio com a conexão fechada → ${r}`);
      return later(30_000, e.message, false);
    }
    if (tooOld || (!e.retryable && o.attempts + 1 >= 3) || o.attempts + 1 >= OUTBOUND_MAX_ATTEMPTS * 4) return fail(e.message);
    // 5 s, 10 s, 20 s... ate 5 min.
    return later(Math.min(5_000 * 2 ** o.attempts, 300_000), e.message, true);
  }
}

function markRead(n: NumberRow, c: Contact, items: Inbound[]) {
  const readMessages = items.map((i) => ({ remoteJid: c.jid, fromMe: false, id: i.externalId }));
  void evolution("POST", `/chat/markMessageAsRead/${encodeURIComponent(n.instanceName)}`, { readMessages }).catch(() => undefined);
}

/** "digitando..." enquanto o turno roda. O Evolution segura a chamada pelo `delay`. */
function sendPresence(n: NumberRow, jid: string) {
  if (n.state !== "open") return;
  void evolution("POST", `/chat/sendPresence/${encodeURIComponent(n.instanceName)}`, { number: destination(jid), presence: "composing", delay: PRESENCE_MS + 2000 }, PRESENCE_MS + 10_000).catch(() => undefined);
}

/** Turnos que ja ganharam o aviso de "estou analisando" / "recebi, espere". */
const progressSent = new Set<string>();
const waitNoticeSent = new Set<string>();
/** Turno mais longo que isto ganha um aviso (o fluxo completo leva minutos). */
const PROGRESS_AFTER_MS = 20_000;

async function presence() {
  const busy = await db
    .select({ c: schema.whatsappContact, n: schema.whatsappNumber, startedAt: schema.run.startedAt })
    .from(schema.whatsappContact)
    .innerJoin(schema.whatsappNumber, eq(schema.whatsappNumber.id, schema.whatsappContact.numberId))
    .innerJoin(schema.run, eq(schema.run.id, schema.whatsappContact.busyRunId))
    .where(isNotNull(schema.whatsappContact.busyRunId));
  for (const { c, n, startedAt } of busy) {
    const runId = c.busyRunId!;
    if (!isLive(runId)) continue;
    sendPresence(n, c.jid);
    if (!progressSent.has(runId) && !waitNoticeSent.has(runId) && Date.now() - startedAt.getTime() > PROGRESS_AFTER_MS) {
      progressSent.add(runId);
      await enqueueText(n.id, c, "Estou analisando o seu caso com cuidado. A resposta completa pode levar alguns minutos; aviso assim que estiver pronta.");
    }
  }
  if (progressSent.size > 500) progressSent.clear();
  if (waitNoticeSent.size > 500) waitNoticeSent.clear();
}

// ── Verificacao periodica ───────────────────────────────────────────────

async function monitor() {
  const ids = [...new Set([...(await monitoredNumbers()), ...(await recentlyClosed())])];
  for (const id of ids) await step(`sessão ${id.slice(0, 8)}`, () => refresh(id));
}

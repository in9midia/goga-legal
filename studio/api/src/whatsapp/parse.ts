/**
 * Webhooks do Evolution API v2 → eventos do Studio. Portado do parser do In9
 * CRM, so com o que o atendimento usa: mensagem recebida (texto, midia,
 * localizacao, contato, resposta de botao/lista), conexao e QR code.
 *
 * - Grupos, status@broadcast e mensagens enviadas pelo proprio numero (fromMe)
 *   sao ignorados: o Goga atende conversas individuais.
 * - LID (`<id>@lid`): o destino da resposta e o proprio JID; o telefone vem em
 *   `senderPn` / `remoteJidAlt` quando o WhatsApp informa.
 */

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface EvolutionEnvelope {
  event: string;
  instance: string;
  apikey?: string;
  data: Loose;
}

export type InboundKind = "text" | "image" | "document" | "audio" | "video" | "sticker" | "location" | "contact" | "other";

export interface InboundMessage {
  externalId: string;
  jid: string;
  phone: string | null;
  pushName: string | null;
  kind: InboundKind;
  text: string;
  media: { mime: string; filename?: string; size?: number } | null;
  /** key + message: o Evolution so baixa a midia com eles (nao guarda mensagens). */
  raw: { key: Loose; message: Loose } | null;
  timestamp: Date;
}

export interface ConnectionSignal {
  type: "connection";
  state: string;
  statusReason: number | null;
  wuid: string | null;
  profileName: string | null;
}
export interface QrSignal {
  type: "qrcode";
  base64: string | null;
  pairingCode: string | null;
}

/** `MESSAGES_UPSERT`, `messages.upsert` e `messages-upsert` sao o mesmo evento. */
export const eventName = (e: unknown) =>
  String(e ?? "")
    .toLowerCase()
    .replace(/[_-]/g, ".");

export function parseEnvelope(body: unknown): EvolutionEnvelope {
  const json = (typeof body === "string" ? JSON.parse(body) : body) as Loose;
  if (!json || typeof json !== "object") throw new Error("webhook vazio");
  return {
    event: eventName(json.event),
    instance: String(json.instance ?? ""),
    apikey: typeof json.apikey === "string" ? json.apikey : undefined,
    data: (json.data ?? {}) as Loose,
  };
}

const userOf = (jid: string) => jid.split("@")[0]!.split(":")[0]!;
const isPhoneJid = (jid: string) => /@(s\.whatsapp\.net|c\.us)$/.test(jid);
export const isGroupJid = (jid: string) => jid.endsWith("@g.us");
const num = (v: unknown) => Number(typeof v === "object" && v !== null ? (v as Loose).low : v);

function unwrap(message: Loose): Loose {
  // Mensagens temporarias / de visualizacao unica / documento com legenda vem embrulhadas.
  return (
    message?.ephemeralMessage?.message ??
    message?.viewOnceMessage?.message ??
    message?.viewOnceMessageV2?.message ??
    message?.documentWithCaptionMessage?.message ??
    message ??
    {}
  );
}

const MEDIA_KEYS: Record<string, InboundKind> = {
  imageMessage: "image",
  documentMessage: "document",
  audioMessage: "audio",
  videoMessage: "video",
  stickerMessage: "sticker",
};

export function messageOf(d: Loose): InboundMessage | null {
  const key = (d.key ?? {}) as Loose;
  const jid = String(key.remoteJid ?? "");
  if (!jid || !key.id) return null;
  if (jid === "status@broadcast" || isGroupJid(jid) || jid.endsWith("@newsletter") || jid.endsWith("@broadcast")) return null;
  if (key.fromMe) return null;
  const pnJid = (key.senderPn ?? key.remoteJidAlt ?? (isPhoneJid(jid) ? jid : null)) as string | null;
  const digits = pnJid ? userOf(pnJid).replace(/\D/g, "") : "";
  const m = unwrap((d.message ?? {}) as Loose);
  // Edicao, apagar, reacao e outras mensagens de protocolo nao viram turno.
  if (m.protocolMessage || m.editedMessage || m.reactionMessage || m.pollUpdateMessage || (m.senderKeyDistributionMessage && Object.keys(m).length === 1)) return null;
  const ts = num(d.messageTimestamp);
  const base: InboundMessage = {
    externalId: String(key.id),
    jid,
    phone: digits ? `+${digits}` : null,
    pushName: typeof d.pushName === "string" && d.pushName ? d.pushName.slice(0, 200) : null,
    kind: "text",
    text: "",
    media: null,
    raw: null,
    timestamp: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : new Date(),
  };
  const mediaKey = Object.keys(MEDIA_KEYS).find((k) => m[k]);
  if (typeof m.conversation === "string") return { ...base, text: m.conversation };
  if (m.extendedTextMessage) return { ...base, text: String(m.extendedTextMessage.text ?? "") };
  if (mediaKey) {
    const mm = m[mediaKey] as Loose;
    return {
      ...base,
      kind: MEDIA_KEYS[mediaKey]!,
      text: mm.caption ? String(mm.caption) : "",
      media: {
        mime: String(mm.mimetype ?? "application/octet-stream").split(";")[0]!.trim(),
        ...(mm.fileName && { filename: String(mm.fileName) }),
        ...(mm.fileLength && { size: num(mm.fileLength) }),
      },
      raw: { key, message: d.message as Loose },
    };
  }
  if (m.locationMessage || m.liveLocationMessage) {
    const l = (m.locationMessage ?? m.liveLocationMessage) as Loose;
    const where = [l.name, l.address].filter(Boolean).join(" — ");
    return { ...base, kind: "location", text: `Localização: ${where ? `${where} ` : ""}(${l.degreesLatitude}, ${l.degreesLongitude})` };
  }
  if (m.contactMessage || m.contactsArrayMessage) {
    const list = (m.contactMessage ? [m.contactMessage] : (m.contactsArrayMessage.contacts ?? [])) as Loose[];
    return { ...base, kind: "contact", text: `Contato compartilhado: ${list.map((c) => c.displayName).filter(Boolean).join("; ")}` };
  }
  if (m.buttonsResponseMessage || m.templateButtonReplyMessage) {
    const b = (m.buttonsResponseMessage ?? m.templateButtonReplyMessage) as Loose;
    return { ...base, text: String(b.selectedDisplayText ?? b.selectedButtonId ?? "") };
  }
  if (m.listResponseMessage) {
    const l = m.listResponseMessage as Loose;
    return { ...base, text: String(l.title ?? l.singleSelectReply?.selectedRowId ?? "") };
  }
  return { ...base, kind: "other", text: "" };
}

export interface ParsedWebhook {
  messages: InboundMessage[];
  signal: ConnectionSignal | QrSignal | null;
}

export function parseWebhook(env: EvolutionEnvelope): ParsedWebhook {
  const d = env.data;
  switch (env.event) {
    case "messages.upsert": {
      // Em sincronizacao pode vir uma lista (`data.messages`) ou um array.
      const list = Array.isArray(d) ? (d as Loose[]) : Array.isArray(d.messages) ? (d.messages as Loose[]) : [d];
      return { messages: list.map(messageOf).filter((x): x is InboundMessage => !!x), signal: null };
    }
    case "connection.update":
      return {
        messages: [],
        signal: {
          type: "connection",
          state: String(d.state ?? ""),
          statusReason: d.statusReason !== undefined && d.statusReason !== null ? Number(d.statusReason) : null,
          wuid: (d.wuid as string | undefined) ?? null,
          profileName: (d.profileName as string | undefined) ?? null,
        },
      };
    case "qrcode.updated":
      return {
        messages: [],
        signal: { type: "qrcode", base64: (d.qrcode?.base64 as string | undefined) ?? null, pairingCode: (d.qrcode?.pairingCode as string | undefined) ?? null },
      };
    default:
      return { messages: [], signal: null };
  }
}

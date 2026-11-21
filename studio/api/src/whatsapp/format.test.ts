import { describe, expect, it } from "vitest";
import { chunks, isYes, parseCommand, resolveOption, toWhatsApp, withOptions } from "./format.js";
import { messageOf, parseEnvelope, parseWebhook } from "./parse.js";

describe("toWhatsApp", () => {
  it("converte negrito, títulos, listas e links", () => {
    const md = "## Seus direitos\n\n**Importante:** veja\n- item um\n* item dois\n\n[CDC](https://planalto.gov.br/cdc)\n\n---";
    expect(toWhatsApp(md)).toBe("*Seus direitos*\n\n*Importante:* veja\n• item um\n• item dois\n\nCDC (https://planalto.gov.br/cdc)");
  });
});

describe("opções", () => {
  const ops = ["Sim, tenho o contrato", "Não tenho", "Não sei"];
  it("lista numerada no fim", () => {
    expect(withOptions("Você tem o contrato?", ops)).toContain("*2.* Não tenho");
  });
  it("número ou texto exato viram a opção", () => {
    expect(resolveOption("2", ops)).toBe("Não tenho");
    expect(resolveOption(" opção 3 ", ops)).toBe("Não sei");
    expect(resolveOption("1.", ops)).toBe("Sim, tenho o contrato");
    expect(resolveOption("não sei", ops)).toBe("Não sei");
    expect(resolveOption("4", ops)).toBeNull();
    expect(resolveOption("2 anos atrás", ops)).toBeNull();
    expect(resolveOption("2", [])).toBeNull();
  });
});

describe("comandos", () => {
  it("só com prefixo", () => {
    expect(parseCommand("/nova")).toBe("nova");
    expect(parseCommand("#limpar tudo")).toBe("limpar");
    expect(parseCommand("!AJUDA")).toBe("ajuda");
    expect(parseCommand("/cancelar")).toBe("cancelar");
    expect(parseCommand("quero limpar meu nome")).toBeNull();
    expect(parseCommand("nova")).toBeNull();
    expect(parseCommand("/xyz")).toBeNull();
  });
  it("confirmação", () => {
    expect(isYes("1")).toBe(true);
    expect(isYes("Sim!")).toBe(true);
    expect(isYes("2")).toBe(false);
    expect(isYes("não")).toBe(false);
  });
});

describe("chunks", () => {
  it("quebra entre parágrafos sem perder texto", () => {
    const p = "a".repeat(3000);
    const out = chunks(`${p}\n\n${p}`);
    expect(out).toHaveLength(2);
    expect(out.join("")).toBe(p + p);
  });
});

describe("parser do webhook", () => {
  const up = (data: unknown) => parseWebhook(parseEnvelope({ event: "messages.upsert", instance: "goga-x", apikey: "k", data }));

  it("texto com LID e telefone alternativo", () => {
    const r = up({ key: { id: "A1", remoteJid: "123@lid", fromMe: false, senderPn: "5511999990000@s.whatsapp.net" }, pushName: "Ana", message: { conversation: "oi" }, messageTimestamp: 1700000000 });
    expect(r.messages[0]).toMatchObject({ externalId: "A1", jid: "123@lid", phone: "+5511999990000", pushName: "Ana", kind: "text", text: "oi" });
  });

  it("ignora grupo, fromMe, status e protocolo", () => {
    expect(up({ key: { id: "1", remoteJid: "1@g.us" }, message: { conversation: "x" } }).messages).toHaveLength(0);
    expect(up({ key: { id: "2", remoteJid: "5511@s.whatsapp.net", fromMe: true }, message: { conversation: "x" } }).messages).toHaveLength(0);
    expect(up({ key: { id: "3", remoteJid: "status@broadcast" }, message: { conversation: "x" } }).messages).toHaveLength(0);
    expect(up({ key: { id: "4", remoteJid: "5511@s.whatsapp.net" }, message: { protocolMessage: { type: 0 } } }).messages).toHaveLength(0);
  });

  it("documento com legenda guarda key+message para baixar", () => {
    const message = { documentWithCaptionMessage: { message: { documentMessage: { mimetype: "application/pdf", fileName: "contrato.pdf", caption: "meu contrato", fileLength: { low: 1234 } } } } };
    const r = up({ key: { id: "D1", remoteJid: "5511988887777@s.whatsapp.net" }, message });
    expect(r.messages[0]).toMatchObject({ kind: "document", text: "meu contrato", media: { mime: "application/pdf", filename: "contrato.pdf", size: 1234 }, phone: "+5511988887777" });
    expect(r.messages[0]!.raw).toEqual({ key: { id: "D1", remoteJid: "5511988887777@s.whatsapp.net" }, message });
  });

  it("conexão e QR", () => {
    expect(parseWebhook(parseEnvelope({ event: "CONNECTION_UPDATE", instance: "i", data: { state: "open", wuid: "5511@s.whatsapp.net", statusReason: 200 } })).signal).toMatchObject({ type: "connection", state: "open", statusReason: 200 });
    expect(parseWebhook(parseEnvelope({ event: "qrcode.updated", instance: "i", data: { qrcode: { base64: "data:x" } } })).signal).toMatchObject({ type: "qrcode", base64: "data:x" });
  });

  it("mensagem sem key é descartada", () => {
    expect(messageOf({ message: { conversation: "x" } })).toBeNull();
  });
});

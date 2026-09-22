import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";

// AES-256-GCM, mesmo desenho do ADR-0009 da KB: a chave de API so existe em
// claro na memoria do processo, e a API devolve apenas os 4 ultimos caracteres.
function key(): Buffer {
  // Hash da variavel em vez de exigir 64 hex exatos: um segredo colado com
  // espaco ou em base64 funciona igual, e o tamanho da chave fica garantido.
  return createHash("sha256").update(config.secretKey()).digest();
}

export function encrypt(plain: string): string {
  if (!plain) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(":");
}

export function decrypt(payload: string): string {
  if (!payload) return "";
  const [version, iv, tag, data] = payload.split(":");
  if (version !== "v1") throw new Error("formato de credencial desconhecido");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

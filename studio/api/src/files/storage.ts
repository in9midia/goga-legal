import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { HttpError } from "../lib/errors.js";
import { config } from "../config.js";

export type FileRow = typeof schema.file.$inferSelect;

// Volume local (decisao D4). O nome no disco e o id, nunca o nome enviado:
// nome de arquivo do usuario com "../" ou acento quebrado nao pode virar caminho.
export async function saveFile(args: {
  sessionId: string | null;
  runId?: string | null;
  direction: "in" | "out";
  name: string;
  mime: string;
  data: Buffer;
  extractedText?: string | null;
}): Promise<FileRow> {
  const id = randomUUID();
  const dir = path.resolve(config.filesDir, args.direction);
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, id);
  await fs.writeFile(p, args.data);
  return insertFile({ ...args, id, path: p, size: args.data.length, sha256: createHash("sha256").update(args.data).digest("hex") });
}

/**
 * Grava um upload direto do stream para o disco, com hash e tamanho calculados
 * no caminho. Arquivo de centenas de MB nao pode passar por um Buffer: o pod da
 * API tem pouca memoria. Se o stream falhar (ex.: passou do limite do
 * multipart), o arquivo parcial e apagado e o erro sobe.
 */
export async function saveFileStream(args: { sessionId: string | null; direction: "in" | "out"; name: string; mime: string; stream: Readable }): Promise<FileRow> {
  const id = randomUUID();
  const dir = path.resolve(config.filesDir, args.direction);
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, id);
  const hash = createHash("sha256");
  let size = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      size += chunk.length;
      cb(null, chunk);
    },
  });
  try {
    await pipeline(args.stream, tap, createWriteStream(p));
  } catch (err) {
    await fs.rm(p, { force: true });
    throw err;
  }
  return insertFile({ ...args, id, path: p, size, sha256: hash.digest("hex") });
}

/** Upload multipart → disco, com o teto em bytes. Passou do teto: 413, sem sobra no disco. */
export async function saveUpload(
  part: { file: Readable & { truncated?: boolean }; filename: string },
  args: { sessionId: string | null; mime: string },
  maxBytes: number,
): Promise<FileRow> {
  const tooBig = () => new HttpError(413, `arquivo acima de ${Math.round(maxBytes / 1048576)} MB`);
  let row: FileRow;
  try {
    row = await saveFileStream({ ...args, direction: "in", name: part.filename, stream: part.file });
  } catch (err) {
    if (part.file.truncated || (err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") throw tooBig();
    throw err;
  }
  if (part.file.truncated) {
    await deleteFile(row);
    throw tooBig();
  }
  return row;
}

export async function deleteFile(row: FileRow) {
  await db.delete(schema.file).where(eq(schema.file.id, row.id));
  await fs.rm(row.path, { force: true });
}

async function insertFile(args: { id: string; sessionId: string | null; runId?: string | null; direction: "in" | "out"; name: string; mime: string; path: string; size: number; sha256: string; extractedText?: string | null }): Promise<FileRow> {
  const { id, path: p } = args;
  const [row] = await db
    .insert(schema.file)
    .values({
      id,
      sessionId: args.sessionId,
      runId: args.runId ?? null,
      direction: args.direction,
      name: args.name.replace(/[/\\]/g, "_").slice(0, 200),
      mime: args.mime,
      size: args.size,
      sha256: args.sha256,
      path: p,
      extractedText: args.extractedText ?? null,
    })
    .returning();
  return row;
}

export const readFileData = (row: FileRow) => fs.readFile(row.path);
export const readFileStream = (row: FileRow) => createReadStream(row.path);

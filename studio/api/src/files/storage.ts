import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { db, schema } from "../db/index.js";
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
  const [row] = await db
    .insert(schema.file)
    .values({
      id,
      sessionId: args.sessionId,
      runId: args.runId ?? null,
      direction: args.direction,
      name: args.name.replace(/[/\\]/g, "_").slice(0, 200),
      mime: args.mime,
      size: args.data.length,
      sha256: createHash("sha256").update(args.data).digest("hex"),
      path: p,
      extractedText: args.extractedText ?? null,
    })
    .returning();
  return row;
}

export const readFileData = (row: FileRow) => fs.readFile(row.path);

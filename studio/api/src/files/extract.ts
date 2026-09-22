import { generateText } from "ai";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { db, schema } from "../db/index.js";
import { costOf, defaultModelId, resolveModel } from "../llm/models.js";

const MAX_CHARS = 60_000;

export interface Extraction {
  text: string;
  method: string;
  warning?: string;
}

// PDF com menos texto que isto por pagina e tratado como escaneado. Um contrato
// digitalizado devolve 0-20 caracteres por pagina (so o carimbo do scanner); um
// PDF nativo curto passa facilmente de 200.
const MIN_CHARS_PER_PAGE = 80;

export async function extractText(data: Buffer, mime: string, name: string, userId: string | null): Promise<Extraction> {
  // Arquivo corrompido (ou com extensao trocada) vira aviso no anexo, e nao erro
  // 500 no upload: o operador ainda pode mandar a pergunta sem o texto dele.
  try {
    return await extractInner(data, mime, name, userId);
  } catch (err) {
    return { text: "", method: "nenhum", warning: `não foi possível ler o arquivo: ${(err as Error).message.slice(0, 160)}` };
  }
}

async function extractInner(data: Buffer, mime: string, name: string, userId: string | null): Promise<Extraction> {
  const lower = name.toLowerCase();
  if (mime === "application/pdf" || lower.endsWith(".pdf")) {
    const parser = new PDFParse({ data: new Uint8Array(data) });
    try {
      const r = await parser.getText();
      const pages = Math.max(1, (r as { total?: number }).total ?? 1);
      const text = r.text.trim();
      if (text.length / pages >= MIN_CHARS_PER_PAGE) return { text: text.slice(0, MAX_CHARS), method: "pdf-parse" };
      return visionExtract(data, "application/pdf", userId, "PDF sem camada de texto (escaneado)");
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  }
  if (lower.endsWith(".docx") || mime.includes("wordprocessingml")) {
    const r = await mammoth.extractRawText({ buffer: data });
    return { text: r.value.trim().slice(0, MAX_CHARS), method: "mammoth" };
  }
  if (mime.startsWith("text/") || /\.(txt|md|csv|json)$/.test(lower)) {
    return { text: data.toString("utf8").slice(0, MAX_CHARS), method: "texto" };
  }
  if (mime.startsWith("image/")) return visionExtract(data, mime, userId, "imagem");
  return { text: "", method: "nenhum", warning: `tipo não suportado: ${mime}` };
}

async function visionExtract(data: Buffer, mime: string, userId: string | null, what: string): Promise<Extraction> {
  const id = await defaultModelId("vision");
  if (!id) return { text: "", method: "nenhum", warning: `${what}: nenhum modelo de visão padrão cadastrado` };
  try {
    const m = await resolveModel(id);
    const r = await generateText({
      model: m.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Transcreva fielmente todo o texto deste documento, em português, preservando a estrutura (títulos, cláusulas, tabelas em Markdown). Não resuma nem comente." },
            { type: "file", data, mediaType: mime },
          ],
        },
      ],
      maxRetries: 1,
      timeout: 120000,
    });
    const tin = r.totalUsage.inputTokens ?? 0;
    const tout = r.totalUsage.outputTokens ?? 0;
    await db.insert(schema.usage).values({
      userId,
      providerId: m.provider.id,
      modelId: m.row.id,
      operation: "vision",
      nodeName: "Extração de anexo",
      tokensIn: tin,
      tokensOut: tout,
      costUsd: costOf(m.row, tin, tout, 0),
    });
    return { text: r.text.slice(0, MAX_CHARS), method: `visão (${m.row.label})` };
  } catch (err) {
    return { text: "", method: "nenhum", warning: `${what}: falha na extração por visão (${(err as Error).message})` };
  }
}

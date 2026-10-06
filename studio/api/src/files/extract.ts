import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { generateText } from "ai";
import mammoth from "mammoth";
import { PDFParse, type LoadParameters } from "pdf-parse";
import { PDFDataRangeTransport } from "pdfjs-dist/legacy/build/pdf.mjs";
import { db, schema } from "../db/index.js";
import { costOf, defaultModelId, resolveModel } from "../llm/models.js";

const MAX_CHARS = 60_000;
// Ate aqui o arquivo e lido inteiro para a memoria (DOCX, imagem, PDF escaneado
// que vai para o modelo de visao). Acima disto so se le do disco o necessario:
// o pod da API tem pouca memoria e o anexo do simulador chega a centenas de MB.
export const MAX_BUFFERED = 25 * 1024 * 1024;

export interface Extraction {
  text: string;
  method: string;
  warning?: string;
}

// PDF com menos texto que isto por pagina e tratado como escaneado. Um contrato
// digitalizado devolve 0-20 caracteres por pagina (so o carimbo do scanner); um
// PDF nativo curto passa facilmente de 200.
const MIN_CHARS_PER_PAGE = 80;
// Depois de tantas paginas sem texto, o PDF e dado como escaneado sem ler o
// resto: cada pagina digitalizada lida puxa a imagem dela inteira do disco.
const SCAN_PROBE_PAGES = 30;

export async function extractText(data: Buffer, mime: string, name: string, userId: string | null): Promise<Extraction> {
  // Arquivo corrompido (ou com extensao trocada) vira aviso no anexo, e nao erro
  // 500 no upload: o operador ainda pode mandar a pergunta sem o texto dele.
  try {
    return await extractInner(data, mime, name, userId);
  } catch (err) {
    return { text: "", method: "nenhum", warning: `não foi possível ler o arquivo: ${(err as Error).message.slice(0, 160)}` };
  }
}

/**
 * Extrai o texto de um arquivo ja gravado no disco. Arquivo pequeno segue o
 * caminho de sempre (em memoria); o grande e lido por trechos, entao um PDF de
 * centenas de MB nao vira um Buffer do mesmo tamanho.
 */
export async function extractFile(file: { path: string; size: number }, mime: string, name: string, userId: string | null): Promise<Extraction> {
  if (file.size <= MAX_BUFFERED) return extractText(await fs.readFile(file.path), mime, name, userId);
  try {
    return await extractLarge(file, mime, name);
  } catch (err) {
    return { text: "", method: "nenhum", warning: `não foi possível ler o arquivo: ${(err as Error).message.slice(0, 160)}` };
  }
}

const isPdf = (mime: string, lower: string) => mime === "application/pdf" || lower.endsWith(".pdf");
const isPlainText = (mime: string, lower: string) => mime.startsWith("text/") || /\.(txt|md|csv|json)$/.test(lower);

async function extractInner(data: Buffer, mime: string, name: string, userId: string | null): Promise<Extraction> {
  const lower = name.toLowerCase();
  if (isPdf(mime, lower)) {
    const r = await pdfText({ data: new Uint8Array(data) });
    if (!r.scanned) return { text: r.text, method: "pdf-parse" };
    return visionExtract(data, "application/pdf", userId, "PDF sem camada de texto (escaneado)");
  }
  if (lower.endsWith(".docx") || mime.includes("wordprocessingml")) {
    const r = await mammoth.extractRawText({ buffer: data });
    return { text: r.value.trim().slice(0, MAX_CHARS), method: "mammoth" };
  }
  if (isPlainText(mime, lower)) {
    return { text: data.toString("utf8").slice(0, MAX_CHARS), method: "texto" };
  }
  if (mime.startsWith("image/")) return visionExtract(data, mime, userId, "imagem");
  return { text: "", method: "nenhum", warning: `tipo não suportado: ${mime}` };
}

async function extractLarge(file: { path: string; size: number }, mime: string, name: string): Promise<Extraction> {
  const lower = name.toLowerCase();
  const mb = Math.round(file.size / 1048576);
  const limit = Math.round(MAX_BUFFERED / 1048576);
  if (isPdf(mime, lower)) {
    const fh = await fs.open(file.path, "r");
    try {
      // Sem auto-fetch nem stream: o pdf.js pede so os trechos das paginas lidas.
      const r = await pdfText({ range: new FileRange(fh, file.size), length: file.size, disableAutoFetch: true, disableStream: true });
      if (!r.scanned) return { text: r.text, method: "pdf-parse" };
      return { text: "", method: "nenhum", warning: `PDF de ${mb} MB sem camada de texto (escaneado): a extração por visão só vai até ${limit} MB. Passe um OCR no arquivo ou divida-o.` };
    } finally {
      await fh.close();
    }
  }
  if (isPlainText(mime, lower)) {
    const fh = await fs.open(file.path, "r");
    try {
      // UTF-8 usa ate 4 bytes por caractere: isto cobre MAX_CHARS com folga.
      const buf = Buffer.alloc(MAX_CHARS * 4);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return { text: buf.subarray(0, bytesRead).toString("utf8").slice(0, MAX_CHARS), method: "texto" };
    } finally {
      await fh.close();
    }
  }
  return { text: "", method: "nenhum", warning: `arquivo de ${mb} MB: acima de ${limit} MB o texto só é extraído de PDF e de texto puro` };
}

/** Entrega ao pdf.js os trechos do arquivo em disco que ele pedir. */
class FileRange extends PDFDataRangeTransport {
  constructor(
    private readonly fh: FileHandle,
    size: number,
  ) {
    super(size, null);
  }

  override requestDataRange(begin: number, end: number) {
    const buf = new Uint8Array(end - begin);
    // Falha de leitura entrega o trecho zerado: o pdf.js acusa PDF invalido (e
    // o anexo ganha um aviso) em vez de esperar para sempre por um trecho.
    this.fh.read(buf, 0, buf.length, begin).then(
      () => this.onDataRange(begin, buf),
      () => this.onDataRange(begin, buf),
    );
  }
}

/**
 * Texto das primeiras paginas, ate MAX_CHARS. Le pagina a pagina e para assim
 * que tem o bastante: num PDF de milhares de paginas o resto nem e aberto.
 */
async function pdfText(src: LoadParameters): Promise<{ text: string; scanned: boolean }> {
  const parser = new PDFParse(src);
  try {
    let text = "";
    let pages = 0;
    for (let total = 1; pages < total && text.length < MAX_CHARS; ) {
      const r = await parser.getText({ partial: [pages + 1] });
      total = Math.max(1, r.total);
      text += r.text;
      pages++;
      if (pages >= SCAN_PROBE_PAGES && text.trim().length / pages < MIN_CHARS_PER_PAGE) break;
    }
    text = text.trim();
    return { text: text.slice(0, MAX_CHARS), scanned: text.length / pages < MIN_CHARS_PER_PAGE };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
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

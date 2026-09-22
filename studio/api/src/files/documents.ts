import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import PDFDocument from "pdfkit";

// Markdown MINIMO (titulo #, lista -, negrito **, paragrafo). Os modelos de
// documento sao escritos pela curadoria nesse subconjunto; um conversor completo
// de Markdown seria dependencia grande para peca que tem estrutura fixa.

type Block = { kind: "h1" | "h2" | "h3" | "li" | "p"; text: string };

export function renderTemplate(body: string, fields: Record<string, string>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = body.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_m, k: string) => {
    const v = fields[k];
    if (v === undefined || v === "") {
      missing.push(k);
      return `[${k.toUpperCase()}]`;
    }
    return v;
  });
  return { text, missing: [...new Set(missing)] };
}

function parse(md: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "p", text: para.join(" ") });
    para = [];
  };
  for (const line of md.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) {
      flush();
      continue;
    }
    const h = t.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flush();
      blocks.push({ kind: (["h1", "h2", "h3"] as const)[h[1].length - 1], text: h[2] });
    } else if (/^[-*]\s+/.test(t)) {
      flush();
      blocks.push({ kind: "li", text: t.replace(/^[-*]\s+/, "") });
    } else para.push(t);
  }
  flush();
  return blocks;
}

function runs(text: string): TextRun[] {
  return text.split(/(\*\*[^*]+\*\*)/).filter(Boolean).map((part) =>
    part.startsWith("**") ? new TextRun({ text: part.slice(2, -2), bold: true }) : new TextRun({ text: part }),
  );
}

export async function toDocx(md: string): Promise<Buffer> {
  const children = parse(md).map((b) => {
    if (b.kind === "h1") return new Paragraph({ heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER, children: runs(b.text) });
    if (b.kind === "h2") return new Paragraph({ heading: HeadingLevel.HEADING_2, children: runs(b.text) });
    if (b.kind === "h3") return new Paragraph({ heading: HeadingLevel.HEADING_3, children: runs(b.text) });
    if (b.kind === "li") return new Paragraph({ bullet: { level: 0 }, children: runs(b.text) });
    return new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { after: 160 }, children: runs(b.text) });
  });
  const doc = new Document({ styles: { default: { document: { run: { font: "Calibri", size: 22 } } } }, sections: [{ children }] });
  return Packer.toBuffer(doc);
}

export function toPdf(md: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 64 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    for (const b of parse(md)) {
      const plain = b.text.replace(/\*\*/g, "");
      if (b.kind === "h1") doc.font("Helvetica-Bold").fontSize(15).text(plain, { align: "center" }).moveDown(0.8);
      else if (b.kind === "h2") doc.font("Helvetica-Bold").fontSize(12.5).text(plain).moveDown(0.4);
      else if (b.kind === "h3") doc.font("Helvetica-Bold").fontSize(11).text(plain).moveDown(0.3);
      else if (b.kind === "li") doc.font("Helvetica").fontSize(10.5).text(`•  ${plain}`, { indent: 12 }).moveDown(0.2);
      else doc.font("Helvetica").fontSize(10.5).text(plain, { align: "justify" }).moveDown(0.6);
    }
    doc.end();
  });
}

import { asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.js";

// Transcricao completa em Markdown para copiar e colar numa revisao: cada
// mensagem da conversa e, para cada execucao, a arvore de spans com a entrada e
// a saida integrais (prompt de sistema, mensagens enviadas, resposta crua).
// Nada e truncado: o objetivo e reproduzir exatamente o que cada agente viu.

type RunRow = typeof schema.run.$inferSelect;
type SpanRow = typeof schema.span.$inferSelect;

const fence = (s: string, lang = "") => {
  // Cerca maior que qualquer sequencia de crases no conteudo.
  const longest = Math.max(2, ...(s.match(/`+/g) ?? []).map((m) => m.length));
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${s}\n${f}`;
};

const json = (v: unknown) => JSON.stringify(v, null, 2);
const usd = (n: number) => `US$ ${n.toFixed(4)}`;
const iso = (d: Date | null) => (d ? d.toISOString() : "—");

function isChatMessages(v: unknown): v is { role: string; content: unknown }[] {
  return Array.isArray(v) && v.every((m) => m && typeof m === "object" && "role" in m);
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : json(p))).join("\n");
  return json(content);
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined) return "_(vazio)_";
  if (typeof v === "string") return fence(v);
  return fence(json(v), "json");
}

// Entrada de chamada LLM: separa system e mensagens para ficarem legiveis.
function renderLlmInput(input: Record<string, unknown>): string {
  const { system, messages, ...rest } = input;
  const out: string[] = [];
  if (Object.keys(rest).length) out.push(fence(json(rest), "json"));
  if (typeof system === "string" && system) out.push(`**[system]**\n\n${fence(system)}`);
  if (isChatMessages(messages)) for (const m of messages) out.push(`**[${m.role}]**\n\n${fence(messageText(m.content))}`);
  else if (messages !== undefined) out.push(renderValue(messages));
  return out.join("\n\n");
}

function renderLlmOutput(output: Record<string, unknown>): string {
  const { text, reasoning, ...rest } = output;
  const out: string[] = [];
  if (typeof reasoning === "string" && reasoning) out.push(`**[raciocínio]**\n\n${fence(reasoning)}`);
  out.push(`**[resposta]**\n\n${fence(typeof text === "string" ? text : json(text))}`);
  if (Object.keys(rest).length) out.push(fence(json(rest), "json"));
  return out.join("\n\n");
}

function renderSpans(spans: SpanRow[], modelLabels: Map<string, string>, heading: string): string {
  const children = new Map<string | null, SpanRow[]>();
  const ids = new Set(spans.map((s) => s.id));
  for (const s of spans) {
    const parent = s.parentId && ids.has(s.parentId) ? s.parentId : null;
    const list = children.get(parent) ?? [];
    list.push(s);
    children.set(parent, list);
  }
  const out: string[] = [];
  let n = 0;
  const walk = (parent: string | null, path: string) => {
    const list = (children.get(parent) ?? []).sort((a, b) => a.seq - b.seq);
    list.forEach((s, i) => {
      const num = path ? `${path}.${i + 1}` : `${i + 1}`;
      n++;
      const meta = [
        s.kind,
        s.status,
        s.ms != null ? `${s.ms} ms` : null,
        s.modelId ? (modelLabels.get(s.modelId) ?? s.modelId) : null,
        s.tokensIn || s.tokensOut ? `tokens ${s.tokensIn} in / ${s.tokensOut} out` : null,
        s.costUsd ? usd(s.costUsd) : null,
      ].filter(Boolean);
      out.push(`${heading} ${num} · ${s.name}\n\n_${meta.join(" · ")}_${s.nodeId ? ` · nó \`${s.nodeId}\`` : ""}`);
      if (s.error) out.push(`**Erro:** ${s.error}`);
      const isLlm = s.kind === "llm";
      const input = s.input as Record<string, unknown> | null;
      const output = s.output as Record<string, unknown> | null;
      out.push(`**Enviado:**\n\n${isLlm && input && typeof input === "object" ? renderLlmInput(input) : renderValue(input)}`);
      out.push(`**Recebido:**\n\n${isLlm && output && typeof output === "object" ? renderLlmOutput(output) : renderValue(output)}`);
      walk(s.id, num);
    });
  };
  walk(null, "");
  return n ? out.join("\n\n") : "_(sem spans registrados)_";
}

async function modelLabelsFor(spans: SpanRow[]) {
  const ids = [...new Set(spans.map((s) => s.modelId).filter(Boolean))] as string[];
  if (!ids.length) return new Map<string, string>();
  const rows = await db
    .select({ id: schema.model.id, label: schema.model.label, modelId: schema.model.modelId })
    .from(schema.model)
    .where(inArray(schema.model.id, ids));
  return new Map(rows.map((r) => [r.id, `${r.label} (${r.modelId})`]));
}

function renderRunHeader(r: RunRow, heading: string): string {
  const dur = r.endedAt ? `${r.endedAt.getTime() - r.startedAt.getTime()} ms` : "—";
  return [
    `${heading} Execução \`${r.id}\``,
    "",
    `- Fluxo: ${r.flowName} · rev ${r.flowRevision} · ${r.isProduction ? "produção" : "rascunho"}`,
    `- Status: ${r.status}${r.error ? ` · erro: ${r.error}` : ""}`,
    `- Início: ${iso(r.startedAt)} · duração: ${dur}`,
    `- Custo: ${usd(r.costUsd)} · tokens ${r.tokensIn} in / ${r.tokensOut} out`,
    r.rating ? `- Avaliação: ${r.rating > 0 ? "👍" : "👎"}${r.ratingComment ? ` — ${r.ratingComment}` : ""}` : null,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

async function renderRunBody(r: RunRow, heading: string): Promise<string> {
  const spans = await db.select().from(schema.span).where(eq(schema.span.runId, r.id)).orderBy(asc(schema.span.seq));
  const labels = await modelLabelsFor(spans);
  const parts = [renderRunHeader(r, heading), `**Pergunta:**\n\n${fence(r.question)}`];
  parts.push(`${heading}# Passo a passo (${spans.length} spans)\n\n${renderSpans(spans, labels, `${heading}##`)}`);
  if (r.outcome) parts.push(`${heading}# Resultado final (outcome)\n\n${fence(json(r.outcome), "json")}`);
  return parts.join("\n\n");
}

export async function runTranscript(runId: string): Promise<string | null> {
  const [r] = await db.select().from(schema.run).where(eq(schema.run.id, runId));
  if (!r) return null;
  return `# Transcrição de execução\n\n${await renderRunBody(r, "##")}\n`;
}

export async function sessionTranscript(sessionId: string): Promise<string | null> {
  const [s] = await db.select().from(schema.chatSession).where(eq(schema.chatSession.id, sessionId));
  if (!s) return null;
  const messages = await db.select().from(schema.message).where(eq(schema.message.sessionId, s.id)).orderBy(asc(schema.message.createdAt));
  const files = await db.select({ id: schema.file.id, name: schema.file.name, mime: schema.file.mime, extracted: schema.file.extractedText }).from(schema.file).where(eq(schema.file.sessionId, s.id));
  const filesById = new Map(files.map((f) => [f.id, f]));
  const runIds = messages.map((m) => m.runId).filter(Boolean) as string[];
  const runs = runIds.length ? await db.select().from(schema.run).where(inArray(schema.run.id, runIds)) : [];
  const runsById = new Map(runs.map((r) => [r.id, r]));

  const out: string[] = [
    [
      `# Transcrição da conversa: ${s.title}`,
      "",
      `- Sessão: \`${s.id}\``,
      `- Criada em: ${iso(s.createdAt)}`,
      `- Mensagens: ${messages.length} · execuções: ${runs.length} · custo total: ${usd(runs.reduce((a, r) => a + r.costUsd, 0))}`,
    ].join("\n"),
  ];
  let turn = 0;
  const rendered = new Set<string>();
  const flush = async (runId: string | null | undefined) => {
    const r = runId ? runsById.get(runId) : undefined;
    if (!r || rendered.has(r.id)) return;
    rendered.add(r.id);
    out.push(await renderRunBody(r, "###"));
  };
  let pendingRun: string | null = null;
  for (const m of messages) {
    if (m.role === "user") {
      // Execucao sem resposta gravada (erro ou em andamento) sai antes do proximo turno.
      await flush(pendingRun);
      pendingRun = m.runId;
      turn++;
      out.push(`\n---\n\n## Interação ${turn}\n\n### 👤 Usuário (${iso(m.createdAt)})\n\n${fence(m.content)}`);
      for (const id of m.attachments ?? []) {
        const f = filesById.get(id);
        if (!f) continue;
        out.push(`**Anexo:** ${f.name} (${f.mime}) — texto extraído (${f.extracted?.length ?? 0} car.):\n\n${fence(f.extracted ?? "")}`);
      }
    } else {
      out.push(`### 🤖 Assistente (${iso(m.createdAt)})\n\n${fence(m.content)}`);
      await flush(m.runId ?? pendingRun);
      pendingRun = null;
    }
  }
  await flush(pendingRun);
  return out.join("\n\n") + "\n";
}

// ── Resumo para o Assistente ("Discutir com o assistente") ──────────────
// A transcricao integral repete o prompt de sistema de cada agente a cada
// turno e estoura o contexto de qualquer modelo. O resumo leva o que importa
// para achar onde o fluxo errou — pergunta, anexos, resposta, decisoes do
// classificador, o que cada passo devolveu, erros, custo e avaliacao — e
// aponta os runIds para o Assistente abrir a transcricao completa quando
// precisar ver um prompt.

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…[cortado: +${s.length - n} car.]` : s);
const brief = (v: unknown, n: number) => (v === null || v === undefined ? "" : clip(typeof v === "string" ? v : JSON.stringify(v), n));

function digestSpans(spans: SpanRow[], labels: Map<string, string>): string {
  const children = new Map<string | null, SpanRow[]>();
  const ids = new Set(spans.map((s) => s.id));
  for (const s of spans) {
    const parent = s.parentId && ids.has(s.parentId) ? s.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), s]);
  }
  const out: string[] = [];
  const walk = (parent: string | null, path: string, depth: number) => {
    (children.get(parent) ?? [])
      .sort((a, b) => a.seq - b.seq)
      .forEach((s, i) => {
        const num = path ? `${path}.${i + 1}` : `${i + 1}`;
        const pad = "  ".repeat(depth);
        const meta = [s.status, s.ms != null ? `${s.ms} ms` : null, s.nodeId ? `nó ${s.nodeId}` : null, s.modelId ? (labels.get(s.modelId) ?? s.modelId) : null, s.costUsd ? usd(s.costUsd) : null].filter(Boolean);
        out.push(`${pad}- ${num} [${s.kind}] ${s.name} · ${meta.join(" · ")}`);
        if (s.error) out.push(`${pad}  ERRO: ${s.error}`);
        const output = s.output as Record<string, unknown> | null;
        if (s.kind === "llm") {
          const text = output && typeof output === "object" && "text" in output ? output.text : output;
          if (text) out.push(`${pad}  saída: ${brief(text, 1500)}`);
        } else if (s.kind !== "run") {
          if (s.kind !== "agent" && s.input != null) out.push(`${pad}  entrada: ${brief(s.input, 400)}`);
          if (output != null) out.push(`${pad}  saída: ${brief(output, s.kind === "agent" ? 600 : 900)}`);
        }
        walk(s.id, num, depth + 1);
      });
  };
  walk(null, "", 0);
  return out.join("\n");
}

function digestOutcome(o: Record<string, unknown>): string {
  const pick = {
    status: o.status,
    intencao: o.intencao,
    atalho: o.atalho,
    especialistas: (o.especialistas as { name?: string }[] | undefined)?.map((e) => e.name),
    // Ranking completo lista todos os especialistas; os primeiros bastam.
    classificacao:
      o.classificacao && typeof o.classificacao === "object"
        ? { ...(o.classificacao as Record<string, unknown>), ranking: ((o.classificacao as { ranking?: { score: number }[] }).ranking ?? []).slice().sort((a, b) => b.score - a.score).slice(0, 5) }
        : o.classificacao,
    flags: o.flags,
    pendencia: o.pendencia,
    compliance: o.compliance,
    citacoes: o.citacoes,
    documentos: (o.documentos as { name?: string; template?: string }[] | undefined)?.map((d) => `${d.name} (${d.template})`),
    erro: o.error,
  };
  const lines = [`- decisões: ${brief(JSON.parse(JSON.stringify(pick)), 2500)}`];
  if (typeof o.resposta_tecnica === "string" && o.resposta_tecnica) lines.push(`- resposta técnica:\n${fence(clip(o.resposta_tecnica, 4000))}`);
  return lines.join("\n");
}

export interface SimulationDigest {
  title: string;
  flow: string;
  text: string;
  /** Execucoes incluidas neste resumo (para nao reenviar na proxima atualizacao). */
  runIds: string[];
  /** Anexos enviados pelo usuario nas interacoes incluidas. */
  fileIds: string[];
  interactions: number;
  totalInteractions: number;
}

export async function simulationDigest(sessionId: string, skipRunIds: Set<string> = new Set(), maxChars = 90_000): Promise<SimulationDigest | null> {
  const [s] = await db.select().from(schema.chatSession).where(eq(schema.chatSession.id, sessionId));
  if (!s) return null;
  const messages = await db.select().from(schema.message).where(eq(schema.message.sessionId, s.id)).orderBy(asc(schema.message.createdAt));
  const files = await db.select({ id: schema.file.id, name: schema.file.name, mime: schema.file.mime, extracted: schema.file.extractedText }).from(schema.file).where(eq(schema.file.sessionId, s.id));
  const filesById = new Map(files.map((f) => [f.id, f]));
  const runIds = messages.map((m) => m.runId).filter(Boolean) as string[];
  const runs = runIds.length ? await db.select().from(schema.run).where(inArray(schema.run.id, runIds)) : [];
  const runsById = new Map(runs.map((r) => [r.id, r]));
  let flow = s.useProduction ? "produção (release publicada)" : "rascunho";
  if (s.flowId) {
    const [f] = await db.select({ name: schema.flow.name, revision: schema.flow.revision }).from(schema.flow).where(eq(schema.flow.id, s.flowId));
    flow = s.useProduction ? flow : f ? `rascunho "${f.name}" (fluxoId ${s.flowId}, rev atual ${f.revision})` : "fluxo excluído";
  }

  // Agrupa em interacoes: mensagem do usuario + resposta (pelo runId).
  type Turn = { user: (typeof messages)[number]; answer?: (typeof messages)[number] };
  const turns: Turn[] = [];
  for (const m of messages) {
    if (m.role === "user") turns.push({ user: m });
    else {
      const t = [...turns].reverse().find((x) => x.user.runId === m.runId) ?? turns[turns.length - 1];
      if (t && !t.answer) t.answer = m;
    }
  }

  const blocks: string[] = [];
  const included: string[] = [];
  const fileIds: string[] = [];
  let size = 0;
  let omitted = 0;
  let running = 0;
  for (const [i, t] of turns.entries()) {
    const run = t.user.runId ? runsById.get(t.user.runId) : undefined;
    if (run && skipRunIds.has(run.id)) continue;
    // Turno ainda rodando fica para o proximo envio (ja com a resposta).
    if (run?.status === "running") {
      running++;
      continue;
    }
    if (size > maxChars) {
      omitted++;
      continue;
    }
    const b: string[] = [`## Interação ${i + 1}${run ? ` · runId ${run.id}` : ""}`];
    if (run) {
      const dur = run.endedAt ? `${((run.endedAt.getTime() - run.startedAt.getTime()) / 1000).toFixed(1)} s` : "em andamento";
      b.push(`_${run.flowName} · rev ${run.flowRevision} · ${run.isProduction ? "produção" : "rascunho"} · status ${run.status} · ${dur} · ${usd(run.costUsd)}_`);
      if (run.rating) b.push(`**Avaliação do usuário no simulador:** ${run.rating > 0 ? "👍 boa" : "👎 ruim"}${run.ratingComment ? ` — ${run.ratingComment}` : ""}`);
    }
    b.push(`### 👤 Usuário\n${fence(t.user.content)}`);
    for (const id of t.user.attachments ?? []) {
      const f = filesById.get(id);
      if (!f) continue;
      fileIds.push(f.id);
      b.push(`**Anexo:** ${f.name} (fileId ${f.id}, ${f.mime}, ${f.extracted?.length ?? 0} car. extraídos)${f.extracted ? `\n${fence(clip(f.extracted, 6000))}` : ""}`);
    }
    if (t.answer) {
      b.push(`### 🤖 Goga respondeu\n${fence(clip(t.answer.content, 6000))}`);
      const p = t.answer.payload as Record<string, unknown> | null;
      if (p && typeof p === "object") b.push(digestOutcome(p));
    } else b.push("_(sem resposta gravada)_");
    if (run) {
      const spans = await db.select().from(schema.span).where(eq(schema.span.runId, run.id)).orderBy(asc(schema.span.seq));
      const labels = await modelLabelsFor(spans);
      b.push(`### Passo a passo (${spans.length} passos; prompts integrais em analisar_execucao)\n${clip(digestSpans(spans, labels), 20_000)}`);
      if (run.error) b.push(`**Erro da execução:** ${run.error}`);
      included.push(run.id);
    }
    const block = b.join("\n\n");
    size += block.length;
    blocks.push(block);
  }

  const head = [
    `# Simulação: ${s.title}`,
    `- sessaoId do simulador: ${s.id}`,
    `- fluxo da conversa: ${flow}`,
    `- interações: ${turns.length}${skipRunIds.size ? ` (aqui só as ${blocks.length} novas desde o último envio)` : ""} · custo total: ${usd(runs.reduce((a, r) => a + r.costUsd, 0))}`,
    omitted ? `- ${omitted} interação(ões) não couberam neste resumo: leia com ler_conversa_simulada.` : null,
    running ? `- ${running} interação(ões) ainda executando: chegam no próximo envio.` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return { title: s.title, flow, text: `${head}\n\n${blocks.join("\n\n---\n\n")}`, runIds: included, fileIds: [...new Set(fileIds)], interactions: blocks.length, totalInteractions: turns.length };
}

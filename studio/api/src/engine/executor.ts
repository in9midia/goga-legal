import type { ModelMessage } from "ai";
import { db, schema } from "../db/index.js";
import type { FlowGraph, FlowNode } from "../shared/graph.js";
import { callLlm, generateJson, type LlmCall } from "../llm/call.js";
import { hasSkill, runSkill, skillsPrompt, toolsFor } from "../skills/index.js";
import { checkCompliance } from "../skills/compliance.js";
import type { CitationCheck } from "../skills/citations.js";
import { activeTemplates } from "../files/templates.js";
import { listTools } from "../mcp/client.js";
import type { RunContext } from "./context.js";
import { errorMessage } from "./tracer.js";
import {
  FORMAT,
  classifierSchema,
  complianceSchema,
  consolidadoSchema,
  documentoSchema,
  parecerSchema,
  renderVars,
  section,
  type Classification,
  type Consolidado,
  type Intencao,
  type Parecer,
} from "./prompts.js";

/**
 * Estado do caso, carregado de um turno para o outro no `outcome` da mensagem
 * do assistente. E o que permite responder "e se a loja nao responder?" sem
 * rodar os especialistas de novo, e separar um assunto novo do anterior.
 */
export interface CaseState {
  /** Mensagens do usuario que pertencem ao caso atual (base da busca na KB). */
  relato: string[];
  /** Pareceres da ultima rodada de especialistas deste caso. */
  pareceres: { nodeId: string; name: string; specialtyNumber: number | null; parecer: Parecer; citacoes: CitationCheck[] }[];
  /** Slugs dos modelos de documento ja gerados neste caso. */
  documentos: string[];
  /** Documento pedido que ainda espera campos obrigatorios do usuario. */
  documento_pendente: { modelo: string; campos: Record<string, string> } | null;
}

const MAX_RELATO = 8;

/** Le o estado do caso de um payload salvo; payload antigo (sem `caso`) vira null. */
export function readCase(payload: unknown): CaseState | null {
  const c = (payload as { caso?: Partial<CaseState> } | null)?.caso;
  if (!c || !Array.isArray(c.relato)) return null;
  return {
    relato: c.relato.filter((r): r is string => typeof r === "string"),
    pareceres: Array.isArray(c.pareceres) ? c.pareceres : [],
    documentos: Array.isArray(c.documentos) ? c.documentos : [],
    documento_pendente: c.documento_pendente ?? null,
  };
}

export interface TurnInput {
  message: string;
  /**
   * `status` so vem nas mensagens do assistente (status do turno que as gerou).
   * `clarify_documento` = pergunta pelos campos de um documento, que nao conta
   * como esclarecimento do caso.
   */
  history: { role: "user" | "assistant"; content: string; status?: string | null; anexos?: string[] }[];
  /** Estado do caso do ultimo turno que o tinha; null em conversa nova ou antiga. */
  caso?: CaseState | null;
}

export interface SpecialistResult {
  nodeId: string;
  name: string;
  specialtyNumber: number | null;
  ok: boolean;
  parecer?: Parecer;
  citacoes?: CitationCheck[];
  error?: string;
  chainedFrom?: string;
  /** Parecer reaproveitado de um turno anterior (o especialista nao rodou agora). */
  reused?: boolean;
}

export interface TurnOutcome {
  status: "ok" | "clarify" | "blocked" | "error";
  resposta_simples: string;
  resposta_tecnica: string;
  citacoes: CitationCheck[];
  documentos: { fileId: string; name: string; mime: string; template: string }[];
  especialistas: { nodeId: string; name: string; ok: boolean; score?: number; chainedFrom?: string; reused?: boolean }[];
  classificacao?: Classification;
  intencao?: Intencao;
  /** Caminho que o turno tomou: completo, conversa, reuso de pareceres ou documento. */
  atalho?: "completo" | "conversa" | "reuso" | "documento";
  /** `documento` = o turno pediu campos de um documento (proximo turno completa). */
  pendencia?: "documento";
  caso: CaseState;
  flags: string[];
  compliance?: { aprovado: boolean; ciclos: number; motivos: string[] };
  path: { nodes: string[]; edges: string[] };
}

type Specialty = typeof schema.specialty.$inferSelect;

const HISTORY_TURNS = 6;
/** Esclarecimentos seguidos antes de o motor rotear com o que tem. */
const MAX_CLARIFY_STREAK = 2;
const GENERIC_CLARIFY = "Pode me contar um pouco mais sobre o que aconteceu, com quem (empresa ou órgão) e quando?";
const CONVERSA_PADRAO = "Olá! Eu sou o Goga e ajudo com orientação sobre problemas de consumo e outras questões cíveis. Me conte o que aconteceu, com quem e quando.";
/** Perguntas seguidas por campos de documento antes de gerar com o que tem. */
const MAX_DOC_CLARIFY = 2;

export async function executeTurn(ctx: RunContext, input: TurnInput): Promise<TurnOutcome> {
  const g = ctx.graph;
  const byType = (t: FlowNode["type"]) => g.nodes.filter((n) => n.type === t);
  const node = (id: string) => g.nodes.find((n) => n.id === id)!;
  const outs = (id: string) => g.edges.filter((e) => e.source === id).map((e) => e.target);
  const edgeId = (s: string, t: string) => g.edges.find((e) => e.source === s && e.target === t)?.id;

  const entry = byType("entry")[0];
  const classifier = byType("classifier")[0];
  const consolidator = byType("consolidator")[0];
  const compliance = byType("compliance")[0];
  const output = byType("output")[0];

  const visited = new Set<string>();
  const usedEdges = new Set<string>();
  const mark = (id: string, from?: string) => {
    visited.add(id);
    if (from) {
      const e = edgeId(from, id);
      if (e) usedEdges.add(e);
    }
  };
  const path = () => ({ nodes: [...visited], edges: [...usedEdges] });
  const flags: string[] = [];
  const specialties = new Map<number, Specialty>((await db.select().from(schema.specialty)).map((s) => [s.number, s]));
  const templates = await activeTemplates();
  const cycle = compliance?.data.cycle ?? { maxCycles: 2, requiredChecks: ["disclaimer", "sem_promessa", "citacoes_verificadas", "zona", "lgpd"], safeResponse: "" };

  const root = await ctx.tracer.start({ kind: "run", name: "Execução", input: { mensagem: input.message, anexos: ctx.files.map((f) => f.name) } });
  const globalRules = [g.settings.globalRules, g.settings.tone && `Tom: ${g.settings.tone}`, `Idioma: ${g.settings.language}`].filter(Boolean).join("\n\n");
  const modelFor = (n: FlowNode) => n.data.model.modelId ?? g.settings.defaultModelId;
  const historyMsgs: ModelMessage[] = input.history.slice(-HISTORY_TURNS).map((h) => ({ role: h.role, content: h.content }));
  // Esclarecimentos seguidos no fim da conversa e as perguntas ja feitas: sem
  // isso o classificador pergunta de novo o que o usuario acabou de responder.
  const assistantTurns = input.history.filter((h) => h.role === "assistant");
  const streakOf = (status: string) => {
    let n = 0;
    for (let i = assistantTurns.length - 1; i >= 0 && assistantTurns[i].status === status; i--) n++;
    return n;
  };
  const clarifyStreak = streakOf("clarify");
  const docClarifyStreak = streakOf("clarify_documento");
  const askedQuestions = assistantTurns.filter((h) => h.status === "clarify").map((h) => h.content.trim());
  const prev = input.caso ?? null;
  // Estado do caso deste turno. Comeca igual ao anterior e e ajustado depois da
  // classificacao (assunto novo zera o relato; conversa nao entra nele).
  let caso: CaseState = prev ?? { relato: [], pareceres: [], documentos: [], documento_pendente: null };

  const baseCall = (n: FlowNode, parentId: string, name: string, system: string, messages: ModelMessage[]): LlmCall => {
    const modelId = modelFor(n);
    if (!modelId) throw new Error(`"${n.data.name}" sem modelo e o fluxo não tem modelo padrão`);
    return {
      ctx,
      name,
      parentId,
      nodeId: n.id,
      nodeName: n.data.name,
      specialtyNumber: n.data.specialtyNumber,
      modelId,
      fallbackModelId: n.data.model.fallbackModelId,
      system,
      messages,
      temperature: n.data.model.temperature,
      maxTokens: n.data.model.maxTokens,
      timeoutMs: n.data.model.timeoutMs,
      maxCostUsd: n.data.model.maxCostUsd,
    };
  };
  const rulesOf = async (n: FlowNode) =>
    (await skillsPrompt(ctx, n)) +
    section("Guardrails deste agente", n.data.rules.guardrails) +
    section("Escalonar para humano quando", n.data.rules.escalation) +
    section("Zona permitida", n.data.rules.zone === "amarela" ? "verde e amarela (orientação com ressalvas)" : "somente verde (orientação geral)");

  type Draft = Omit<TurnOutcome, "path" | "flags" | "caso"> & { caso?: CaseState };
  const finish = async (o: Draft): Promise<TurnOutcome> => {
    const outcome = { ...o, caso: o.caso ?? caso, flags, path: path() };
    if (output) {
      await ctx.tracer.wrap({ kind: "agent", name: output.data.name, nodeId: output.id, parentId: root.id, input: { status: o.status } }, async () => ({
        resposta_simples: o.resposta_simples,
        documentos: o.documentos.map((d) => d.name),
      }));
    }
    await root.end({ output: { status: o.status, atalho: o.atalho, flags }, tokensIn: ctx.tokensIn, tokensOut: ctx.tokensOut, costUsd: ctx.costUsd });
    return outcome;
  };

  try {
    // ── 1. Entrada ──────────────────────────────────────────────────────
    mark(entry.id);
    const anexos = ctx.files.map((f) => `### Anexo: ${f.name}\n${f.text ? f.text.slice(0, 6000) : "(sem texto extraído)"}`).join("\n\n");
    // Relato do usuario e o que importa: corte largo. Resposta do Goga, curto.
    const hist = input.history.slice(-HISTORY_TURNS).map((h) => (h.role === "user" ? `Usuário: ${h.content.slice(0, 6000)}${h.anexos?.length ? ` [anexou: ${h.anexos.join(", ")}]` : ""}` : `Goga: ${h.content.slice(0, 800)}`)).join("\n");
    const buildFicha = (withHistory: boolean) =>
      [`## Mensagem atual\n${input.message.trim()}`, withHistory && hist && `## Conversa anterior\n${hist}`, anexos && `## Anexos\n${anexos}`].filter(Boolean).join("\n\n");
    let ficha = await ctx.tracer.wrap({ kind: "agent", name: entry.data.name, nodeId: entry.id, parentId: root.id, input: { mensagem: input.message } }, async () => buildFicha(true));
    const vars = { mensagem: input.message, ficha, regras_globais: globalRules, pareceres: "" };

    // ── 2. Classificador ────────────────────────────────────────────────
    mark(classifier.id, entry.id);
    const routing = classifier.data.routing ?? { routingThreshold: 0.55, clarifyThreshold: 0.35, maxSpecialists: 3, exclusionTriggers: ["familia", "penal"], defendantFastPath: true };
    const candidates = outs(classifier.id).map(node).filter((n) => n.type === "specialist");
    const candidateInfo = candidates.map((n) => {
      const sp = n.data.specialtyNumber != null ? specialties.get(n.data.specialtyNumber) : undefined;
      return {
        nodeId: n.id,
        number: n.data.specialtyNumber,
        name: n.data.name,
        escopo: sp?.scope ?? n.data.description,
        keywords: sp?.routingHints.keywords ?? [],
        exemplos: sp?.routingHints.examples ?? [],
      };
    });
    const casoResumo = prev
      ? [
          prev.pareceres.length ? `Orientação já dada neste caso por: ${prev.pareceres.map((p) => p.name).join(", ")}.` : "Caso em andamento, ainda sem orientação dada.",
          prev.documentos.length && `Documentos já gerados: ${prev.documentos.join(", ")}.`,
          prev.documento_pendente && `O Goga está coletando dados para gerar o documento "${prev.documento_pendente.modelo}": se a mensagem traz esses dados, a intenção é pedido_documento.`,
        ]
      : ["Nenhum caso em andamento."];

    const cls = await ctx.tracer.wrap({ kind: "agent", name: classifier.data.name, nodeId: classifier.id, parentId: root.id, input: { candidatos: candidateInfo.length } }, async (span) => {
      const especialidades = candidateInfo.map((c) => `- ${c.nodeId}: ${c.name} — ${c.escopo}`).join("\n");
      const system =
        renderVars(classifier.data.prompt.system, { ...vars, especialidades }) +
        section("Regras globais", globalRules) +
        section("Gatilhos de exclusão (fora de escopo: só detectar e encaminhar)", routing.exclusionTriggers) +
        section("Caso em andamento", casoResumo.filter((l): l is string => !!l)) +
        section(
          "Perguntas de esclarecimento já feitas nesta conversa (NÃO repita; considere as respostas do usuário na conversa anterior)",
          askedQuestions,
        ) +
        (clarifyStreak >= MAX_CLARIFY_STREAK ? section("Limite de esclarecimentos", "Já foram feitas perguntas demais. Não peça esclarecimento: classifique com os fatos disponíveis.") : "") +
        (await rulesOf(classifier)) +
        `\n\n## Candidatos\n<<candidatos>>${JSON.stringify(candidateInfo)}<</candidatos>>\n\n` +
        FORMAT.classificador;
      const { value } = await generateJson(baseCall(classifier, span.id, "Classificação", system, [...historyMsgs, { role: "user", content: ficha }]), classifierSchema);
      return value;
    });

    // O modelo pode identificar o candidato pelo numero da especialidade (o
    // prompt do preset pede assim) em vez do nodeId: traduz aqui.
    cls.ranking = cls.ranking
      .map((r) => {
        if (candidates.some((c) => c.id === r.nodeId)) return r;
        const byNumber = r.especialidade != null ? candidates.find((c) => c.data.specialtyNumber === r.especialidade) : undefined;
        return byNumber ? { ...r, nodeId: byNumber.id } : r;
      })
      .filter((r) => candidates.some((c) => c.id === r.nodeId));
    const scoreOf = new Map(cls.ranking.map((r) => [r.nodeId, r.score]));
    const ranked = [...cls.ranking].sort((a, b) => b.score - a.score);
    const top = ranked[0]?.score ?? 0;

    // Intencao efetiva. O modelo erra nos cantos; o motor corrige com o que sabe
    // do caso: continuar/gerar documento sem caso nenhum e consulta nova, e
    // resposta a uma coleta de campos em andamento e o proprio pedido.
    let intencao: Intencao = cls.intencao;
    if (prev?.documento_pendente && intencao === "continuacao") intencao = "pedido_documento";
    if (intencao === "continuacao" && !prev && !input.history.length) intencao = "nova_consulta";

    // Relato do caso: base da busca na KB e da ficha. Assunto novo depois de uma
    // orientacao dada zera o relato (e a ficha perde a conversa anterior), para
    // os dois assuntos nao se misturarem na busca nem nos pareceres.
    const reset = intencao === "nova_consulta" && !!prev?.pareceres.length;
    let relato: string[];
    if (intencao === "conversa") relato = prev?.relato ?? [];
    else if (reset) relato = [input.message];
    else if (prev) relato = [...prev.relato, input.message];
    // Conversa sem estado salvo (anterior a este campo): o relato e o que era.
    else relato = [...input.history.filter((h) => h.role === "user").slice(-4).map((h) => h.content), input.message];
    relato = relato.slice(-MAX_RELATO);
    const caseText = relato.join("\n").slice(-2000);
    if (reset) {
      ficha = buildFicha(false);
      vars.ficha = ficha;
      flags.push("novo_assunto");
    }
    caso = { relato, pareceres: reset ? [] : caso.pareceres, documentos: reset ? [] : caso.documentos, documento_pendente: reset ? null : caso.documento_pendente };

    const canGenerateDoc = templates.length > 0 && (await hasSkill(ctx, consolidator, "gerar_documento"));
    let selected: FlowNode[] = [];
    let decision: string;
    const encaminhamento = candidates.find((c) => c.data.specialtyNumber === 5);
    if (cls.conflito_interesse) {
      decision = "conflito_interesse";
    } else if (cls.fora_de_escopo) {
      decision = encaminhamento ? "encaminhamento" : "fora_de_escopo_sem_no";
      if (encaminhamento) selected = [encaminhamento];
    } else if (intencao === "conversa") {
      decision = "conversa";
    } else if (intencao === "pedido_documento" && canGenerateDoc) {
      decision = "documento";
    } else if (intencao !== "nova_consulta" && !cls.fatos_novos && prev?.pareceres.length) {
      // Pergunta sobre a orientacao ja dada (ou documento sem skill): o
      // Consolidador responde com os pareceres do turno anterior.
      if (intencao === "pedido_documento") flags.push("documento_indisponivel");
      decision = "reuso";
    } else if (clarifyStreak >= MAX_CLARIFY_STREAK && top === 0) {
      // Limite de esclarecimentos atingido e ainda sem ranking: perguntar de
      // novo so prende o usuario num loop. Falha visivel, com trace.
      throw new Error("Classificador não produziu ranking utilizável após o limite de esclarecimentos (veja a saída da Classificação no trace).");
    } else if ((cls.precisa_esclarecimento || top < routing.clarifyThreshold) && clarifyStreak < MAX_CLARIFY_STREAK) {
      decision = "esclarecimento";
    } else {
      if (intencao === "pedido_documento") flags.push("documento_indisponivel");
      if (cls.precisa_esclarecimento || top < routing.clarifyThreshold) flags.push("esclarecimento_esgotado");
      const above = ranked.filter((r) => r.score >= routing.routingThreshold);
      const pick = (above.length ? above : ranked.slice(0, 1)).slice(0, cls.polo === "reu" && routing.defendantFastPath ? 1 : routing.maxSpecialists);
      selected = pick.map((r) => node(r.nodeId)).filter((n) => n.data.specialtyNumber !== 5 || cls.fora_de_escopo);
      if (!selected.length) selected = pick.map((r) => node(r.nodeId));
      decision = "roteamento";
      if (cls.polo === "reu" && routing.defendantFastPath) flags.push("polo_reu_fast_path");
    }
    await ctx.tracer.wrap({ kind: "route", name: `Roteamento: ${decision}`, nodeId: classifier.id, parentId: root.id, input: { intencao_modelo: cls.intencao, intencao, fatos_novos: cls.fatos_novos, limiar_roteamento: routing.routingThreshold, limiar_esclarecimento: routing.clarifyThreshold, top, esclarecimentos_seguidos: clarifyStreak, pareceres_do_caso: prev?.pareceres.length ?? 0 } }, async () => ({
      decisao: decision,
      selecionados: selected.map((n) => ({ nodeId: n.id, nome: n.data.name, score: scoreOf.get(n.id) })),
    }));
    if (cls.urgencia === "alta") flags.push("urgencia_alta");
    const base = { classificacao: cls, intencao };

    if (decision === "conflito_interesse") {
      flags.push("conflito_interesse");
      return finish({
        ...base,
        status: "blocked",
        resposta_simples: "Não podemos orientar este caso: identificamos um possível conflito de interesse. Procure a Defensoria Pública ou um advogado de sua confiança.",
        resposta_tecnica: "Regra Absoluta nº 2 (conflito de interesse): atendimento bloqueado pelo classificador.",
        citacoes: [],
        documentos: [],
        especialistas: [],
      });
    }
    if (decision === "fora_de_escopo_sem_no") {
      flags.push("fora_de_escopo");
      return finish({ ...base, status: "blocked", resposta_simples: "Este assunto está fora do que o Goga orienta. Procure a Defensoria Pública, a OAB da sua cidade ou um advogado.", resposta_tecnica: "Fora de escopo e o fluxo não tem nó de Encaminhamento (Ag. 5).", citacoes: [], documentos: [], especialistas: [] });
    }
    if (decision === "esclarecimento") {
      const asked = new Set(askedQuestions);
      const own = cls.pergunta_esclarecimento.trim();
      const q =
        own && !asked.has(own)
          ? own
          : !asked.has(GENERIC_CLARIFY)
            ? GENERIC_CLARIFY
            : "Há mais algum detalhe importante que eu ainda não sei? Se não houver, responda “não” e eu sigo com a orientação.";
      return finish({ ...base, status: "clarify", resposta_simples: q, resposta_tecnica: `Score máximo ${top.toFixed(2)} abaixo do limiar de esclarecimento ${routing.clarifyThreshold} ou lacuna apontada pelo classificador (regra-mãe: uma lacuna por vez).`, citacoes: [], documentos: [], especialistas: [] });
    }

    // ── Atalho: conversa ────────────────────────────────────────────────
    // Saudacao/agradecimento: o proprio classificador ja escreveu a resposta.
    // Sem especialista nem consolidador; so as checagens deterministicas.
    if (decision === "conversa") {
      let text = cls.resposta_conversa.trim() || CONVERSA_PADRAO;
      const guardNode = compliance ?? consolidator;
      if (compliance) mark(compliance.id);
      const det = await ctx.tracer.wrap({ kind: "guardrail", name: "Checagens determinísticas (conversa)", nodeId: guardNode.id, parentId: root.id, input: { resposta: text } }, async () =>
        checkCompliance(text, { disclaimer: "", checks: cycle.requiredChecks.filter((c) => c !== "disclaimer" && c !== "citacoes_verificadas") }),
      );
      const failed = det.filter((d) => !d.ok);
      if (failed.length) {
        flags.push("conversa_reprovada");
        text = CONVERSA_PADRAO;
      }
      if (output) mark(output.id);
      return finish({
        ...base,
        status: "ok",
        atalho: "conversa",
        resposta_simples: text,
        resposta_tecnica: failed.length ? `Resposta do classificador reprovada (${failed.map((f) => f.detalhe).join("; ")}); usada a resposta padrão.` : "",
        citacoes: [],
        documentos: [],
        especialistas: [],
      });
    }

    // ── Atalho: documento ───────────────────────────────────────────────
    if (decision === "documento") {
      mark(consolidator.id);
      const pend = caso.documento_pendente;
      const fill = await ctx.tracer.wrap({ kind: "agent", name: `${consolidator.data.name} (documento)`, nodeId: consolidator.id, parentId: root.id, input: { pendente: pend, pareceres: caso.pareceres.length } }, async (span) => {
        const system =
          "Você prepara documentos do caso a partir de modelos cadastrados." +
          section("Regras globais", globalRules) +
          (await rulesOf(consolidator)) +
          section("Modelos de documento disponíveis", templates.map((t) => `${t.slug}: ${t.title} — ${t.description} (campos: ${t.fields.map((c) => `${c.nome}${c.obrigatorio ? "*" : ""} = ${c.rotulo}`).join("; ")}; * = obrigatório)`)) +
          section("Relato do caso", relato) +
          section("Pareceres do caso", caso.pareceres.length ? JSON.stringify(caso.pareceres.map((p) => ({ especialista: p.name, parecer: p.parecer }))) : "") +
          section("Documento em andamento (mantenha o modelo e os campos já coletados)", pend ? JSON.stringify(pend) : "") +
          "\n\n" +
          FORMAT.documento;
        const { value } = await generateJson(baseCall(consolidator, span.id, "Preenchimento de documento", system, [...historyMsgs, { role: "user", content: ficha }]), documentoSchema);
        return value;
      });
      const tpl = templates.find((t) => t.slug === fill.modelo) ?? templates.find((t) => t.slug === pend?.modelo);
      const docBase = { ...base, atalho: "documento" as const, citacoes: [], especialistas: [] };
      if (!tpl) {
        caso = { ...caso, documento_pendente: { modelo: "", campos: {} } };
        if (output) mark(output.id);
        return finish({ ...docBase, status: "clarify", pendencia: "documento", resposta_simples: `Qual documento você precisa? Posso preparar: ${templates.map((t) => t.title).join("; ")}.`, resposta_tecnica: `Modelo "${fill.modelo}" não reconhecido.`, documentos: [] });
      }
      const campos: Record<string, string> = {};
      for (const [k, v] of Object.entries({ ...pend?.campos, ...fill.campos })) if (v.trim()) campos[k] = v.trim();
      const missing = tpl.fields.filter((f) => f.obrigatorio && !campos[f.nome]);
      if (missing.length && docClarifyStreak < MAX_DOC_CLARIFY) {
        caso = { ...caso, documento_pendente: { modelo: tpl.slug, campos } };
        if (output) mark(output.id);
        return finish({
          ...docBase,
          status: "clarify",
          pendencia: "documento",
          resposta_simples: fill.pergunta.trim() || `Para montar "${tpl.title}", preciso de: ${missing.map((f) => f.rotulo).join(", ")}.`,
          resposta_tecnica: `Campos obrigatórios faltando em ${tpl.slug}: ${missing.map((f) => f.nome).join(", ")}.`,
          documentos: [],
        });
      }
      if (missing.length) flags.push("documento_incompleto");
      await runSkill("gerar_documento", { modelo: tpl.slug, campos, formato: "ambos" }, { ctx, node: consolidator, parentId: root.id }).catch((err) => flags.push(`documento_falhou:${tpl.slug}:${errorMessage(err)}`));
      const ok = ctx.generated.length > 0;
      caso = { ...caso, documento_pendente: null, documentos: ok ? [...new Set([...caso.documentos, tpl.slug])] : caso.documentos };
      if (output) mark(output.id, consolidator.id);
      const faltou = missing.length ? ` Deixei em branco: ${missing.map((f) => f.rotulo).join(", ")}. Complete antes de enviar.` : "";
      return finish({
        ...docBase,
        status: ok ? "ok" : "error",
        resposta_simples: [ok ? `Pronto: preparei "${tpl.title}" em DOCX e PDF (arquivos abaixo). Revise os dados antes de usar; a decisão de enviar é sua.${faltou}` : `Não consegui gerar "${tpl.title}" agora. Tente de novo em instantes.`, g.settings.disclaimer].filter(Boolean).join("\n\n"),
        resposta_tecnica: `Modelo ${tpl.slug} preenchido com: ${Object.keys(campos).join(", ") || "(nenhum campo)"}.`,
        documentos: ctx.generated,
      });
    }

    // ── 3. Especialistas (paralelo) + encadeamentos (sequencial) ─────────
    const runSpecialist = async (n: FlowNode, from: string, prior?: SpecialistResult): Promise<SpecialistResult> => {
      mark(n.id, from);
      const base = { nodeId: n.id, name: n.data.name, specialtyNumber: n.data.specialtyNumber, chainedFrom: prior?.nodeId };
      const span = await ctx.tracer.start({ kind: "agent", name: n.data.name, nodeId: n.id, parentId: root.id, input: { score: scoreOf.get(n.id), encadeado_de: prior?.name } });
      try {
        const env = { ctx, node: n, parentId: span.id };
        let evidencias = "";
        if (n.data.knowledge.spaces.length) {
          try {
            const r = (await runSkill("buscar_kb", { consulta: caseText }, env)) as { resultados: { titulo: string; base: string; pagina: number | null; trecho: string; armadilha: string | null; document_id?: number; pagina_wiki_id?: number }[] };
            evidencias = r.resultados
              .filter((p) => !(n.data.knowledge.verifiedOnly && p.armadilha))
              .map((p, i) => `[${i + 1}] ${p.titulo} (base ${p.base}${p.pagina ? `, p. ${p.pagina}` : ""}, ${p.pagina_wiki_id != null ? `pagina_wiki_id ${p.pagina_wiki_id}` : `document_id ${p.document_id}`})${p.armadilha ? `\n⚠ ARMADILHA: ${p.armadilha}` : ""}\n${p.trecho}`)
              .join("\n\n");
          } catch (err) {
            evidencias = `(KB indisponível: ${errorMessage(err)}. Não cite fundamento que não possa sustentar.)`;
          }
        }
        const mcpTools = await mcpToolsFor(n);
        const system =
          renderVars(n.data.prompt.system, vars) +
          `\n\nEspecialidade: ${n.data.name}` +
          section("Regras globais", globalRules) +
          (await rulesOf(n)) +
          section("Evidências da base de conhecimento", evidencias || "(nenhuma evidência recuperada)") +
          (prior?.parecer ? section(`Parecer anterior (${prior.name})`, JSON.stringify(prior.parecer)) : "") +
          (n.data.prompt.examples ? section("Exemplos", n.data.prompt.examples) : "") +
          "\n\n" +
          (n.data.prompt.outputFormat === "parecer" ? FORMAT.parecer : "");
        const call = { ...baseCall(n, span.id, `Parecer · ${n.data.name}`, system, [{ role: "user", content: ficha }] as ModelMessage[]), tools: await toolsFor(env, mcpTools), maxSteps: 6 };
        let parecer: Parecer;
        if (n.data.prompt.outputFormat === "parecer") {
          parecer = (await generateJson(call, parecerSchema)).value;
        } else {
          const r = await callLlm(call);
          parecer = parecerSchema.parse({ especialidade: n.data.name, resumo_fatos: r.text });
        }
        let citacoes: CitationCheck[] = [];
        if (await hasSkill(ctx, n, "verificar_citacao")) {
          const txt = parecer.fundamentos.map((f) => f.citacao).join("\n");
          citacoes = ((await runSkill("verificar_citacao", { texto: txt }, env)) as { citacoes: CitationCheck[] }).citacoes;
          const st = new Map(citacoes.map((c) => [c.citacao, c.status]));
          parecer.fundamentos = parecer.fundamentos.map((f) => ({ ...f, status: st.get(f.citacao) ?? f.status }));
        }
        if (parecer.precisa_humano) flags.push(`escalonamento_humano:${n.data.name}`);
        await span.end({ output: { parecer, citacoes } });
        return { ...base, ok: true, parecer, citacoes };
      } catch (err) {
        await span.fail(err);
        return { ...base, ok: false, error: errorMessage(err) };
      }
    };

    let results: SpecialistResult[];
    if (decision === "reuso") {
      results = caso.pareceres.map((p) => ({ ...p, ok: true, reused: true }));
      await ctx.tracer.wrap({ kind: "route", name: "Pareceres reaproveitados", nodeId: consolidator.id, parentId: root.id, input: { especialistas: results.map((r) => r.name) } }, async () => ({ reaproveitados: results.length }));
    } else {
      const firstWave = await Promise.allSettled(selected.map((n) => runSpecialist(n, classifier.id)));
      results = firstWave.map((r, i) => (r.status === "fulfilled" ? r.value : { nodeId: selected[i].id, name: selected[i].data.name, specialtyNumber: selected[i].data.specialtyNumber, ok: false, error: errorMessage(r.reason) }));
      // Encadeamentos (53 -> 52, 54 -> 29 -> 52): cada especialista que rodou
      // alimenta o seguinte, em sequencia, e cada no roda no maximo uma vez.
      const queue = results.filter((r) => r.ok);
      const ran = new Set(results.map((r) => r.nodeId));
      while (queue.length) {
        const src = queue.shift()!;
        for (const t of outs(src.nodeId)) {
          const tn = node(t);
          if (tn.type !== "specialist" || ran.has(t)) continue;
          ran.add(t);
          const r = await runSpecialist(tn, src.nodeId, src);
          results.push(r);
          if (r.ok) queue.push(r);
        }
      }
    }
    const okResults = results.filter((r) => r.ok);
    if (!okResults.length) throw new Error(`Nenhum especialista concluiu: ${results.map((r) => `${r.name}: ${r.error}`).join("; ")}`);
    if (decision === "reuso") mark(consolidator.id);
    else for (const r of okResults) mark(consolidator.id, r.nodeId);
    caso = {
      ...caso,
      pareceres: okResults.map((r) => ({ nodeId: r.nodeId, name: r.name, specialtyNumber: r.specialtyNumber, parecer: r.parecer!, citacoes: r.citacoes ?? [] })),
      documento_pendente: null,
    };

    // ── 4/5. Consolidador <-> Compliance ────────────────────────────────
    const pareceres = JSON.stringify(okResults.map((r) => ({ especialista: r.name, parecer: r.parecer, citacoes_conferidas: r.citacoes })), null, 1);
    const allCitations = okResults.flatMap((r) => r.citacoes ?? []);
    const hasCompliance = compliance && outs(consolidator.id).includes(compliance.id);

    let feedback: string[] = [];
    let consolidado: Consolidado | null = null;
    let verdict = { aprovado: true, motivos: [] as string[] };
    let cycles = 0;
    for (;;) {
      consolidado = await ctx.tracer.wrap({ kind: "agent", name: cycles ? `${consolidator.data.name} (revisão ${cycles})` : consolidator.data.name, nodeId: consolidator.id, parentId: root.id, input: { pareceres: okResults.length, reaproveitados: decision === "reuso", correcoes: feedback } }, async (span) => {
        const system =
          renderVars(consolidator.data.prompt.system, { ...vars, pareceres }) +
          section("Regras globais", globalRules) +
          (await rulesOf(consolidator)) +
          (decision === "reuso"
            ? section("Continuação do caso", "Os pareceres abaixo são do turno anterior e a orientação já foi dada. Responda à mensagem atual do usuário (dúvida sobre a orientação) sem repetir a orientação inteira.")
            : "") +
          section("Pareceres dos especialistas", pareceres) +
          section("Citações conferidas", allCitations.map((c) => `${c.citacao}: ${c.status}${c.bloqueada ? " (NÃO CITAR)" : ""}`)) +
          section("Modelos de documento disponíveis", templates.map((t) => `${t.slug}: ${t.title} (campos: ${t.fields.map((c) => c.nome).join(", ")})`)) +
          section("Correções exigidas pelo Compliance", feedback) +
          section("Disclaimer obrigatório (termine a resposta simples com ele)", g.settings.disclaimer) +
          "\n\n" +
          FORMAT.consolidado;
        const { value } = await generateJson(baseCall(consolidator, span.id, "Consolidação", system, [...historyMsgs, { role: "user", content: ficha }]), consolidadoSchema);
        // O disclaimer e anexado pelo motor, nao confiado ao modelo: e texto
        // fixo, e o Compliance reprovaria a resposta inteira por esquecimento.
        if (g.settings.disclaimer && !value.resposta_simples.includes(g.settings.disclaimer.slice(0, 40))) {
          value.resposta_simples = `${value.resposta_simples.trim()}\n\n${g.settings.disclaimer}`;
        }
        return value;
      });
      if (!hasCompliance) break;
      mark(compliance.id, consolidator.id);
      const text = `${consolidado.resposta_simples}\n\n${consolidado.resposta_tecnica}`;
      verdict = await ctx.tracer.wrap({ kind: "agent", name: cycles ? `${compliance.data.name} (ciclo ${cycles + 1})` : compliance.data.name, nodeId: compliance.id, parentId: root.id, input: { ciclo: cycles + 1 } }, async (span) => {
        const env = { ctx, node: compliance, parentId: span.id };
        const det = await ctx.tracer.wrap({ kind: "guardrail", name: "Checagens determinísticas", nodeId: compliance.id, parentId: span.id, input: { checks: cycle.requiredChecks } }, async () => {
          const r = checkCompliance(text, { disclaimer: g.settings.disclaimer, checks: cycle.requiredChecks });
          if (cycle.requiredChecks.includes("citacoes_verificadas")) {
            const { citacoes } = (await runSkill("verificar_citacao", { texto: text }, env)) as { citacoes: CitationCheck[] };
            const bad = citacoes.filter((c) => c.bloqueada);
            r.push({ check: "citacoes_verificadas", ok: !bad.length, detalhe: bad.length ? `citações não verificadas: ${bad.map((c) => `${c.citacao} (${c.status})`).join(", ")}` : `${citacoes.length} citação(ões) verificada(s)` });
          }
          return r;
        });
        const failedDet = det.filter((d) => !d.ok).map((d) => d.detalhe);
        const system =
          renderVars(compliance.data.prompt.system, vars) +
          section("Regras globais", globalRules) +
          (await rulesOf(compliance)) +
          section("Resultado das checagens determinísticas", det.map((d) => `${d.ok ? "OK" : "FALHOU"} ${d.check}: ${d.detalhe}`)) +
          "\n\n" +
          FORMAT.compliance;
        const { value } = await generateJson(baseCall(compliance, span.id, "Revisão de compliance", system, [{ role: "user", content: `Resposta a revisar:\n\n${text}` }]), complianceSchema);
        const aprovado = value.aprovado && failedDet.length === 0;
        if (value.zona === "vermelha") flags.push("zona_vermelha");
        return { aprovado, motivos: [...failedDet, ...value.motivos, ...value.correcoes] };
      });
      if (verdict.aprovado) break;
      cycles++;
      if (cycles > cycle.maxCycles) break;
      mark(consolidator.id, compliance.id);
      feedback = verdict.motivos;
    }

    let finalAnswer = consolidado!;
    let status: TurnOutcome["status"] = "ok";
    if (!verdict.aprovado) {
      flags.push("compliance_reprovado");
      status = "blocked";
      finalAnswer = {
        ...finalAnswer,
        resposta_simples: [cycle.safeResponse || "Não conseguimos montar uma orientação segura para este caso. Procure a Defensoria Pública, o Procon ou um advogado.", g.settings.disclaimer].filter(Boolean).join("\n\n"),
        resposta_tecnica: `Resposta retida pelo Compliance após ${cycles} ciclo(s): ${verdict.motivos.join("; ")}`,
        documentos_solicitados: [],
      };
    }

    // ── Documentos pedidos ───────────────────────────────────────────────
    if (status === "ok" && finalAnswer.documentos_solicitados.length && canGenerateDoc) {
      const valid = new Set(templates.map((t) => t.slug));
      for (const slug of finalAnswer.documentos_solicitados.filter((s) => valid.has(s)).slice(0, 3)) {
        await runSkill("gerar_documento", { modelo: slug, campos: finalAnswer.campos_documento, formato: "ambos" }, { ctx, node: consolidator, parentId: root.id }).catch((err) => flags.push(`documento_falhou:${slug}:${errorMessage(err)}`));
      }
      caso = { ...caso, documentos: [...new Set([...caso.documentos, ...ctx.generated.map((d) => d.template)])] };
    }

    if (output) mark(output.id, hasCompliance && visited.has(compliance.id) ? compliance.id : consolidator.id);
    return finish({
      ...base,
      status,
      atalho: decision === "reuso" ? "reuso" : "completo",
      resposta_simples: finalAnswer.resposta_simples,
      resposta_tecnica: finalAnswer.resposta_tecnica,
      citacoes: dedupe(allCitations),
      documentos: ctx.generated,
      especialistas: results.map((r) => ({ nodeId: r.nodeId, name: r.name, ok: r.ok, score: scoreOf.get(r.nodeId), chainedFrom: r.chainedFrom, reused: r.reused })),
      compliance: hasCompliance ? { aprovado: verdict.aprovado, ciclos: cycles + (verdict.aprovado ? 1 : 0), motivos: verdict.motivos } : undefined,
    });
  } catch (err) {
    await root.fail(err);
    throw err;
  }
}

function dedupe(c: CitationCheck[]): CitationCheck[] {
  const m = new Map<string, CitationCheck>();
  for (const x of c) if (!m.has(x.citacao)) m.set(x.citacao, x);
  return [...m.values()];
}

async function mcpToolsFor(n: FlowNode) {
  const wanted = n.data.tools.mcp;
  if (!wanted.length) return [];
  const servers = [...new Set(wanted.map((w) => w.split(":")[0]))];
  const out: { server: string; name: string; description?: string; inputSchema: Record<string, unknown> }[] = [];
  for (const s of servers) {
    try {
      const tools = await listTools(s);
      for (const t of tools) if (wanted.includes(`${s}:${t.name}`)) out.push({ server: s, ...t });
    } catch {
      // Servidor MCP fora do ar nao derruba o especialista: ele segue com as
      // skills e as evidencias ja recuperadas.
    }
  }
  return out;
}

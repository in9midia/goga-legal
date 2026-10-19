import type { ModelMessage } from "ai";
import { db, schema } from "../db/index.js";
import type { FlowGraph, FlowNode } from "../shared/graph.js";
import { BudgetError, CancelledError, callLlm, generateJson, type LlmCall } from "../llm/call.js";
import { hasSkill, runSkill, skillsPrompt, toolsFor } from "../skills/index.js";
import { checkCompliance, checkLeak } from "../skills/compliance.js";
import type { CitationCheck } from "../skills/citations.js";
import { activeTemplates } from "../files/templates.js";
import { listTools } from "../mcp/client.js";
import type { RunContext } from "./context.js";
import { errorMessage } from "./tracer.js";
import { DATA_NOTICE, INJECTION_ALERT, asData, injectionSignals, neutralize } from "./guard.js";
import { decideCycle, unchanged, type CycleStop, type Objection } from "./proportionality.js";
import { planConsultations, type ConsultAsk, type ConsultRequest } from "./consultations.js";
import { chainClosure, runChains } from "./chains.js";
import {
  FORMAT,
  classifierSchema,
  complianceSchema,
  consolidadoSchema,
  documentoSchema,
  parecerSchema,
  consultSection,
  retriagemFormat,
  retriagemSchema,
  renderVars,
  reviewText,
  type Colleague,
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
  /** Todas as origens do encadeamento que concluíram (chainedFrom é a primeira). */
  encadeadoDe?: string[];
  /** Parecer reaproveitado de um turno anterior (o especialista nao rodou agora). */
  reused?: boolean;
  /** Ferramentas que devolveram erro: a falta de resultado delas nao prova que algo nao existe. */
  falhas?: string[];
  /** Especialistas da primeira rodada que pediram esta consulta (Retriagem). */
  consultadoPor?: string[];
}

export interface TurnOutcome {
  status: "ok" | "clarify" | "blocked" | "error";
  resposta_simples: string;
  resposta_tecnica: string;
  citacoes: CitationCheck[];
  documentos: { fileId: string; name: string; mime: string; template: string }[];
  especialistas: { nodeId: string; name: string; ok: boolean; score?: number; chainedFrom?: string; encadeadoDe?: string[]; reused?: boolean; consultadoPor?: string[] }[];
  classificacao?: Classification;
  intencao?: Intencao;
  /** Caminho que o turno tomou: completo, conversa, reuso de pareceres ou documento. */
  atalho?: "completo" | "conversa" | "reuso" | "documento";
  /** `documento` = o turno pediu campos de um documento (proximo turno completa). */
  pendencia?: "documento";
  caso: CaseState;
  flags: string[];
  compliance?: { aprovado: boolean; ciclos: number; motivos: string[]; parada?: CycleStop; melhorias?: string[] };
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
  const retriagem = byType("retriagem")[0];
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
  const cycle = compliance?.data.cycle ?? { maxCycles: 2, requiredChecks: ["disclaimer", "sem_promessa", "citacoes_verificadas", "zona", "lgpd"], safeResponse: "", deliverWithReservations: false };

  const root = await ctx.tracer.start({ kind: "run", name: "Execução", input: { mensagem: input.message, anexos: ctx.files.map((f) => f.name) } });
  const globalRules = [g.settings.globalRules, g.settings.tone && `Tom: ${g.settings.tone}`, `Idioma: ${g.settings.language}`].filter(Boolean).join("\n\n");
  const modelFor = (n: FlowNode) => n.data.model.modelId ?? g.settings.defaultModelId;
  // Texto de fora (mensagem, historico, anexos) entra nos prompts neutralizado:
  // sem caracteres invisiveis nem os delimitadores do motor (`<<dado>>`,
  // `<<formato:...>>`), que serviriam para "falar como sistema".
  const message = neutralize(input.message);
  // Material do proprio usuario: numero de processo que vem daqui e do caso,
  // nao precedente a conferir na KB (verificar_citacao).
  const userMaterial = [input.message, ...input.history.filter((h) => h.role === "user").map((h) => h.content), ...ctx.files.map((f) => f.text ?? "")].join("\n");
  const historyMsgs: ModelMessage[] = input.history.slice(-HISTORY_TURNS).map((h) => ({ role: h.role, content: neutralize(h.content) }));
  // Heuristicas de injecao: nao bloqueiam (relato juridico cita "ignore" e
  // "sistema" o tempo todo), so poem o alerta no prompt dos nos seguintes.
  const signals = [...injectionSignals(input.message, "mensagem"), ...ctx.files.flatMap((f) => injectionSignals(f.text ?? "", `anexo:${f.name}`))];
  const injectionAlert = signals.length ? INJECTION_ALERT : "";
  if (signals.length) flags.push("injecao_suspeita");
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
    // Anexo e dado, nao instrucao: vai num envelope que o texto dele nao fecha.
    const anexos = ctx.files.map((f) => `### Anexo: ${neutralize(f.name)}\n${asData(`anexo:${f.name}`, f.text ? f.text.slice(0, 6000) : "(sem texto extraído)")}`).join("\n\n");
    // Relato do usuario e o que importa: corte largo. Resposta do Goga, curto.
    const hist = input.history
      .slice(-HISTORY_TURNS)
      .map((h) => (h.role === "user" ? `Usuário: ${neutralize(h.content.slice(0, 6000))}${h.anexos?.length ? ` [anexou: ${h.anexos.map(neutralize).join(", ")}]` : ""}` : `Goga: ${neutralize(h.content.slice(0, 800))}`))
      .join("\n");
    const buildFicha = (withHistory: boolean) =>
      [`## Mensagem atual\n${message.trim()}`, withHistory && hist && `## Conversa anterior\n${hist}`, anexos && `## Anexos\n${anexos}`].filter(Boolean).join("\n\n");
    let ficha = await ctx.tracer.wrap({ kind: "agent", name: entry.data.name, nodeId: entry.id, parentId: root.id, input: { mensagem: message, ...(signals.length ? { sinais_de_injecao: signals } : {}) } }, async () => buildFicha(true));
    const vars = { mensagem: message, ficha, regras_globais: globalRules, pareceres: "" };

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
        `\n\n${DATA_NOTICE}` +
        section("Regras globais", globalRules) +
        section("Alerta de manipulação", injectionAlert) +
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
    else if (reset) relato = [message];
    else if (prev) relato = [...prev.relato, message];
    // Conversa sem estado salvo (anterior a este campo): o relato e o que era.
    else relato = [...input.history.filter((h) => h.role === "user").slice(-4).map((h) => neutralize(h.content)), message];
    relato = relato.slice(-MAX_RELATO);
    const caseText = relato.join("\n").slice(-2000);
    // A busca na KB vai com a consulta enxuta do Classificador: o relato cru
    // (saudacao, desabafo, anexo colado) dilui a busca e traz trecho vizinho.
    // Sem ela (modelo nao preencheu), vale o relato, como antes.
    const kbQuery = neutralize(cls.consulta_busca).trim().slice(0, 600);
    const searchText = kbQuery || caseText;
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
    await ctx.tracer.wrap({ kind: "route", name: `Roteamento: ${decision}`, nodeId: classifier.id, parentId: root.id, input: { intencao_modelo: cls.intencao, intencao, fatos_novos: cls.fatos_novos, consulta_busca: kbQuery || null, limiar_roteamento: routing.routingThreshold, limiar_esclarecimento: routing.clarifyThreshold, top, esclarecimentos_seguidos: clarifyStreak, pareceres_do_caso: prev?.pareceres.length ?? 0 } }, async () => ({
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
        [...checkCompliance(text, { disclaimer: "", checks: cycle.requiredChecks.filter((c) => c !== "disclaimer" && c !== "citacoes_verificadas") }), checkLeak(text)],
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

    // ── 3. Especialistas (paralelo) + encadeamentos (por níveis) ─────────
    // Colegas que a primeira rodada pode acionar: especialista do fluxo que nao
    // foi escolhido nem roda por encadeamento de um escolhido. Sem o no
    // Retriagem, nao ha segunda rodada: o especialista nem e convidado a pedir.
    const maxConsultas = retriagem && decision !== "reuso" ? (retriagem.data.retriagem?.maxConsultas ?? 2) : 0;
    const isSpecialist = (id: string) => node(id)?.type === "specialist";
    const willRun = new Set(chainClosure(selected.map((n) => n.id), outs, isSpecialist));
    const specialistNodes = byType("specialist");
    const colleagues: Colleague[] = maxConsultas
      ? specialistNodes
          .filter((n) => !willRun.has(n.id) && n.data.specialtyNumber !== 5)
          .map((n) => {
            const sp = n.data.specialtyNumber != null ? specialties.get(n.data.specialtyNumber) : undefined;
            return { nodeId: n.id, name: n.data.name, escopo: sp?.scope ?? n.data.description, ferramentas: n.data.tools.skills.filter((x) => x !== "buscar_kb" && x !== "verificar_citacao" && x !== "buscar_documento_kb") };
          })
      : [];

    // priors: pareceres das origens do encadeamento (todas as que concluiram).
    const runSpecialist = async (n: FlowNode, from: string | null, priors: SpecialistResult[] = [], requests: ConsultRequest[] = []): Promise<SpecialistResult> => {
      // Consultado por um colega: nao ha aresta da origem a marcar no caminho.
      if (priors.length) for (const p of priors) mark(n.id, p.nodeId);
      else mark(n.id, from ?? undefined);
      const base = {
        nodeId: n.id,
        name: n.data.name,
        specialtyNumber: n.data.specialtyNumber,
        chainedFrom: priors[0]?.nodeId,
        ...(priors.length > 1 ? { encadeadoDe: priors.map((p) => p.nodeId) } : {}),
        ...(requests.length ? { consultadoPor: requests.map((r) => r.de) } : {}),
      };
      const span = await ctx.tracer.start({ kind: "agent", name: n.data.name, nodeId: n.id, parentId: root.id, input: { score: scoreOf.get(n.id), encadeado_de: priors.length ? priors.map((p) => p.name) : undefined, ...(requests.length ? { consulta: requests.map((r) => ({ de: r.de, pergunta: r.pergunta })) } : {}) } });
      const falhas: string[] = [];
      try {
        const env = { ctx, node: n, parentId: span.id, failures: falhas };
        let evidencias = "";
        if (n.data.knowledge.spaces.length) {
          try {
            // Na consulta, a busca vai pelo que o colega pediu: e o ponto que falta, nao o caso todo.
            const consulta = requests.length ? [...requests.map((x) => neutralize(x.pergunta)), searchText].join("\n").slice(0, 1500) : searchText;
            const r = (await runSkill("buscar_kb", { consulta }, env)) as { resultados: { titulo: string; base: string; pagina: number | null; secao?: string | null; trecho: string; armadilha: string | null; document_id?: number; pagina_wiki_id?: number }[] };
            evidencias = r.resultados
              .filter((p) => !(n.data.knowledge.verifiedOnly && p.armadilha))
              // O trecho e dado recuperado: vai no envelope, que o texto do
              // documento nao consegue fechar nem transformar em instrucao.
              .map((p, i) => `[${i + 1}] ${p.titulo} (base ${p.base}${p.secao ? `, ${p.secao}` : ""}${p.pagina ? `, p. ${p.pagina}` : ""}, ${p.pagina_wiki_id != null ? `pagina_wiki_id ${p.pagina_wiki_id}` : `document_id ${p.document_id}`})${p.armadilha ? `\n⚠ ARMADILHA: ${p.armadilha}` : ""}\n${asData(`kb:${p.base}`, p.trecho)}`)
              .join("\n\n");
          } catch (err) {
            if (err instanceof BudgetError || err instanceof CancelledError) throw err;
            if (!flags.includes("kb_indisponivel")) flags.push("kb_indisponivel");
            evidencias = `(KB indisponível: ${errorMessage(err)}. Não cite fundamento que não possa sustentar.)`;
          }
        }
        const mcpTools = await mcpToolsFor(n);
        const system =
          renderVars(n.data.prompt.system, vars) +
          `\n\nEspecialidade: ${n.data.name}` +
          `\n\n${DATA_NOTICE}` +
          section("Regras globais", globalRules) +
          section("Alerta de manipulação", injectionAlert) +
          (await rulesOf(n)) +
          section("Evidências da base de conhecimento", evidencias || "(nenhuma evidência recuperada)") +
          // O parecer do colega e saida de modelo que leu documentos e anexos: vai como dado.
          priors
            .filter((p) => p.parecer)
            .map((p) => section(`Parecer anterior (${p.name})`, asData(`parecer:${p.name}`, JSON.stringify(p.parecer))))
            .join("") +
          (n.data.prompt.examples ? section("Exemplos", n.data.prompt.examples) : "") +
          // Uma rodada de consulta so: quem foi consultado nao aciona mais ninguem.
          (!requests.length && n.data.prompt.outputFormat === "parecer" ? consultSection(colleagues, maxConsultas) : "") +
          "\n\n" +
          (n.data.prompt.outputFormat === "parecer" ? FORMAT.parecer : "");
        // O parecer do colega e saida de modelo que leu documentos e anexos: vai como dado.
        const content = requests.length
          ? ficha +
            section(
              "Consulta de colegas",
              `Outro especialista já analisou este caso e precisa de um ponto que você apura. Responda ao que ele pediu, no contexto do caso acima.\n\n${requests.map((r) => `### Pedido de ${r.de}\n${neutralize(r.pergunta)}\n\nO que ${r.de} já apurou:\n${asData(`parecer:${r.de}`, r.parecer)}`).join("\n\n")}`,
            )
          : ficha;
        const call = { ...baseCall(n, span.id, `Parecer · ${n.data.name}`, system, [{ role: "user", content }] as ModelMessage[]), tools: await toolsFor(env, mcpTools), maxSteps: 6 };
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
          citacoes = ((await runSkill("verificar_citacao", { texto: txt, caso: userMaterial }, env)) as { citacoes: CitationCheck[] }).citacoes;
          const st = new Map(citacoes.map((c) => [c.citacao, c.status]));
          parecer.fundamentos = parecer.fundamentos.map((f) => ({ ...f, status: st.get(f.citacao) ?? f.status }));
        }
        if (parecer.precisa_humano) flags.push(`escalonamento_humano:${n.data.name}`);
        await span.end({ output: { parecer, citacoes, ...(falhas.length ? { falhas } : {}) } });
        return { ...base, ok: true, parecer, citacoes, falhas };
      } catch (err) {
        await span.fail(err);
        // Teto de custo e pedido de parar valem para o turno inteiro: virar
        // "especialista falhou" so esconderia a causa atras de outra mensagem.
        if (err instanceof BudgetError || err instanceof CancelledError) throw err;
        return { ...base, ok: false, error: errorMessage(err) };
      }
    };

    let results: SpecialistResult[];
    if (decision === "reuso") {
      results = caso.pareceres.map((p) => ({ ...p, ok: true, reused: true }));
      await ctx.tracer.wrap({ kind: "route", name: "Pareceres reaproveitados", nodeId: consolidator.id, parentId: root.id, input: { especialistas: results.map((r) => r.name) } }, async () => ({ reaproveitados: results.length }));
    } else {
      const firstWave = await Promise.allSettled(selected.map((n) => runSpecialist(n, classifier.id)));
      const fatal = firstWave.find((r): r is PromiseRejectedResult => r.status === "rejected" && (r.reason instanceof BudgetError || r.reason instanceof CancelledError));
      if (fatal) throw fatal.reason;
      results = firstWave.map((r, i) => (r.status === "fulfilled" ? r.value : { nodeId: selected[i].id, name: selected[i].data.name, specialtyNumber: selected[i].data.specialtyNumber, ok: false, error: errorMessage(r.reason) }));
      // Encadeamentos (53 -> 52, 54 -> 29 -> 52): cada no roda no maximo uma vez,
      // depois de todas as suas origens, com o parecer de todas; nos do mesmo
      // nivel rodam em paralelo.
      results.push(...(await runChains({ first: results, outs, isSpecialist, run: (id, priors) => runSpecialist(node(id), null, priors) })));
    }
    // ── 3b. Retriagem: consulta entre especialistas (uma rodada) ──────────
    // O Classificador decide antes de alguem analisar; um parecer pode descobrir
    // que a orientacao depende do que outro especialista apura. O especialista,
    // ocupado com a propria resposta, raramente pede ajuda sozinho: a Retriagem
    // le as lacunas e aponta quem as fecha. O modelo sugere, o motor decide.
    let retriagemRan = false;
    if (retriagem && decision !== "reuso") {
      retriagemRan = true;
      // No caminho: Classificador -> Retriagem -> Consolidador (as arestas do no).
      mark(retriagem.id, classifier.id);
      await ctx.tracer.wrap(
        { kind: "agent", name: retriagem.data.name, nodeId: retriagem.id, parentId: root.id, input: { maxConsultas, colegas: colleagues.length, lacunas: results.reduce((t, r) => t + (r.parecer?.lacunas.length ?? 0), 0) } },
        async (span) => {
          const answered = results.filter((r) => r.ok && r.parecer);
          if (!maxConsultas || !colleagues.length) return { consultados: [], motivo: !maxConsultas ? "teto 0" : "sem colega disponível" };
          if (!answered.some((r) => r.parecer!.lacunas.length || r.parecer!.consultar.length)) return { consultados: [], motivo: "nenhuma lacuna nem pedido" };
          const parecerText = (r: SpecialistResult) => JSON.stringify(r.parecer).slice(0, 4000);
          const asks: ConsultAsk[] = [];
          try {
            const rtg = await ctx.tracer.wrap({ kind: "agent", name: "Retriagem · decisão", nodeId: retriagem.id, parentId: span.id, input: { pareceres: answered.length } }, async (inner) => {
              const system =
                renderVars(retriagem.data.prompt.system, vars) +
                (retriagem.data.prompt.system ? "" : "Você é a Retriagem do Goga.") +
                `\n\n${DATA_NOTICE}` +
                section("Regras globais", globalRules) +
                section("Alerta de manipulação", injectionAlert) +
                (await rulesOf(retriagem)) +
                "\n\n" +
                retriagemFormat(colleagues, maxConsultas);
              const user =
                `## Caso\n${relato.join("\n").slice(-3000)}\n\n## Pareceres da primeira rodada\n` +
                answered
                  .map((r) => `### ${r.nodeId}: ${r.name}\n${asData(`parecer:${r.name}`, parecerText(r))}\nLacunas: ${r.parecer!.lacunas.join("; ") || "(nenhuma)"}${r.parecer!.consultar.length ? `\nPedidos dele: ${r.parecer!.consultar.map((c) => `${c.especialista}: ${c.pergunta}`).join("; ")}` : ""}`)
                  .join("\n\n");
              return (await generateJson(baseCall(retriagem, inner.id, "Retriagem", system, [{ role: "user", content: user }]), retriagemSchema)).value;
            });
            const fromOf = (de: string) => {
              const d = de.trim().toLowerCase();
              return answered.find((x) => x.nodeId.toLowerCase() === d || x.name.toLowerCase() === d) ?? answered[0];
            };
            for (const c of rtg.consultas) {
              const src = fromOf(c.de);
              asks.push({ from: src.name, parecer: parecerText(src), target: c.especialista, pergunta: c.pergunta, origem: "retriagem" });
            }
          } catch (err) {
            if (err instanceof BudgetError || err instanceof CancelledError) throw err;
            // Sem o modelo da Retriagem, valem os pedidos dos proprios especialistas.
            flags.push("retriagem_falhou");
          }
          for (const r of answered) for (const c of r.parecer!.consultar) asks.push({ from: r.name, parecer: parecerText(r), target: c.especialista, pergunta: c.pergunta, origem: "especialista" });
          const plan = planConsultations({
            asks,
            candidates: specialistNodes.map((n) => ({ nodeId: n.id, name: n.data.name, specialtyNumber: n.data.specialtyNumber })),
            ran: new Set(results.map((r) => r.nodeId)),
            max: maxConsultas,
          });
          if (asks.length)
            await ctx.tracer.wrap({ kind: "route", name: "Consulta entre especialistas", nodeId: retriagem.id, parentId: span.id, input: { maxConsultas, pedidos: asks.map((a) => ({ origem: a.origem, de: a.from, especialista: a.target, pergunta: a.pergunta })) } }, async () => ({
              consultados: [...plan.byNode].map(([id, rs]) => ({ nodeId: id, nome: node(id).data.name, de: rs.map((x) => x.de) })),
              descartados: plan.discarded,
            }));
          if (plan.byNode.size) {
            flags.push("consulta_entre_especialistas");
            const second = await Promise.allSettled([...plan.byNode].map(([id, rs]) => runSpecialist(node(id), null, [], rs)));
            const fatal = second.find((r): r is PromiseRejectedResult => r.status === "rejected" && (r.reason instanceof BudgetError || r.reason instanceof CancelledError));
            if (fatal) throw fatal.reason;
            const ids = [...plan.byNode.keys()];
            second.forEach((r, i) => results.push(r.status === "fulfilled" ? r.value : { nodeId: ids[i], name: node(ids[i]).data.name, specialtyNumber: node(ids[i]).data.specialtyNumber, ok: false, error: errorMessage(r.reason) }));
          }
          return { consultados: [...plan.byNode].map(([id, rs]) => ({ nodeId: id, nome: node(id).data.name, de: rs.map((x) => x.de) })) };
        },
      );
    }

    const okResults = results.filter((r) => r.ok);
    if (!okResults.length) throw new Error(`Nenhum especialista concluiu: ${results.map((r) => `${r.name}: ${r.error}`).join("; ")}`);
    if (decision === "reuso") mark(consolidator.id);
    else if (retriagemRan) mark(consolidator.id, retriagem.id);
    else for (const r of okResults) mark(consolidator.id, r.nodeId);
    caso = {
      ...caso,
      pareceres: okResults.map((r) => ({ nodeId: r.nodeId, name: r.name, specialtyNumber: r.specialtyNumber, parecer: r.parecer!, citacoes: r.citacoes ?? [] })),
      documento_pendente: null,
    };

    // ── 4/5. Consolidador <-> Compliance ────────────────────────────────
    const pareceres = JSON.stringify(
      okResults.map((r) => ({
        especialista: r.name,
        ...(r.consultadoPor?.length ? { consultado_por: r.consultadoPor } : {}),
        parecer: r.parecer,
        citacoes_conferidas: r.citacoes,
        ...(r.falhas?.length ? { consultas_que_falharam: r.falhas } : {}),
      })),
      null,
      1,
    );
    const allCitations = okResults.flatMap((r) => r.citacoes ?? []);
    const hasCompliance = compliance && outs(consolidator.id).includes(compliance.id);
    const anyFailure = okResults.some((r) => r.falhas?.length);
    const disclaimer = g.settings.disclaimer;
    const withoutDisclaimer = (t: string) => (disclaimer ? t.split(disclaimer).join("").trim() : t.trim());

    let feedback: string[] = [];
    let consolidado: Consolidado | null = null;
    let verdict = { aprovado: true, motivos: [] as string[], failedChecks: false, zona: "verde" as string, blocking: [] as Objection[], improvements: [] as Objection[] };
    let cycles = 0;
    let stop: CycleStop | undefined;
    /** Objecoes bloqueantes de todos os ciclos anteriores: a regua do "ja foi pedido". */
    const previousObjections: Objection[] = [];
    /** A versao que o Compliance reprovou: o Consolidador corrige ela, nao escreve outra do zero. */
    let previousVersion = "";
    for (;;) {
      consolidado = await ctx.tracer.wrap({ kind: "agent", name: cycles ? `${consolidator.data.name} (revisão ${cycles})` : consolidator.data.name, nodeId: consolidator.id, parentId: root.id, input: { pareceres: okResults.length, reaproveitados: decision === "reuso", correcoes: feedback } }, async (span) => {
        const system =
          renderVars(consolidator.data.prompt.system, { ...vars, pareceres }) +
          `\n\n${DATA_NOTICE}` +
          section("Regras globais", globalRules) +
          section("Alerta de manipulação", injectionAlert) +
          (await rulesOf(consolidator)) +
          (decision === "reuso"
            ? section("Continuação do caso", "Os pareceres abaixo são do turno anterior e a orientação já foi dada. Responda à mensagem atual do usuário (dúvida sobre a orientação) sem repetir a orientação inteira.")
            : "") +
          section("Pareceres dos especialistas", asData("pareceres", pareceres)) +
          (anyFailure
            ? section(
                "Consultas que falharam",
                "Algumas ferramentas dos especialistas devolveram erro (em consultas_que_falharam). A falta de resultado delas não prova que algo não existe: nunca afirme que um direito, prazo ou cálculo não se aplica por causa delas; diga que não foi possível verificar aquilo.",
              )
            : "") +
          section("Citações conferidas", allCitations.map((c) => `${c.citacao}: ${c.status}${c.bloqueada ? " (NÃO CITAR)" : ""}`)) +
          section("Modelos de documento disponíveis", templates.map((t) => `${t.slug}: ${t.title} (campos: ${t.fields.map((c) => c.nome).join(", ")})`)) +
          section("Versão anterior (reprovada pelo Compliance)", previousVersion) +
          section("Correções exigidas pelo Compliance", feedback) +
          (previousVersion
            ? section("Como corrigir", "Parta da versão anterior e mude SÓ os trechos que as correções apontam; o resto fica como está, palavra por palavra. Reescrever o que não foi apontado abre objeções novas e atrasa a resposta.")
            : "") +
          section("Disclaimer obrigatório (termine a resposta simples com ele)", disclaimer) +
          "\n\n" +
          FORMAT.consolidado;
        const { value } = await generateJson(baseCall(consolidator, span.id, "Consolidação", system, [...historyMsgs, { role: "user", content: ficha }]), consolidadoSchema);
        // O disclaimer e anexado pelo motor, nao confiado ao modelo: e texto
        // fixo, e o Compliance reprovaria a resposta inteira por esquecimento.
        if (disclaimer && !value.resposta_simples.includes(disclaimer.slice(0, 40))) {
          value.resposta_simples = `${value.resposta_simples.trim()}\n\n${disclaimer}`;
        }
        return value;
      });
      if (!hasCompliance) break;
      const text = reviewText(consolidado);
      // Mesmo texto, mesmo veredito: revisar de novo so gasta tempo.
      if (previousVersion && unchanged(previousVersion, withoutDisclaimer(text))) {
        stop = "sem_mudanca";
        break;
      }
      mark(compliance.id, consolidator.id);
      verdict = await ctx.tracer.wrap({ kind: "agent", name: cycles ? `${compliance.data.name} (ciclo ${cycles + 1})` : compliance.data.name, nodeId: compliance.id, parentId: root.id, input: { ciclo: cycles + 1 } }, async (span) => {
        const env = { ctx, node: compliance, parentId: span.id };
        const det = await ctx.tracer.wrap({ kind: "guardrail", name: "Checagens determinísticas", nodeId: compliance.id, parentId: span.id, input: { checks: cycle.requiredChecks } }, async () => {
          const r = checkCompliance(text, { disclaimer, checks: cycle.requiredChecks });
          if (cycle.requiredChecks.includes("citacoes_verificadas")) {
            const { citacoes } = (await runSkill("verificar_citacao", { texto: text, caso: userMaterial }, env)) as { citacoes: CitationCheck[] };
            const bad = citacoes.filter((c) => c.bloqueada);
            r.push({ check: "citacoes_verificadas", ok: !bad.length, detalhe: bad.length ? `citações não verificadas: ${bad.map((c) => `${c.citacao} (${c.status})`).join(", ")}` : `${citacoes.length} citação(ões) verificada(s)` });
          }
          // Fixa, fora da lista do no: resposta que repete o prompt nunca sai.
          r.push(checkLeak(text));
          return r;
        });
        const failedDet = det.filter((d) => !d.ok).map((d) => `${d.check}: ${d.detalhe}`);
        const system =
          renderVars(compliance.data.prompt.system, vars) +
          `\n\n${DATA_NOTICE}` +
          section("Regras globais", globalRules) +
          section("Alerta de manipulação", injectionAlert) +
          (await rulesOf(compliance)) +
          section("Resultado das checagens determinísticas", det.map((d) => `${d.ok ? "OK" : "FALHOU"} ${d.check}: ${d.detalhe}`)) +
          // Sem os pareceres, o Compliance julga a sustentacao as cegas e
          // reprova por palpite (no Concierge, o mesmo achado com as fontes).
          section("Pareceres usados", asData("pareceres", pareceres)) +
          section("Citações conferidas", allCitations.map((c) => `${c.citacao}: ${c.status}${c.bloqueada ? " (NÃO CITAR)" : ""}`)) +
          section("Correções pedidas na revisão anterior", feedback) +
          "\n\n" +
          FORMAT.compliance;
        const { value } = await generateJson(baseCall(compliance, span.id, "Revisão de compliance", system, [{ role: "user", content: `Mensagem do usuário:\n${message}\n\nResposta a revisar:\n\n${text}` }]), complianceSchema);
        if (value.zona === "vermelha" && !flags.includes("zona_vermelha")) flags.push("zona_vermelha");
        // Formato antigo, sem `objecoes`: reprovacao com motivos e uma objecao bloqueante.
        const objections: Objection[] = value.objecoes.length
          ? value.objecoes
          : !value.aprovado && (value.motivos.length || value.correcoes.length)
            ? [{ motivo: value.motivos.join(" "), correcao: value.correcoes.join(" "), gravidade: "bloqueante" }]
            : [];
        const blocking = objections.filter((o) => o.gravidade === "bloqueante");
        const improvements = objections.filter((o) => o.gravidade === "melhoria");
        const asText = (o: Objection) => [o.motivo, o.correcao].filter(Boolean).join(" Correção: ");
        return {
          // Melhoria nao reprova: o modelo que diz "aprovado: false" so com
          // melhorias e contrariado pela propria classificacao.
          aprovado: blocking.length === 0 && failedDet.length === 0,
          motivos: [...failedDet, ...blocking.map(asText)],
          failedChecks: failedDet.length > 0,
          zona: value.zona,
          blocking,
          improvements,
        };
      });
      if (verdict.aprovado) {
        stop = "aprovado";
        break;
      }
      const next = decideCycle({ failedChecks: verdict.failedChecks, blocking: verdict.blocking, previous: previousObjections, cycles, maxCycles: cycle.maxCycles });
      await ctx.tracer.wrap(
        { kind: "guardrail", name: "Vale outro ciclo?", nodeId: compliance.id, parentId: root.id, input: { ciclo: cycles + 1, maxCiclos: cycle.maxCycles, falhouChecagem: verdict.failedChecks, bloqueantes: verdict.blocking.length, melhorias: verdict.improvements.length } },
        async () => (next.continue ? { continuar: true, novas: next.fresh.length } : { continuar: false, parada: next.stop }),
      );
      if (!next.continue) {
        stop = next.stop;
        break;
      }
      cycles++;
      previousObjections.push(...verdict.blocking);
      previousVersion = withoutDisclaimer(text);
      mark(consolidator.id, compliance.id);
      feedback = verdict.motivos;
    }

    let finalAnswer = consolidado!;
    let status: TurnOutcome["status"] = "ok";
    // Parou porque outro ciclo nao mudaria nada, nao porque a resposta foi aceita.
    if (stop === "objecao_repetida" || stop === "sem_mudanca") flags.push("compliance_catraca");
    if (stop === "teto" && !verdict.aprovado) flags.push("compliance_teto");
    // So checagem deterministica reprovada (ou zona vermelha) descarta a resposta
    // sempre. Objecao que sobra apenas do modelo, esgotados os ciclos, entrega a
    // ultima versao com ressalva quando o no permite; senao, resposta segura.
    const reservations = !verdict.aprovado && !verdict.failedChecks && verdict.zona !== "vermelha" && cycle.deliverWithReservations;
    if (reservations) flags.push("compliance_ressalvas");
    if (!verdict.aprovado && !reservations) {
      flags.push("compliance_reprovado");
      status = "blocked";
      finalAnswer = {
        ...finalAnswer,
        resposta_simples: [cycle.safeResponse || "Não conseguimos montar uma orientação segura para este caso. Procure a Defensoria Pública, o Procon ou um advogado.", disclaimer].filter(Boolean).join("\n\n"),
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
      especialistas: results.map((r) => ({ nodeId: r.nodeId, name: r.name, ok: r.ok, score: scoreOf.get(r.nodeId), chainedFrom: r.chainedFrom, ...(r.encadeadoDe ? { encadeadoDe: r.encadeadoDe } : {}), reused: r.reused, ...(r.consultadoPor ? { consultadoPor: r.consultadoPor } : {}) })),
      compliance: hasCompliance
        ? {
            aprovado: verdict.aprovado,
            ciclos: cycles + (verdict.aprovado ? 1 : 0),
            motivos: verdict.motivos,
            ...(stop ? { parada: stop } : {}),
            ...(verdict.improvements.length ? { melhorias: verdict.improvements.map((o) => [o.motivo, o.correcao].filter(Boolean).join(" Correção: ")) } : {}),
          }
        : undefined,
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

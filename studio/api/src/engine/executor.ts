import type { ModelMessage } from "ai";
import { db, schema } from "../db/index.js";
import type { FlowGraph, FlowNode } from "../shared/graph.js";
import { callLlm, generateJson, type LlmCall } from "../llm/call.js";
import { runSkill, toolsFor } from "../skills/index.js";
import { checkCompliance } from "../skills/compliance.js";
import type { CitationCheck } from "../skills/citations.js";
import { seedTemplates } from "../seed/files.js";
import { listTools } from "../mcp/client.js";
import type { RunContext } from "./context.js";
import { errorMessage } from "./tracer.js";
import {
  FORMAT,
  classifierSchema,
  complianceSchema,
  consolidadoSchema,
  parecerSchema,
  renderVars,
  section,
  type Classification,
  type Consolidado,
  type Parecer,
} from "./prompts.js";

export interface TurnInput {
  message: string;
  /** `status` so vem nas mensagens do assistente (status do turno que as gerou). */
  history: { role: "user" | "assistant"; content: string; status?: string | null }[];
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
}

export interface TurnOutcome {
  status: "ok" | "clarify" | "blocked" | "error";
  resposta_simples: string;
  resposta_tecnica: string;
  citacoes: CitationCheck[];
  documentos: { fileId: string; name: string; mime: string; template: string }[];
  especialistas: { nodeId: string; name: string; ok: boolean; score?: number; chainedFrom?: string }[];
  classificacao?: Classification;
  flags: string[];
  compliance?: { aprovado: boolean; ciclos: number; motivos: string[] };
  path: { nodes: string[]; edges: string[] };
}

type Specialty = typeof schema.specialty.$inferSelect;

const HISTORY_TURNS = 6;
/** Esclarecimentos seguidos antes de o motor rotear com o que tem. */
const MAX_CLARIFY_STREAK = 2;
const GENERIC_CLARIFY = "Pode me contar um pouco mais sobre o que aconteceu, com quem (empresa ou órgão) e quando?";

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

  const root = await ctx.tracer.start({ kind: "run", name: "Execução", input: { mensagem: input.message, anexos: ctx.files.map((f) => f.name) } });
  const globalRules = [g.settings.globalRules, g.settings.tone && `Tom: ${g.settings.tone}`, `Idioma: ${g.settings.language}`].filter(Boolean).join("\n\n");
  const modelFor = (n: FlowNode) => n.data.model.modelId ?? g.settings.defaultModelId;
  const historyMsgs: ModelMessage[] = input.history.slice(-HISTORY_TURNS).map((h) => ({ role: h.role, content: h.content }));
  // Esclarecimentos seguidos no fim da conversa e as perguntas ja feitas: sem
  // isso o classificador pergunta de novo o que o usuario acabou de responder.
  const assistantTurns = input.history.filter((h) => h.role === "assistant");
  let clarifyStreak = 0;
  for (let i = assistantTurns.length - 1; i >= 0 && assistantTurns[i].status === "clarify"; i--) clarifyStreak++;
  const askedQuestions = assistantTurns.filter((h) => h.status === "clarify").map((h) => h.content.trim());
  // O relato do caso esta espalhado pelas mensagens do usuario: a busca na KB
  // precisa dele inteiro, nao so da ultima resposta ("sim, gastei 300 reais").
  const caseText = [...input.history.filter((h) => h.role === "user").slice(-4).map((h) => h.content), input.message].join("\n").slice(-2000);

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
  const rulesOf = (n: FlowNode) =>
    section("Guardrails deste agente", n.data.rules.guardrails) +
    section("Escalonar para humano quando", n.data.rules.escalation) +
    section("Zona permitida", n.data.rules.zone === "amarela" ? "verde e amarela (orientação com ressalvas)" : "somente verde (orientação geral)");

  const finish = async (o: Omit<TurnOutcome, "path" | "flags">): Promise<TurnOutcome> => {
    const outcome = { ...o, flags, path: path() };
    if (output) {
      await ctx.tracer.wrap({ kind: "agent", name: output.data.name, nodeId: output.id, parentId: root.id, input: { status: o.status } }, async () => ({
        resposta_simples: o.resposta_simples,
        documentos: o.documentos.map((d) => d.name),
      }));
    }
    await root.end({ output: { status: o.status, flags }, tokensIn: ctx.tokensIn, tokensOut: ctx.tokensOut, costUsd: ctx.costUsd });
    return outcome;
  };

  try {
    // ── 1. Entrada ──────────────────────────────────────────────────────
    mark(entry.id);
    const ficha = await ctx.tracer.wrap({ kind: "agent", name: entry.data.name, nodeId: entry.id, parentId: root.id, input: { mensagem: input.message } }, async () => {
      const anexos = ctx.files.map((f) => `### Anexo: ${f.name}\n${f.text ? f.text.slice(0, 6000) : "(sem texto extraído)"}`).join("\n\n");
      // Relato do usuario e o que importa: corte largo. Resposta do Goga, curto.
      const hist = input.history.slice(-HISTORY_TURNS).map((h) => (h.role === "user" ? `Usuário: ${h.content.slice(0, 6000)}` : `Goga: ${h.content.slice(0, 800)}`)).join("\n");
      return [
        `## Mensagem atual\n${input.message.trim()}`,
        hist && `## Conversa anterior\n${hist}`,
        anexos && `## Anexos\n${anexos}`,
      ]
        .filter(Boolean)
        .join("\n\n");
    });
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

    const cls = await ctx.tracer.wrap({ kind: "agent", name: classifier.data.name, nodeId: classifier.id, parentId: root.id, input: { candidatos: candidateInfo.length } }, async (span) => {
      const especialidades = candidateInfo.map((c) => `- ${c.nodeId}: ${c.name} — ${c.escopo}`).join("\n");
      const system =
        renderVars(classifier.data.prompt.system, { ...vars, especialidades }) +
        section("Regras globais", globalRules) +
        section("Gatilhos de exclusão (fora de escopo: só detectar e encaminhar)", routing.exclusionTriggers) +
        section(
          "Perguntas de esclarecimento já feitas nesta conversa (NÃO repita; considere as respostas do usuário na conversa anterior)",
          askedQuestions,
        ) +
        (clarifyStreak >= MAX_CLARIFY_STREAK ? section("Limite de esclarecimentos", "Já foram feitas perguntas demais. Não peça esclarecimento: classifique com os fatos disponíveis.") : "") +
        rulesOf(classifier) +
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

    let selected: FlowNode[] = [];
    let decision: string;
    const encaminhamento = candidates.find((c) => c.data.specialtyNumber === 5);
    if (cls.conflito_interesse) {
      decision = "conflito_interesse";
    } else if (cls.fora_de_escopo) {
      decision = encaminhamento ? "encaminhamento" : "fora_de_escopo_sem_no";
      if (encaminhamento) selected = [encaminhamento];
    } else if (clarifyStreak >= MAX_CLARIFY_STREAK && top === 0) {
      // Limite de esclarecimentos atingido e ainda sem ranking: perguntar de
      // novo so prende o usuario num loop. Falha visivel, com trace.
      throw new Error("Classificador não produziu ranking utilizável após o limite de esclarecimentos (veja a saída da Classificação no trace).");
    } else if ((cls.precisa_esclarecimento || top < routing.clarifyThreshold) && clarifyStreak < MAX_CLARIFY_STREAK) {
      decision = "esclarecimento";
    } else {
      if (cls.precisa_esclarecimento || top < routing.clarifyThreshold) flags.push("esclarecimento_esgotado");
      const above = ranked.filter((r) => r.score >= routing.routingThreshold);
      const pick = (above.length ? above : ranked.slice(0, 1)).slice(0, cls.polo === "reu" && routing.defendantFastPath ? 1 : routing.maxSpecialists);
      selected = pick.map((r) => node(r.nodeId)).filter((n) => n.data.specialtyNumber !== 5 || cls.fora_de_escopo);
      if (!selected.length) selected = pick.map((r) => node(r.nodeId));
      decision = "roteamento";
      if (cls.polo === "reu" && routing.defendantFastPath) flags.push("polo_reu_fast_path");
    }
    await ctx.tracer.wrap({ kind: "route", name: `Roteamento: ${decision}`, nodeId: classifier.id, parentId: root.id, input: { limiar_roteamento: routing.routingThreshold, limiar_esclarecimento: routing.clarifyThreshold, top, esclarecimentos_seguidos: clarifyStreak } }, async () => ({
      decisao: decision,
      selecionados: selected.map((n) => ({ nodeId: n.id, nome: n.data.name, score: scoreOf.get(n.id) })),
    }));
    if (cls.urgencia === "alta") flags.push("urgencia_alta");

    if (decision === "conflito_interesse") {
      flags.push("conflito_interesse");
      return finish({
        status: "blocked",
        resposta_simples: "Não podemos orientar este caso: identificamos um possível conflito de interesse. Procure a Defensoria Pública ou um advogado de sua confiança.",
        resposta_tecnica: "Regra Absoluta nº 2 (conflito de interesse): atendimento bloqueado pelo classificador.",
        citacoes: [],
        documentos: [],
        especialistas: [],
        classificacao: cls,
      });
    }
    if (decision === "fora_de_escopo_sem_no") {
      flags.push("fora_de_escopo");
      return finish({ status: "blocked", resposta_simples: "Este assunto está fora do que o Goga orienta. Procure a Defensoria Pública, a OAB da sua cidade ou um advogado.", resposta_tecnica: "Fora de escopo e o fluxo não tem nó de Encaminhamento (Ag. 5).", citacoes: [], documentos: [], especialistas: [], classificacao: cls });
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
      return finish({ status: "clarify", resposta_simples: q, resposta_tecnica: `Score máximo ${top.toFixed(2)} abaixo do limiar de esclarecimento ${routing.clarifyThreshold} ou lacuna apontada pelo classificador (regra-mãe: uma lacuna por vez).`, citacoes: [], documentos: [], especialistas: [], classificacao: cls });
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
            const r = (await runSkill("buscar_kb", { consulta: caseText }, env)) as { resultados: { titulo: string; base: string; pagina: number | null; trecho: string; armadilha: string | null; document_id: number }[] };
            evidencias = r.resultados
              .filter((p) => !(n.data.knowledge.verifiedOnly && p.armadilha))
              .map((p, i) => `[${i + 1}] ${p.titulo} (base ${p.base}${p.pagina ? `, p. ${p.pagina}` : ""}, doc ${p.document_id})${p.armadilha ? `\n⚠ ARMADILHA: ${p.armadilha}` : ""}\n${p.trecho}`)
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
          rulesOf(n) +
          section("Evidências da base de conhecimento", evidencias || "(nenhuma evidência recuperada)") +
          (prior?.parecer ? section(`Parecer anterior (${prior.name})`, JSON.stringify(prior.parecer)) : "") +
          (n.data.prompt.examples ? section("Exemplos", n.data.prompt.examples) : "") +
          "\n\n" +
          (n.data.prompt.outputFormat === "parecer" ? FORMAT.parecer : "");
        const call = { ...baseCall(n, span.id, `Parecer · ${n.data.name}`, system, [{ role: "user", content: ficha }] as ModelMessage[]), tools: toolsFor(env, mcpTools), maxSteps: 6 };
        let parecer: Parecer;
        if (n.data.prompt.outputFormat === "parecer") {
          parecer = (await generateJson(call, parecerSchema)).value;
        } else {
          const r = await callLlm(call);
          parecer = parecerSchema.parse({ especialidade: n.data.name, resumo_fatos: r.text });
        }
        let citacoes: CitationCheck[] = [];
        if (n.data.tools.skills.includes("verificar_citacao")) {
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

    const firstWave = await Promise.allSettled(selected.map((n) => runSpecialist(n, classifier.id)));
    const results: SpecialistResult[] = firstWave.map((r, i) => (r.status === "fulfilled" ? r.value : { nodeId: selected[i].id, name: selected[i].data.name, specialtyNumber: selected[i].data.specialtyNumber, ok: false, error: errorMessage(r.reason) }));
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
    const okResults = results.filter((r) => r.ok);
    if (!okResults.length) throw new Error(`Nenhum especialista concluiu: ${results.map((r) => `${r.name}: ${r.error}`).join("; ")}`);
    for (const r of okResults) mark(consolidator.id, r.nodeId);

    // ── 4/5. Consolidador <-> Compliance ────────────────────────────────
    const pareceres = JSON.stringify(okResults.map((r) => ({ especialista: r.name, parecer: r.parecer, citacoes_conferidas: r.citacoes })), null, 1);
    const allCitations = okResults.flatMap((r) => r.citacoes ?? []);
    const cycle = compliance?.data.cycle ?? { maxCycles: 2, requiredChecks: ["disclaimer", "sem_promessa", "citacoes_verificadas", "zona", "lgpd"], safeResponse: "" };
    const hasCompliance = compliance && outs(consolidator.id).includes(compliance.id);

    let feedback: string[] = [];
    let consolidado: Consolidado | null = null;
    let verdict = { aprovado: true, motivos: [] as string[] };
    let cycles = 0;
    for (;;) {
      consolidado = await ctx.tracer.wrap({ kind: "agent", name: cycles ? `${consolidator.data.name} (revisão ${cycles})` : consolidator.data.name, nodeId: consolidator.id, parentId: root.id, input: { pareceres: okResults.length, correcoes: feedback } }, async (span) => {
        const system =
          renderVars(consolidator.data.prompt.system, { ...vars, pareceres }) +
          section("Regras globais", globalRules) +
          rulesOf(consolidator) +
          section("Pareceres dos especialistas", pareceres) +
          section("Citações conferidas", allCitations.map((c) => `${c.citacao}: ${c.status}${c.bloqueada ? " (NÃO CITAR)" : ""}`)) +
          section("Modelos de documento disponíveis", seedTemplates().map((t) => `${t.slug}: ${t.titulo} (campos: ${t.campos.map((c) => c.nome).join(", ")})`)) +
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
          rulesOf(compliance) +
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
    if (status === "ok" && finalAnswer.documentos_solicitados.length && consolidator.data.tools.skills.includes("gerar_documento")) {
      const valid = new Set(seedTemplates().map((t) => t.slug));
      for (const slug of finalAnswer.documentos_solicitados.filter((s) => valid.has(s)).slice(0, 3)) {
        await runSkill("gerar_documento", { modelo: slug, campos: finalAnswer.campos_documento, formato: "ambos" }, { ctx, node: consolidator, parentId: root.id }).catch((err) => flags.push(`documento_falhou:${slug}:${errorMessage(err)}`));
      }
    }

    if (output) mark(output.id, hasCompliance && visited.has(compliance.id) ? compliance.id : consolidator.id);
    return finish({
      status,
      resposta_simples: finalAnswer.resposta_simples,
      resposta_tecnica: finalAnswer.resposta_tecnica,
      citacoes: dedupe(allCitations),
      documentos: ctx.generated,
      especialistas: results.map((r) => ({ nodeId: r.nodeId, name: r.name, ok: r.ok, score: scoreOf.get(r.nodeId), chainedFrom: r.chainedFrom })),
      classificacao: cls,
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

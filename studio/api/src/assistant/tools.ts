import type { FastifyInstance } from "fastify";
import { tool, type ToolSet } from "ai";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import type { SessionUser } from "../lib/auth.js";
import { resolveTarget, runOnce } from "../engine/run.js";
import { flowGraphSchema, type FlowGraph } from "../shared/graph.js";
import { applyFlowOps, flowOpSchema, flowSummary, type SpecialtyLike } from "./flowOps.js";

// Ferramentas do Assistente. Quase todas chamam a PROPRIA API do Studio
// (app.inject com o cookie de quem conversa): a validacao, a permissao
// (admin/operador) e a auditoria sao as mesmas da tela, e o log de auditoria
// mostra a pessoa, nao "o assistente". Nada aqui escreve no banco por fora.

export class StudioApi {
  constructor(
    private app: FastifyInstance,
    private cookie: string,
  ) {}

  async call<T = unknown>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    const hasBody = method === "POST" || method === "PUT";
    const res = await this.app.inject({
      method,
      url: `/api/v1${path}`,
      headers: { cookie: this.cookie, ...(hasBody ? { "content-type": "application/json" } : {}) },
      payload: hasBody ? JSON.stringify(body ?? {}) : undefined,
    });
    const isJson = String(res.headers["content-type"] ?? "").includes("json");
    if (res.statusCode >= 400) {
      const data = isJson ? (res.json() as { error?: string; details?: unknown }) : null;
      const details = data?.details ? ` · detalhes: ${clipStr(JSON.stringify(data.details), 1500)}` : "";
      throw new Error(`HTTP ${res.statusCode}: ${data?.error ?? clipStr(res.body, 300)}${details}`);
    }
    return (isJson ? res.json() : res.body) as T;
  }
}

export interface ToolCtx {
  api: StudioApi;
  user: SessionUser;
}

// ── utilitarios ─────────────────────────────────────────────────────────
const MAX_OUT = 28_000;
export const clipStr = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…[cortado: ${s.length - n} caracteres a mais]` : s);

/** Saida grande demais vira texto cortado: o modelo sabe que ha mais e pode refinar a consulta. */
function fit(v: unknown, max = MAX_OUT): unknown {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s.length <= max) return v;
  return { truncado: true, aviso: "saída grande demais; refine a consulta ou leia por partes", conteudo: s.slice(0, max) };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Diferenca campo a campo (listas com `id` casadas por id) para a leitura da auditoria. */
export function diffPaths(a: unknown, b: unknown, clip = 400, path = "", out: { campo: string; antes: unknown; depois: unknown }[] = []) {
  if (out.length >= 80 || JSON.stringify(a) === JSON.stringify(b)) return out;
  const short = (v: unknown) => (typeof v === "string" ? clipStr(v, clip) : v !== undefined && JSON.stringify(v).length > clip ? clipStr(JSON.stringify(v), clip) : v);
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], clip, path ? `${path}.${k}` : k, out);
    return out;
  }
  const keyed = (x: unknown): x is { id: string }[] => Array.isArray(x) && x.every((i) => isObj(i) && typeof i.id === "string");
  if (keyed(a) && keyed(b)) {
    const ma = new Map(a.map((i) => [i.id, i]));
    const mb = new Map(b.map((i) => [i.id, i]));
    for (const id of new Set([...ma.keys(), ...mb.keys()])) diffPaths(ma.get(id), mb.get(id), clip, `${path}[${id}]`, out);
    return out;
  }
  out.push({ campo: path || "(raiz)", antes: short(a), depois: short(b) });
  return out;
}

const runSummary = (r: Record<string, unknown>) => ({
  id: r.id,
  pergunta: clipStr(String(r.question ?? ""), 200),
  fluxo: `${r.flowName} · rev ${r.flowRevision}${r.isProduction ? " (produção)" : ""}`,
  status: r.status,
  erro: r.error ?? undefined,
  custoUsd: r.costUsd,
  avaliacao: r.rating ?? undefined,
  em: r.startedAt,
  usuario: r.userEmail,
  sessaoId: r.sessionId ?? undefined,
});

async function modelLabels(api: StudioApi) {
  const { models } = await api.call<{ models: { id: string; label: string }[] }>("GET", "/models");
  const m = new Map(models.map((x) => [x.id, x.label]));
  return (id: string | null) => (id ? (m.get(id) ?? `modelo inexistente (${id})`) : "—");
}

// ── ferramentas que pausam o turno ──────────────────────────────────────
// Sem `execute`: o laco do AI SDK para e a UI resolve. `perguntar` devolve a
// escolha do usuario; as sensiveis rodam aqui so depois do "Aprovar".

export const ASK_TOOL = "perguntar";

export interface SensitiveTool {
  description: string;
  input: z.ZodObject;
  resumo: (input: Record<string, unknown>) => string;
  run: (input: Record<string, unknown>, ctx: ToolCtx) => Promise<unknown>;
}

const ref = z.string().describe("id (uuid) do registro");

export const SENSITIVE: Record<string, SensitiveTool> = {
  publicar_fluxo: {
    description: "Publica o rascunho atual de um fluxo em PRODUÇÃO (substitui o que está em produção). Pede aprovação do usuário. Valide antes.",
    input: z.object({ fluxoId: ref, motivo: z.string().describe("por que publicar, em uma frase") }),
    resumo: (i) => `Publicar o fluxo ${i.fluxoId} em produção — ${i.motivo}`,
    run: async (i, { api }) => {
      const { flow } = await api.call<{ flow: { revision: number; name: string } }>("GET", `/flows/${i.fluxoId}`);
      const r = await api.call<{ release: unknown }>("POST", `/flows/${i.fluxoId}/publish`, { expectedRevision: flow.revision });
      return { publicado: true, fluxo: flow.name, revisao: flow.revision, release: r.release };
    },
  },
  excluir: {
    description:
      "Exclui um registro. entidade: fluxo | skill | mcp | especialidade | modelo_documento | modelo_llm | conversa_simulada. Itens do sistema (seed) não se excluem: desative-os. Pede aprovação.",
    input: z.object({
      entidade: z.enum(["fluxo", "skill", "mcp", "especialidade", "modelo_documento", "modelo_llm", "conversa_simulada"]),
      id: z.string().describe("id, slug ou nº interno (especialidade: o id interno, não o número)"),
      nome: z.string().describe("nome legível, para o usuário saber o que aprova"),
    }),
    resumo: (i) => `Excluir ${i.entidade} "${i.nome}" (${i.id})`,
    run: async (i, { api }) => {
      const path = {
        fluxo: "/flows/",
        skill: "/skills/",
        mcp: "/mcp/",
        especialidade: "/catalog/specialties/",
        modelo_documento: "/catalog/templates/",
        modelo_llm: "/models/",
        conversa_simulada: "/sessions/",
      }[i.entidade as string];
      return api.call("DELETE", `${path}${encodeURIComponent(String(i.id))}`);
    },
  },
  restaurar_padrao: {
    description: "Restaura o texto padrão (do seed) de uma skill do sistema, especialidade do sistema ou modelo de documento do sistema, descartando a curadoria. Pede aprovação.",
    input: z.object({ entidade: z.enum(["skill", "especialidade", "modelo_documento"]), id: z.string(), nome: z.string() }),
    resumo: (i) => `Restaurar o padrão de ${i.entidade} "${i.nome}" (a curadoria atual será descartada)`,
    run: async (i, { api }) => {
      const path = { skill: "/skills/", especialidade: "/catalog/specialties/", modelo_documento: "/catalog/templates/" }[i.entidade as string];
      return api.call("POST", `${path}${encodeURIComponent(String(i.id))}/reset`);
    },
  },
  iniciar_lote: {
    description: "Inicia uma avaliação em lote (várias execuções reais, com custo). Pede aprovação. Use conjuntos de listar_conjuntos_avaliacao e/ou perguntas próprias.",
    input: z.object({
      nome: z.string(),
      fluxoIds: z.array(z.string()).min(1).max(2),
      conjuntos: z.array(z.string()).default([]),
      porConjunto: z.number().int().min(1).max(100).default(5),
      perguntas: z.array(z.object({ question: z.string(), space: z.string().nullable().default(null) })).default([]),
    }),
    resumo: (i) => `Rodar o lote "${i.nome}" em ${(i.fluxoIds as string[]).length} fluxo(s) (conjuntos: ${(i.conjuntos as string[]).join(", ") || "—"}, ${(i.perguntas as unknown[]).length} pergunta(s) avulsas)`,
    run: async (i, { api }) =>
      api.call("POST", "/eval/batches", { name: i.nome, flowIds: i.fluxoIds, sets: i.conjuntos, perSet: i.porConjunto, questions: i.perguntas }),
  },
  alterar_via_api: {
    description:
      "Escape para qualquer ALTERAÇÃO que as outras ferramentas não cobrem (ex.: provedores, usuários, importar MCP). Chama a API REST do Studio (prefixo /api/v1 já incluído). Pede aprovação. Prefira as ferramentas específicas.",
    input: z.object({
      metodo: z.enum(["POST", "PUT", "DELETE"]),
      caminho: z.string().describe("ex.: /providers/<id>/test"),
      corpo: z.record(z.string(), z.unknown()).optional(),
      motivo: z.string(),
    }),
    resumo: (i) => `${i.metodo} /api/v1${i.caminho} — ${i.motivo}`,
    run: async (i, { api }) => fit(await api.call(i.metodo as "POST", String(i.caminho), i.corpo)),
  },
};

// ── ferramentas que executam direto ─────────────────────────────────────

export function buildTools(ctx: ToolCtx): ToolSet {
  const { api } = ctx;
  const t: ToolSet = {};

  t[ASK_TOOL] = tool({
    description:
      "Faz uma pergunta ao usuário com opções clicáveis (escolha única ou múltipla) e PAUSA até ele responder. Use quando houver uma decisão real a tomar ou para confirmar um plano com alternativas. Não use para perguntas abertas triviais.",
    inputSchema: z.object({
      pergunta: z.string(),
      opcoes: z.array(z.object({ rotulo: z.string(), descricao: z.string().optional() })).min(2).max(8),
      multipla: z.boolean().default(false).describe("true = o usuário pode marcar várias"),
      permitirOutro: z.boolean().default(true).describe("mostra um campo de texto livre"),
    }),
  });

  for (const [name, s] of Object.entries(SENSITIVE)) t[name] = tool({ description: s.description, inputSchema: s.input });

  t.exibir = tool({
    description:
      "Mostra algo visual na conversa: imagem (fileId de anexo ou url), fluxo (desenho do grafo, com nós destacados), tabela ou gráfico de barras. Use para deixar comparações e diagnósticos mais claros.",
    inputSchema: z.object({
      tipo: z.enum(["imagem", "fluxo", "tabela", "grafico"]),
      titulo: z.string().optional(),
      fileId: z.string().optional().describe("imagem: id de um anexo"),
      url: z.string().optional().describe("imagem: URL externa"),
      fluxoId: z.string().optional().describe("fluxo"),
      destacar: z.array(z.string()).optional().describe("fluxo: ids de nós a destacar"),
      colunas: z.array(z.string()).optional().describe("tabela"),
      linhas: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).optional().describe("tabela"),
      dados: z.array(z.object({ rotulo: z.string(), valor: z.number() })).optional().describe("gráfico"),
      unidade: z.string().optional().describe("gráfico: ex. US$, s, %"),
    }),
    execute: async (i) => {
      if (i.tipo === "fluxo" && i.fluxoId) await api.call("GET", `/flows/${i.fluxoId}`);
      return { exibido: true };
    },
  });

  // Visao geral
  t.visao_geral = tool({
    description: "Panorama do Studio: fluxos (e qual está em produção), modelos, contagem de skills, MCP, especialidades, modelos de documento e bases da KB. Bom primeiro passo.",
    inputSchema: z.object({}),
    execute: async () => {
      const [flows, prod, models, skills, mcp, specs, tpls, kb] = await Promise.all([
        api.call<{ flows: Record<string, unknown>[] }>("GET", "/flows"),
        api.call<{ production: unknown }>("GET", "/production"),
        api.call<{ models: Record<string, unknown>[] }>("GET", "/models"),
        api.call<{ skills: { enabled: boolean }[] }>("GET", "/skills"),
        api.call<{ servers: { enabled: boolean }[] }>("GET", "/mcp?refresh=0"),
        api.call<{ specialties: { routable: boolean }[] }>("GET", "/catalog/specialties"),
        api.call<{ templates: { enabled: boolean }[] }>("GET", "/catalog/templates"),
        api.call<{ available: boolean; spaces: { slug: string; name?: string }[] }>("GET", "/kb/spaces"),
      ]);
      return {
        usuario: { nome: ctx.user.name, papel: ctx.user.role },
        producao: prod.production,
        fluxos: flows.flows.map((f) => ({ id: f.id, nome: f.name, revisao: f.revision, nos: f.nodeCount, especialistas: f.specialistCount, emProducao: f.isProduction, alteracoesNaoPublicadas: f.unpublishedChanges })),
        modelos: models.models.map((m) => ({ id: m.id, rotulo: m.label, provedor: m.providerName, uso: m.purpose, ativo: m.usable, padrao: m.isDefault })),
        skills: { total: skills.skills.length, ativas: skills.skills.filter((s) => s.enabled).length },
        mcp: { total: mcp.servers.length, ativos: mcp.servers.filter((s) => s.enabled).length },
        especialidades: { total: specs.specialties.length, roteaveis: specs.specialties.filter((s) => s.routable).length },
        modelosDocumento: { total: tpls.templates.length, ativos: tpls.templates.filter((s) => s.enabled).length },
        kb: { noAr: kb.available, bases: kb.spaces.map((s) => s.slug) },
      };
    },
  });

  t.consultar_api = tool({
    description:
      "Escape para LEITURA de qualquer rota GET da API do Studio (prefixo /api/v1 já incluído), ex.: /providers, /users, /skills/<id>/stats, /mcp/<id>/stats, /flows/<id>/releases, /eval/sets. Prefira as ferramentas específicas.",
    inputSchema: z.object({ caminho: z.string() }),
    execute: async ({ caminho }) => fit(await api.call("GET", caminho)),
  });

  // ── Fluxos ─────────────────────────────────────────────────────────
  t.listar_fluxos = tool({
    description: "Lista os fluxos (rascunhos), com revisão, nº de nós e qual está em produção.",
    inputSchema: z.object({}),
    execute: async () => {
      const [{ flows }, { production }] = await Promise.all([api.call<{ flows: unknown[] }>("GET", "/flows"), api.call<{ production: unknown }>("GET", "/production")]);
      return { producao: production, fluxos: flows };
    },
  });

  t.ler_fluxo = tool({
    description: "Lê um fluxo: configurações, nós (resumo, prompts cortados), ligações, erros de validação e revisão. Para o conteúdo integral de um nó use ler_no.",
    inputSchema: z.object({ fluxoId: z.string() }),
    execute: async ({ fluxoId }) => {
      const r = await api.call<{ flow: { id: string; name: string; description: string; revision: number; graph: FlowGraph }; isProduction: boolean; unpublishedChanges: boolean; errors: unknown[] }>("GET", `/flows/${fluxoId}`);
      return fit({
        id: r.flow.id,
        nome: r.flow.name,
        descricao: r.flow.description,
        revisao: r.flow.revision,
        emProducao: r.isProduction,
        alteracoesNaoPublicadas: r.unpublishedChanges,
        errosDeValidacao: r.errors,
        ...flowSummary(r.flow.graph, await modelLabels(api)),
      });
    },
  });

  t.ler_no = tool({
    description: "Conteúdo integral de um ou mais nós de um fluxo (data completo: prompt, modelo, bases, skills, MCP, regras, roteamento, ciclo).",
    inputSchema: z.object({ fluxoId: z.string(), nos: z.array(z.string()).min(1).describe("ids dos nós") }),
    execute: async ({ fluxoId, nos }) => {
      const r = await api.call<{ flow: { graph: FlowGraph } }>("GET", `/flows/${fluxoId}`);
      return fit(nos.map((id) => r.flow.graph.nodes.find((n) => n.id === id) ?? { id, erro: "nó não existe" }));
    },
  });

  t.ler_configuracoes_fluxo = tool({
    description: "Configurações integrais do fluxo (regras globais, disclaimer, tom, idioma, modelo padrão, custo máximo).",
    inputSchema: z.object({ fluxoId: z.string() }),
    execute: async ({ fluxoId }) => (await api.call<{ flow: { graph: FlowGraph } }>("GET", `/flows/${fluxoId}`)).flow.graph.settings,
  });

  t.criar_fluxo = tool({
    description: "Cria um fluxo novo (com a estrutura mínima padrão) ou duplica um existente (copiarDe). Nunca mexe na produção.",
    inputSchema: z.object({ nome: z.string(), descricao: z.string().default(""), copiarDe: z.string().optional().describe("id do fluxo a duplicar") }),
    execute: async ({ nome, descricao, copiarDe }) => {
      if (copiarDe) {
        const r = await api.call<{ flow: { id: string; revision: number } }>("POST", `/flows/${copiarDe}/duplicate`, { name: nome });
        if (descricao) await api.call("PUT", `/flows/${r.flow.id}`, { description: descricao, expectedRevision: r.flow.revision });
        return { criado: true, fluxoId: r.flow.id };
      }
      const r = await api.call<{ flow: { id: string } }>("POST", "/flows", { name: nome, description: descricao });
      return { criado: true, fluxoId: r.flow.id };
    },
  });

  t.editar_fluxo = tool({
    description:
      "Edita o RASCUNHO de um fluxo com uma lista de operações aplicadas em ordem, numa única revisão (ou nenhuma, se alguma falhar). Para TEXTO use substituir_texto (troca um trecho exato) ou acrescentar_texto — nunca reenvie um prompt inteiro. Para o mesmo valor em vários nós use definir_campo (ex.: nos [\"tipo:specialist\"], caminho \"model.maxTokens\"). Demais: adicionar_no, alterar_no (merge profundo em data, para campos curtos), remover_no, ligar, desligar, alterar_configuracoes (campos curtos), renomear_fluxo. Mantenha cada chamada pequena (idealmente < 3 mil caracteres); para muitas mudanças, faça várias chamadas. Devolve o log, a nova revisão e os erros de validação. Não publica.",
    inputSchema: z.object({ fluxoId: z.string(), operacoes: z.array(flowOpSchema).min(1) }),
    execute: async ({ fluxoId, operacoes }) => {
      const r = await api.call<{ flow: { name: string; description: string; revision: number; graph: FlowGraph } }>("GET", `/flows/${fluxoId}`);
      const specs = operacoes.some((o) => o.op === "adicionar_no" && o.especialidade !== undefined)
        ? (await api.call<{ specialties: SpecialtyLike[] }>("GET", "/catalog/specialties")).specialties
        : [];
      const out = applyFlowOps(flowGraphSchema.parse(r.flow.graph), operacoes, { name: r.flow.name, description: r.flow.description }, specs);
      const saved = await api.call<{ flow: { revision: number }; errors: unknown[] }>("PUT", `/flows/${fluxoId}`, {
        name: out.name,
        description: out.description,
        graph: out.graph,
        expectedRevision: r.flow.revision,
      });
      return { salvo: true, revisaoAnterior: r.flow.revision, revisao: saved.flow.revision, log: out.log, errosDeValidacao: saved.errors };
    },
  });

  t.validar_fluxo = tool({
    description: "Valida o rascunho de um fluxo (estrutura, modelos, bases, skills, MCP).",
    inputSchema: z.object({ fluxoId: z.string() }),
    execute: async ({ fluxoId }) => {
      const r = await api.call<{ errors: unknown[]; flow: { revision: number } }>("GET", `/flows/${fluxoId}`);
      return { revisao: r.flow.revision, valido: r.errors.length === 0, erros: r.errors };
    },
  });

  t.testar_fluxo = tool({
    description:
      "Roda UMA pergunta de teste num fluxo (rascunho, ou produção com producao=true) e devolve o resultado: status, especialistas escolhidos, resposta, compliance, custo e o runId (para analisar_execucao). Tem custo real de LLM.",
    inputSchema: z.object({ pergunta: z.string(), fluxoId: z.string().optional(), producao: z.boolean().default(false) }),
    execute: async ({ pergunta, fluxoId, producao }) => {
      const tg = await resolveTarget({ flowId: fluxoId ?? null, useProduction: producao });
      const r = await runOnce({ user: ctx.user, graph: tg.graph, flowId: tg.flowId, flowName: tg.flowName, revision: tg.revision, message: pergunta });
      if (tg.releaseId) await db.update(schema.run).set({ isProduction: true, flowReleaseId: tg.releaseId }).where(eq(schema.run.id, r.runId));
      const o = r.outcome as Record<string, unknown> | null;
      return fit({
        runId: r.runId,
        fluxo: `${tg.flowName} · rev ${tg.revision}${tg.isProduction ? " (produção)" : ""}`,
        status: o?.status ?? "error",
        erro: r.error ?? undefined,
        custoUsd: r.costUsd,
        especialistas: (o?.especialistas as { name: string }[] | undefined)?.map((e) => e.name),
        resposta: o?.resposta_simples,
        respostaTecnica: o?.resposta_tecnica,
        intencao: o?.intencao,
        atalho: o?.atalho,
        classificacao: o?.classificacao,
        flags: o?.flags,
        compliance: o?.compliance,
        citacoes: o?.citacoes,
      });
    },
  });

  // ── Modelos de LLM ────────────────────────────────────────────────
  t.listar_modelos_llm = tool({
    description: "Lista provedores e modelos de LLM (chat, embedding, visão) com preços, contexto, ativo e padrão. A chave de API nunca aparece.",
    inputSchema: z.object({}),
    execute: async () => fit(await api.call("GET", "/providers")),
  });

  t.salvar_modelo_llm = tool({
    description:
      "Cria (sem id) ou altera (com id) um modelo de LLM. Campos: providerId, modelId, label, purpose (chat|embedding|vision), priceInPer1m, priceOutPer1m, priceCachePer1m, contextWindow, supportsTools, supportsJson, active, isDefault.",
    inputSchema: z.object({ id: z.string().optional(), dados: z.record(z.string(), z.unknown()) }),
    execute: async ({ id, dados }) => (id ? api.call("PUT", `/models/${id}`, dados) : api.call("POST", "/models", dados)),
  });

  // ── Skills ────────────────────────────────────────────────────────
  t.listar_skills = tool({
    description: "Lista as skills (builtin, prompt, http) com ativação, uso nos últimos 30 dias e nº de fluxos que usam.",
    inputSchema: z.object({}),
    execute: async () => {
      const { skills } = await api.call<{ skills: Record<string, unknown>[] }>("GET", "/skills");
      return skills.map((s) => ({ id: s.id, nome: s.name, tipo: s.kind, ativa: s.enabled, descricao: clipStr(String(s.description), 200), uso30d: s.usage30d, fluxos: s.flowCount }));
    },
  });

  t.ler_skill = tool({
    description: "Lê uma skill completa (instruções, esquema de entrada, config http, fluxos que a usam).",
    inputSchema: z.object({ id: z.string() }),
    execute: async ({ id }) => fit(await api.call("GET", `/skills/${encodeURIComponent(id)}`)),
  });

  t.salvar_skill = tool({
    description:
      "Cria (criar=true) ou altera uma skill. Criar: dados = { kind: 'prompt'|'http', name, description, instructions, inputSchema?, llmTool?, enabled?, config?: {url, method, timeoutMs}, headers? }. Alterar: dados parciais { name, description, instructions, enabled, llmTool, inputSchema, config, headers }. Skills builtin só aceitam name, description, instructions, enabled.",
    inputSchema: z.object({ id: z.string(), criar: z.boolean().default(false), dados: z.record(z.string(), z.unknown()) }),
    execute: async ({ id, criar, dados }) => (criar ? api.call("POST", "/skills", { ...dados, id }) : api.call("PUT", `/skills/${encodeURIComponent(id)}`, dados)),
  });

  t.importar_skill = tool({
    description: "Instala skill(s) a partir do conteúdo de um SKILL.md (frontmatter name/description + corpo) ou de um pacote JSON exportado.",
    inputSchema: z.object({ conteudo: z.string(), substituir: z.boolean().default(false) }),
    execute: async ({ conteudo, substituir }) => api.call("POST", "/skills/import", { content: conteudo, overwrite: substituir }),
  });

  t.testar_skill = tool({
    description: "Executa uma skill com uma entrada de teste (como no botão Testar).",
    inputSchema: z.object({ id: z.string(), entrada: z.record(z.string(), z.unknown()).default({}), bases: z.array(z.string()).default([]) }),
    execute: async ({ id, entrada, bases }) => fit(await api.call("POST", `/skills/${encodeURIComponent(id)}/test`, { input: entrada, spaces: bases })),
  });

  // ── MCP ──────────────────────────────────────────────────────────
  t.listar_mcp = tool({
    description: "Lista os servidores MCP com suas ferramentas, estado e último erro.",
    inputSchema: z.object({ atualizar: z.boolean().default(false).describe("reconsulta as ferramentas dos servidores ativos") }),
    execute: async ({ atualizar }) => {
      const { servers } = await api.call<{ servers: Record<string, unknown>[] }>("GET", `/mcp?refresh=${atualizar ? 1 : 0}`);
      return fit(
        servers.map((s) => ({
          id: s.id,
          nome: s.name,
          url: s.url,
          ativo: s.enabled,
          erro: s.lastError,
          fluxos: s.flowCount,
          ferramentas: ((s.toolsCache as { name: string; description?: string }[]) ?? []).map((x) => `${x.name}: ${clipStr(x.description ?? "", 120)}`),
        })),
      );
    },
  });

  t.salvar_mcp = tool({
    description: "Cria (criar=true: dados = { name, url, transport?: http|sse, headers?, enabled?, description? }) ou altera (dados parciais) um servidor MCP.",
    inputSchema: z.object({ id: z.string(), criar: z.boolean().default(false), dados: z.record(z.string(), z.unknown()) }),
    execute: async ({ id, criar, dados }) => (criar ? api.call("POST", "/mcp", { ...dados, id }) : api.call("PUT", `/mcp/${encodeURIComponent(id)}`, dados)),
  });

  t.testar_mcp = tool({
    description: "Reconecta um servidor MCP e atualiza a lista de ferramentas (diagnóstico de conexão).",
    inputSchema: z.object({ id: z.string() }),
    execute: async ({ id }) => fit(await api.call("POST", `/mcp/${encodeURIComponent(id)}/refresh`)),
  });

  t.chamar_ferramenta_mcp = tool({
    description: "Chama uma ferramenta de um servidor MCP com argumentos de teste.",
    inputSchema: z.object({ servidor: z.string(), ferramenta: z.string(), args: z.record(z.string(), z.unknown()).default({}) }),
    execute: async ({ servidor, ferramenta, args }) => fit(await api.call("POST", `/mcp/${encodeURIComponent(servidor)}/call`, { tool: ferramenta, args })),
  });

  // ── Especialidades ────────────────────────────────────────────────
  t.listar_especialidades = tool({
    description: "Lista o catálogo de especialidades (id interno, nº, nome, área, roteável, zona, origem sistema/custom).",
    inputSchema: z.object({}),
    execute: async () => {
      const { specialties } = await api.call<{ specialties: Record<string, unknown>[] }>("GET", "/catalog/specialties");
      return specialties.map((s) => ({ id: s.id, numero: s.number, nome: s.name, area: s.area, cluster: s.cluster, papel: s.role, roteavel: s.routable, zona: s.zone, origem: s.origin, bases: s.defaultSpaces }));
    },
  });

  t.ler_especialidade = tool({
    description: "Lê uma especialidade completa (prompt padrão, bases, skills, dicas de roteamento, escalonamento) e os fluxos que a usam. Use o id interno.",
    inputSchema: z.object({ id: z.number().int() }),
    execute: async ({ id }) => fit(await api.call("GET", `/catalog/specialties/${id}`)),
  });

  t.salvar_especialidade = tool({
    description:
      "Cria (sem id) ou altera (com id interno) uma especialidade. Campos: name, number (só na criação), area, cluster, role (specialist|support), scope, defaultPrompt, defaultSpaces[], defaultSkills[], routingHints {keywords[], examples[]}, escalationRules[], zone (verde|amarela), phase, routable. Mudanças no catálogo NÃO alteram nós já existentes nos fluxos: para isso use editar_fluxo.",
    inputSchema: z.object({ id: z.number().int().optional(), dados: z.record(z.string(), z.unknown()) }),
    execute: async ({ id, dados }) => (id ? api.call("PUT", `/catalog/specialties/${id}`, dados) : api.call("POST", "/catalog/specialties", dados)),
  });

  // ── Modelos de documento ──────────────────────────────────────────
  t.listar_modelos_documento = tool({
    description: "Lista os modelos de documento (slug, título, campos, ativo, origem).",
    inputSchema: z.object({}),
    execute: async () => {
      const { templates } = await api.call<{ templates: Record<string, unknown>[] }>("GET", "/catalog/templates");
      return templates.map((x) => ({ slug: x.slug, titulo: x.title, ativo: x.enabled, origem: x.origin, campos: x.fields, marcadores: x.placeholders }));
    },
  });

  t.ler_modelo_documento = tool({
    description: "Lê um modelo de documento completo (corpo com {{marcadores}}).",
    inputSchema: z.object({ slug: z.string() }),
    execute: async ({ slug }) => {
      const { templates } = await api.call<{ templates: { slug: string }[] }>("GET", "/catalog/templates");
      return templates.find((x) => x.slug === slug) ?? { erro: "modelo não encontrado" };
    },
  });

  t.salvar_modelo_documento = tool({
    description: "Cria (criar=true) ou altera um modelo de documento. Campos: title, description, fields [{nome, rotulo, obrigatorio}], body (texto com {{nome_do_campo}}), enabled.",
    inputSchema: z.object({ slug: z.string(), criar: z.boolean().default(false), dados: z.record(z.string(), z.unknown()) }),
    execute: async ({ slug, criar, dados }) => (criar ? api.call("POST", "/catalog/templates", { ...dados, slug }) : api.call("PUT", `/catalog/templates/${encodeURIComponent(slug)}`, dados)),
  });

  // ── KB ───────────────────────────────────────────────────────────
  t.buscar_kb = tool({
    description: "Busca na base de conhecimento (KB). Sem bases = todas. Útil para conferir se um especialista teria material para responder.",
    inputSchema: z.object({ consulta: z.string(), bases: z.array(z.string()).default([]), topK: z.number().int().min(1).max(20).default(6) }),
    execute: async ({ consulta, bases, topK }) => fit(await api.call("POST", "/kb/search", { query: consulta, spaces: bases, top_k: topK }), 16_000),
  });

  // ── Histórico, conversas, auditoria, custos ───────────────────────
  t.listar_execucoes = tool({
    description: "Lista execuções do histórico com filtros (datas AAAA-MM-DD; padrão últimos 30 dias). status: ok|error|blocked|clarify|running.",
    inputSchema: z.object({
      fluxoId: z.string().optional(),
      status: z.string().optional(),
      producao: z.boolean().optional(),
      texto: z.string().optional().describe("trecho da pergunta"),
      de: z.string().optional(),
      ate: z.string().optional(),
      limite: z.number().int().min(1).max(200).default(30),
    }),
    execute: async (i) => {
      const q = new URLSearchParams();
      if (i.fluxoId) q.set("flowId", i.fluxoId);
      if (i.status) q.set("status", i.status);
      if (i.producao !== undefined) q.set("production", String(i.producao));
      if (i.texto) q.set("q", i.texto);
      if (i.de) q.set("from", i.de);
      if (i.ate) q.set("to", i.ate);
      q.set("limit", String(i.limite));
      const { runs } = await api.call<{ runs: Record<string, unknown>[] }>("GET", `/runs?${q}`);
      return runs.map(runSummary);
    },
  });

  t.analisar_execucao = tool({
    description:
      "Transcrição completa de uma execução (item do histórico): o que cada agente recebeu (prompt, mensagens), o que devolveu, ferramentas, KB, compliance, custos e erros. Base para diagnosticar e propor ajustes.",
    inputSchema: z.object({ runId: z.string(), maxCaracteres: z.number().int().min(2000).max(120_000).default(60_000) }),
    execute: async ({ runId, maxCaracteres }) => clipStr(await api.call<string>("GET", `/runs/${runId}/transcript`), maxCaracteres),
  });

  t.listar_conversas_simuladas = tool({
    description: "Lista as conversas do Simulador do usuário atual.",
    inputSchema: z.object({}),
    execute: async () => {
      const { sessions } = await api.call<{ sessions: Record<string, unknown>[] }>("GET", "/sessions");
      return sessions.map((s) => ({ id: s.id, titulo: s.title, fluxo: s.useProduction ? "produção" : s.flowName, em: s.createdAt }));
    },
  });

  t.ler_conversa_simulada = tool({
    description: "Transcrição completa de uma conversa do Simulador: todas as mensagens e, para cada turno, a execução inteira (agentes, prompts, respostas, custos).",
    inputSchema: z.object({ sessaoId: z.string(), maxCaracteres: z.number().int().min(2000).max(120_000).default(60_000) }),
    execute: async ({ sessaoId, maxCaracteres }) => clipStr(await api.call<string>("GET", `/sessions/${sessaoId}/transcript`), maxCaracteres),
  });

  t.consultar_auditoria = tool({
    description:
      "Consulta o log de auditoria (quem mudou o quê, quando), com a diferença campo a campo de cada alteração. entidade: flow, production, skill, mcp_server, specialty, doc_template, model, provider, user. Só administradores.",
    inputSchema: z.object({
      entidade: z.string().optional(),
      entidadeId: z.string().optional(),
      ator: z.string().optional().describe("e-mail (parcial)"),
      de: z.string().optional(),
      ate: z.string().optional(),
      limite: z.number().int().min(1).max(100).default(20),
    }),
    execute: async (i) => {
      const q = new URLSearchParams();
      if (i.entidade) q.set("entity", i.entidade);
      if (i.entidadeId) q.set("entityId", i.entidadeId);
      if (i.ator) q.set("actor", i.ator);
      if (i.de) q.set("from", i.de);
      if (i.ate) q.set("to", i.ate);
      q.set("limit", String(i.limite));
      const { entries } = await api.call<{ entries: { id: string; at: string; actorEmail: string; action: string; entity: string; entityId: string | null; before: unknown; after: unknown }[] }>("GET", `/audit?${q}`);
      return fit(entries.map((e) => ({ id: e.id, em: e.at, ator: e.actorEmail, acao: e.action, entidade: e.entity, entidadeId: e.entityId, mudancas: diffPaths(e.before, e.after, 240).slice(0, 25) })));
    },
  });

  t.ler_registro_auditoria = tool({
    description: "Diferença completa (textos longos quase inteiros) de UM registro de auditoria, pelo id devolvido em consultar_auditoria.",
    inputSchema: z.object({ id: z.string() }),
    execute: async ({ id }) => {
      if (ctx.user.role !== "admin") throw new Error("HTTP 403: apenas administradores");
      const [e] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.id, id));
      if (!e) throw new Error("registro não encontrado");
      return fit({ em: e.at, ator: e.actorEmail, acao: e.action, entidade: e.entity, entidadeId: e.entityId, mudancas: diffPaths(e.before, e.after, 6000) });
    },
  });

  t.consultar_custos = tool({
    description: "Custos de LLM no período (AAAA-MM-DD), agrupados por provider, model, user, flow ou agent (nó).",
    inputSchema: z.object({ de: z.string().optional(), ate: z.string().optional(), agruparPor: z.enum(["provider", "model", "user", "flow", "agent"]).default("agent") }),
    execute: async (i) => {
      const q = new URLSearchParams({ groupBy: i.agruparPor });
      if (i.de) q.set("from", i.de);
      if (i.ate) q.set("to", i.ate);
      const r = await api.call<Record<string, unknown>>("GET", `/costs?${q}`);
      return fit({ periodo: r.range, kpis: r.kpis, tabela: r.table, kb: r.kb });
    },
  });

  t.listar_lotes = tool({
    description: "Lista as avaliações em lote e os conjuntos de perguntas disponíveis.",
    inputSchema: z.object({}),
    execute: async () => {
      const [b, s] = await Promise.all([api.call("GET", "/eval/batches"), api.call("GET", "/eval/sets")]);
      return fit({ lotes: (b as { batches: unknown }).batches, conjuntos: (s as { sets: unknown }).sets });
    },
  });

  t.ler_lote = tool({
    description: "Resultado de uma avaliação em lote: por pergunta e fluxo, status, especialistas, roteamento certo, compliance, custo e runId.",
    inputSchema: z.object({ id: z.string() }),
    execute: async ({ id }) => fit(await api.call("GET", `/eval/batches/${id}`)),
  });

  t.ler_anexo = tool({
    description: "Texto extraído de um arquivo (anexo desta conversa ou de uma conversa do simulador), pelo fileId.",
    inputSchema: z.object({ fileId: z.string(), inicio: z.number().int().min(0).default(0), tamanho: z.number().int().min(1000).max(60_000).default(30_000) }),
    execute: async ({ fileId, inicio, tamanho }) => {
      const r = await api.call<{ name: string; text: string }>("GET", `/files/${fileId}/text`);
      return { nome: r.name, total: r.text.length, inicio, texto: r.text.slice(inicio, inicio + tamanho) };
    },
  });

  return t;
}

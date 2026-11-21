import { z } from "zod";

// Schemas de saida de cada tipo de no. `.catch()`/defaults generosos de
// proposito: o modelo omite campo opcional com frequencia, e reprovar o parecer
// inteiro por falta de `riscos` jogaria fora o que importa (fatos, fundamentos).

const strList = z.array(z.string()).catch([]);

export const INTENCOES = ["nova_consulta", "continuacao", "pedido_documento", "conversa"] as const;
export type Intencao = (typeof INTENCOES)[number];

export const classifierSchema = z.object({
  // Cada item e validado sozinho: um item torto nao pode zerar o ranking
  // inteiro (ranking vazio = score 0 = esclarecimento eterno). O prompt do
  // preset pede `especialidade` (numero); o motor traduz para nodeId.
  // `ranking` em si e obrigatorio (sem .catch): um JSON sem ele nao e uma
  // classificacao, e tem de cair no reparo em vez de virar "tudo padrao".
  ranking: z
    .array(
      z
        .object({
          nodeId: z.string().catch(""),
          especialidade: z.coerce.number().int().nullable().catch(null).optional(),
          score: z.coerce.number().min(0).max(1).catch(0),
          justificativa: z.string().catch(""),
        })
        .nullable()
        .catch(null),
    )
    .transform((items) => items.filter((i): i is NonNullable<typeof i> => i !== null)),
  polo: z.enum(["autor", "reu", "indefinido"]).catch("indefinido"),
  urgencia: z.enum(["baixa", "normal", "alta"]).catch("normal"),
  foro: z.string().catch(""),
  complexidade: z.enum(["baixa", "media", "alta"]).catch("media"),
  fora_de_escopo: z.boolean().catch(false),
  conflito_interesse: z.boolean().catch(false),
  precisa_esclarecimento: z.boolean().catch(false),
  pergunta_esclarecimento: z.string().nullable().catch("").transform((v) => v ?? ""),
  // Intencao do turno. O padrao (`nova_consulta`) e o caminho completo: se o
  // modelo nao souber dizer, o motor faz o que sempre fez em vez de pegar atalho.
  intencao: z.enum(INTENCOES).catch("nova_consulta"),
  // So vale para `continuacao`: fato novo pede especialista de novo; pergunta
  // sobre a orientacao ja dada reaproveita os pareceres.
  fatos_novos: z.boolean().catch(true),
  resposta_conversa: z.string().nullable().catch("").transform((v) => v ?? ""),
  // Consulta enxuta para a KB. O texto cru do relato (saudacao, desabafo,
  // anexo colado, assinatura) dilui a busca e traz trecho de assunto vizinho.
  consulta_busca: z.string().nullable().catch("").transform((v) => v ?? ""),
});
export type Classification = z.infer<typeof classifierSchema>;

export const parecerSchema = z.object({
  especialidade: z.string().catch(""),
  resumo_fatos: z.string().catch(""),
  enquadramento: strList,
  direitos: strList,
  fundamentos: z
    .array(
      z.union([
        z.object({ citacao: z.string(), fonte_kb: z.string().catch(""), status: z.string().catch("") }),
        z.string().transform((citacao) => ({ citacao, fonte_kb: "", status: "" })),
      ]),
    )
    .catch([]),
  prazos: strList,
  provas_necessarias: strList,
  vias: strList,
  riscos: strList,
  confianca: z.coerce.number().min(0).max(1).catch(0.5),
  precisa_humano: z.boolean().catch(false),
  motivo_humano: z.string().catch(""),
  /** O que o especialista nao conseguiu apurar: e o que a Retriagem le. */
  lacunas: strList,
  /** Pedidos a colegas; o motor decide quais rodam (existe no fluxo, ainda nao rodou, teto). */
  consultar: z
    .array(z.object({ especialista: z.coerce.string(), pergunta: z.string().min(1) }).nullable().catch(null))
    .catch([])
    .transform((items) => items.filter((i): i is NonNullable<typeof i> => i !== null)),
});
export type Parecer = z.infer<typeof parecerSchema>;

export const consolidadoSchema = z.object({
  resposta_simples: z.string().min(1),
  resposta_tecnica: z.string().catch(""),
  citacoes: strList,
  documentos_solicitados: strList,
  campos_documento: z.record(z.string(), z.coerce.string()).catch({}),
});
export type Consolidado = z.infer<typeof consolidadoSchema>;

// Preenchimento de documento pelo atalho `pedido_documento` (sem especialistas).
export const documentoSchema = z.object({
  modelo: z.string().nullable().catch("").transform((v) => v ?? ""),
  campos: z.record(z.string(), z.coerce.string()).catch({}),
  pergunta: z.string().nullable().catch("").transform((v) => v ?? ""),
});
export type DocumentoFill = z.infer<typeof documentoSchema>;

export const complianceSchema = z.object({
  aprovado: z.boolean(),
  zona: z.enum(["verde", "amarela", "vermelha"]).catch("verde"),
  /** Cada objecao com a gravidade: so `bloqueante` reprova; `melhoria` vira nota. */
  objecoes: z
    .array(
      z
        .object({
          motivo: z.string().catch(""),
          correcao: z.string().catch(""),
          // Sem gravidade, vale a regra antiga: objecao reprova.
          gravidade: z.enum(["bloqueante", "melhoria"]).catch("bloqueante"),
        })
        .nullable()
        .catch(null),
    )
    .catch([])
    .transform((items) => items.filter((i): i is NonNullable<typeof i> => !!i && !!(i.motivo || i.correcao))),
  // Formato antigo (sem `objecoes`): lido como objecoes bloqueantes.
  motivos: strList,
  correcoes: strList,
});
export type ComplianceVerdict = z.infer<typeof complianceSchema>;

// O marcador `<<formato:...>>` e lido pelo modelo simulado (llm/mock.ts). Para
// um modelo real ele e inofensivo. Ele vem do motor, nao do texto editavel
// (texts/defaults.ts): quem edita o formato no Studio nao consegue apaga-lo.
export type FormatKind = "classificador" | "parecer" | "consolidado" | "documento" | "compliance" | "retriagem" | "guarda";
export const withFormat = (kind: FormatKind, body: string) => `<<formato:${kind}>>\n${body.trim()}`;

export const REVIEW_LABELS = {
  usuario: "=== Resposta ao usuário (é o que a pessoa lê) ===",
  tecnica: "=== Versão técnica (registro interno, NÃO é enviada ao usuário) ===",
};

/**
 * O que o Compliance revisa. As duas versoes do Consolidador vao rotuladas e
 * separadas: emendadas, a tecnica aparecia "depois do disclaimer" e o
 * Compliance reprovava todo turno por "bloco de bastidor na mensagem".
 */
export function reviewText(c: { resposta_simples: string; resposta_tecnica: string }): string {
  const tecnica = c.resposta_tecnica.trim();
  return `${REVIEW_LABELS.usuario}\n${c.resposta_simples.trim()}` + (tecnica ? `\n\n${REVIEW_LABELS.tecnica}\n${tecnica}` : "");
}

/** A segunda rodada: le as lacunas dos pareceres e decide quem consultar. */
export const retriagemSchema = z.object({
  /**
   * Todo ponto em aberto dos pareceres, com o colega que o fecha. Enumerar antes
   * de decidir e o que faz o modelo nao pular nenhum; o motor usa as `consultas`.
   */
  verificacoes: z
    .array(
      z
        .object({
          texto: z.string().catch(""),
          de: z.string().catch(""),
          quem_responde: z.coerce.string().nullable().catch(null).transform((v) => v?.trim() || null),
        })
        .nullable()
        .catch(null),
    )
    .catch([])
    .transform((items) => items.filter((i): i is NonNullable<typeof i> => !!i && !!i.texto)),
  consultas: z
    .array(
      z
        .object({
          especialista: z.coerce.string(),
          pergunta: z.string().min(1),
          /** O especialista da primeira rodada cuja lacuna o pedido fecha. */
          de: z.coerce.string().catch(""),
        })
        .nullable()
        .catch(null),
    )
    .catch([])
    .transform((items) => items.filter((i): i is NonNullable<typeof i> => i !== null)),
});
export type Retriagem = z.infer<typeof retriagemSchema>;

/** Colega que a primeira rodada pode acionar: especialista do fluxo que nao rodou. */
export interface Colleague {
  nodeId: string;
  name: string;
  escopo: string;
  /** Skills que dizem o que ele consegue apurar (calcular_prazo, calcular_correcao…). */
  ferramentas: string[];
}

const colleagueList = (cs: Colleague[]) =>
  `<<colegas>>\n${cs.map((c) => `- ${c.nodeId}: ${c.name}${c.escopo ? ` — ${c.escopo.slice(0, 200)}` : ""}${c.ferramentas.length ? ` [ferramentas: ${c.ferramentas.join(", ")}]` : ""}`).join("\n")}\n<</colegas>>`;

/** Secao do parecer da primeira rodada: os colegas que podem ser acionados e como pedir. */
export function consultSection(cs: Colleague[], max: number, template: string): string {
  if (!cs.length || max <= 0) return "";
  return section("Consultar colegas", renderVars(template, { colegas: colleagueList(cs), max: String(max) }));
}

/** O fim do prompt da Retriagem (texto editavel `retriagem.formato`). */
export const retriagemFormat = (cs: Colleague[], max: number, template: string) => withFormat("retriagem", renderVars(template, { colegas: colleagueList(cs), max: String(max) }));

export function renderVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

export function section(title: string, body: string | string[]): string {
  const text = Array.isArray(body) ? body.filter(Boolean).map((l) => `- ${l}`).join("\n") : body;
  return text.trim() ? `\n\n## ${title}\n${text.trim()}` : "";
}

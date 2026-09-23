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
  motivos: strList,
  correcoes: strList,
});
export type ComplianceVerdict = z.infer<typeof complianceSchema>;

// O marcador `<<formato:...>>` e lido pelo modelo simulado (llm/mock.ts). Para
// um modelo real ele e inofensivo: vem junto da descricao do formato.
export const FORMAT = {
  classificador: `<<formato:classificador>>
Responda APENAS com um objeto JSON, sem texto fora dele:
{"ranking":[{"nodeId":"<id do candidato>","score":0.0-1.0,"justificativa":"..."}],
 "polo":"autor|reu|indefinido","urgencia":"baixa|normal|alta","foro":"...",
 "complexidade":"baixa|media|alta","fora_de_escopo":bool,"conflito_interesse":bool,
 "precisa_esclarecimento":bool,"pergunta_esclarecimento":"uma única pergunta, se precisar",
 "intencao":"nova_consulta|continuacao|pedido_documento|conversa","fatos_novos":bool,
 "resposta_conversa":"só quando intencao=conversa"}
Intenção da MENSAGEM ATUAL (olhe a conversa anterior):
- nova_consulta: um problema jurídico novo, ou um assunto diferente do caso em andamento. Assunto diferente: o ranking considera SÓ a mensagem atual, não o caso anterior.
- continuacao: sobre o caso em andamento: responde a uma pergunta do Goga, acrescenta fatos ou pergunta sobre a orientação já dada ("e se a loja não responder?", "explica o item 2"). fatos_novos=true se trouxe fato novo relevante; false se só pergunta sobre o que já foi orientado.
- pedido_documento: pede para gerar/redigir um documento (carta, reclamação, notificação) do caso.
- conversa: saudação, agradecimento, despedida ou pergunta sobre o próprio Goga, sem conteúdo jurídico. Escreva resposta_conversa: curta, cordial, sem orientação jurídica, sem prometer resultado; convide a contar o problema se ainda não contou.
Inclua no ranking SOMENTE os candidatos plausíveis (score >= 0.1), no máximo 5, usando exatamente o nodeId informado; candidato omitido vale score 0. Justificativa com no máximo 15 palavras. Seja breve: a resposta tem limite de tamanho.`,
  parecer: `<<formato:parecer>>
Responda APENAS com um objeto JSON (parecer padronizado), sem texto fora dele:
{"especialidade":"...","resumo_fatos":"...","enquadramento":["..."],"direitos":["..."],
 "fundamentos":[{"citacao":"ex.: CDC, art. 14","fonte_kb":"título do trecho da KB usado","status":"VERIFICADA|a verificar"}],
 "prazos":["..."],"provas_necessarias":["..."],"vias":["..."],"riscos":["..."],
 "confianca":0.0-1.0,"precisa_humano":bool,"motivo_humano":"..."}
Cite SOMENTE o que estiver nas evidências da KB ou for retornado por ferramenta. Nunca invente número de lei, súmula, tema ou processo.`,
  consolidado: `<<formato:consolidado>>
Responda APENAS com um objeto JSON, sem texto fora dele:
{"resposta_simples":"linguagem simples, para o cidadão","resposta_tecnica":"versão técnica com fundamentos",
 "citacoes":["..."],"documentos_solicitados":["slug do modelo, só se o usuário pediu um documento"],
 "campos_documento":{"campo":"valor"}}`,
  documento: `<<formato:documento>>
Responda APENAS com um objeto JSON, sem texto fora dele:
{"modelo":"slug do modelo escolhido","campos":{"campo":"valor"},"pergunta":"uma única pergunta pelos campos obrigatórios que faltam, ou vazio"}
Preencha os campos SOMENTE com fatos que o usuário informou ou que estão nos pareceres. Nunca invente nome, CPF, endereço, número de pedido ou data: campo sem informação fica de fora e entra na pergunta.`,
  compliance: `<<formato:compliance>>
Responda APENAS com um objeto JSON, sem texto fora dele:
{"aprovado":bool,"zona":"verde|amarela|vermelha","motivos":["por que reprovou"],"correcoes":["o que o consolidador deve mudar"]}`,
};

export function renderVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

export function section(title: string, body: string | string[]): string {
  const text = Array.isArray(body) ? body.filter(Boolean).map((l) => `- ${l}`).join("\n") : body;
  return text.trim() ? `\n\n## ${title}\n${text.trim()}` : "";
}

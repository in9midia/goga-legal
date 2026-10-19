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
// um modelo real ele e inofensivo: vem junto da descricao do formato.
export const FORMAT = {
  classificador: `<<formato:classificador>>
Responda APENAS com um objeto JSON, sem texto fora dele:
{"ranking":[{"nodeId":"<id do candidato>","score":0.0-1.0,"justificativa":"..."}],
 "polo":"autor|reu|indefinido","urgencia":"baixa|normal|alta","foro":"...",
 "complexidade":"baixa|media|alta","fora_de_escopo":bool,"conflito_interesse":bool,
 "precisa_esclarecimento":bool,"pergunta_esclarecimento":"uma única pergunta, se precisar",
 "intencao":"nova_consulta|continuacao|pedido_documento|conversa","fatos_novos":bool,
 "resposta_conversa":"só quando intencao=conversa",
 "consulta_busca":"o caso como consulta à base jurídica, em uma linha"}
Intenção da MENSAGEM ATUAL (olhe a conversa anterior):
- nova_consulta: um problema jurídico novo, ou um assunto diferente do caso em andamento. Assunto diferente: o ranking considera SÓ a mensagem atual, não o caso anterior.
- continuacao: sobre o caso em andamento: responde a uma pergunta do Goga, acrescenta fatos ou pergunta sobre a orientação já dada ("e se a loja não responder?", "explica o item 2"). fatos_novos=true se trouxe fato novo relevante; false se só pergunta sobre o que já foi orientado.
- pedido_documento: pede para gerar/redigir um documento (carta, reclamação, notificação) do caso.
- conversa: saudação, agradecimento, despedida ou pergunta sobre o próprio Goga, sem conteúdo jurídico. Escreva resposta_conversa: curta, cordial, sem orientação jurídica, sem prometer resultado; convide a contar o problema se ainda não contou.
Inclua no ranking SOMENTE os candidatos plausíveis (score >= 0.1), no máximo 5, usando exatamente o nodeId informado; candidato omitido vale score 0. Justificativa com no máximo 15 palavras. Seja breve: a resposta tem limite de tamanho.
consulta_busca: o caso como consulta à base jurídica, em até 25 palavras: o problema, a relação (consumo, bancária, locação…), o tipo de réu e os termos jurídicos que o relato sugere (ex.: "cobrança indevida de tarifa bancária não contratada, restituição em dobro, dano moral"). Sem saudação, desabafo, nomes de pessoas, documentos pessoais ou datas. Em continuação, junte o que veio antes ao que a mensagem atual acrescenta. Em conversa, vazio.`,
  parecer: `<<formato:parecer>>
Responda APENAS com um objeto JSON (parecer padronizado), sem texto fora dele:
{"especialidade":"...","resumo_fatos":"...","enquadramento":["..."],"direitos":["..."],
 "fundamentos":[{"citacao":"ex.: CDC, art. 14","fonte_kb":"título do trecho da KB usado","status":"VERIFICADA|a verificar"}],
 "prazos":["..."],"provas_necessarias":["..."],"vias":["..."],"riscos":["..."],
 "confianca":0.0-1.0,"precisa_humano":bool,"motivo_humano":"...",
 "lacunas":["o que você não conseguiu apurar e a orientação precisa"]}
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
{"aprovado":bool,"zona":"verde|amarela|vermelha","objecoes":[{"motivo":"o que está errado","correcao":"o que o Consolidador deve mudar","gravidade":"bloqueante|melhoria"}]}
aprovado=true quando não há objeção bloqueante (melhorias não reprovam).
Gravidade:
- bloqueante: afirmação jurídica errada ou sem base nos pareceres e nas citações conferidas, citação não verificada, promessa de resultado, zona vermelha orientada em vez de encaminhada, dado pessoal exposto, ou fuga da pergunta (o direito, o prazo ou a via está num parecer e a resposta não o dá). Algo que levaria a pessoa a agir errado.
- melhoria: todo o resto, mesmo que verdadeiro: ordem, ênfase, cautela a mais, redação, um detalhe a mais.
Na dúvida entre as duas, é melhoria: cada ciclo a mais atrasa a resposta, e o motor não repete objeção já feita.
Como julgar:
- Sustentação: confira a resposta contra os pareceres e as citações conferidas. Não reprove por falta de sustentação o que está neles.
- Orientar a pessoa a agir ("guarde os comprovantes", "registre no Procon") não é promessa nem ação do Goga.
- Numa revisão de correção, verifique se as correções anteriores foram atendidas; não invente objeções novas sobre o que já estava aceitável. Correção já atendida não volta como objeção com outras palavras: aprove.
- O disclaimer final é texto fixo que o sistema acrescenta: nunca peça para removê-lo.`,
};

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
export function consultSection(cs: Colleague[], max: number): string {
  if (!cs.length || max <= 0) return "";
  return section(
    "Consultar colegas",
    `Se a orientação depende de algo que outro especialista apura e você não consegue apurar (o enquadramento em outra área, um prazo ou cálculo de outra relação jurídica, o direito de um réu diferente), acrescente ao JSON "consultar": [{"especialista":"<nodeId>","pergunta":"o que ele deve verificar, específica e autossuficiente"}]. No máximo ${max}. Não peça o que você mesmo pode apurar, não peça por desencargo e não transfira a pergunta inteira: peça o ponto que falta. Sem necessidade, "consultar": [].
Colegas:
${colleagueList(cs)}`,
  );
}

export const retriagemFormat = (cs: Colleague[], max: number) => `<<formato:retriagem>>
Você coordena a segunda rodada do Goga. Os especialistas da primeira rodada já deram parecer; leia as lacunas de cada um e decida quem, entre os colegas abaixo, consegue FECHAR uma lacuna com o próprio escopo e as próprias ferramentas.
Também são lacunas os pontos que o parecer deixa em aberto por depender de outra área ("se a relação for de consumo…", "o prazo depende de quem é o réu", "não calculei a correção").
Não peça: o que nenhum colega apura (um fato que só o usuário sabe: isso é esclarecimento, não consulta); o que já está respondido nos pareceres; a mesma coisa a dois colegas. Sem lacuna real (algo que a orientação precisa e nenhum parecer trouxe), "consultas": [].
Cada pergunta é específica e autossuficiente: o que verificar, sobre quais fatos do relato, e o que devolver.
Faça em duas etapas:
1. "verificacoes": liste todo ponto em aberto dos pareceres; para cada um, "quem_responde": o nodeId do colega que o fecha, ou null se nenhum fecha.
2. "consultas": no máximo ${max}, em ordem de prioridade, as que mais mudam a orientação.
Colegas:
${colleagueList(cs)}
Responda APENAS com um objeto JSON, sem texto fora dele:
{"verificacoes":[{"texto":"o ponto em aberto","de":"<nodeId do especialista>","quem_responde":"<nodeId do colega> ou null"}],
 "consultas":[{"especialista":"<nodeId do colega>","pergunta":"o que verificar e devolver","de":"<nodeId do especialista cuja lacuna isto fecha>"}]}`;

export function renderVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

export function section(title: string, body: string | string[]): string {
  const text = Array.isArray(body) ? body.filter(Boolean).map((l) => `- ${l}`).join("\n") : body;
  return text.trim() ? `\n\n## ${title}\n${text.trim()}` : "";
}

import { z } from "zod";

// Higiene de entrada contra injecao de prompt (portado do Concierge). Tudo o que
// vem de fora (mensagem, historico, anexo, trecho da KB) passa por `neutralize`
// antes de entrar num prompt, e o que e dado recuperado vai num envelope
// `<<dado>>` que o proprio texto nao consegue fechar. Os sinais sao heuristicas
// baratas: nao bloqueiam, so poem o alerta no prompt dos nos seguintes.

export interface InjectionSignal {
  tipo: string;
  /** Forte = ninguem digita isso num relato legitimo. */
  forte: boolean;
  trecho: string;
  /** `mensagem` ou `anexo:<nome>` */
  onde: string;
}

// Caracteres que o leitor nao ve e o modelo le: largura zero, controle de
// direcao (bidi) e o bloco de tags Unicode (U+E0000–E007F), usado para esconder
// instrucoes inteiras.
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/gu;
const UNICODE_TAGS = /[\u{E0000}-\u{E007F}]/gu;

// Marcadores que o proprio motor usa para separar instrucao de dado: vindos do
// usuario, so servem para fechar o envelope e falar "como sistema".
const ENGINE_MARKER = /<<\s*\/?\s*(dado|formato|candidatos|colegas|entrada)\b/i;

const SIGNALS: { tipo: string; forte: boolean; re: RegExp }[] = [
  { tipo: "marcador do motor", forte: true, re: ENGINE_MARKER },
  { tipo: "tag de papel", forte: true, re: /<\|\s*(im_start|im_end|system|assistant|user|endoftext)\s*\|>|\[\/?(INST|SYS)\]|<<\/?SYS>>/i },
  { tipo: "cabeçalho de sistema", forte: false, re: /^\s*(#{1,4}\s*)?(system|instru[çc][õo]es do sistema|developer)\s*(prompt|message)?\s*:/im },
  {
    tipo: "sobrescrever instruções",
    forte: false,
    re: /\b(ignor[ea]\w*|desconsider[ea]\w*|esque[çc][ae]\w*|disregard|forget|override)\b[^.\n]{0,40}\b(instru[çc][õo]es|regras|orienta[çc][õo]es|prompt|instructions|rules)\b[^.\n]{0,30}\b(anteriores|acima|do sistema|originais|previous|above|prior|system)\b/i,
  },
  { tipo: "novas instruções", forte: false, re: /\b(a partir de agora|de agora em diante|from now on)\b[^.\n]{0,60}\b(voc[êe]|you)\b[^.\n]{0,20}\b([ée]|ser[áa]|deve|vai|must|will|are)\b/i },
  { tipo: "troca de papel", forte: false, re: /\b(voc[êe] agora [ée]|you are now|aja como|finja (ser|que)|act as|pretend (to be|you)|modo (desenvolvedor|developer|deus|god)|developer mode|jailbreak)/i },
  {
    tipo: "extrair prompt",
    forte: false,
    re: /\b(mostr[ea]|revel[ea]|exib[ae]|imprim[ae]|repit[ae]|copie|show|reveal|print|repeat|output)\b[^.\n]{0,40}\b(prompt|instru[çc][õo]es (do sistema|iniciais|internas)|system message|mensagem de sistema|initial instructions)\b/i,
  },
];

const excerpt = (text: string, i: number, n: number) => text.slice(Math.max(0, i - 20), i + n + 20).replace(/\s+/g, " ").trim().slice(0, 120);

/** Os sinais de injecao num texto. `onde` diz de que parte da entrada ele veio. */
export function injectionSignals(text: string, onde: string): InjectionSignal[] {
  const found: InjectionSignal[] = [];
  const tags = text.match(UNICODE_TAGS);
  if (tags?.length) found.push({ tipo: "texto escondido (tags Unicode)", forte: true, trecho: `${tags.length} caractere(s) invisível(is)`, onde });
  const invisible = text.match(INVISIBLE);
  // Um ou outro ZWJ aparece em emoji e em texto colado do Word; muitos e ofuscacao.
  if (invisible && invisible.length >= 5) found.push({ tipo: "caracteres invisíveis", forte: false, trecho: `${invisible.length} caractere(s) invisível(is)`, onde });
  // Os padroes rodam no texto sem os invisiveis: "ig​nore" nao pode escapar da regra.
  const clean = text.replace(INVISIBLE, "").replace(UNICODE_TAGS, "");
  for (const { tipo, forte, re } of SIGNALS) {
    const m = re.exec(clean);
    if (m) found.push({ tipo, forte, trecho: excerpt(clean, m.index, m[0].length), onde });
  }
  return found;
}

/**
 * Tira do texto o que so serve para enganar o modelo: caracteres invisiveis e
 * os delimitadores do motor. Toda sequencia de dois ou mais `<` ou `>` vira
 * `‹`/`›` (`<</dado>>` vira `‹‹/dado››`): o envelope nao se fecha por dentro.
 */
export function neutralize(text: string): string {
  return text
    .replace(UNICODE_TAGS, "")
    .replace(INVISIBLE, "")
    .replace(/<{2,}/g, (m) => "‹".repeat(m.length))
    .replace(/>{2,}/g, (m) => "›".repeat(m.length));
}

/** Envelope de dado recuperado. O conteudo e neutralizado: um `<</dado>>` dentro do documento nao fecha o envelope. */
export function asData(origem: string, content: string): string {
  return `<<dado origem="${neutralize(origem).replace(/"/g, "'")}">>\n${neutralize(content)}\n<</dado>>`;
}

// O aviso de dado e o alerta de manipulacao sao textos editaveis
// (texts/defaults.ts: motor.aviso_dado e guarda.alerta).

// ── Guarda de entrada (no `guard`) ──────────────────────────────────────
// Duas camadas: as heuristicas acima, que rodam sem modelo, e um classificador
// por modelo para a frase suspeita que so o sentido revela. O classificador
// tambem e alvo de injecao: so devolve JSON, recebe a mensagem neutralizada e
// envelopada, e o sinal forte decide sem ele.

export const INJECTION_CATEGORIES = ["nenhuma", "sobrescrever_instrucoes", "extrair_prompt", "troca_de_papel", "falsa_autoridade", "acao_indevida", "outro_usuario", "ofuscacao"] as const;

export const guardVerdictSchema = z.object({
  injecao: z.boolean(),
  confianca: z.coerce.number().min(0).max(1).catch(0.5),
  categoria: z.enum(INJECTION_CATEGORIES).catch("nenhuma"),
  motivo: z.string().catch(""),
});
export type GuardVerdict = z.infer<typeof guardVerdictSchema>;

/** A mensagem que o classificador da Guarda le: mensagem e anexos neutralizados, num envelope so. */
export function guardInput(message: string, files: { name: string; text: string }[]): string {
  const parts = [`## Mensagem\n${neutralize(message)}`];
  for (const f of files) parts.push(`## Anexo "${neutralize(f.name)}"\n${neutralize(f.text).slice(0, 6000)}`);
  return `<<entrada>>\n${parts.join("\n\n")}\n<</entrada>>`;
}

export type GuardDecision = "liberar" | "sinalizar" | "bloquear";

/**
 * A decisao da Guarda a partir dos sinais e do veredito do modelo. Funcao pura
 * (testada a parte): o executor so chama o modelo e aplica o resultado.
 */
export function decideGuard(o: {
  signals: InjectionSignal[];
  verdict: GuardVerdict | null;
  /** O modelo foi chamado e falhou (erro, timeout, JSON invalido). */
  failed: boolean;
  config: { modo: "bloquear" | "sinalizar"; limiar: number; usarModelo: boolean; seFalhar: "seguir" | "bloquear" };
}): { decision: GuardDecision; motivos: string[] } {
  const { signals, verdict, failed, config } = o;
  const strong = signals.some((s) => s.forte);
  // Sem o modelo (desligado ou falhou), as heuristicas decidem sozinhas.
  const heuristicOnly = !config.usarModelo || failed;
  const motivos = [
    ...(strong || (heuristicOnly && signals.length) ? signals.map((s) => s.tipo) : []),
    ...(verdict?.injecao && verdict.confianca >= config.limiar ? [`${verdict.categoria} (${verdict.confianca.toFixed(2)}): ${verdict.motivo}`] : []),
    ...(failed && config.seFalhar === "bloquear" ? ["classificador da Guarda indisponível"] : []),
  ];
  if (!motivos.length) return { decision: "liberar", motivos };
  // Sinal fraco sem modelo nunca bloqueia: relato juridico cita "ignore" e
  // "sistema" o tempo todo. So sinaliza (alerta nos prompts seguintes).
  const blockable = strong || (verdict?.injecao && verdict.confianca >= config.limiar) || (failed && config.seFalhar === "bloquear");
  return { decision: config.modo === "bloquear" && blockable ? "bloquear" : "sinalizar", motivos };
}

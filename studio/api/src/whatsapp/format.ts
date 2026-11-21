/**
 * Texto do Goga → WhatsApp, opcoes numeradas e comandos do contato. Funcoes
 * puras (testadas em format.test.ts).
 */

/** Markdown do motor → marcacao do WhatsApp (*negrito*, _italico_, listas com •). */
export function toWhatsApp(md: string): string {
  return (
    md
      .replace(/\r\n/g, "\n")
      // Bloco de codigo: o WhatsApp usa ``` tambem, mas sem a linguagem.
      .replace(/```[a-z]*\n/gi, "```\n")
      // Titulos viram negrito.
      .replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, (_m, t: string) => `*${t.replace(/\*\*/g, "")}*`)
      // **negrito** e __negrito__ → *negrito*
      .replace(/\*\*(.+?)\*\*/g, "*$1*")
      .replace(/__(.+?)__/g, "*$1*")
      // Itens de lista.
      .replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• ")
      // [texto](url) → texto (url)
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_m, t: string, u: string) => (t === u ? u : `${t} (${u})`))
      // Linha horizontal.
      .replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/** Lista numerada das opcoes, no fim da pergunta. */
export function withOptions(text: string, options: string[]): string {
  if (!options.length) return text;
  return `${text.trim()}\n\n${options.map((o, i) => `*${i + 1}.* ${o}`).join("\n")}\n\n_Responda com o número ou escreva a sua resposta._`;
}

/**
 * Resposta curta a uma pergunta com opcoes: "2", "2.", "opção 2", "a 2" ou o
 * proprio texto da opcao viram o texto da opcao. Qualquer outra coisa segue
 * como esta (o contato pode responder livremente).
 */
export function resolveOption(text: string, options: string[]): string | null {
  if (!options.length) return null;
  const t = text.trim().toLowerCase();
  const m = /^(?:op[cç][aã]o\s*|a\s+|n[uú]mero\s*|#)?(\d{1,2})[.)!]?$/.exec(t);
  if (m) {
    const i = Number(m[1]) - 1;
    return i >= 0 && i < options.length ? options[i]! : null;
  }
  const exact = options.find((o) => o.toLowerCase() === t);
  return exact ?? null;
}

const MAX_CHUNK = 3800;

/** Quebra em mensagens de ate ~3800 caracteres, de preferencia entre paragrafos. */
export function chunks(text: string, max = MAX_CHUNK): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export type Command = "nova" | "limpar" | "ajuda" | "cancelar";

const COMMANDS: Record<string, Command> = {
  nova: "nova",
  novo: "nova",
  "nova conversa": "nova",
  "nova sessao": "nova",
  "nova sessão": "nova",
  reiniciar: "nova",
  recomecar: "nova",
  recomeçar: "nova",
  limpar: "limpar",
  "limpar tudo": "limpar",
  apagar: "limpar",
  "apagar tudo": "limpar",
  ajuda: "ajuda",
  help: "ajuda",
  comandos: "ajuda",
  menu: "ajuda",
  cancelar: "cancelar",
  parar: "cancelar",
};

/**
 * Comando do contato: `/nova`, `#limpar`, `!ajuda`... O prefixo e obrigatorio
 * para nao confundir com o relato ("quero limpar meu nome" nao e comando).
 */
export function parseCommand(text: string): Command | null {
  const m = /^\s*[/#!]\s*([a-zçãé ]{3,20})\s*$/i.exec(text);
  if (!m) return null;
  return COMMANDS[m[1]!.trim().toLowerCase()] ?? null;
}

export const isYes = (text: string) => /^\s*(1|sim|s|yes|confirmo|pode|apagar|isso)\b[.!]*\s*$/i.test(text);

export const HELP_TEXT = [
  "*Comandos do Goga*",
  "",
  "*/nova* — começa uma conversa nova (a anterior fica guardada)",
  "*/limpar* — apaga todas as suas conversas e arquivos daqui",
  "*/cancelar* — interrompe a resposta que está sendo preparada",
  "*/ajuda* — mostra esta lista",
  "",
  "Você pode mandar texto, fotos e documentos (PDF, Word ou imagem).",
].join("\n");

// Checagens deterministicas do Compliance (Ag. 8). O modelo julga o que exige
// leitura (tom, promessa implicita); o que da para decidir por padrao de texto
// fica aqui, porque aqui nao ha "desta vez passou".

const PROIBIDOS = [
  /\bgarantid[oa]s?\b/i,
  /com certeza (?:vai|vais|voc[eê] vai) ganhar/i,
  /\b(?:vai|ir[aá]) ganhar\b/i,
  /\bcausa ganha\b/i,
  /\bsem risco\b/i,
  /\b100\s*%\s*(?:de\s+)?(?:chance|certeza)/i,
];
const PERCENTUAL_EXITO = /\d{1,3}\s*%\s*(?:de\s+)?(?:chance|probabilidade|[êe]xito|sucesso)/i;
const ZONA_VERMELHA = /\b(?:prisão|pris[aã]o preventiva|habeas corpus|den[uú]ncia criminal|div[oó]rcio|guarda d[oa]s? filh|pens[aã]o aliment[ií]cia|invent[aá]rio)\b/i;
const CPF = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/;

// O proprio disclaimer diz "nenhum resultado e garantido". Sem tirar o
// disclaimer do texto antes, toda resposta correta reprovava por promessa, e o
// ciclo de compliance terminava sempre na resposta segura padrao.
function withoutDisclaimer(text: string, disclaimer: string): string {
  const d = disclaimer.trim();
  return d ? text.split(d).join(" ") : text;
}

// Negacao logo antes do termo ("nao ha garantia", "nenhum resultado e
// garantido") e o contrario de promessa.
const NEGACAO = /\b(?:n[ãa]o|nenhum[a]?|nunca|sem|jamais)\b[^.!?\n]{0,30}$/i;

export function findPromise(text: string): string | undefined {
  for (const p of [...PROIBIDOS, PERCENTUAL_EXITO]) {
    const re = new RegExp(p.source, p.flags.includes("g") ? p.flags : p.flags + "g");
    for (const m of text.matchAll(re)) {
      const before = text.slice(Math.max(0, (m.index ?? 0) - 40), m.index);
      if (!NEGACAO.test(before)) return m[0];
    }
  }
  return undefined;
}

export interface ComplianceIssue {
  check: string;
  ok: boolean;
  detalhe: string;
}

export function checkCompliance(text: string, opts: { disclaimer: string; checks: string[] }): ComplianceIssue[] {
  const res: ComplianceIssue[] = [];
  const want = new Set(opts.checks);
  if (want.has("disclaimer")) {
    const d = opts.disclaimer.trim();
    // Compara pelo inicio do disclaimer: o consolidador pode quebrar linha ou
    // trocar aspas, e exigir o texto byte a byte reprovaria resposta correta.
    const head = d.slice(0, 60).toLowerCase().replace(/\s+/g, " ");
    const ok = !d || text.toLowerCase().replace(/\s+/g, " ").includes(head);
    res.push({ check: "disclaimer", ok, detalhe: ok ? "disclaimer presente" : "disclaimer final obrigatório ausente" });
  }
  if (want.has("sem_promessa")) {
    const hit = findPromise(withoutDisclaimer(text, opts.disclaimer));
    res.push({ check: "sem_promessa", ok: !hit, detalhe: hit ? `promessa de resultado: "${hit}"` : "sem promessa de resultado" });
  }
  if (want.has("zona")) {
    const hit = text.match(ZONA_VERMELHA)?.[0];
    res.push({ check: "zona", ok: !hit, detalhe: hit ? `tema de zona vermelha na resposta: "${hit}" (só encaminhar)` : "zona verde/amarela" });
  }
  if (want.has("lgpd")) {
    const hit = CPF.test(text);
    res.push({ check: "lgpd", ok: !hit, detalhe: hit ? "resposta expõe número de documento pessoal (CPF)" : "sem dado pessoal exposto" });
  }
  return res;
}

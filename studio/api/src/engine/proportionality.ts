// Portao de proporcionalidade do ciclo Consolidador <-> Compliance (portado do
// Concierge). O Compliance responde "isto esta correto?"; sozinho, ele so sabe
// pedir mais um ciclo. Aqui o motor responde "vale outro ciclo?", por regra e
// nao por discussao: objecao REAL e objecao que VALE UM CICLO sao eixos
// diferentes. No Concierge, antes desta regra, 57% das execucoes chegavam ao
// teto de ciclos e 80% delas saiam reprovadas mesmo assim, quase sempre pela
// mesma objecao reescrita com outras palavras.

export type Severity = "bloqueante" | "melhoria";

export interface Objection {
  motivo: string;
  correcao: string;
  gravidade: Severity;
}

/** Por que o ciclo parou. So `aprovado` quer dizer que o Compliance aceitou a resposta. */
export type CycleStop =
  | "aprovado"
  /** Toda objecao bloqueante deste ciclo ja tinha sido feita antes: outro ciclo nao resolve. */
  | "objecao_repetida"
  /** O Consolidador devolveu o mesmo texto: revisar de novo daria o mesmo veredito. */
  | "sem_mudanca"
  /** Esgotou `maxCycles` com objecao nova ainda aberta. */
  | "teto";

const normalize = (t: string) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

// Vocabulario do proprio revisor: aparece em quase toda objecao e faria duas
// objecoes diferentes parecerem a mesma.
const REVIEWER_WORDS = new Set(
  `resposta afirma afirmacao evidencia evidencias parecer pareceres como para pela pelo mais deve
deveria sobre isso essa esse esta este nao sem com que dos das uma pois mesmo quando ainda apenas
cada entre seja sejam ser sao foi tem traz trazer precisa pede pedido correcao correcoes revisao
anterior texto fato hipotese sustentado sustenta sustentacao base simples tecnica orientacao
consolidador compliance usuario cidadao citacao citacoes`.split(/\s+/),
);

function words(t: string): Set<string> {
  return new Set(
    (normalize(t).match(/[a-z0-9_.]{4,}/g) ?? []).map((w) => w.replace(/\.+$/, "")).filter((w) => w.length >= 4 && !REVIEWER_WORDS.has(w)),
  );
}

/** Termos que identificam o assunto: artigo, numero de lei, sumula, id com digito. */
function marks(t: string): Set<string> {
  return new Set((normalize(t).match(/[a-z0-9_.[\]#/º°-]{3,}/g) ?? []).map((w) => w.replace(/\.+$/, "")).filter((w) => /\d|_/.test(w)));
}

export function similarity(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  const union = A.size + B.size - common;
  return union ? common / union : 0;
}

/**
 * A objecao ja foi feita num ciclo anterior, com outras palavras? Acima de 0,35
 * quase tudo e repeticao; entre 0,2 e 0,35, so quando as duas falam do mesmo
 * termo marcado (art. 14, 8.078/90, Sumula 297). Errar para "nova" custa um
 * ciclo, como antes; errar para "repetida" encerra o ciclo mais cedo.
 */
export function repeatedObjection(o: Objection, previous: Objection[]): boolean {
  const text = `${o.motivo} ${o.correcao}`;
  const mn = marks(text);
  return previous.some((p) => {
    const tp = `${p.motivo} ${p.correcao}`;
    const s = similarity(text, tp);
    if (s >= 0.35) return true;
    if (s < 0.2) return false;
    for (const m of marks(tp)) if (mn.has(m)) return true;
    return false;
  });
}

/** O Consolidador devolveu, em essencia, o mesmo texto (aqui conta toda palavra, numero incluso). */
export function unchanged(before: string, after: string): boolean {
  if (before.trim() === after.trim()) return true;
  const A = new Set(normalize(before).match(/[a-z0-9]+/g) ?? []);
  const B = new Set(normalize(after).match(/[a-z0-9]+/g) ?? []);
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  const union = A.size + B.size - common;
  return union > 0 && common / union >= 0.95;
}

/**
 * Depois de um veredito reprovado, decide se vale outro ciclo. Checagem
 * deterministica falha sempre vale (e barata e o defeito e objetivo); objecao
 * do modelo so vale se for nova.
 */
export function decideCycle(o: {
  failedChecks: boolean;
  blocking: Objection[];
  previous: Objection[];
  cycles: number;
  maxCycles: number;
}): { continue: true; fresh: Objection[] } | { continue: false; stop: CycleStop } {
  const fresh = o.blocking.filter((b) => !repeatedObjection(b, o.previous));
  if (!o.failedChecks && o.previous.length && !fresh.length) return { continue: false, stop: "objecao_repetida" };
  if (o.cycles >= o.maxCycles) return { continue: false, stop: "teto" };
  return { continue: true, fresh };
}

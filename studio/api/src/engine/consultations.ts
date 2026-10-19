// Decisao da segunda rodada (Retriagem, portada do Concierge). O modelo sugere
// quem consultar; o motor decide: so especialista do fluxo, que ainda nao rodou
// neste turno, ate o teto de consultas. Pedido da Retriagem e do proprio
// especialista ao mesmo colega vira um pedido so, com as duas perguntas.

export interface ConsultCandidate {
  nodeId: string;
  name: string;
  specialtyNumber: number | null;
}

export interface ConsultAsk {
  /** Nome do especialista da primeira rodada que tem a lacuna. */
  from: string;
  /** Parecer dele (texto), que o colega le como dado. */
  parecer: string;
  /** Como o modelo identificou o colega: nodeId, nome ou numero da especialidade. */
  target: string;
  pergunta: string;
  origem: "retriagem" | "especialista";
}

/** O que o colega recebe: quem pediu, o que pediu e o que esse ja apurou. */
export interface ConsultRequest {
  de: string;
  pergunta: string;
  parecer: string;
}

export interface ConsultPlan {
  byNode: Map<string, ConsultRequest[]>;
  discarded: { de: string; especialista: string; motivo: string }[];
}

const norm = (t: string) => t.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Acha o candidato pelo nodeId, pelo nome (inteiro ou sem o "N · ") ou pelo numero da especialidade. */
export function findCandidate(target: string, candidates: ConsultCandidate[]): ConsultCandidate | undefined {
  const t = norm(target);
  if (!t) return undefined;
  return (
    candidates.find((c) => norm(c.nodeId) === t) ??
    candidates.find((c) => norm(c.name) === t || norm(c.name.replace(/^\d+\s*·\s*/, "")) === t) ??
    (/^\d+$/.test(t) ? candidates.find((c) => c.specialtyNumber === Number(t)) : undefined)
  );
}

export function planConsultations(o: { asks: ConsultAsk[]; candidates: ConsultCandidate[]; ran: Set<string>; max: number }): ConsultPlan {
  const byNode = new Map<string, ConsultRequest[]>();
  const discarded: ConsultPlan["discarded"] = [];
  for (const a of o.asks) {
    const c = findCandidate(a.target, o.candidates);
    const motivo = !c
      ? "não é especialista deste fluxo"
      : o.ran.has(c.nodeId)
        ? "já respondeu nesta execução"
        : !byNode.has(c.nodeId) && byNode.size >= o.max
          ? "acima do teto de consultas"
          : "";
    if (!c || motivo) {
      discarded.push({ de: a.from, especialista: a.target, motivo });
      continue;
    }
    const list = byNode.get(c.nodeId) ?? [];
    const same = list.find((x) => x.de === a.from);
    if (same) same.pergunta = `${same.pergunta}\n${a.pergunta.slice(0, 1000)}`;
    else list.push({ de: a.from, pergunta: a.pergunta.slice(0, 1000), parecer: a.parecer });
    byNode.set(c.nodeId, list);
  }
  return { byNode, discarded };
}

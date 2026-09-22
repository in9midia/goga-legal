import { MockLanguageModelV4 } from "ai/test";

// Modelo OFFLINE, deterministico. Existe para dois usos: o teste de integracao
// do motor (que nao pode depender de rede nem de chave) e a demonstracao do
// Studio numa maquina sem chave de provedor. Ele nao "entende" nada: le os
// marcadores que o motor poe no prompt (`<<formato:...>>`, `<<candidatos>>`) e
// devolve JSON no formato pedido. Custo zero, e marcado como "Simulado" na UI
// para ninguem confundir com resposta de verdade.

type Part = { type: string; text?: string };
type Msg = { role: string; content: string | Part[] };

function textOf(m: Msg): string {
  if (typeof m.content === "string") return m.content;
  return m.content
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");
}

function between(s: string, tag: string): string | null {
  const m = s.match(new RegExp(`<<${tag}>>([\\s\\S]*?)<</${tag}>>`));
  return m ? m[1] : null;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

function respond(system: string, user: string): unknown {
  const fmt = system.match(/<<formato:([a-z_]+)>>/)?.[1] ?? "";
  const q = norm(user);
  switch (fmt) {
    case "classificador": {
      let cands: { nodeId: string; number: number | null; name: string; keywords: string[] }[] = [];
      try {
        cands = JSON.parse(between(system, "candidatos") ?? "[]");
      } catch {
        /* sem candidatos */
      }
      const ranking = cands
        .map((c) => {
          const hits = c.keywords.filter((k) => k && new RegExp(`(^|[^a-z0-9])${norm(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`).test(q)).length;
          return { nodeId: c.nodeId, score: Math.min(0.95, hits ? 0.5 + hits * 0.15 : 0.1), justificativa: hits ? `${hits} termo(s) do domínio de ${c.name} na mensagem` : "sem aderência" };
        })
        .sort((a, b) => b.score - a.score);
      const fora = /\b(divorcio|pensao alimenticia|guarda|homicidio|furto|roubo|crime)\b/.test(q);
      return {
        ranking,
        polo: /\bme processaram|fui processad|sou reu\b/.test(q) ? "reu" : "autor",
        urgencia: /\burgente|hoje|amanha|liminar|cirurgia\b/.test(q) ? "alta" : "normal",
        foro: "juizado_especial",
        complexidade: "baixa",
        fora_de_escopo: fora,
        conflito_interesse: false,
        precisa_esclarecimento: false,
        pergunta_esclarecimento: "",
      };
    }
    case "parecer":
      return {
        especialidade: system.match(/Especialidade: ([^\n]+)/)?.[1] ?? "Especialista",
        resumo_fatos: user.slice(0, 280),
        enquadramento: ["Relação de consumo (CDC, art. 2º e 3º)"],
        direitos: ["Reparação dos danos materiais comprovados", "Possível dano moral conforme as circunstâncias"],
        fundamentos: [{ citacao: "CDC, art. 14", fonte_kb: "", status: "a verificar" }],
        prazos: ["Verificar prazo com a skill calcular_prazo a partir da data do fato"],
        provas_necessarias: ["Comprovantes, protocolos de atendimento e prints das conversas"],
        vias: ["Reclamação no canal da empresa", "consumidor.gov.br", "Juizado Especial Cível"],
        riscos: ["Resposta gerada por modelo simulado (offline): não use como orientação real"],
        confianca: 0.5,
        precisa_humano: false,
        motivo_humano: "",
      };
    case "consolidado": {
      const docs = /reclamac|notificac|modelo de|documento/.test(q) ? ["reclamacao-consumidor-gov"] : [];
      return {
        resposta_simples:
          "Pelo que você contou, há indícios de falha na prestação do serviço. O primeiro passo é registrar uma reclamação no canal da empresa e guardar os protocolos. (Resposta do modelo simulado, sem valor jurídico.)",
        resposta_tecnica:
          "Aplica-se o CDC (responsabilidade objetiva do fornecedor, art. 14). Recomenda-se tentativa extrajudicial prévia e, frustrada, ajuizamento no JEC. (Modelo simulado.)",
        citacoes: ["CDC, art. 14"],
        documentos_solicitados: docs,
        campos_documento: { fatos: user.slice(0, 500), pedido: "Solução do problema e reparação dos danos." },
      };
    }
    case "compliance":
      return { aprovado: true, zona: "verde", motivos: [], correcoes: [] };
    default:
      return null;
  }
}

export function mockModel(modelId: string) {
  return new MockLanguageModelV4({
    provider: "mock",
    modelId,
    doGenerate: async (options) => {
      const prompt = options.prompt as unknown as Msg[];
      const system = prompt.filter((m) => m.role === "system").map(textOf).join("\n");
      const users = prompt.filter((m) => m.role === "user").map(textOf);
      const user = users[users.length - 1] ?? "";
      const out = respond(system, user);
      const text = out === null ? `Resposta simulada para: ${user.slice(0, 200)}` : JSON.stringify(out);
      const inTok = Math.ceil((system.length + users.join("").length) / 4);
      const outTok = Math.ceil(text.length / 4);
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: inTok, noCache: inTok, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: outTok, text: outTok, reasoning: 0 },
        },
        warnings: [],
      } as never;
    },
  });
}

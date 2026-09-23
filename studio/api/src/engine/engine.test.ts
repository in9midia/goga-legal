// Teste de integracao do motor (criterio de pronto da F4): o fluxo seed roda
// de ponta a ponta contra o Postgres de dev, com o modelo SIMULADO, e o trace
// tem que fazer sentido. Precisa do banco (docker-compose.dev.yml); sem ele,
// o teste e pulado em vez de falhar por motivo alheio ao codigo.
import { beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import pg from "pg";

process.env.STUDIO_SECRET_KEY ||= "teste-integracao-chave-de-32-caracteres";
process.env.STUDIO_ADMIN_PASSWORD ||= "teste-integracao";
process.env.KB_URL ||= "http://127.0.0.1:9"; // KB fora: o motor tem de seguir sem ela

const url = process.env.DATABASE_URL ?? "postgres://studio:studio@localhost:5442/studio";
const dbUp = await new pg.Client({ connectionString: url }).connect().then(() => true, () => false);

describe.skipIf(!dbUp)("motor: fluxo seed com modelo simulado", () => {
  let mods: {
    db: typeof import("../db/index.js");
    run: typeof import("./run.js");
    flows: typeof import("../seed/flows.js");
  };
  let mockId: string;

  beforeAll(async () => {
    mods = { db: await import("../db/index.js"), run: await import("./run.js"), flows: await import("../seed/flows.js") };
    await mods.db.runMigrations();
    await (await import("../seed/index.js")).seed(() => undefined);
    const { db, schema } = mods.db;
    const [m] = await db.select().from(schema.model).where(and(eq(schema.model.modelId, "goga-simulado")));
    mockId = m.id;
  });

  it("roteia, consolida, passa no compliance e registra spans e uso", async () => {
    const { db, schema } = mods.db;
    const graph = mods.flows.buildFlow(mods.flows.FULL_FLOW, mods.flows.FULL_CHAINS, mockId);
    const r = await mods.run.runOnce({ user: null, graph, flowId: null, flowName: "teste", revision: 1, message: "O banco fez um empréstimo no meu nome que eu não contratei e agora estou negativado" });
    expect(r.error).toBeNull();
    const o = r.outcome!;
    expect(o.status).toBe("ok");
    expect(o.especialistas.map((e) => e.name).join(" ")).toMatch(/Bancário/);
    // 15 -> 23 (dano moral) e encadeamento do seed
    expect(o.especialistas.some((e) => e.chainedFrom === "sp-15")).toBe(true);
    expect(o.compliance?.aprovado).toBe(true);
    expect(o.resposta_simples).toContain(graph.settings.disclaimer.slice(0, 30));
    expect(o.path.nodes).toEqual(expect.arrayContaining(["entry", "classifier", "sp-15", "consolidator", "compliance", "output"]));

    const spans = await db.select().from(schema.span).where(eq(schema.span.runId, r.runId)).orderBy(asc(schema.span.seq));
    const kinds = new Set(spans.map((s) => s.kind));
    for (const k of ["run", "agent", "llm", "route", "guardrail", "kb"]) expect(kinds).toContain(k);
    expect(spans.every((s) => s.status !== "running")).toBe(true);
    // KB fora do ar: a busca falha como span de erro, o especialista nao.
    expect(spans.find((s) => s.kind === "kb")?.status).toBe("error");
    const usage = await db.select().from(schema.usage).where(eq(schema.usage.runId, r.runId));
    expect(usage.length).toBe(spans.filter((s) => s.kind === "llm").length);
  }, 30000);

  it("pede esclarecimento quando nada tem aderência", async () => {
    const graph = mods.flows.buildFlow(mods.flows.PHASE1_FLOW, mods.flows.PHASE1_CHAINS, mockId);
    const r = await mods.run.runOnce({ user: null, graph, flowId: null, flowName: "teste", revision: 1, message: "tenho uma dúvida" });
    expect(r.outcome?.status).toBe("clarify");
  }, 30000);

  // Conversa de varios turnos: cada tipo de mensagem pega o caminho dela, e o
  // numero de chamadas de LLM por turno e a medida de que o atalho funciona.
  it("conversa de vários turnos: atalhos por intenção e estado do caso", async () => {
    const { db, schema } = mods.db;
    const graph = mods.flows.buildFlow(mods.flows.FULL_FLOW, mods.flows.FULL_CHAINS, mockId);
    type Hist = NonNullable<Parameters<typeof mods.run.runOnce>[0]["history"]>;
    const history: Hist = [];
    let caso: Parameters<typeof mods.run.runOnce>[0]["caso"] = null;
    const turn = async (message: string) => {
      const r = await mods.run.runOnce({ user: null, graph, flowId: null, flowName: "teste", revision: 1, message, history: [...history], caso });
      expect(r.error).toBeNull();
      const o = r.outcome!;
      history.push({ role: "user", content: message }, { role: "assistant", content: o.resposta_simples, status: o.pendencia === "documento" ? "clarify_documento" : o.status });
      caso = o.caso;
      const spans = await db.select().from(schema.span).where(eq(schema.span.runId, r.runId));
      return { o, llm: spans.filter((s) => s.kind === "llm").length };
    };

    const oi = await turn("oi");
    expect(oi.o.atalho).toBe("conversa");
    expect(oi.o.especialistas).toEqual([]);
    expect(oi.llm).toBe(1); // so o classificador
    expect(oi.o.caso.relato).toEqual([]);

    const caso1 = await turn("O banco fez um empréstimo no meu nome que eu não contratei e agora estou negativado");
    expect(caso1.o.atalho).toBe("completo");
    expect(caso1.o.caso.pareceres.length).toBeGreaterThan(0);

    const duvida = await turn("e se o banco não responder?");
    expect(duvida.o.atalho).toBe("reuso");
    expect(duvida.o.especialistas.every((e) => e.reused)).toBe(true);
    expect(duvida.llm).toBe(3); // classificador + consolidador + compliance
    expect(duvida.llm).toBeLessThan(caso1.llm);
    expect(duvida.o.caso.relato).toHaveLength(2);

    const obrigado = await turn("obrigado");
    expect(obrigado.o.atalho).toBe("conversa");
    expect(obrigado.llm).toBe(1);
    expect(obrigado.o.caso.pareceres.length).toBe(caso1.o.caso.pareceres.length);

    const pede = await turn("gera a reclamação no procon");
    expect(pede.o.atalho).toBe("documento");
    expect(pede.o.status).toBe("clarify");
    expect(pede.o.pendencia).toBe("documento");
    expect(pede.o.caso.documento_pendente?.modelo).toBe("reclamacao-procon");
    expect(pede.llm).toBe(2); // classificador + preenchimento

    const dados = await turn("nome_consumidor: Maria Souza; cpf_consumidor: 111.444.777-35; contato_consumidor: maria@example.com; empresa: Banco X; documentos_anexos: extrato; cidade: Recife");
    expect(dados.o.atalho).toBe("documento");
    expect(dados.o.status).toBe("ok");
    expect(dados.o.documentos.map((d) => d.name).sort()).toEqual(["reclamacao-procon.docx", "reclamacao-procon.pdf"]);
    expect(dados.o.caso.documento_pendente).toBeNull();
    expect(dados.o.caso.documentos).toContain("reclamacao-procon");

    const novo = await turn("Comprei uma geladeira que veio com defeito e a loja não quer trocar");
    expect(novo.o.atalho).toBe("completo");
    expect(novo.o.flags).toContain("novo_assunto");
    expect(novo.o.caso.relato).toEqual(["Comprei uma geladeira que veio com defeito e a loja não quer trocar"]);
    expect(novo.o.caso.documentos).toEqual([]);
  }, 60000);

  it("fora de escopo vai para o Encaminhamento (Ag. 5)", async () => {
    const graph = mods.flows.buildFlow(mods.flows.FULL_FLOW, mods.flows.FULL_CHAINS, mockId);
    const r = await mods.run.runOnce({ user: null, graph, flowId: null, flowName: "teste", revision: 1, message: "quero saber sobre divórcio e guarda dos filhos" });
    expect(r.outcome?.especialistas.map((e) => e.nodeId)).toEqual(["sp-5"]);
  }, 30000);
});

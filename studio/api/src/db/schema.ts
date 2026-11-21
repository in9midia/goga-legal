import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const appUser = pgTable("app_user", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["admin", "operador"] }).notNull().default("operador"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const appSession = pgTable("app_session", {
  sid: text("sid").primaryKey(),
  data: jsonb("data").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// Token de API pessoal: agentes externos (Claude Code, Codex, Gemini CLI)
// operam o Studio como a pessoa que criou o token, com o mesmo papel e a mesma
// auditoria. So o hash fica no banco; o token aparece uma vez, na criacao.
export const apiToken = pgTable(
  "api_token",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUser.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    prefix: text("prefix").notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("api_token_user_idx").on(t.userId)],
);

// Login de agente pelo navegador (fluxo tipo "device code"): o CLI abre um
// pedido, a pessoa autoriza logada no Studio e o CLI, que consulta com o
// segredo `device_hash`, recebe um token novo. O token so e gerado nessa
// consulta: nada em claro fica guardado aqui.
export const agentLogin = pgTable("agent_login", {
  id: uuid("id").primaryKey().defaultRandom(),
  deviceHash: text("device_hash").notNull().unique(),
  userCode: text("user_code").notNull().unique(),
  client: text("client").notNull(),
  status: text("status", { enum: ["pending", "approved", "denied", "consumed"] }).notNull().default("pending"),
  userId: uuid("user_id").references(() => appUser.id, { onDelete: "cascade" }),
  expiresInDays: integer("expires_in_days"),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const provider = pgTable("provider", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["deepseek", "gemini", "openai_compat", "mock"] }).notNull(),
  baseUrl: text("base_url").notNull().default(""),
  apiKeyEnc: text("api_key_enc").notNull().default(""),
  apiKeyTail: text("api_key_tail").notNull().default(""),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const model = pgTable("model", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerId: uuid("provider_id")
    .notNull()
    .references(() => provider.id, { onDelete: "cascade" }),
  modelId: text("model_id").notNull(),
  label: text("label").notNull(),
  purpose: text("purpose", { enum: ["chat", "embedding", "vision"] }).notNull(),
  priceInPer1m: doublePrecision("price_in_per_1m").notNull().default(0),
  priceOutPer1m: doublePrecision("price_out_per_1m").notNull().default(0),
  priceCachePer1m: doublePrecision("price_cache_per_1m").notNull().default(0),
  contextWindow: integer("context_window").notNull().default(0),
  supportsTools: boolean("supports_tools").notNull().default(true),
  supportsJson: boolean("supports_json").notNull().default(true),
  active: boolean("active").notNull().default(true),
  isDefault: boolean("is_default").notNull().default(false),
});

export const specialty = pgTable("specialty", {
  id: serial("id").primaryKey(),
  number: integer("number").notNull().unique(),
  name: text("name").notNull(),
  area: text("area").notNull().default(""),
  cluster: text("cluster").notNull().default(""),
  role: text("role").notNull().default("specialist"),
  routable: boolean("routable").notNull().default(true),
  scope: text("scope").notNull().default(""),
  defaultPrompt: text("default_prompt").notNull().default(""),
  defaultSpaces: jsonb("default_spaces").$type<string[]>().notNull().default([]),
  defaultSkills: jsonb("default_skills").$type<string[]>().notNull().default([]),
  routingHints: jsonb("routing_hints")
    .$type<{ keywords: string[]; examples: string[] }>()
    .notNull()
    .default({ keywords: [], examples: [] }),
  escalationRules: jsonb("escalation_rules").$type<string[]>().notNull().default([]),
  phase: integer("phase").notNull().default(1),
  zone: text("zone").notNull().default("verde"),
});

// Skills e servidores MCP sao cadastros editaveis. As skills "builtin" tem a
// implementacao no codigo (skills/index.ts): o seed garante a linha e o
// esquema de entrada, mas nome, descricao, instrucoes e o liga/desliga sao da
// curadoria e o seed nao os sobrescreve. `defaults` guarda o texto do codigo
// para o "restaurar padrao".
export const skill = pgTable("skill", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  inputSchema: jsonb("input_schema").notNull(),
  kind: text("kind", { enum: ["builtin", "prompt", "http"] }).notNull().default("builtin"),
  enabled: boolean("enabled").notNull().default(true),
  llmTool: boolean("llm_tool").notNull().default(true),
  // Texto injetado no prompt dos agentes que tem a skill. Numa skill "prompt"
  // e o proprio corpo (o SKILL.md); nas outras, orientacao de uso opcional.
  instructions: text("instructions").notNull().default(""),
  // http: { url, method, timeoutMs }
  config: jsonb("config").notNull().default({}),
  // Cabecalhos do http (podem ter token), cifrados como a chave de API.
  secretEnc: text("secret_enc").notNull().default(""),
  defaults: jsonb("defaults"),
  source: text("source").notNull().default(""),
  version: integer("version").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mcpServer = pgTable("mcp_server", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  transport: text("transport", { enum: ["http", "sse"] }).notNull().default("http"),
  authMode: text("auth_mode").notNull().default("none"),
  headersEnc: text("headers_enc").notNull().default(""),
  toolsCache: jsonb("tools_cache").notNull().default([]),
  enabled: boolean("enabled").notNull().default(false),
  description: text("description").notNull().default(""),
  // "system" = cadastrado pelo seed (a URL do goga-kb acompanha KB_URL).
  origin: text("origin").notNull().default("custom"),
  lastError: text("last_error"),
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Modelos de documento (gerar_documento). O seed insere os de
// seed/templates.json uma vez e nao sobrescreve: o texto e da curadoria. Os do
// seed nao se excluem (voltariam no proximo boot), so se desativam; o
// "restaurar padrao" le o arquivo de seed.
export const docTemplate = pgTable("doc_template", {
  slug: text("slug").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  fields: jsonb("fields").$type<{ nome: string; rotulo: string; obrigatorio?: boolean }[]>().notNull().default([]),
  body: text("body").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const flow = pgTable("flow", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  graph: jsonb("graph").notNull(),
  revision: integer("revision").notNull().default(1),
  createdBy: uuid("created_by").references(() => appUser.id),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const flowRelease = pgTable("flow_release", {
  id: uuid("id").primaryKey().defaultRandom(),
  flowId: uuid("flow_id")
    .notNull()
    .references(() => flow.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  graph: jsonb("graph").notNull(),
  publishedBy: uuid("published_by").references(() => appUser.id),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
});

// Singleton: a linha com id = 1 e "o" fluxo de producao. Uma tabela de uma
// linha, e nao uma flag em flow_release, porque a flag permitiria dois "em
// producao" no meio de uma troca concorrente; aqui a troca e um UPDATE so.
export const production = pgTable("production", {
  id: integer("id").primaryKey().default(1),
  flowReleaseId: uuid("flow_release_id").references(() => flowRelease.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chatSession = pgTable("session", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull().default("Nova conversa"),
  userId: uuid("user_id").references(() => appUser.id),
  flowId: uuid("flow_id").references(() => flow.id, { onDelete: "set null" }),
  useProduction: boolean("use_production").notNull().default(false),
  // Conversa de um contato do WhatsApp (sem usuario do Studio). O /limpar do
  // contato apaga todas as conversas com este vinculo.
  whatsappContactId: uuid("whatsapp_contact_id"),
  createdAt: createdAt(),
});

export const run = pgTable(
  "run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flowId: uuid("flow_id").references(() => flow.id, { onDelete: "set null" }),
    flowName: text("flow_name").notNull().default(""),
    flowRevision: integer("flow_revision").notNull(),
    flowReleaseId: uuid("flow_release_id"),
    // O grafo que rodou, copiado. O rascunho muda depois; o trace precisa
    // continuar correspondendo ao que executou.
    graph: jsonb("graph").notNull(),
    isProduction: boolean("is_production").notNull().default(false),
    sessionId: uuid("session_id").references(() => chatSession.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => appUser.id),
    question: text("question").notNull().default(""),
    status: text("status", { enum: ["running", "ok", "error", "blocked", "clarify"] })
      .notNull()
      .default("running"),
    error: text("error"),
    outcome: jsonb("outcome"),
    rating: integer("rating"),
    ratingComment: text("rating_comment"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
  },
  (t) => [index("run_started_idx").on(t.startedAt), index("run_session_idx").on(t.sessionId)],
);

export const message = pgTable(
  "message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => chatSession.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    payload: jsonb("payload"),
    attachments: jsonb("attachments").$type<string[]>().notNull().default([]),
    runId: uuid("run_id").references(() => run.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("message_session_idx").on(t.sessionId)],
);

export const span = pgTable(
  "span",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    nodeId: text("node_id"),
    kind: text("kind", {
      enum: ["run", "agent", "llm", "tool", "mcp", "kb", "guardrail", "route"],
    }).notNull(),
    name: text("name").notNull(),
    input: jsonb("input"),
    output: jsonb("output"),
    status: text("status", { enum: ["running", "ok", "error", "skipped"] })
      .notNull()
      .default("running"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    ms: integer("ms"),
    modelId: uuid("model_id"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    seq: integer("seq").notNull().default(0),
  },
  (t) => [index("span_run_idx").on(t.runId)],
);

export const file = pgTable("file", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").references(() => chatSession.id, { onDelete: "cascade" }),
  runId: uuid("run_id"),
  direction: text("direction", { enum: ["in", "out"] }).notNull(),
  name: text("name").notNull(),
  mime: text("mime").notNull(),
  size: bigint("size", { mode: "number" }).notNull(),
  sha256: text("sha256").notNull(),
  path: text("path").notNull(),
  extractedText: text("extracted_text"),
  createdAt: createdAt(),
});

export const usage = pgTable(
  "usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").references(() => run.id, { onDelete: "set null" }),
    spanId: uuid("span_id"),
    userId: uuid("user_id"),
    flowId: uuid("flow_id"),
    nodeId: text("node_id"),
    nodeName: text("node_name"),
    specialtyNumber: integer("specialty_number"),
    providerId: uuid("provider_id"),
    modelId: uuid("model_id"),
    operation: text("operation").notNull().default("chat"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    tokensCache: integer("tokens_cache").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("usage_created_idx").on(t.createdAt)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id"),
    actorEmail: text("actor_email").notNull().default("system"),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_at_idx").on(t.at)],
);

// Textos do motor editados no Studio (tela Prompts): formatos de saida, Guarda,
// Retriagem, respostas padrao. O padrao fica no codigo (texts/defaults.ts); so o
// que alguem editou mora aqui, e restaurar apaga a linha.
export const engineText = pgTable("engine_text", {
  key: text("key").primaryKey(),
  text: text("text").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by").notNull().default("system"),
});

// Lote de avaliacao (F7): as perguntas de content/evaluation rodadas contra um
// ou dois fluxos. Os resultados ficam no jsonb porque sao lidos inteiros, nunca
// consultados por campo.
export const evalBatch = pgTable("eval_batch", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  flowIds: jsonb("flow_ids").$type<string[]>().notNull(),
  questions: jsonb("questions").$type<{ question: string; space: string | null; kind?: string }[]>().notNull(),
  results: jsonb("results").$type<unknown[]>().notNull().default([]),
  status: text("status", { enum: ["running", "done", "error", "cancelled"] }).notNull().default("running"),
  error: text("error"),
  createdBy: uuid("created_by").references(() => appUser.id),
  createdAt: createdAt(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

// Assistente do Studio: um agente que opera o proprio Studio (fluxos,
// catalogos, skills, MCP, historico) pelas mesmas rotas da UI. `llm` guarda as
// ModelMessages que a linha contribui para o historico enviado ao modelo;
// `parts` e o que a UI desenha (texto, chamadas de ferramenta, perguntas,
// aprovacoes). Sao separados porque a UI mostra mais (e menos) do que o modelo ve.
export const assistantSession = pgTable("assistant_session", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => appUser.id, { onDelete: "cascade" }),
  title: text("title").notNull().default("Nova conversa"),
  modelId: uuid("model_id").references(() => model.id, { onDelete: "set null" }),
  // Discussao aberta a partir de uma conversa do Simulador ("Discutir com o
  // assistente"): o log dela entra como contexto e novas interacoes sao
  // acrescentadas quando o botao e usado de novo.
  simSessionId: uuid("sim_session_id").references(() => chatSession.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const assistantMessage = pgTable(
  "assistant_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => assistantSession.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    // "running" = resposta sendo gravada aos poucos; se a API cair no meio, o
    // boot a fecha como interrompida (com o que ja tinha sido feito).
    status: text("status", { enum: ["running", "done"] }).notNull().default("done"),
    content: text("content").notNull().default(""),
    parts: jsonb("parts").$type<unknown[]>().notNull().default([]),
    llm: jsonb("llm").$type<unknown[]>().notNull().default([]),
    attachments: jsonb("attachments").$type<string[]>().notNull().default([]),
    modelId: uuid("model_id"),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("assistant_message_session_idx").on(t.sessionId, t.createdAt)],
);

// ── WhatsApp nao oficial (Evolution API) ────────────────────────────────
// Um numero = uma instancia do Evolution, ligada a UM fluxo de atendimento.
// O estado da sessao (QR, conectado, caiu) espelha o Evolution: webhook
// CONNECTION_UPDATE + verificacao a cada minuto.
export const whatsappNumber = pgTable("whatsapp_number", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  instanceName: text("instance_name").notNull().unique(),
  // Fluxo que atende: o de producao (segue a publicacao) ou um fluxo especifico
  // (a ultima versao publicada dele; sem publicacao, o rascunho).
  useProduction: boolean("use_production").notNull().default(true),
  flowId: uuid("flow_id").references(() => flow.id, { onDelete: "set null" }),
  enabled: boolean("enabled").notNull().default(true),
  state: text("state", { enum: ["not_created", "connecting", "open", "close"] }).notNull().default("not_created"),
  qrCode: text("qr_code"),
  pairingCode: text("pairing_code"),
  qrUpdatedAt: timestamp("qr_updated_at", { withTimezone: true }),
  number: text("number"),
  profileName: text("profile_name"),
  statusReason: integer("status_reason"),
  connectedAt: timestamp("connected_at", { withTimezone: true }),
  disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
  lastEventAt: timestamp("last_event_at", { withTimezone: true }),
  restartRequestedAt: timestamp("restart_requested_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => appUser.id),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const whatsappContact = pgTable(
  "whatsapp_contact",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    numberId: uuid("number_id")
      .notNull()
      .references(() => whatsappNumber.id, { onDelete: "cascade" }),
    // JID do WhatsApp (telefone@s.whatsapp.net ou id@lid): o destino das respostas.
    jid: text("jid").notNull(),
    phone: text("phone"),
    name: text("name"),
    // Conversa atual do contato (o /nova abre outra).
    sessionId: uuid("session_id").references(() => chatSession.id, { onDelete: "set null" }),
    // Opcoes da ultima pergunta do Goga: "2" vira o texto da opcao 2.
    pendingOptions: jsonb("pending_options").$type<string[]>().notNull().default([]),
    // Comando esperando confirmacao (ex.: limpar).
    pendingCommand: text("pending_command"),
    // Turno em execucao: enquanto houver, as mensagens novas esperam na fila.
    busyRunId: uuid("busy_run_id"),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("whatsapp_contact_number_jid_idx").on(t.numberId, t.jid)],
);

// Mensagem recebida: gravada ANTES de responder 200 ao webhook (o Evolution
// reenvia o que nao foi aceito) e processada pela fila. Nada se perde se o
// Studio cair no meio: o que estava em `processing` volta para a fila no boot.
export const whatsappInbound = pgTable(
  "whatsapp_inbound",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    numberId: uuid("number_id")
      .notNull()
      .references(() => whatsappNumber.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => whatsappContact.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    kind: text("kind").notNull(),
    text: text("text").notNull().default(""),
    // key + message do Baileys: o Evolution baixa a midia so com eles.
    raw: jsonb("raw"),
    media: jsonb("media").$type<{ mime: string; filename?: string; size?: number } | null>(),
    status: text("status", { enum: ["pending", "processing", "done", "ignored"] }).notNull().default("pending"),
    runId: uuid("run_id"),
    error: text("error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("whatsapp_inbound_ext_idx").on(t.numberId, t.externalId), index("whatsapp_inbound_status_idx").on(t.status, t.contactId)],
);

// Mensagem a enviar. Envio com o Evolution fora do ar ou a sessao caida fica
// na fila e e tentado de novo com espera crescente.
export const whatsappOutbound = pgTable(
  "whatsapp_outbound",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    numberId: uuid("number_id")
      .notNull()
      .references(() => whatsappNumber.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => whatsappContact.id, { onDelete: "cascade" }),
    jid: text("jid").notNull(),
    text: text("text").notNull().default(""),
    fileId: uuid("file_id"),
    runId: uuid("run_id"),
    status: text("status", { enum: ["pending", "sent", "failed"] }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    error: text("error"),
    externalId: text("external_id"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("whatsapp_outbound_due_idx").on(t.status, t.nextAttemptAt)],
);

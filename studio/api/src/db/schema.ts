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

export const skill = pgTable("skill", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  inputSchema: jsonb("input_schema").notNull(),
  kind: text("kind").notNull().default("builtin"),
});

export const mcpServer = pgTable("mcp_server", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  authMode: text("auth_mode").notNull().default("none"),
  toolsCache: jsonb("tools_cache").notNull().default([]),
  enabled: boolean("enabled").notNull().default(false),
  description: text("description").notNull().default(""),
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

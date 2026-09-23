import type { FlowGraph, SpanRecord } from "@shared/graph";
export type { FlowGraph, FlowNode, FlowEdge, NodeData, NodeType, SpanRecord, RunEvent, GraphError } from "@shared/graph";

export interface User {
  id: string;
  name: string;
  email: string;
  role: "admin" | "operador";
  active?: boolean;
  createdAt?: string;
}

export interface Model {
  id: string;
  providerId: string;
  modelId: string;
  label: string;
  purpose: "chat" | "embedding" | "vision";
  priceInPer1m: number;
  priceOutPer1m: number;
  priceCachePer1m: number;
  contextWindow: number;
  supportsTools: boolean;
  supportsJson: boolean;
  active: boolean;
  isDefault: boolean;
  providerName?: string;
  providerKind?: string;
  usable?: boolean;
}

export interface DiscoveredModel {
  modelId: string;
  label: string;
  source: "catalogo" | "nenhum" | "indisponivel";
  priceInPer1m: number | null;
  priceOutPer1m: number | null;
  priceCachePer1m: number | null;
  contextWindow: number | null;
  purpose: Model["purpose"] | null;
  supportsTools: boolean | null;
  supportsJson: boolean | null;
  registered: boolean;
}

export interface Provider {
  id: string;
  name: string;
  kind: "deepseek" | "gemini" | "openai_compat" | "mock";
  baseUrl: string;
  apiKeyTail: string;
  hasKey: boolean;
  active: boolean;
  models: Model[];
}

export interface FlowSummary {
  id: string;
  name: string;
  description: string;
  revision: number;
  updatedAt: string;
  nodeCount: number;
  specialistCount: number;
  isProduction: boolean;
  productionRevision: number | null;
  lastPublishedRevision: number | null;
  unpublishedChanges: boolean;
}

export interface Flow {
  id: string;
  name: string;
  description: string;
  revision: number;
  graph: FlowGraph;
  updatedAt: string;
}

export interface Specialty {
  id: number;
  number: number;
  name: string;
  area: string;
  cluster: string;
  role: string;
  routable: boolean;
  scope: string;
  defaultPrompt: string;
  defaultSpaces: string[];
  defaultSkills: string[];
  routingHints: { keywords: string[]; examples: string[] };
  escalationRules: string[];
  phase: number;
  zone: string;
  /** "system" = veio do seed (não se exclui, restaura padrão); "custom" = criada no Studio. */
  origin: "system" | "custom";
}

export interface TemplateField {
  nome: string;
  rotulo: string;
  obrigatorio?: boolean;
}

export interface DocTemplate {
  slug: string;
  title: string;
  description: string;
  fields: TemplateField[];
  body: string;
  enabled: boolean;
  updatedAt: string;
  origin: "system" | "custom";
  /** Campos {{...}} encontrados no corpo. */
  placeholders: string[];
}

export type SkillKind = "builtin" | "prompt" | "http";

export interface Skill {
  id: string;
  name: string;
  description: string;
  inputSchema: unknown;
  kind: SkillKind;
  enabled: boolean;
  llmTool: boolean;
  instructions: string;
  config: { url?: string; method?: string; timeoutMs?: number };
  defaults: { name: string; description: string } | null;
  source: string;
  version: number;
  updatedAt: string;
  headerNames: string[];
  testable: boolean;
  usage30d?: { calls: number; errors: number };
  flowCount?: number;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpServer {
  id: string;
  name: string;
  url: string;
  transport: "http" | "sse";
  enabled: boolean;
  description: string;
  origin: "system" | "custom";
  toolsCache: McpTool[];
  headerNames: string[];
  lastError: string | null;
  checkedAt: string | null;
  updatedAt: string;
  flowCount?: number;
}

export interface FlowUse {
  id: string;
  name: string;
  nodes: string[];
  production: boolean;
}

export interface UsageStats {
  days: number;
  calls: number;
  errors: number;
  runs: number;
  avgMs: number | null;
  p95Ms: number | null;
  lastAt: string | null;
  daily: { day: string; calls: number; errors: number }[];
  byName: { name: string; calls: number; errors: number; avgMs: number | null }[];
  recentErrors: { runId: string; name: string; error: string | null; input: unknown; at: string }[];
}

export interface AuditEntry {
  id: string;
  actorEmail: string;
  action: string;
  entity: string;
  entityId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  at: string;
}

export interface KbSpace {
  slug: string;
  name?: string;
  label?: string;
  description?: string;
  documents?: number;
  [k: string]: unknown;
}

export interface CitationCheck {
  citacao: string;
  status: string;
  bloqueada: boolean;
  fonte: string;
  nota?: string;
}

export type Atalho = "completo" | "conversa" | "reuso" | "documento";

export const ATALHO_LABEL: Record<Atalho, string> = {
  completo: "fluxo completo",
  conversa: "conversa (sem especialistas)",
  reuso: "pareceres reaproveitados",
  documento: "documento",
};

export interface Outcome {
  status: "ok" | "clarify" | "blocked" | "error";
  resposta_simples: string;
  resposta_tecnica: string;
  citacoes: CitationCheck[];
  documentos: { fileId: string; name: string; mime: string; template: string }[];
  especialistas: { nodeId: string; name: string; ok: boolean; score?: number; chainedFrom?: string; reused?: boolean }[];
  intencao?: "nova_consulta" | "continuacao" | "pedido_documento" | "conversa";
  /** Caminho que o turno tomou no fluxo. */
  atalho?: Atalho;
  pendencia?: "documento";
  flags: string[];
  compliance?: { aprovado: boolean; ciclos: number; motivos: string[] };
  path: { nodes: string[]; edges: string[] };
  classificacao?: Record<string, unknown>;
  error?: string;
}

export interface Run {
  id: string;
  question: string;
  flowId: string | null;
  flowName: string;
  flowRevision: number;
  isProduction: boolean;
  status: string;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  rating: number | null;
  ratingComment?: string | null;
  sessionId: string | null;
  userEmail: string | null;
  graph?: FlowGraph;
  outcome?: Outcome | null;
}

export interface RunDetail {
  run: Run & { graph: FlowGraph; outcome: Outcome | null };
  spans: SpanRecord[];
  files: { id: string; name: string; mime: string; direction: string }[];
}

export interface ChatSession {
  id: string;
  title: string;
  flowId: string | null;
  flowName?: string | null;
  useProduction: boolean;
  createdAt: string;
}

export interface Message {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  payload: (Outcome & { error?: string }) | null;
  attachments: string[];
  runId: string | null;
  createdAt: string;
}

export interface SessionFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  direction: "in" | "out";
  extractedChars: number;
  method?: string;
  warning?: string;
}

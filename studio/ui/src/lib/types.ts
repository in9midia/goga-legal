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
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface McpServer {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  description: string;
  toolsCache: { name: string; description?: string }[];
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

export interface Outcome {
  status: "ok" | "clarify" | "blocked" | "error";
  resposta_simples: string;
  resposta_tecnica: string;
  citacoes: CitationCheck[];
  documentos: { fileId: string; name: string; mime: string; template: string }[];
  especialistas: { nodeId: string; name: string; ok: boolean; score?: number; chainedFrom?: string }[];
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

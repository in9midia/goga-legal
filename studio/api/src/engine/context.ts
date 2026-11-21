import type { FlowGraph } from "../shared/graph.js";
import type { RunTracer } from "./tracer.js";
import type { SkillRow } from "../skills/index.js";

export interface SessionFile {
  id: string;
  name: string;
  mime: string;
  text: string;
}

export interface GeneratedDoc {
  fileId: string;
  name: string;
  mime: string;
  template: string;
}

/**
 * O que a pessoa acrescentou enquanto o turno rodava (agente de conversa).
 * Entra em toda chamada a modelo seguinte; `seen` diz se alguma chamada que
 * ainda escreve a resposta chegou a ver. O que ninguem viu vira o turno seguinte.
 */
export interface Addendum {
  id: string;
  text: string;
  seen: boolean;
  /** Canal decide o que fazer com o complemento que nenhuma chamada viu. */
  onUnseen?: () => Promise<void>;
  meta?: Record<string, unknown>;
}

export interface RunContext {
  runId: string;
  userId: string | null;
  flowId: string | null;
  sessionId: string | null;
  graph: FlowGraph;
  tracer: RunTracer;
  signal?: AbortSignal;
  aborted: boolean;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  maxRunCostUsd: number;
  files: SessionFile[];
  generated: GeneratedDoc[];
  /** Documentos que alguma busca na KB devolveu nesta execucao. So eles podem ser abertos. */
  kbDocIds?: Set<number>;
  kbWikiIds?: Set<number>;
  /** Cadastro de skills lido uma vez por execucao (edicao no meio nao muda o turno). */
  skills?: Map<string, SkillRow>;
  /** Complementos da pessoa durante o turno (ver Addendum). */
  addenda?: Addendum[];
  /** Pergunta que abriu o turno e inicio (para o agente de conversa). */
  question?: string;
  startedAt?: number;
}

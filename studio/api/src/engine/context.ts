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
  /** Cadastro de skills lido uma vez por execucao (edicao no meio nao muda o turno). */
  skills?: Map<string, SkillRow>;
}

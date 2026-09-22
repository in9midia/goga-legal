import type { FlowGraph } from "../shared/graph.js";
import type { RunTracer } from "./tracer.js";

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
}

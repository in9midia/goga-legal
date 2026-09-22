import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ReactFlowProvider } from "@xyflow/react";
import { BookOpen, Bot, ChevronRight, Cpu, ExternalLink, GitBranch, Play, Plug, ShieldCheck, Wrench, type LucideIcon } from "lucide-react";
import type { FlowGraph, SpanRecord } from "@shared/graph";
import type { Outcome } from "@/lib/types";
import { int, ms, usd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { JsonView, KPI, Pill, StatusBadge } from "@/components/common";
import { FlowCanvas, toRfEdges, toRfNodes, type NodeState } from "@/components/flow/FlowCanvas";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const KIND: Record<SpanRecord["kind"], { icon: LucideIcon; label: string }> = {
  run: { icon: Play, label: "execução" },
  agent: { icon: Bot, label: "agente" },
  llm: { icon: Cpu, label: "LLM" },
  tool: { icon: Wrench, label: "skill" },
  mcp: { icon: Plug, label: "MCP" },
  kb: { icon: BookOpen, label: "KB" },
  guardrail: { icon: ShieldCheck, label: "guardrail" },
  route: { icon: GitBranch, label: "rota" },
};

export function TraceView({ graph, spans, outcome, flowId, live }: { graph: FlowGraph | null | undefined; spans: SpanRecord[]; outcome?: Outcome | null; flowId?: string | null; live?: boolean }) {
  const totals = useMemo(() => {
    const llm = spans.filter((s) => s.kind === "llm");
    const root = spans.find((s) => s.kind === "run");
    return {
      cost: llm.reduce((a, s) => a + (s.costUsd || 0), 0),
      tin: llm.reduce((a, s) => a + s.tokensIn, 0),
      tout: llm.reduce((a, s) => a + s.tokensOut, 0),
      time: root?.ms ?? (root ? Date.now() - Date.parse(root.startedAt) : null),
      agents: new Set(spans.filter((s) => s.kind === "agent" && s.nodeId).map((s) => s.nodeId)).size,
    };
  }, [spans]);

  // Estado por no: o pior status entre os spans de agente daquele no.
  const states = useMemo(() => {
    const st: Record<string, NodeState> = {};
    for (const s of spans) {
      if (s.kind !== "agent" || !s.nodeId) continue;
      const cur = st[s.nodeId];
      const next: NodeState = s.status === "error" ? "error" : s.status === "running" ? "running" : "ok";
      if (cur !== "error") st[s.nodeId] = cur === "running" && next === "ok" ? "running" : next;
    }
    return st;
  }, [spans]);
  const visited = useMemo(() => new Set(outcome?.path?.nodes ?? Object.keys(states)), [outcome, states]);
  const usedEdges = useMemo(() => {
    if (outcome?.path?.edges) return new Set(outcome.path.edges);
    // Durante a execucao ao vivo nao ha `path`: deduz pelas arestas entre nos ja visitados.
    return new Set((graph?.edges ?? []).filter((e) => visited.has(e.source) && visited.has(e.target)).map((e) => e.id));
  }, [outcome, graph, visited]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="grid grid-cols-4 gap-2 border-b border-line p-3">
        <KPI label="Custo" value={<span className="text-base">{usd(totals.cost)}</span>} />
        <KPI label="Tokens" value={<span className="text-base">{int(totals.tin + totals.tout)}</span>} hint={`${int(totals.tin)} in · ${int(totals.tout)} out`} />
        <KPI label="Tempo" value={<span className="text-base">{ms(totals.time)}</span>} />
        <KPI label="Agentes" value={<span className="text-base">{totals.agents}</span>} />
      </div>
      <Tabs defaultValue="spans" className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList className="mx-3 mt-2">
          <TabsTrigger value="spans" className="text-xs">Passos</TabsTrigger>
          <TabsTrigger value="canvas" className="text-xs">Caminho no fluxo</TabsTrigger>
          {outcome && <TabsTrigger value="resultado" className="text-xs">Resultado</TabsTrigger>}
        </TabsList>
        <TabsContent value="spans" className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          <SpanTree spans={spans} flowId={flowId} live={live} />
        </TabsContent>
        <TabsContent value="canvas" className="min-h-[320px] flex-1">
          {graph ? (
            <ReactFlowProvider>
              <FlowCanvas key={spans.length ? "c" : "e"} nodes={toRfNodes(graph, { states, visited: visited.size ? visited : undefined })} edges={toRfEdges(graph, { used: usedEdges, animateUsed: true })} readOnly minimap={false} />
            </ReactFlowProvider>
          ) : null}
        </TabsContent>
        {outcome && (
          <TabsContent value="resultado" className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            <div className="flex flex-wrap gap-1.5">
              <StatusBadge status={outcome.status} />
              {outcome.compliance && <Pill tone={outcome.compliance.aprovado ? "ok" : "bad"}>compliance {outcome.compliance.aprovado ? "aprovado" : "reprovado"} · {outcome.compliance.ciclos} ciclo(s)</Pill>}
              {outcome.flags.map((f) => <Pill key={f} tone="warn">{f}</Pill>)}
            </div>
            {outcome.classificacao && <><div className="text-xs text-text-muted">Classificação</div><JsonView value={outcome.classificacao} /></>}
            <div className="text-xs text-text-muted">Especialistas</div>
            <JsonView value={outcome.especialistas} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

function SpanTree({ spans, flowId, live }: { spans: SpanRecord[]; flowId?: string | null; live?: boolean }) {
  const children = useMemo(() => {
    const m = new Map<string | null, SpanRecord[]>();
    const ids = new Set(spans.map((s) => s.id));
    for (const s of [...spans].sort((a, b) => a.seq - b.seq)) {
      const p = s.parentId && ids.has(s.parentId) ? s.parentId : null;
      m.set(p, [...(m.get(p) ?? []), s]);
    }
    return m;
  }, [spans]);
  const roots = children.get(null) ?? [];
  if (!spans.length) return <p className="p-3 text-sm text-text-dim">{live ? "Aguardando os primeiros passos…" : "Selecione uma resposta para ver o trace."}</p>;
  // A raiz ("Execucao") so agrupa: os filhos dela aparecem no primeiro nivel.
  const top = roots.length === 1 && roots[0].kind === "run" ? (children.get(roots[0].id) ?? []) : roots;
  return <div className="space-y-0.5">{top.map((s) => <SpanRow key={s.id} span={s} childrenOf={children} depth={0} flowId={flowId} />)}</div>;
}

function SpanRow({ span, childrenOf, depth, flowId }: { span: SpanRecord; childrenOf: Map<string | null, SpanRecord[]>; depth: number; flowId?: string | null }) {
  const kids = childrenOf.get(span.id) ?? [];
  const [open, setOpen] = useState(false);
  const K = KIND[span.kind];
  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[0.78rem] hover:bg-ink-800", open && "bg-ink-850")} style={{ paddingLeft: 8 + depth * 14 }}>
        <ChevronRight className={cn("h-3 w-3 shrink-0 text-text-dim transition-transform", open && "rotate-90")} />
        <K.icon className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        <span className="min-w-0 flex-1 truncate">{span.name}</span>
        {span.kind === "llm" && <span className="font-mono text-[0.66rem] text-text-dim tabular-nums">{int(span.tokensIn + span.tokensOut)} tok · {usd(span.costUsd)}</span>}
        <span className="w-12 text-right font-mono text-[0.66rem] text-text-dim tabular-nums">{ms(span.ms)}</span>
        {span.status !== "ok" && <StatusBadge status={span.status} />}
      </button>
      {open && <SpanDetail span={span} flowId={flowId} />}
      {kids.map((k) => <SpanRow key={k.id} span={k} childrenOf={childrenOf} depth={depth + 1} flowId={flowId} />)}
    </div>
  );
}

function SpanDetail({ span, flowId }: { span: SpanRecord; flowId?: string | null }) {
  const input = span.input as Record<string, unknown> | null;
  const output = span.output as Record<string, unknown> | null;
  return (
    <div className="my-1 ml-6 space-y-2 rounded-md border border-line bg-ink-900 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2 text-text-dim">
        <Pill>{KIND[span.kind].label}</Pill>
        {span.kind === "llm" && typeof input?.model === "string" && <Pill tone="info">{input.model}</Pill>}
        {span.nodeId && flowId && (
          <Link to={`/flows/${flowId}?node=${encodeURIComponent(span.nodeId)}`} className="inline-flex items-center gap-1 text-text-muted hover:text-text">
            abrir nó no editor <ExternalLink className="h-3 w-3" />
          </Link>
        )}
        {span.error && <span className="text-rose-300">{span.error}</span>}
      </div>
      {span.kind === "llm" ? (
        <Tabs defaultValue="resp">
          <TabsList>
            <TabsTrigger value="resp" className="text-xs">Resposta</TabsTrigger>
            <TabsTrigger value="system" className="text-xs">Prompt de sistema</TabsTrigger>
            <TabsTrigger value="msgs" className="text-xs">Mensagens</TabsTrigger>
            {Array.isArray(output?.toolCalls) && (output.toolCalls as unknown[]).length > 0 && <TabsTrigger value="tools" className="text-xs">Tools</TabsTrigger>}
          </TabsList>
          <TabsContent value="resp"><JsonView value={tryJson(String(output?.text ?? ""))} />{typeof output?.reasoning === "string" && output.reasoning && <><div className="mt-2 text-text-dim">raciocínio</div><JsonView value={output.reasoning} /></>}</TabsContent>
          <TabsContent value="system"><JsonView value={String(input?.system ?? "")} maxHeight={480} /></TabsContent>
          <TabsContent value="msgs"><JsonView value={input?.messages} /></TabsContent>
          <TabsContent value="tools"><JsonView value={output?.toolCalls} /></TabsContent>
        </Tabs>
      ) : span.kind === "kb" && Array.isArray((output as { resultados?: unknown[] })?.resultados) ? (
        <KbPassages input={input} output={output as { resultados: Passage[] }} />
      ) : span.kind === "guardrail" && Array.isArray(output) ? (
        <ul className="space-y-1">
          {(output as { check: string; ok: boolean; detalhe: string }[]).map((c) => (
            <li key={c.check} className="flex gap-2"><Pill tone={c.ok ? "ok" : "bad"}>{c.ok ? "OK" : "FALHOU"}</Pill><span className="font-mono text-text-dim">{c.check}</span><span className="text-text-muted">{c.detalhe}</span></li>
          ))}
        </ul>
      ) : (
        <div className="grid gap-2 md:grid-cols-2">
          <div><div className="mb-1 text-text-dim">entrada</div><JsonView value={span.input} /></div>
          <div><div className="mb-1 text-text-dim">saída</div><JsonView value={span.output} /></div>
        </div>
      )}
    </div>
  );
}

interface Passage {
  document_id: number;
  base: string;
  titulo: string;
  pagina: number | null;
  score: number;
  armadilha: string | null;
  trecho: string;
}

function KbPassages({ input, output }: { input: Record<string, unknown> | null; output: { resultados: Passage[]; aviso?: string } }) {
  return (
    <div className="space-y-2">
      <div className="text-text-dim">consulta: <span className="text-text-muted">{String(input?.consulta ?? "")}</span></div>
      {output.aviso && <Pill tone="warn">{output.aviso}</Pill>}
      {output.resultados.length === 0 && <p className="text-text-dim">Nenhum trecho recuperado.</p>}
      {output.resultados.map((p, i) => (
        <div key={i} className="rounded border border-line bg-ink-950 p-2">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-text">{p.titulo}</span>
            <Pill>{p.base}</Pill>
            {p.pagina && <Pill>p. {p.pagina}</Pill>}
            <span className="font-mono text-[0.66rem] text-text-dim">score {p.score.toFixed(4)}</span>
            {p.armadilha && <Pill tone="bad" title={p.armadilha}>armadilha</Pill>}
          </div>
          <p className="line-clamp-6 whitespace-pre-wrap text-text-muted">{p.trecho}</p>
        </div>
      ))}
    </div>
  );
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

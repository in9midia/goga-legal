import { memo, useMemo } from "react";
import { Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, type Edge, type Node, type NodeProps, type OnConnect, type OnEdgesChange, type OnNodesChange } from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import { BookOpen, Filter, Gavel, Inbox, Layers, LogOut, ShieldCheck, type LucideIcon } from "lucide-react";
import { NODE_TYPE_LABEL, type FlowGraph, type NodeData, type NodeType } from "@shared/graph";
import { cn } from "@/lib/utils";

export const NODE_META: Record<NodeType, { icon: LucideIcon; color: string }> = {
  entry: { icon: Inbox, color: "#60a5fa" },
  classifier: { icon: Filter, color: "#a78bfa" },
  specialist: { icon: Gavel, color: "#34d399" },
  consolidator: { icon: Layers, color: "#fbbf24" },
  compliance: { icon: ShieldCheck, color: "#f472b6" },
  output: { icon: LogOut, color: "#9a9aa3" },
};

export type NodeState = "ok" | "error" | "running" | "skipped" | undefined;

export interface CanvasNodeData extends Record<string, unknown> {
  type: NodeType;
  data: NodeData;
  modelLabel?: string;
  hasError?: boolean;
  state?: NodeState;
  dimmed?: boolean;
}

const STATE_RING: Record<string, string> = {
  ok: "ring-2 ring-emerald-500/70",
  error: "ring-2 ring-rose-500/80",
  running: "ring-2 ring-blue-500/80 animate-pulse",
};

const AgentNode = memo(function AgentNode({ data, selected }: NodeProps<Node<CanvasNodeData>>) {
  const meta = NODE_META[data.type];
  const Icon = meta.icon;
  const d = data.data;
  const sub =
    data.type === "specialist"
      ? [d.knowledge.spaces.length ? `${d.knowledge.spaces.length} base(s)` : "sem KB", `${d.tools.skills.length} skills`].join(" · ")
      : data.type === "classifier" && d.routing
        ? `limiar ${d.routing.routingThreshold} · máx ${d.routing.maxSpecialists}`
        : data.type === "compliance" && d.cycle
          ? `até ${d.cycle.maxCycles} ciclo(s)`
          : NODE_TYPE_LABEL[data.type];
  return (
    <div
      className={cn(
        "w-[210px] rounded-lg border bg-ink-900 px-3 py-2 text-left shadow-[0_8px_24px_-16px_rgba(0,0,0,0.6)] transition-opacity",
        selected ? "border-text-muted" : "border-line",
        data.hasError && "border-rose-500/70",
        data.state && STATE_RING[data.state],
        data.dimmed && "opacity-35",
      )}
    >
      {data.type !== "entry" && <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-ink-500 !bg-ink-700" />}
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded" style={{ background: `${meta.color}22`, color: meta.color }}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[0.78rem] leading-tight font-medium">{d.name}</div>
          <div className="truncate text-[0.66rem] text-text-dim">{sub}</div>
        </div>
        {data.type === "specialist" && d.knowledge.spaces.length > 0 && <BookOpen className="h-3 w-3 shrink-0 text-text-dim" />}
      </div>
      {data.modelLabel && <div className="mt-1 truncate font-mono text-[0.62rem] text-text-dim">{data.modelLabel}</div>}
      {data.type !== "output" && <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-ink-500 !bg-ink-700" />}
    </div>
  );
});

export const nodeTypes = { agent: AgentNode };

export function toRfNodes(graph: FlowGraph, opts: { modelLabel?: (id: string | null) => string | undefined; errors?: Set<string>; states?: Record<string, NodeState>; visited?: Set<string> } = {}): Node<CanvasNodeData>[] {
  return graph.nodes.map((n) => ({
    id: n.id,
    type: "agent",
    position: n.position,
    data: {
      type: n.type,
      data: n.data,
      modelLabel: opts.modelLabel?.(n.data.model.modelId),
      hasError: opts.errors?.has(n.id),
      state: opts.states?.[n.id],
      dimmed: opts.visited ? !opts.visited.has(n.id) : false,
    },
  }));
}

export function toRfEdges(graph: FlowGraph, opts: { used?: Set<string>; animateUsed?: boolean } = {}): Edge[] {
  return graph.edges.map((e) => {
    const src = graph.nodes.find((n) => n.id === e.source);
    const tgt = graph.nodes.find((n) => n.id === e.target);
    const back = src?.type === "compliance" && tgt?.type === "consolidator";
    const chain = src?.type === "specialist" && tgt?.type === "specialist";
    const used = opts.used?.has(e.id);
    const dim = opts.used && !used;
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      animated: !!(used && opts.animateUsed) || back,
      label: back ? "revisão" : chain ? "encadeia" : undefined,
      labelStyle: { fill: "#9a9aa3", fontSize: 10 },
      labelBgStyle: { fill: "#111113" },
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: used ? "#34d399" : "#52525b" },
      style: { stroke: used ? "#34d399" : chain ? "#a78bfa" : "#3f3f46", strokeWidth: used ? 2 : 1.2, strokeDasharray: back || chain ? "5 4" : undefined, opacity: dim ? 0.25 : 1 },
    };
  });
}

/** Layout em camadas (esquerda -> direita). A aresta de revisao Compliance -> Consolidador fica fora, senao vira ciclo e baguna as camadas. */
export function autoLayout(graph: FlowGraph): FlowGraph {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 14, ranksep: 70, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of graph.nodes) g.setNode(n.id, { width: 210, height: 58 });
  const typeOf = new Map(graph.nodes.map((n) => [n.id, n.type]));
  for (const e of graph.edges) {
    if (typeOf.get(e.source) === "compliance" && typeOf.get(e.target) === "consolidator") continue;
    g.setEdge(e.source, e.target);
  }
  dagre.layout(g);
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const p = g.node(n.id);
      return p ? { ...n, position: { x: Math.round(p.x - 105), y: Math.round(p.y - 29) } } : n;
    }),
  };
}

export function FlowCanvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onNodeClick,
  onPaneClick,
  readOnly,
  minimap = true,
  fitKey,
}: {
  nodes: Node<CanvasNodeData>[];
  edges: Edge[];
  onNodesChange?: OnNodesChange<Node<CanvasNodeData>>;
  onEdgesChange?: OnEdgesChange;
  onConnect?: OnConnect;
  onNodeClick?: (id: string) => void;
  onPaneClick?: () => void;
  readOnly?: boolean;
  minimap?: boolean;
  fitKey?: string;
}) {
  const proOptions = useMemo(() => ({ hideAttribution: true }), []);
  return (
    <ReactFlow
      key={fitKey}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onNodeClick={(_, n) => onNodeClick?.(n.id)}
      onPaneClick={onPaneClick}
      nodesDraggable={!readOnly}
      nodesConnectable={!readOnly}
      elementsSelectable
      deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
      fitView
      fitViewOptions={{ padding: 0.12 }}
      minZoom={0.15}
      proOptions={proOptions}
      colorMode="dark"
    >
      <Background gap={20} size={1} color="#1f1f23" />
      <Controls showInteractive={false} />
      {minimap && <MiniMap pannable zoomable nodeColor={(n) => NODE_META[(n.data as CanvasNodeData).type]?.color ?? "#555"} maskColor="rgba(10,10,11,0.7)" />}
    </ReactFlow>
  );
}

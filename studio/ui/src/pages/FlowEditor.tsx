import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useBlocker, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ReactFlowProvider, useNodesState, type Connection, type EdgeChange, type NodeChange, type Node } from "@xyflow/react";
import { AlertTriangle, ArrowLeft, CheckCircle2, LayoutGrid, MessagesSquare, Plus, Rocket, Save } from "lucide-react";
import { toast } from "sonner";
import { nodeDataSchema, type FlowGraph, type FlowNode, type GraphError, type NodeData, type NodeType } from "@shared/graph";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Flow } from "@/lib/types";
import { ErrorBox, Loading, Pill } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { FlowCanvas, autoLayout, toRfEdges, toRfNodes, type CanvasNodeData } from "@/components/flow/FlowCanvas";
import { FlowSettingsPanel, NodeInspector, useCatalogs } from "@/components/flow/Inspector";

interface FlowResponse {
  flow: Flow;
  isProduction: boolean;
  unpublishedChanges: boolean;
  errors: GraphError[];
}

export function FlowEditorPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ["flow", id], queryFn: () => api.get<FlowResponse>(`/flows/${id}`), refetchOnMount: "always" });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <div className="p-6"><ErrorBox error={q.error ?? "fluxo não encontrado"} /></div>;
  return (
    <ReactFlowProvider>
      <Editor key={`${q.data.flow.id}`} initial={q.data} />
    </ReactFlowProvider>
  );
}

function Editor({ initial }: { initial: FlowResponse }) {
  const { isAdmin } = useAuth();
  const readOnly = !isAdmin;
  const qc = useQueryClient();
  const cats = useCatalogs();
  const [name, setName] = useState(initial.flow.name);
  const [description, setDescription] = useState(initial.flow.description);
  const [revision, setRevision] = useState(initial.flow.revision);
  const [isProduction, setIsProduction] = useState(initial.isProduction);
  const [unpublished, setUnpublished] = useState(initial.unpublishedChanges);
  // Na primeira abertura de um fluxo seed (revisao 1) o layout e refeito pelo
  // dagre: as posicoes do seed sao colunas simples e 30 nos ficam ilegiveis.
  const [graph, setGraph] = useState<FlowGraph>(() => (initial.flow.revision === 1 ? autoLayout(initial.flow.graph) : initial.flow.graph));
  const [rfNodes, setRfNodes, onRfNodesChange] = useNodesState<Node<CanvasNodeData>>([]);
  const [params] = useSearchParams();
  const [selected, setSelected] = useState<string | null>(params.get("node"));
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<GraphError[]>(initial.errors);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [adding, setAdding] = useState(false);
  const [fitKey, setFitKey] = useState("0");

  const modelLabel = useCallback(
    (mid: string | null) => {
      const m = (cats.models.data ?? []).find((x) => x.id === (mid ?? graph.settings.defaultModelId));
      return m ? `${mid ? "" : "padrão · "}${m.label}` : undefined;
    },
    [cats.models.data, graph.settings.defaultModelId],
  );
  const errorNodes = useMemo(() => new Set(errors.map((e) => e.nodeId).filter(Boolean) as string[]), [errors]);

  // Posicoes vivem no estado do React Flow (ele precisa das medidas dos nos);
  // dados vivem no `graph`. Aqui os dois se reencontram.
  const firstSync = useRef(true);
  useEffect(() => {
    setRfNodes((prev) => {
      const pos = new Map(prev.map((n) => [n.id, n.position]));
      return toRfNodes(graph, { modelLabel, errors: errorNodes }).map((n) => ({ ...n, position: firstSync.current ? n.position : (pos.get(n.id) ?? n.position), selected: n.id === selected }));
    });
    firstSync.current = false;
  }, [graph, modelLabel, errorNodes, selected, setRfNodes]);

  const rfEdges = useMemo(() => toRfEdges(graph), [graph]);
  const touch = () => setDirty(true);

  const PROTECTED: NodeType[] = ["entry", "classifier", "consolidator", "output"];
  const onNodesChange = (changes: NodeChange<Node<CanvasNodeData>>[]) => {
    if (readOnly) return onRfNodesChange(changes.filter((c) => c.type === "select" || c.type === "dimensions"));
    const typeOf = new Map(graph.nodes.map((n) => [n.id, n.type]));
    const allowed = changes.filter((c) => c.type !== "remove" || !PROTECTED.includes(typeOf.get(c.id)!));
    onRfNodesChange(allowed);
    const removed = allowed.filter((c) => c.type === "remove").map((c) => (c as { id: string }).id);
    if (removed.length) removeNodes(removed);
    if (allowed.some((c) => c.type === "position" && c.dragging === false)) touch();
  };
  const removeNodes = (ids: string[]) => {
    setGraph((g) => ({ ...g, nodes: g.nodes.filter((n) => !ids.includes(n.id)), edges: g.edges.filter((e) => !ids.includes(e.source) && !ids.includes(e.target)) }));
    if (selected && ids.includes(selected)) setSelected(null);
    touch();
  };
  const onEdgesChange = (changes: EdgeChange[]) => {
    if (readOnly) return;
    const removed = changes.filter((c) => c.type === "remove").map((c) => c.id);
    if (removed.length) {
      setGraph((g) => ({ ...g, edges: g.edges.filter((e) => !removed.includes(e.id)) }));
      touch();
    }
  };
  const onConnect = (c: Connection) => {
    if (readOnly || !c.source || !c.target || c.source === c.target) return;
    const id = `${c.source}->${c.target}`;
    setGraph((g) => (g.edges.some((e) => e.id === id) ? g : { ...g, edges: [...g.edges, { id, source: c.source, target: c.target }] }));
    touch();
  };
  const updateNode = (id: string, data: NodeData) => {
    setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, data } : n)) }));
    touch();
  };

  const currentGraph = (): FlowGraph => {
    const pos = new Map(rfNodes.map((n) => [n.id, n.position]));
    return { ...graph, nodes: graph.nodes.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })) };
  };

  // Validacao ao vivo (debounce): o servidor e a fonte, porque so ele sabe quais
  // modelos estao ativos e quais bases existem na KB.
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => {
      api.post<{ errors: GraphError[] }>(`/flows/${initial.flow.id}/validate`, { graph: currentGraph() }).then((r) => setErrors(r.errors)).catch(() => undefined);
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, dirty]);

  const save = useMutation({
    mutationFn: () => api.put<{ flow: Flow; errors: GraphError[] }>(`/flows/${initial.flow.id}`, { name, description, graph: currentGraph(), expectedRevision: revision }),
    onSuccess: (r) => {
      setRevision(r.flow.revision);
      setErrors(r.errors);
      setDirty(false);
      if (isProduction) setUnpublished(true);
      qc.invalidateQueries({ queryKey: ["flows"] });
      toast.success(`Salvo (revisão ${r.flow.revision})${r.errors.length ? ` com ${r.errors.length} erro(s) de validação` : ""}`);
    },
    onError: (e) => toast.error(e instanceof ApiError && e.status === 409 ? `${e.message}` : (e as Error).message),
  });

  const production = useQuery({ queryKey: ["production"], queryFn: () => api.get<{ production: { flowName: string; revision: number; flowId: string } | null }>("/production").then((r) => r.production) });
  const publish = useMutation({
    mutationFn: () => api.post(`/flows/${initial.flow.id}/publish`, { expectedRevision: revision }),
    onSuccess: () => {
      setIsProduction(true);
      setUnpublished(false);
      qc.invalidateQueries({ queryKey: ["flows"] });
      qc.invalidateQueries({ queryKey: ["production"] });
      toast.success(`Revisão ${revision} publicada em produção`);
    },
    onError: (e) => {
      const errs = (e as ApiError).details as { errors?: GraphError[] } | undefined;
      if (errs?.errors) setErrors(errs.errors);
      toast.error((e as Error).message);
    },
  });

  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const addNode = (type: NodeType, specialtyNumber?: number) => {
    const specs = cats.specialties.data ?? [];
    const s = specs.find((x) => x.number === specialtyNumber);
    let id = s ? `sp-${s.number}` : `${type}-${Math.random().toString(36).slice(2, 7)}`;
    while (graph.nodes.some((n) => n.id === id)) id = `${id}-${Math.random().toString(36).slice(2, 4)}`;
    const cls = rfNodes.find((n) => n.data.type === "classifier");
    const data: NodeData = s
      ? nodeDataSchema.parse({
          name: `${s.number} · ${s.name}`,
          description: s.scope,
          specialtyNumber: s.number,
          prompt: { system: s.defaultPrompt, outputFormat: "parecer", examples: "" },
          knowledge: { spaces: s.defaultSpaces },
          tools: { skills: [...new Set(["buscar_kb", "verificar_citacao", ...s.defaultSkills])], mcp: [] },
          rules: { escalation: s.escalationRules, zone: s.zone === "amarela" ? "amarela" : "verde" },
        })
      : nodeDataSchema.parse({ name: type === "specialist" ? "Novo especialista" : type === "compliance" ? "Compliance" : "Novo nó", cycle: type === "compliance" ? {} : undefined, routing: type === "classifier" ? {} : undefined });
    const node: FlowNode = { id, type, position: { x: (cls?.position.x ?? 300) + 300, y: (cls?.position.y ?? 200) + 40 * (graph.nodes.length % 8) }, data };
    const edges = [...graph.edges];
    if (type === "specialist") {
      const classifier = graph.nodes.find((n) => n.type === "classifier");
      const consolidator = graph.nodes.find((n) => n.type === "consolidator");
      if (classifier) edges.push({ id: `${classifier.id}->${id}`, source: classifier.id, target: id });
      if (consolidator) edges.push({ id: `${id}->${consolidator.id}`, source: id, target: consolidator.id });
    }
    setGraph((g) => ({ ...g, nodes: [...g.nodes, node], edges }));
    setSelected(id);
    touch();
    setAdding(false);
  };

  const selNode = graph.nodes.find((n) => n.id === selected);
  const inFlow = new Set(graph.nodes.map((n) => n.data.specialtyNumber));

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-line bg-ink-900/60 px-4 py-2.5">
        <Button variant="ghost" size="icon" asChild><Link to="/flows" aria-label="Voltar"><ArrowLeft className="h-4 w-4" /></Link></Button>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{name}</span>
            <span className="text-[0.72rem] text-text-dim">rev {revision}</span>
            {isProduction && <Pill tone="ok"><Rocket className="h-3 w-3" />Produção</Pill>}
            {isProduction && unpublished && <Pill tone="warn">alterações não publicadas</Pill>}
            {dirty && <Pill tone="info">não salvo</Pill>}
            {readOnly && <Pill>somente leitura</Pill>}
          </div>
          <div className="text-[0.7rem] text-text-dim">{graph.nodes.length} nós · {graph.edges.length} arestas</div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className={errors.length ? "border-rose-500/40 text-rose-300" : "text-emerald-300"}>
                {errors.length ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                {errors.length ? `${errors.length} erro(s)` : "válido"}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-96 p-2">
              {errors.length === 0 ? <p className="p-2 text-sm text-text-muted">Nenhum erro de validação.</p> : (
                <ul className="max-h-80 space-y-1 overflow-y-auto">
                  {errors.map((e, i) => (
                    <li key={i}>
                      <button className="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-ink-800" onClick={() => e.nodeId && setSelected(e.nodeId)}>
                        <span className="font-mono text-[0.65rem] text-text-dim">{e.code}</span>
                        <div className="text-rose-200">{e.message}</div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </PopoverContent>
          </Popover>
          <Button variant="outline" size="sm" onClick={() => { setGraph(autoLayout(currentGraph())); firstSync.current = true; setFitKey(String(Date.now())); touch(); }} disabled={readOnly}><LayoutGrid className="h-4 w-4" /> Organizar</Button>
          {!readOnly && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="outline" size="sm"><Plus className="h-4 w-4" /> Nó</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Adicionar</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => setAdding(true)}>Especialista do catálogo…</DropdownMenuItem>
                <DropdownMenuItem onClick={() => addNode("specialist")}>Especialista em branco</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={graph.nodes.some((n) => n.type === "compliance")} onClick={() => addNode("compliance")}>Compliance</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button variant="outline" size="sm" asChild><Link to={`/simulator?flow=${initial.flow.id}`}><MessagesSquare className="h-4 w-4" /> Simular</Link></Button>
          {!readOnly && <Button size="sm" variant="secondary" onClick={() => save.mutate()} disabled={!dirty || save.isPending}><Save className="h-4 w-4" /> {save.isPending ? "Salvando…" : "Salvar"}</Button>}
          {!readOnly && (
            <Button size="sm" onClick={() => setConfirmPublish(true)} disabled={dirty || publish.isPending || errors.length > 0} title={dirty ? "Salve antes de publicar" : errors.length ? "Corrija os erros antes de publicar" : undefined}>
              <Rocket className="h-4 w-4" /> Publicar
            </Button>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <FlowCanvas nodes={rfNodes} edges={rfEdges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeClick={setSelected} onPaneClick={() => setSelected(null)} readOnly={readOnly} fitKey={fitKey} />
          <div className="pointer-events-none absolute top-3 left-3 rounded-md border border-line bg-ink-900/80 px-2.5 py-1.5 text-[0.68rem] text-text-dim">
            arraste da borda direita de um nó para conectar · Delete remove · clique no vazio para configurar o fluxo
          </div>
        </div>
        <aside className="w-[420px] shrink-0 border-l border-line bg-ink-900">
          {selNode ? (
            <NodeInspector key={selNode.id} node={selNode} cats={cats} readOnly={readOnly} errors={errors.filter((e) => e.nodeId === selNode.id).map((e) => e.message)} onChange={(d) => updateNode(selNode.id, d)} onDelete={() => removeNodes([selNode.id])} />
          ) : (
            <FlowSettingsPanel
              name={name}
              description={description}
              settings={graph.settings}
              cats={cats}
              readOnly={readOnly}
              onChange={(p) => {
                if (p.name !== undefined) setName(p.name);
                if (p.description !== undefined) setDescription(p.description);
                if (p.settings) setGraph((g) => ({ ...g, settings: p.settings! }));
                touch();
              }}
            />
          )}
        </aside>
      </div>

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="p-0">
          <DialogHeader className="px-4 pt-4"><DialogTitle>Adicionar especialista</DialogTitle></DialogHeader>
          <Command>
            <CommandInput placeholder="Buscar especialidade…" />
            <CommandList className="max-h-96">
              <CommandEmpty>Nada encontrado.</CommandEmpty>
              <CommandGroup>
                {(cats.specialties.data ?? []).filter((s) => s.role === "specialist" || s.routable).map((s) => (
                  <CommandItem key={s.number} value={`${s.number} ${s.name} ${s.area}`} onSelect={() => addNode("specialist", s.number)}>
                    <span className="w-7 font-mono text-xs text-text-dim">{s.number}</span>
                    <span className="flex-1">{s.name}</span>
                    {inFlow.has(s.number) && <Pill>já no fluxo</Pill>}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmPublish} onOpenChange={setConfirmPublish}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publicar "{name}" (rev {revision}) em produção?</AlertDialogTitle>
            <AlertDialogDescription>
              {production.data && production.data.flowId !== initial.flow.id
                ? `Substitui o que está em produção agora: "${production.data.flowName}" (rev ${production.data.revision}). `
                : production.data
                  ? `Substitui a release atual deste fluxo (rev ${production.data.revision}). `
                  : ""}
              Só existe um fluxo em produção. A publicação cria uma release imutável e fica registrada na auditoria.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => publish.mutate()}>Publicar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={blocker.state === "blocked"}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sair sem salvar?</AlertDialogTitle>
            <AlertDialogDescription>As alterações deste fluxo ainda não foram salvas.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => blocker.reset?.()}>Continuar editando</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => blocker.proceed?.()}>Descartar e sair</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

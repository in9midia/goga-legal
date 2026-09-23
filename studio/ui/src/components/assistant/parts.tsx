import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { AlertTriangle, Check, ChevronRight, CircleHelp, ExternalLink, Loader2, ShieldAlert, Wrench, X } from "lucide-react";
import { api, fileUrl } from "@/lib/api";
import type { Flow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FlowCanvas, toRfEdges, toRfNodes, type NodeState } from "@/components/flow/FlowCanvas";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type Part =
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; input: unknown; status: "running" | "ok" | "error"; output?: string; error?: string }
  | { type: "ask"; id: string; pergunta: string; opcoes: { rotulo: string; descricao?: string }[]; multipla: boolean; permitirOutro: boolean; status: "pending" | "answered" | "skipped"; resposta?: string[] }
  | { type: "approval"; id: string; name: string; input: unknown; resumo: string; status: "pending" | "approved" | "denied" | "skipped"; output?: string; error?: string }
  | { type: "display"; id: string; input: DisplayInput }
  | { type: "error"; text: string };

export interface DisplayInput {
  tipo: "imagem" | "fluxo" | "tabela" | "grafico";
  titulo?: string;
  fileId?: string;
  url?: string;
  fluxoId?: string;
  destacar?: string[];
  colunas?: string[];
  linhas?: (string | number | null)[][];
  dados?: { rotulo: string; valor: number }[];
  unidade?: string;
}

// Rotulo legivel de cada ferramenta (o nome tecnico aparece ao expandir).
const TOOL_LABEL: Record<string, string> = {
  visao_geral: "Panorama do Studio",
  consultar_api: "Consulta à API",
  listar_fluxos: "Listou fluxos",
  ler_fluxo: "Leu o fluxo",
  ler_no: "Leu nós do fluxo",
  ler_configuracoes_fluxo: "Leu configurações do fluxo",
  criar_fluxo: "Criou fluxo",
  editar_fluxo: "Editou o rascunho do fluxo",
  validar_fluxo: "Validou o fluxo",
  testar_fluxo: "Rodou pergunta de teste",
  listar_modelos_llm: "Listou modelos de LLM",
  salvar_modelo_llm: "Salvou modelo de LLM",
  listar_skills: "Listou skills",
  ler_skill: "Leu skill",
  salvar_skill: "Salvou skill",
  importar_skill: "Importou skill",
  testar_skill: "Testou skill",
  listar_mcp: "Listou servidores MCP",
  salvar_mcp: "Salvou servidor MCP",
  testar_mcp: "Testou servidor MCP",
  chamar_ferramenta_mcp: "Chamou ferramenta MCP",
  listar_especialidades: "Listou especialidades",
  ler_especialidade: "Leu especialidade",
  salvar_especialidade: "Salvou especialidade",
  listar_modelos_documento: "Listou modelos de documento",
  ler_modelo_documento: "Leu modelo de documento",
  salvar_modelo_documento: "Salvou modelo de documento",
  buscar_kb: "Buscou na KB",
  listar_execucoes: "Listou execuções",
  analisar_execucao: "Leu a transcrição da execução",
  listar_conversas_simuladas: "Listou conversas do simulador",
  ler_conversa_simulada: "Leu a conversa do simulador",
  consultar_auditoria: "Consultou a auditoria",
  ler_registro_auditoria: "Leu registro de auditoria",
  consultar_custos: "Consultou custos",
  listar_lotes: "Listou lotes de avaliação",
  ler_lote: "Leu lote de avaliação",
  ler_anexo: "Leu anexo",
  publicar_fluxo: "Publicar em produção",
  excluir: "Excluir",
  restaurar_padrao: "Restaurar padrão",
  iniciar_lote: "Iniciar avaliação em lote",
  alterar_via_api: "Alteração via API",
};

/** Links para as telas que a ferramenta tocou. */
function toolLink(name: string, input: Record<string, unknown>): { to: string; label: string } | null {
  const id = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  if (id("fluxoId") && /fluxo|no$|nos$/.test(name)) return { to: `/flows/${id("fluxoId")}`, label: "abrir fluxo" };
  if (id("runId")) return { to: `/history/${id("runId")}`, label: "abrir no histórico" };
  if (id("sessaoId")) return { to: `/simulator/${id("sessaoId")}`, label: "abrir conversa" };
  return null;
}

const pretty = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

export function ToolCard({ part }: { part: Extract<Part, { type: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const input = (part.input ?? {}) as Record<string, unknown>;
  const link = toolLink(part.name, input);
  // O runId do teste vem na saida, nao na entrada.
  const runId = part.name === "testar_fluxo" ? part.output?.match(/"runId":\s*"([0-9a-f-]{36})"/)?.[1] : undefined;
  return (
    <div className="my-1.5 rounded-md border border-line bg-ink-900/60 text-xs">
      <button className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left" onClick={() => setOpen((o) => !o)}>
        <ChevronRight className={cn("h-3 w-3 shrink-0 text-text-dim transition-transform", open && "rotate-90")} />
        {part.status === "running" ? <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-300" /> : part.status === "ok" ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <X className="h-3.5 w-3.5 text-rose-400" />}
        <Wrench className="h-3 w-3 text-text-dim" />
        <span className="truncate text-text-muted">{TOOL_LABEL[part.name] ?? part.name}</span>
        {part.status === "error" && <span className="truncate text-rose-300">· {part.error}</span>}
        <span className="ml-auto flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {runId && <Link to={`/history/${runId}`} className="text-text-dim hover:text-text">abrir execução</Link>}
          {link && <Link to={link.to} className="text-text-dim hover:text-text">{link.label}</Link>}
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-line px-2.5 py-2">
          <div className="font-mono text-[0.66rem] text-text-dim">{part.name}</div>
          <Block label="entrada" text={pretty(part.input)} />
          {part.output && <Block label="saída" text={part.output} />}
          {part.error && <Block label="erro" text={part.error} tone="bad" />}
        </div>
      )}
    </div>
  );
}

function Block({ label, text, tone }: { label: string; text: string; tone?: "bad" }) {
  return (
    <div>
      <div className="mb-0.5 text-[0.62rem] tracking-wider text-text-dim uppercase">{label}</div>
      <pre className={cn("max-h-72 overflow-auto rounded border border-line bg-ink-950 p-2 font-mono text-[0.7rem] leading-relaxed whitespace-pre-wrap", tone === "bad" && "text-rose-300")}>{text}</pre>
    </div>
  );
}

export function AskCard({ part, active, onAnswer }: { part: Extract<Part, { type: "ask" }>; active: boolean; onAnswer: (resposta: string[]) => void }) {
  const [sel, setSel] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const answer = [...sel, ...(other.trim() ? [other.trim()] : [])];
  const toggle = (r: string) => setSel((s) => (part.multipla ? (s.includes(r) ? s.filter((x) => x !== r) : [...s, r]) : [r]));
  const done = part.status !== "pending";
  return (
    <div className={cn("my-2 rounded-lg border p-3", done ? "border-line bg-ink-900/40" : "border-blue-500/40 bg-blue-500/5")}>
      <div className="mb-2 flex items-start gap-2 text-sm font-medium">
        <CircleHelp className="mt-0.5 h-4 w-4 shrink-0 text-blue-300" />
        <span>{part.pergunta}</span>
      </div>
      {part.multipla && !done && <div className="mb-1.5 text-[0.68rem] text-text-dim">Marque uma ou mais opções.</div>}
      <div className="grid gap-1.5">
        {part.opcoes.map((o) => {
          const chosen = done ? !!part.resposta?.includes(o.rotulo) : sel.includes(o.rotulo);
          return (
            <button
              key={o.rotulo}
              disabled={done || !active}
              onClick={() => toggle(o.rotulo)}
              onDoubleClick={() => !part.multipla && active && !done && onAnswer([o.rotulo])}
              className={cn(
                "flex items-start gap-2.5 rounded-md border px-2.5 py-2 text-left text-[0.82rem] transition-colors",
                chosen ? "border-blue-400/60 bg-blue-500/10" : "border-line bg-ink-900 enabled:hover:border-ink-500",
                (done || !active) && !chosen && "opacity-50",
              )}
            >
              {part.multipla ? (
                <span className={cn("mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border", chosen ? "border-blue-300 bg-blue-300 text-ink-950" : "border-ink-500")}>{chosen && <Check className="h-3 w-3" strokeWidth={3} />}</span>
              ) : <span className={cn("mt-1 h-3 w-3 shrink-0 rounded-full border", chosen ? "border-blue-300 bg-blue-300" : "border-ink-500")} />}
              <span>
                <span className="font-medium">{o.rotulo}</span>
                {o.descricao && <span className="block text-[0.72rem] text-text-muted">{o.descricao}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {done ? (
        <div className="mt-2 text-[0.72rem] text-text-dim">
          {part.status === "answered" ? (
            <>
              Resposta: <span className="text-text-muted">{part.resposta?.join(", ")}</span>
            </>
          ) : (
            "Sem resposta (a conversa seguiu)."
          )}
        </div>
      ) : (
        active && (
          <div className="mt-2 flex gap-2">
            {part.permitirOutro && <Input value={other} onChange={(e) => setOther(e.target.value)} placeholder="Outra resposta…" className="h-8 text-xs" onKeyDown={(e) => e.key === "Enter" && answer.length && onAnswer(answer)} />}
            <Button size="sm" className="h-8" disabled={!answer.length} onClick={() => onAnswer(answer)}>
              Responder
            </Button>
          </div>
        )
      )}
    </div>
  );
}

export function ApprovalCard({ part, active, onDecide }: { part: Extract<Part, { type: "approval" }>; active: boolean; onDecide: (ok: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const status = {
    pending: null,
    approved: part.error ? <span className="text-rose-300">aprovado · falhou: {part.error}</span> : <span className="text-emerald-300">aprovado e executado</span>,
    denied: <span className="text-rose-300">negado</span>,
    skipped: <span className="text-text-dim">sem decisão (a conversa seguiu)</span>,
  }[part.status];
  return (
    <div className={cn("my-2 rounded-lg border p-3", part.status === "pending" ? "border-amber-500/50 bg-amber-500/5" : "border-line bg-ink-900/40")}>
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
        <div className="min-w-0 flex-1">
          <div className="text-[0.7rem] tracking-wider text-amber-300/80 uppercase">{TOOL_LABEL[part.name] ?? part.name} · requer aprovação</div>
          <div className="mt-0.5 text-sm">{part.resumo}</div>
          <button className="mt-1 text-[0.7rem] text-text-dim hover:text-text-muted" onClick={() => setOpen((o) => !o)}>
            {open ? "ocultar detalhes" : "ver detalhes"}
          </button>
          {open && (
            <div className="mt-1.5 space-y-2">
              <Block label="parâmetros" text={pretty(part.input)} />
              {part.output && <Block label="resultado" text={part.output} />}
            </div>
          )}
        </div>
      </div>
      {part.status === "pending" ? (
        active && (
          <div className="mt-2.5 flex justify-end gap-2">
            <Button size="sm" variant="outline" className="h-8" onClick={() => onDecide(false)}>
              Negar
            </Button>
            <Button size="sm" className="h-8" onClick={() => onDecide(true)}>
              Aprovar
            </Button>
          </div>
        )
      ) : (
        <div className="mt-2 text-[0.72rem]">{status}</div>
      )}
    </div>
  );
}

export function DisplayPart({ input }: { input: DisplayInput }) {
  return (
    <figure className="my-2 overflow-hidden rounded-lg border border-line bg-ink-900">
      {input.titulo && <figcaption className="border-b border-line px-3 py-1.5 text-xs font-medium">{input.titulo}</figcaption>}
      {input.tipo === "imagem" && <DisplayImage input={input} />}
      {input.tipo === "fluxo" && input.fluxoId && <DisplayFlow flowId={input.fluxoId} highlight={input.destacar ?? []} />}
      {input.tipo === "tabela" && (
        <div className="overflow-x-auto">
          <table className="w-full text-[0.78rem]">
            <thead className="bg-ink-850 text-left text-text-muted">
              <tr>{(input.colunas ?? []).map((c) => <th key={c} className="px-2.5 py-1.5 font-medium">{c}</th>)}</tr>
            </thead>
            <tbody>
              {(input.linhas ?? []).map((r, i) => (
                <tr key={i}>{r.map((c, j) => <td key={j} className="border-t border-line px-2.5 py-1.5 align-top tabular-nums">{c ?? "—"}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {input.tipo === "grafico" && <DisplayChart input={input} />}
    </figure>
  );
}

function DisplayImage({ input }: { input: DisplayInput }) {
  const src = input.fileId ? fileUrl(input.fileId, true) : input.url;
  if (!src) return <div className="p-3 text-xs text-text-dim">imagem sem origem</div>;
  return (
    <a href={src} target="_blank" rel="noreferrer" className="block bg-ink-950 p-2">
      <img src={src} alt={input.titulo ?? ""} className="mx-auto max-h-[28rem] max-w-full rounded" />
    </a>
  );
}

function DisplayFlow({ flowId, highlight }: { flowId: string; highlight: string[] }) {
  const q = useQuery({ queryKey: ["flow", flowId, "assistant-view"], queryFn: () => api.get<{ flow: Flow }>(`/flows/${flowId}`) });
  const view = useMemo(() => {
    if (!q.data) return null;
    const g = q.data.flow.graph;
    const hl = new Set(highlight);
    const states: Record<string, NodeState> = Object.fromEntries([...hl].map((id) => [id, "ok" as NodeState]));
    const nodes = toRfNodes(g, { states }).map((n) => ({ ...n, data: { ...n.data, dimmed: hl.size > 0 && !hl.has(n.id) } }));
    return { nodes, edges: toRfEdges(g) };
  }, [q.data, highlight]);
  if (q.isError) return <div className="flex items-center gap-2 p-3 text-xs text-rose-300"><AlertTriangle className="h-3.5 w-3.5" /> não foi possível carregar o fluxo</div>;
  if (!view) return <div className="flex h-40 items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-text-dim" /></div>;
  return (
    <div>
      <div className="h-80">
        <FlowCanvas nodes={view.nodes} edges={view.edges} readOnly minimap={false} fitKey={flowId} />
      </div>
      <div className="flex items-center justify-between border-t border-line px-3 py-1.5 text-[0.7rem] text-text-dim">
        <span>{q.data!.flow.name} · rev {q.data!.flow.revision}</span>
        <Link to={`/flows/${flowId}`} className="flex items-center gap-1 hover:text-text">abrir no editor <ExternalLink className="h-3 w-3" /></Link>
      </div>
    </div>
  );
}

function DisplayChart({ input }: { input: DisplayInput }) {
  const data = (input.dados ?? []).map((d) => ({ rotulo: d.rotulo, valor: d.valor }));
  const config: ChartConfig = { valor: { label: input.unidade ? `Valor (${input.unidade})` : "Valor", color: "var(--chart-1)" } };
  return (
    <div className="p-3">
      <ChartContainer config={config} className="aspect-auto h-56 w-full">
        <BarChart data={data} margin={{ left: 4, right: 8, top: 4 }}>
          <CartesianGrid vertical={false} stroke="var(--color-line)" />
          <XAxis dataKey="rotulo" tickLine={false} axisLine={false} fontSize={11} interval={0} />
          <YAxis tickLine={false} axisLine={false} width={48} fontSize={11} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar dataKey="valor" fill="var(--color-valor)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ChartContainer>
    </div>
  );
}

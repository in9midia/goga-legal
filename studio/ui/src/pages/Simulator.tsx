import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeftRight, FileDown, FileText, Loader2, MessageSquarePlus, Paperclip, Rocket, Send, ThumbsDown, ThumbsUp, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { api, fileUrl } from "@/lib/api";
import { bytes, dateTime, usd } from "@/lib/format";
import { ATALHO_LABEL, type ChatSession, type FlowSummary, type Message, type Outcome, type RunDetail, type SessionFile } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useRunStream } from "@/hooks/useRunStream";
import { Empty, Pill, StatusBadge } from "@/components/common";
import { TraceView } from "@/components/trace/TraceView";
import { CopyButton, TranscriptMenu } from "@/components/transcript";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const PROD = "__production__";

interface SessionDetail {
  session: ChatSession;
  messages: Message[];
  files: SessionFile[];
  runs: { id: string; status: string; costUsd: number; flowName: string; flowRevision: number; isProduction: boolean }[];
}

type Target = { flowId: string | null; useProduction: boolean };
const targetValue = (t: Target) => (t.useProduction ? PROD : (t.flowId ?? ""));
const parseTarget = (v: string): Target => (v === PROD ? { flowId: null, useProduction: true } : { flowId: v, useProduction: false });

export function SimulatorPage() {
  const { sessionId } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();

  const flows = useQuery({ queryKey: ["flows"], queryFn: () => api.get<{ flows: FlowSummary[] }>("/flows").then((r) => r.flows) });
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => api.get<{ sessions: ChatSession[] }>("/sessions").then((r) => r.sessions) });
  const detail = useQuery({ queryKey: ["session", sessionId], queryFn: () => api.get<SessionDetail>(`/sessions/${sessionId}`), enabled: !!sessionId });

  // Alvo de uma conversa nova: ?flow= (vindo do editor) ou a producao.
  const [draftTarget, setDraftTarget] = useState<Target>(() => (params.get("flow") ? { flowId: params.get("flow"), useProduction: false } : { flowId: null, useProduction: true }));
  const target: Target = sessionId && detail.data ? { flowId: detail.data.session.flowId, useProduction: detail.data.session.useProduction } : draftTarget;

  const [activeRun, setActiveRun] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const stream = useRunStream(activeRun, () => {
    qc.invalidateQueries({ queryKey: ["session", sessionId] });
    qc.invalidateQueries({ queryKey: ["sessions"] });
    qc.invalidateQueries({ queryKey: ["run", activeRun] });
  });
  useEffect(() => {
    setActiveRun(null);
    setSelectedRun(null);
  }, [sessionId]);
  // Ultima resposta selecionada por padrao ao abrir uma conversa.
  useEffect(() => {
    if (!selectedRun && detail.data?.messages.length) {
      const last = [...detail.data.messages].reverse().find((m) => m.runId);
      if (last?.runId) setSelectedRun(last.runId);
    }
  }, [detail.data, selectedRun]);

  const traceRunId = selectedRun ?? activeRun;
  const isLive = !!activeRun && traceRunId === activeRun && !stream.status;
  const runDetail = useQuery({ queryKey: ["run", traceRunId], queryFn: () => api.get<RunDetail>(`/runs/${traceRunId}`), enabled: !!traceRunId });

  const changeTarget = useMutation({
    mutationFn: (t: Target) => (sessionId ? api.put(`/sessions/${sessionId}`, t) : Promise.resolve(setDraftTarget(t))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["session", sessionId] }),
  });

  const ensureSession = async (): Promise<string> => {
    if (sessionId) return sessionId;
    const r = await api.post<{ session: ChatSession }>("/sessions", draftTarget);
    qc.invalidateQueries({ queryKey: ["sessions"] });
    nav(`/simulator/${r.session.id}`, { replace: true });
    return r.session.id;
  };

  const flowName = (t: Target) => (t.useProduction ? "Produção" : (flows.data?.find((f) => f.id === t.flowId)?.name ?? "—"));

  return (
    <div className="h-full">
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel defaultSize="18%" minSize="12%" maxSize="30%">
          <SessionList sessions={sessions.data ?? []} current={sessionId} onNew={() => nav("/simulator")} onDeleted={(id) => { qc.invalidateQueries({ queryKey: ["sessions"] }); if (id === sessionId) nav("/simulator"); }} />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize="44%" minSize="28%">
          <Chat
            key={sessionId ?? "new"}
            sessionId={sessionId}
            detail={detail.data}
            flows={flows.data ?? []}
            target={target}
            onTarget={(t) => changeTarget.mutate(t)}
            ensureSession={ensureSession}
            running={isLive}
            onSent={(runId) => {
              setActiveRun(runId);
              setSelectedRun(runId);
              qc.invalidateQueries({ queryKey: ["session", sessionId] });
            }}
            selectedRun={traceRunId}
            onSelectRun={setSelectedRun}
            flowName={flowName}
          />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize="38%" minSize="24%">
          <div className="flex h-full flex-col border-l border-line bg-ink-900/40">
            <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
              <span className="text-sm font-medium">Trace</span>
              {isLive && <StatusBadge status="running" />}
              {runDetail.data && !isLive && <StatusBadge status={runDetail.data.run.status} />}
              {runDetail.data && (
                <span className="truncate text-[0.7rem] text-text-dim">
                  {runDetail.data.run.flowName} · rev {runDetail.data.run.flowRevision}
                  {runDetail.data.run.isProduction ? " · produção" : " · rascunho"}
                </span>
              )}
              {traceRunId && !isLive && (
                <div className="ml-auto flex items-center gap-2">
                  <TranscriptMenu label="Copiar execução" sources={[{ label: "Esta execução", path: `/runs/${traceRunId}/transcript`, filename: `execucao-${traceRunId.slice(0, 8)}.md` }]} />
                  <Link to={`/history/${traceRunId}`} className="text-[0.7rem] text-text-muted hover:text-text">abrir no histórico</Link>
                </div>
              )}
            </div>
            <div className="min-h-0 flex-1">
              {traceRunId ? (
                <TraceView
                  graph={runDetail.data?.run.graph}
                  spans={isLive ? stream.spans : (runDetail.data?.spans ?? [])}
                  outcome={isLive ? null : runDetail.data?.run.outcome}
                  flowId={runDetail.data?.run.flowId ?? target.flowId}
                  live={isLive}
                />
              ) : (
                <p className="p-4 text-sm text-text-dim">Envie uma mensagem para ver cada passo: classificação, especialistas, KB, skills, compliance, custo e tempo.</p>
              )}
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

function SessionList({ sessions, current, onNew, onDeleted }: { sessions: ChatSession[]; current?: string; onNew: () => void; onDeleted: (id: string) => void }) {
  const del = useMutation({ mutationFn: (id: string) => api.del(`/sessions/${id}`), onSuccess: (_, id) => onDeleted(id) });
  return (
    <div className="flex h-full flex-col border-r border-line bg-ink-900/40">
      <div className="border-b border-line p-3">
        <Button size="sm" className="w-full" onClick={onNew}><MessageSquarePlus className="h-4 w-4" /> Nova conversa</Button>
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        {sessions.length === 0 && <p className="p-2 text-xs text-text-dim">Nenhuma conversa ainda.</p>}
        {sessions.map((s) => (
          <div key={s.id} className={cn("group flex items-center rounded-md", s.id === current ? "bg-ink-800" : "hover:bg-ink-850")}>
            <Link to={`/simulator/${s.id}`} className="min-w-0 flex-1 px-2.5 py-2">
              <div className="truncate text-[0.8rem]">{s.title}</div>
              <div className="truncate text-[0.66rem] text-text-dim">{s.useProduction ? "produção" : (s.flowName ?? "fluxo excluído")} · {dateTime(s.createdAt)}</div>
            </Link>
            <button className="mr-1 hidden rounded p-1 text-text-dim group-hover:block hover:text-rose-300" title="Excluir conversa" onClick={() => del.mutate(s.id)}><Trash2 className="h-3.5 w-3.5" /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

function TargetSelect({ value, flows, onChange, className }: { value: Target; flows: FlowSummary[]; onChange: (t: Target) => void; className?: string }) {
  return (
    <Select value={targetValue(value)} onValueChange={(v) => onChange(parseTarget(v))}>
      <SelectTrigger size="sm" className={cn("w-72", className)}><SelectValue placeholder="Escolha um fluxo" /></SelectTrigger>
      <SelectContent>
        <SelectItem value={PROD}><Rocket className="h-3.5 w-3.5 text-emerald-400" /> Produção (release publicada)</SelectItem>
        <SelectGroup>
          <SelectLabel>Rascunhos</SelectLabel>
          {flows.map((f) => <SelectItem key={f.id} value={f.id}>{f.name} · rev {f.revision}</SelectItem>)}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function Chat({
  sessionId,
  detail,
  flows,
  target,
  onTarget,
  ensureSession,
  running,
  onSent,
  selectedRun,
  onSelectRun,
  flowName,
}: {
  sessionId?: string;
  detail?: SessionDetail;
  flows: FlowSummary[];
  target: Target;
  onTarget: (t: Target) => void;
  ensureSession: () => Promise<string>;
  running: boolean;
  onSent: (runId: string) => void;
  selectedRun: string | null;
  onSelectRun: (id: string) => void;
  flowName: (t: Target) => string;
}) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [pending, setPending] = useState<SessionFile[]>([]);
  const [uploading, setUploading] = useState(0);
  const [drag, setDrag] = useState(false);
  const [compare, setCompare] = useState<{ runId: string; outcome: Outcome | null } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const messages = detail?.messages ?? [];
  const filesById = useMemo(() => new Map((detail?.files ?? []).map((f) => [f.id, f])), [detail?.files]);
  const runsById = useMemo(() => new Map((detail?.runs ?? []).map((r) => [r.id, r])), [detail?.runs]);

  // Chaves obrigatorias: no Chrome novo `scrollIntoView` devolve uma Promise, e
  // devolve-la do efeito faz o React trata-la como cleanup ("destroy is not a function").
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, running]);

  const upload = async (files: FileList | File[]) => {
    const sid = await ensureSession();
    for (const f of Array.from(files)) {
      setUploading((n) => n + 1);
      try {
        const r = await api.upload<{ file: SessionFile }>(`/sessions/${sid}/files`, f);
        setPending((p) => [...p, r.file]);
        if (r.file.warning) toast.warning(`${r.file.name}: ${r.file.warning}`);
      } catch (e) {
        toast.error(`${f.name}: ${(e as Error).message}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const send = useMutation({
    mutationFn: async () => {
      const sid = await ensureSession();
      return api.post<{ runId: string }>(`/sessions/${sid}/messages`, { content: text.trim(), fileIds: pending.map((f) => f.id) });
    },
    onSuccess: (r) => {
      setText("");
      setPending([]);
      onSent(r.runId);
      qc.invalidateQueries({ queryKey: ["session"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const canSend = text.trim().length > 0 && !running && !send.isPending && uploading === 0 && (target.useProduction || !!target.flowId);

  return (
    <div
      className={cn("relative flex h-full flex-col", drag && "ring-2 ring-inset ring-blue-500/50")}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) upload(e.dataTransfer.files); }}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="text-xs text-text-muted">Fluxo</span>
        <TargetSelect value={target} flows={flows} onChange={onTarget} />
        {detail && <span className="ml-auto truncate text-[0.7rem] text-text-dim">{detail.session.title}</span>}
        {sessionId && messages.length > 0 && (
          <TranscriptMenu
            label="Copiar conversa completa"
            className={cn(!detail && "ml-auto")}
            sources={[{ label: "Conversa inteira (todas as interações e execuções)", path: `/sessions/${sessionId}/transcript`, filename: `conversa-${sessionId.slice(0, 8)}.md` }]}
          />
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {!sessionId && messages.length === 0 && (
          <Empty icon={<MessageSquarePlus />}>
            <div>Simule uma pergunta de um usuário. Arraste PDF, DOCX, imagem ou TXT para anexar.</div>
            <div className="text-[0.72rem] text-text-dim">Qualquer fluxo pode ser simulado, não só o de produção.</div>
          </Empty>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="group relative ml-auto max-w-[85%] rounded-lg rounded-br-sm bg-ink-700 px-3.5 py-2.5 text-sm">
              <div className="whitespace-pre-wrap select-text">{m.content}</div>
              <div className="-mb-1 mt-1 flex justify-end"><CopyButton text={m.content} title="Copiar pergunta" label="Copiar" className="h-6 text-text-muted" /></div>
              {m.attachments.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {m.attachments.map((id) => <FileChip key={id} file={filesById.get(id)} id={id} />)}
                </div>
              )}
            </div>
          ) : (
            <AssistantMessage
              key={m.id}
              m={m}
              run={m.runId ? runsById.get(m.runId) : undefined}
              selected={m.runId === selectedRun}
              onSelect={() => m.runId && onSelectRun(m.runId)}
              flows={flows}
              onCompare={(runId, t) =>
                api.post<{ runId: string }>(`/runs/${m.runId}/rerun`, t).then((r) => {
                  setCompare({ runId: r.runId, outcome: m.payload });
                  toast.success(`Reexecutando com ${flowName(t)}`);
                  void runId;
                }).catch((e) => toast.error((e as Error).message))
              }
            />
          ),
        )}
        {running && (
          <div className="flex items-center gap-2 text-sm text-text-muted"><Loader2 className="h-4 w-4 animate-spin" /> executando o fluxo… acompanhe no trace ao lado</div>
        )}
        <div ref={bottom} />
      </div>

      <div className="border-t border-line p-3">
        {(pending.length > 0 || uploading > 0) && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {pending.map((f) => (
              <span key={f.id} className="inline-flex items-center gap-1.5 rounded border border-line bg-ink-850 px-2 py-1 text-[0.72rem]">
                <FileText className="h-3 w-3" /> {f.name} <span className="text-text-dim">{bytes(f.size)} · {f.extractedChars} car. · {f.method}</span>
                {f.warning && <AlertTriangle className="h-3 w-3 text-amber-400" />}
                <button onClick={() => setPending((p) => p.filter((x) => x.id !== f.id))}><X className="h-3 w-3" /></button>
              </span>
            ))}
            {uploading > 0 && <span className="inline-flex items-center gap-1 text-[0.72rem] text-text-muted"><Loader2 className="h-3 w-3 animate-spin" /> extraindo texto…</span>}
          </div>
        )}
        <div className="flex items-end gap-2">
          <input ref={fileInput} type="file" multiple hidden accept=".pdf,.docx,.txt,.md,image/*" onChange={(e) => e.target.files && upload(e.target.files)} />
          <Button variant="ghost" size="icon" title="Anexar" onClick={() => fileInput.current?.click()}><Paperclip className="h-4 w-4" /></Button>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Escreva como um usuário escreveria…  (Enter envia, Shift+Enter quebra linha)"
            className="max-h-48 min-h-[44px] flex-1 resize-none"
            rows={2}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (canSend) send.mutate();
              }
            }}
          />
          <Button onClick={() => send.mutate()} disabled={!canSend}><Send className="h-4 w-4" /></Button>
        </div>
      </div>

      <CompareDialog state={compare} onClose={() => setCompare(null)} />
    </div>
  );
}

function FileChip({ file, id }: { file?: SessionFile; id: string }) {
  return (
    <a href={fileUrl(id)} className="inline-flex items-center gap-1 rounded bg-ink-900/60 px-1.5 py-0.5 text-[0.7rem] text-text-muted hover:text-text">
      <Paperclip className="h-3 w-3" /> {file?.name ?? "anexo"}
    </a>
  );
}

function AssistantMessage({ m, run, selected, onSelect, flows, onCompare }: { m: Message; run?: SessionDetail["runs"][number]; selected: boolean; onSelect: () => void; flows: FlowSummary[]; onCompare: (runId: string, t: Target) => void }) {
  const o = m.payload;
  const [rating, setRating] = useState<number | null>(null);
  const [cmpTarget, setCmpTarget] = useState<Target | null>(null);
  const rate = (v: number) => {
    if (!m.runId) return;
    const next = rating === v ? 0 : v;
    api.post(`/runs/${m.runId}/rating`, { rating: next, comment: "" }).then(() => setRating(next || null));
  };
  return (
    <div onClick={onSelect} className={cn("max-w-[92%] cursor-pointer rounded-lg rounded-bl-sm border bg-ink-900 px-3.5 py-3 text-sm transition-colors", selected ? "border-text-dim" : "border-line hover:border-ink-500")}>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {o?.status && <StatusBadge status={o.status} />}
        {o?.error && <StatusBadge status="error" />}
        {run && <span className="text-[0.68rem] text-text-dim">{run.flowName} · rev {run.flowRevision}{run.isProduction ? " · produção" : ""} · {usd(run.costUsd)}</span>}
        {o?.atalho && o.atalho !== "completo" && <Pill>{ATALHO_LABEL[o.atalho]}</Pill>}
        {o?.flags?.filter((f) => f !== "compliance_reprovado").map((f) => <Pill key={f} tone="warn">{f.replace(/_/g, " ")}</Pill>)}
      </div>
      {o?.resposta_tecnica ? (
        <Tabs defaultValue="simples" onClick={(e) => e.stopPropagation()}>
          <TabsList className="mb-2 h-7">
            <TabsTrigger value="simples" className="text-xs">Simples</TabsTrigger>
            <TabsTrigger value="tecnica" className="text-xs">Técnica</TabsTrigger>
          </TabsList>
          <TabsContent value="simples"><div className="leading-relaxed whitespace-pre-wrap">{o.resposta_simples}</div></TabsContent>
          <TabsContent value="tecnica"><div className="leading-relaxed whitespace-pre-wrap text-text-muted">{o.resposta_tecnica}</div></TabsContent>
        </Tabs>
      ) : (
        <div className="whitespace-pre-wrap">{m.content}</div>
      )}
      {o?.citacoes && o.citacoes.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {o.citacoes.map((c) => (
            <span key={c.citacao} title={c.nota ?? c.fonte} className="inline-flex items-center gap-1 text-[0.7rem] text-text-muted">{c.citacao} <StatusBadge status={c.status} /></span>
          ))}
        </div>
      )}
      {o?.documentos && o.documentos.length > 0 && (
        <div className="mt-3 grid gap-1.5 sm:grid-cols-2" onClick={(e) => e.stopPropagation()}>
          {o.documentos.map((d) => (
            <a key={d.fileId} href={fileUrl(d.fileId)} className="flex items-center gap-2 rounded-md border border-line bg-ink-850 px-2.5 py-2 hover:border-ink-500">
              <FileDown className="h-4 w-4 text-emerald-400" />
              <div className="min-w-0">
                <div className="truncate text-xs font-medium">{d.name}</div>
                <div className="text-[0.66rem] text-text-dim">{d.template} · baixar</div>
              </div>
            </a>
          ))}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-1 border-t border-line pt-2" onClick={(e) => e.stopPropagation()}>
        <Button variant="ghost" size="icon" className={cn("h-7 w-7", rating === 1 && "text-emerald-400")} title="Boa resposta" onClick={() => rate(1)}><ThumbsUp className="h-3.5 w-3.5" /></Button>
        <Button variant="ghost" size="icon" className={cn("h-7 w-7", rating === -1 && "text-rose-400")} title="Resposta ruim" onClick={() => rate(-1)}><ThumbsDown className="h-3.5 w-3.5" /></Button>
        <CopyButton text={o?.resposta_simples || m.content} title="Copiar resposta" label="Copiar resposta" />
        {o?.resposta_tecnica && <CopyButton text={o.resposta_tecnica} title="Copiar resposta técnica" label="Copiar técnica" />}
        <div className="ml-auto flex items-center gap-1.5">
          <ArrowLeftRight className="h-3.5 w-3.5 text-text-dim" />
          <TargetSelect value={cmpTarget ?? { flowId: null, useProduction: false }} flows={flows} onChange={setCmpTarget} className="h-7 w-48 text-xs" />
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!cmpTarget || !m.runId} onClick={() => cmpTarget && m.runId && onCompare(m.runId, cmpTarget)}>Reexecutar e comparar</Button>
        </div>
      </div>
    </div>
  );
}

function CompareDialog({ state, onClose }: { state: { runId: string; outcome: Outcome | null } | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["run", state?.runId, "compare"],
    queryFn: () => api.get<RunDetail>(`/runs/${state!.runId}`),
    enabled: !!state,
    refetchInterval: (query) => (query.state.data?.run.status === "running" ? 1500 : false),
  });
  const r = q.data?.run;
  const col = (title: string, o: Outcome | null | undefined, extra?: React.ReactNode) => (
    <div className="min-w-0 space-y-2 rounded-md border border-line bg-ink-900 p-3">
      <div className="flex flex-wrap items-center gap-1.5 text-xs font-medium">{title} {o && <StatusBadge status={o.status} />} {extra}</div>
      {o ? (
        <>
          <div className="text-[0.7rem] text-text-dim">especialistas: {o.especialistas.map((e) => e.name).join(", ") || "—"}</div>
          <div className="max-h-[50vh] overflow-y-auto text-sm whitespace-pre-wrap">{o.resposta_simples}</div>
          {o.compliance && <Pill tone={o.compliance.aprovado ? "ok" : "bad"}>compliance {o.compliance.aprovado ? "ok" : "reprovado"}</Pill>}
        </>
      ) : (
        <div className="flex items-center gap-2 text-sm text-text-muted"><Loader2 className="h-4 w-4 animate-spin" /> executando…</div>
      )}
    </div>
  );
  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader><DialogTitle>Comparação lado a lado</DialogTitle></DialogHeader>
        <div className="grid gap-3 md:grid-cols-2">
          {col("Original", state?.outcome)}
          {col(r ? `${r.flowName} · rev ${r.flowRevision}` : "Novo fluxo", r?.status === "running" ? null : r?.outcome, r && r.status !== "running" && <span className="text-text-dim">{usd(r.costUsd)}</span>)}
        </div>
        {r && r.status !== "running" && (
          <div className="flex justify-end gap-2 text-xs">
            <Link to={`/history/${r.id}`} className="text-text-muted hover:text-text">trace completo</Link>
            {r.sessionId && <Link to={`/simulator/${r.sessionId}`} className="text-text-muted hover:text-text" onClick={onClose}>abrir conversa</Link>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

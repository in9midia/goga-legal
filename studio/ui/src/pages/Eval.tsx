import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Check, ExternalLink, FlaskConical, Loader2, Play, Square, X } from "lucide-react";
import { api } from "@/lib/api";
import { dateTime, int, usd } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import type { FlowSummary } from "@/lib/types";
import { Page } from "@/Layout";
import { DividerLabel, Empty, ErrorBox, Field, KPI, Loading, PageHeader, Pill, StatusBadge } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Slider } from "@/components/ui/slider";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface EvalSet {
  id: string;
  count: number;
  space: string | null;
}
interface BatchSummary {
  id: string;
  name: string;
  status: "running" | "done" | "error" | "cancelled";
  flowIds: string[];
  total: number;
  done: number;
  createdAt: string;
  endedAt: string | null;
}
interface BatchResult {
  qi: number;
  flowId: string;
  runId: string;
  question: string;
  expectedSpace: string | null;
  status: "ok" | "clarify" | "blocked" | "error";
  error?: string | null;
  specialists: string[];
  routedOk: boolean | null;
  complianceApproved: boolean | null;
  complianceCycles: number | null;
  costUsd: number;
}
interface BatchDetail {
  batch: {
    id: string;
    name: string;
    flowIds: string[];
    questions: { question: string; space: string | null; kind?: string }[];
    results: BatchResult[];
    status: BatchSummary["status"];
    error: string | null;
    createdAt: string;
    endedAt: string | null;
  };
  flows: { id: string; name: string }[];
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");

export function EvalPage() {
  const { isAdmin } = useAuth();
  const [params, setParams] = useSearchParams();
  const selected = params.get("batch");
  const batches = useQuery({
    queryKey: ["eval", "batches"],
    queryFn: () => api.get<{ batches: BatchSummary[] }>("/eval/batches").then((r) => r.batches),
    refetchInterval: (q) => (q.state.data?.some((b) => b.status === "running") ? 3000 : false),
  });
  const select = (id: string | null) => setParams(id ? { batch: id } : {});

  return (
    <Page>
      <PageHeader
        icon={<FlaskConical />}
        title="Avaliação em lote"
        description="Roda as perguntas dos conjuntos de avaliação da KB contra um ou dois fluxos e compara roteamento, aprovação no compliance e custo, pergunta a pergunta."
      />

      <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>Cada pergunta é uma execução completa do fluxo (classificador, especialistas, consolidador e compliance). Com modelos reais isso custa dinheiro: confira o total de execuções antes de iniciar. Use o provedor "Simulado" para testar sem custo.</span>
      </div>

      {isAdmin ? <NewBatchForm onCreated={select} /> : <div className="rounded-md border border-line bg-ink-900 px-3 py-2 text-xs text-text-muted">Somente administradores iniciam lotes. Você pode consultar os resultados abaixo.</div>}

      <div className="space-y-2">
        <DividerLabel>Lotes</DividerLabel>
        <ErrorBox error={batches.error} />
        {batches.isLoading ? (
          <Loading />
        ) : !batches.data?.length ? (
          <Empty icon={<FlaskConical />}>Nenhum lote executado ainda.</Empty>
        ) : (
          <div className="rounded-[10px] border border-line bg-ink-900">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Nome</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead>Progresso</TableHead>
                  <TableHead className="text-right">Fluxos</TableHead>
                  <TableHead className="pr-4">Criado em</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {batches.data.map((b) => (
                  <TableRow key={b.id} className={cn("cursor-pointer", selected === b.id && "bg-ink-850")} onClick={() => select(selected === b.id ? null : b.id)}>
                    <TableCell className="pl-4 font-medium">{b.name}</TableCell>
                    <TableCell>
                      <StatusBadge status={b.status} />
                    </TableCell>
                    <TableCell>
                      <Progress done={Number(b.done)} total={Number(b.total)} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{b.flowIds.length}</TableCell>
                    <TableCell className="pr-4 text-text-muted tabular-nums">{dateTime(b.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {selected && <BatchView id={selected} />}
    </Page>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-28 overflow-hidden rounded-full bg-ink-700">
        <div className="h-full bg-[var(--chart-1)] transition-all" style={{ width: total ? `${(done / total) * 100}%` : 0 }} />
      </div>
      <span className="text-xs text-text-muted tabular-nums">
        {int(done)}/{int(total)}
      </span>
    </div>
  );
}

// ── Formulario ────────────────────────────────────────────────────────

function NewBatchForm({ onCreated }: { onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const sets = useQuery({ queryKey: ["eval", "sets"], queryFn: () => api.get<{ sets: EvalSet[] }>("/eval/sets").then((r) => r.sets) });
  const flows = useQuery({ queryKey: ["flows"], queryFn: () => api.get<{ flows: FlowSummary[] }>("/flows").then((r) => r.flows) });
  const [name, setName] = useState("");
  const [flowIds, setFlowIds] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [perSet, setPerSet] = useState(5);

  const questions = (sets.data ?? []).filter((s) => chosen.includes(s.id)).reduce((n, s) => n + Math.min(s.count, perSet), 0);
  const totalRuns = questions * flowIds.length;

  const toggleFlow = (id: string) => setFlowIds((v) => (v.includes(id) ? v.filter((x) => x !== id) : v.length >= 2 ? [v[1], id] : [...v, id]));
  const toggleSet = (id: string) => setChosen((v) => (v.includes(id) ? v.filter((x) => x !== id) : [...v, id]));

  const create = useMutation({
    mutationFn: () => api.post<{ batch: { id: string } }>("/eval/batches", { name: name.trim() || `Lote ${new Date().toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}`, flowIds, sets: chosen, perSet }),
    onSuccess: (r) => {
      toast.success("Lote iniciado");
      qc.invalidateQueries({ queryKey: ["eval", "batches"] });
      setName("");
      onCreated(r.batch.id);
    },
  });

  return (
    <div className="rounded-[10px] border border-line bg-ink-900 p-4">
      <div className="mb-3 text-sm font-medium">Novo lote</div>
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-4">
          <Field label="Nome do lote">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex.: roteamento v3 vs produção" />
          </Field>
          <Field label="Fluxos a comparar" hint="Escolha 1 fluxo, ou 2 para comparar lado a lado.">
            {flows.isLoading ? (
              <Loading />
            ) : flows.error ? (
              <ErrorBox error={flows.error} />
            ) : !flows.data?.length ? (
              <div className="text-xs text-text-dim">Nenhum fluxo cadastrado.</div>
            ) : (
              <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-line p-1">
                {flows.data.map((f) => {
                  const idx = flowIds.indexOf(f.id);
                  return (
                    <label key={f.id} className={cn("flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-ink-850", idx >= 0 && "bg-ink-850")}>
                      <Checkbox checked={idx >= 0} onCheckedChange={() => toggleFlow(f.id)} />
                      <span className="flex-1 truncate">{f.name}</span>
                      {f.isProduction && <Pill tone="ok">produção</Pill>}
                      {idx >= 0 && <Pill tone="info">{idx === 0 ? "A" : "B"}</Pill>}
                    </label>
                  );
                })}
              </div>
            )}
          </Field>
        </div>
        <div className="space-y-4">
          <Field label="Conjuntos de perguntas" hint="Conjuntos de content/evaluation da KB. Cada um tem uma base esperada, usada para medir o roteamento.">
            {sets.isLoading ? (
              <Loading />
            ) : sets.error ? (
              <ErrorBox error={sets.error} />
            ) : !sets.data?.length ? (
              <div className="text-xs text-text-dim">Nenhum conjunto encontrado.</div>
            ) : (
              <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-line p-1">
                {sets.data.map((s) => (
                  <label key={s.id} className={cn("flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-ink-850", chosen.includes(s.id) && "bg-ink-850")}>
                    <Checkbox checked={chosen.includes(s.id)} onCheckedChange={() => toggleSet(s.id)} />
                    <span className="flex-1 truncate">{s.id}</span>
                    {s.space && <span className="font-mono text-[0.68rem] text-text-dim">{s.space}</span>}
                    <span className="w-16 text-right text-xs text-text-muted tabular-nums">{s.count} perg.</span>
                  </label>
                ))}
              </div>
            )}
          </Field>
          <Field label={`Perguntas por conjunto: ${perSet}`}>
            <Slider min={1} max={50} step={1} value={[perSet]} onValueChange={(v) => setPerSet(v[0])} className="py-2" />
          </Field>
        </div>
      </div>
      <ErrorBox error={create.error} />
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
        <div className="text-sm text-text-muted">
          <span className="font-semibold text-text tabular-nums">{int(questions)}</span> perguntas × <span className="font-semibold text-text tabular-nums">{flowIds.length}</span> fluxo(s) ={" "}
          <span className={cn("font-semibold tabular-nums", totalRuns > 500 ? "text-rose-300" : "text-text")}>{int(totalRuns)} execuções</span>
          {totalRuns > 500 && <span className="ml-2 text-xs text-rose-300">máximo 500</span>}
        </div>
        <Button onClick={() => create.mutate()} disabled={!flowIds.length || !questions || totalRuns > 500 || create.isPending}>
          {create.isPending ? <Loader2 className="animate-spin" /> : <Play />} Iniciar lote
        </Button>
      </div>
    </div>
  );
}

// ── Detalhe ───────────────────────────────────────────────────────────

function BatchView({ id }: { id: string }) {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["eval", "batch", id],
    queryFn: () => api.get<BatchDetail>(`/eval/batches/${id}`),
    refetchInterval: (query) => (query.state.data?.batch.status === "running" ? 3000 : false),
  });
  const status = q.data?.batch.status;
  useEffect(() => {
    // quando o lote termina, a lista tambem precisa atualizar
    if (status && status !== "running") qc.invalidateQueries({ queryKey: ["eval", "batches"] });
  }, [status, qc]);

  const cancel = useMutation({
    mutationFn: () => api.post(`/eval/batches/${id}/cancel`),
    onSuccess: () => {
      toast.success("Cancelamento solicitado: as execuções em andamento terminam primeiro.");
      qc.invalidateQueries({ queryKey: ["eval"] });
    },
    onError: (e) => toast.error(e.message),
  });

  const view = useMemo(() => {
    if (!q.data) return null;
    const { batch, flows } = q.data;
    const flowName = (fid: string) => flows.find((f) => f.id === fid)?.name ?? "(fluxo excluído)";
    const perFlow = batch.flowIds.map((fid) => {
      const rs = batch.results.filter((r) => r.flowId === fid);
      const routed = rs.filter((r) => r.routedOk != null);
      const comp = rs.filter((r) => r.complianceApproved != null);
      const counts = { ok: 0, clarify: 0, blocked: 0, error: 0 } as Record<string, number>;
      for (const r of rs) counts[r.status] = (counts[r.status] ?? 0) + 1;
      const cost = rs.reduce((s, r) => s + (r.costUsd ?? 0), 0);
      return {
        fid,
        name: flowName(fid),
        n: rs.length,
        routedOk: routed.filter((r) => r.routedOk).length,
        routedN: routed.length,
        compOk: comp.filter((r) => r.complianceApproved).length,
        compN: comp.length,
        cost,
        avg: rs.length ? cost / rs.length : 0,
        counts,
      };
    });
    const byQ = new Map<number, Map<string, BatchResult>>();
    for (const r of batch.results) {
      if (!byQ.has(r.qi)) byQ.set(r.qi, new Map());
      byQ.get(r.qi)!.set(r.flowId, r);
    }
    return { batch, perFlow, byQ };
  }, [q.data]);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  if (!view) return null;
  const { batch, perFlow, byQ } = view;
  const total = batch.questions.length * batch.flowIds.length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold">{batch.name}</h2>
          <StatusBadge status={batch.status} />
          <Progress done={batch.results.length} total={total} />
          <span className="text-xs text-text-dim">
            {dateTime(batch.createdAt)}
            {batch.endedAt && ` → ${dateTime(batch.endedAt)}`}
          </span>
        </div>
        {isAdmin && batch.status === "running" && (
          <Button size="sm" variant="outline" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
            <Square /> Cancelar
          </Button>
        )}
      </div>
      {batch.error && <ErrorBox error={batch.error} />}

      <div className={cn("grid gap-4", perFlow.length > 1 && "lg:grid-cols-2")}>
        {perFlow.map((f, i) => (
          <div key={f.fid} className="space-y-2 rounded-[10px] border border-line bg-ink-900 p-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              {perFlow.length > 1 && <Pill tone="info">{i === 0 ? "A" : "B"}</Pill>}
              {f.name}
              <span className="text-xs font-normal text-text-dim">{f.n} resultado(s)</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <KPI label="Roteamento correto" value={pct(f.routedOk, f.routedN)} hint={`${f.routedOk}/${f.routedN} com base esperada`} />
              <KPI label="Custo médio" value={usd(f.avg)} hint={`total ${usd(f.cost)}`} />
              <KPI label="Aprovação compliance" value={pct(f.compOk, f.compN)} hint={`${f.compOk}/${f.compN}`} />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(["ok", "clarify", "blocked", "error"] as const).map((s) => (
                <span key={s} className="flex items-center gap-1">
                  <StatusBadge status={s} />
                  <span className="text-xs text-text-muted tabular-nums">{f.counts[s] ?? 0}</span>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-[10px] border border-line bg-ink-900">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10 pl-4">#</TableHead>
              <TableHead>Pergunta</TableHead>
              {perFlow.map((f, i) => (
                <TableHead key={f.fid} className="min-w-64">
                  {perFlow.length > 1 ? `${i === 0 ? "A" : "B"} · ` : ""}
                  {f.name}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {batch.questions.map((qq, qi) => (
              <TableRow key={qi} className="align-top">
                <TableCell className="pl-4 text-text-dim tabular-nums">{qi + 1}</TableCell>
                <TableCell className="max-w-md whitespace-normal">
                  <div className="text-sm leading-snug">{qq.question}</div>
                  {qq.space && <div className="mt-0.5 font-mono text-[0.68rem] text-text-dim">base esperada: {qq.space}</div>}
                </TableCell>
                {perFlow.map((f) => (
                  <TableCell key={f.fid} className="whitespace-normal">
                    <ResultCell r={byQ.get(qi)?.get(f.fid)} running={batch.status === "running"} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function ResultCell({ r, running }: { r?: BatchResult; running: boolean }) {
  if (!r) return <span className="text-xs text-text-dim">{running ? "aguardando…" : "não executada"}</span>;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge status={r.status} />
        {r.routedOk === true && (
          <Pill tone="ok" title="Um dos especialistas escolhidos consulta a base esperada">
            <Check className="h-3 w-3" /> roteamento
          </Pill>
        )}
        {r.routedOk === false && (
          <Pill tone="bad" title="Nenhum especialista escolhido consulta a base esperada">
            <X className="h-3 w-3" /> roteamento
          </Pill>
        )}
        {r.complianceApproved === false && <Pill tone="warn">compliance reprovou</Pill>}
        <span className="text-xs text-text-muted tabular-nums">{usd(r.costUsd)}</span>
        <Link to={`/history/${r.runId}`} className="ml-auto text-text-dim hover:text-text" title="Abrir execução">
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </div>
      {r.specialists.length > 0 && <div className="text-xs text-text-muted">{r.specialists.join(", ")}</div>}
      {r.error && <div className="line-clamp-2 text-xs text-rose-300" title={r.error}>{r.error}</div>}
    </div>
  );
}

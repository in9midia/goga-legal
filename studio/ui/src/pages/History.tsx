import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, FileDown, History, Rocket, ThumbsDown, ThumbsUp } from "lucide-react";
import { api, fileUrl, qs } from "@/lib/api";
import { dateTime, isoDay, ms, usd, int } from "@/lib/format";
import type { FlowSummary, Run, RunDetail, User } from "@/lib/types";
import { useAuth } from "@/lib/auth";
import { Page } from "@/Layout";
import { Empty, ErrorBox, Field, Loading, PageHeader, Pill, StatusBadge } from "@/components/common";
import { TraceView } from "@/components/trace/TraceView";
import { TranscriptMenu } from "@/components/transcript";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const ALL = "__all__";

export function HistoryPage() {
  const { isAdmin } = useAuth();
  const [f, setF] = useState({ flowId: ALL, userId: ALL, status: ALL, production: ALL, from: isoDay(new Date(Date.now() - 30 * 864e5)), to: isoDay(new Date()), q: "" });
  const flows = useQuery({ queryKey: ["flows"], queryFn: () => api.get<{ flows: FlowSummary[] }>("/flows").then((r) => r.flows) });
  const users = useQuery({ queryKey: ["users"], queryFn: () => api.get<{ users: User[] }>("/users").then((r) => r.users), enabled: isAdmin });
  const norm = (v: string) => (v === ALL ? undefined : v);
  const runs = useQuery({
    queryKey: ["runs", f],
    queryFn: () => api.get<{ runs: Run[] }>(`/runs${qs({ flowId: norm(f.flowId), userId: norm(f.userId), status: norm(f.status), production: norm(f.production), from: f.from, to: f.to, q: f.q, limit: 300 })}`).then((r) => r.runs),
    refetchInterval: 10_000,
  });
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));

  return (
    <Page>
      <PageHeader icon={<History />} title="Histórico" description="Todas as execuções: o que foi perguntado, por qual fluxo (e revisão), com qual resultado e custo. Clique para abrir o trace completo." />
      <div className="grid gap-3 rounded-[10px] border border-line bg-ink-900 p-3 sm:grid-cols-3 lg:grid-cols-7">
        <Field label="Busca" className="lg:col-span-2"><Input value={f.q} onChange={(e) => set("q")(e.target.value)} placeholder="texto da pergunta" /></Field>
        <Field label="Fluxo">
          <Select value={f.flowId} onValueChange={set("flowId")}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value={ALL}>Todos</SelectItem>{(flows.data ?? []).map((x) => <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        {isAdmin && (
          <Field label="Usuário">
            <Select value={f.userId} onValueChange={set("userId")}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ALL}>Todos</SelectItem>{(users.data ?? []).map((u) => <SelectItem key={u.id} value={u.id}>{u.email}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        )}
        <Field label="Status">
          <Select value={f.status} onValueChange={set("status")}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todos</SelectItem>
              {["ok", "clarify", "blocked", "error", "running"].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Origem">
          <Select value={f.production} onValueChange={set("production")}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value={ALL}>Todas</SelectItem><SelectItem value="true">Produção</SelectItem><SelectItem value="false">Rascunho</SelectItem></SelectContent>
          </Select>
        </Field>
        <Field label="De"><Input type="date" value={f.from} onChange={(e) => set("from")(e.target.value)} /></Field>
        <Field label="Até"><Input type="date" value={f.to} onChange={(e) => set("to")(e.target.value)} /></Field>
      </div>
      <ErrorBox error={runs.error} />
      {runs.isLoading ? (
        <Loading />
      ) : !runs.data?.length ? (
        <Empty icon={<History />}>Nenhuma execução no período.</Empty>
      ) : (
        <div className="overflow-hidden rounded-[10px] border border-line bg-ink-900">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Quando</TableHead>
                <TableHead>Pergunta</TableHead>
                <TableHead>Fluxo</TableHead>
                <TableHead>Usuário</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Custo</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.data.map((r) => (
                <TableRow key={r.id} className="cursor-pointer">
                  <TableCell className="text-xs whitespace-nowrap text-text-muted">{dateTime(r.startedAt)}</TableCell>
                  <TableCell className="max-w-[340px]"><Link to={`/history/${r.id}`} className="line-clamp-2 text-sm hover:underline">{r.question}</Link></TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {r.flowName} <span className="text-text-dim">rev {r.flowRevision}</span>
                    {r.isProduction && <Rocket className="ml-1 inline h-3 w-3 text-emerald-400" />}
                  </TableCell>
                  <TableCell className="text-xs text-text-muted">{r.userEmail ?? "lote"}</TableCell>
                  <TableCell><StatusBadge status={r.status} /></TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{int(r.tokensIn + r.tokensOut)}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{usd(r.costUsd)}</TableCell>
                  <TableCell>{r.rating === 1 ? <ThumbsUp className="h-3.5 w-3.5 text-emerald-400" /> : r.rating === -1 ? <ThumbsDown className="h-3.5 w-3.5 text-rose-400" /> : null}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Page>
  );
}

export function RunPage() {
  const { runId } = useParams();
  const q = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.get<RunDetail>(`/runs/${runId}`),
    refetchInterval: (query) => (query.state.data?.run.status === "running" ? 2000 : false),
  });
  if (q.isLoading) return <Loading />;
  if (!q.data) return <div className="p-6"><ErrorBox error={q.error ?? "execução não encontrada"} /></div>;
  const { run, spans, files } = q.data;
  const o = run.outcome;
  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-line bg-ink-900/60 px-4 py-2.5">
        <Link to="/history" className="rounded-md p-1.5 text-text-muted hover:bg-ink-850 hover:text-text"><ArrowLeft className="h-4 w-4" /></Link>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={run.status} />
            <span className="truncate text-sm font-medium">{run.question}</span>
          </div>
          <div className="text-[0.7rem] text-text-dim">
            {run.flowName} · rev {run.flowRevision} · {run.isProduction ? "produção" : "rascunho"} · {run.userEmail ?? "lote"} · {dateTime(run.startedAt)} · {usd(run.costUsd)} · {ms(run.endedAt ? Date.parse(run.endedAt) - Date.parse(run.startedAt) : null)}
          </div>
        </div>
        <TranscriptMenu
          label="Copiar fluxo completo"
          sources={[
            { label: "Esta execução", path: `/runs/${run.id}/transcript`, filename: `execucao-${run.id.slice(0, 8)}.md` },
            ...(run.sessionId ? [{ label: "Conversa inteira (todas as interações)", path: `/sessions/${run.sessionId}/transcript`, filename: `conversa-${run.sessionId.slice(0, 8)}.md` }] : []),
          ]}
        />
        {run.sessionId && <Link to={`/simulator/${run.sessionId}`} className="text-xs text-text-muted hover:text-text">abrir conversa</Link>}
      </header>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="min-h-0 space-y-4 overflow-y-auto border-r border-line p-5">
          {run.error && <ErrorBox error={run.error} />}
          {o && (
            <>
              <div className="flex flex-wrap gap-1.5">
                {o.compliance && <Pill tone={o.compliance.aprovado ? "ok" : "bad"}>compliance {o.compliance.aprovado ? "aprovado" : "reprovado"} · {o.compliance.ciclos} ciclo(s)</Pill>}
                {o.flags.map((f) => <Pill key={f} tone="warn">{f.replace(/_/g, " ")}</Pill>)}
              </div>
              <Tabs defaultValue="simples">
                <TabsList>
                  <TabsTrigger value="simples" className="text-xs">Resposta simples</TabsTrigger>
                  <TabsTrigger value="tecnica" className="text-xs">Técnica</TabsTrigger>
                </TabsList>
                <TabsContent value="simples" className="rounded-md border border-line bg-ink-900 p-4 text-sm leading-relaxed whitespace-pre-wrap">{o.resposta_simples}</TabsContent>
                <TabsContent value="tecnica" className="rounded-md border border-line bg-ink-900 p-4 text-sm leading-relaxed whitespace-pre-wrap text-text-muted">{o.resposta_tecnica || "—"}</TabsContent>
              </Tabs>
              {o.citacoes.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-xs text-text-muted">Citações conferidas</div>
                  {o.citacoes.map((c) => (
                    <div key={c.citacao} className="flex flex-wrap items-center gap-2 text-xs"><StatusBadge status={c.status} /><span>{c.citacao}</span><span className="text-text-dim">{c.fonte || c.nota}</span></div>
                  ))}
                </div>
              )}
              <div className="space-y-1.5">
                <div className="text-xs text-text-muted">Especialistas</div>
                {o.especialistas.map((e) => (
                  <div key={e.nodeId} className="flex items-center gap-2 text-xs">
                    <StatusBadge status={e.ok ? "ok" : "error"} /> {e.name}
                    {e.score != null && <span className="font-mono text-text-dim">score {e.score.toFixed(2)}</span>}
                    {e.chainedFrom && <Pill>encadeado de {e.chainedFrom}</Pill>}
                    {e.reused && <Pill>reaproveitado</Pill>}
                  </div>
                ))}
              </div>
            </>
          )}
          {files.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs text-text-muted">Arquivos</div>
              {files.map((f) => (
                <a key={f.id} href={fileUrl(f.id)} className="flex items-center gap-2 text-xs text-text-muted hover:text-text"><FileDown className="h-3.5 w-3.5" /> {f.name} <Pill>{f.direction === "out" ? "gerado" : "anexo"}</Pill></a>
              ))}
            </div>
          )}
          {run.ratingComment && <div className="text-xs text-text-muted">Comentário do curador: {run.ratingComment}</div>}
        </div>
        <div className="min-h-[480px]">
          <TraceView graph={run.graph} spans={spans} outcome={o} flowId={run.flowId} live={run.status === "running"} />
        </div>
      </div>
    </div>
  );
}

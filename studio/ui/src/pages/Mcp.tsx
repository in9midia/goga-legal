import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Download, Loader2, MoreHorizontal, Play, Plug, PlugZap, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { dateTime, ms } from "@/lib/format";
import type { FlowUse, McpServer, McpTool } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Page } from "@/Layout";
import { DividerLabel, Empty, ErrorBox, Field, JsonView, Loading, PageHeader, Pill } from "@/components/common";
import { exampleFromSchema, FlowsUsing, headerRows, headersPayload, HeadersEditor, HistoryPanel, ImpactNote, JsonEditor, parseJson, UsagePanel, type HeaderRow } from "@/components/capabilities";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

type ProbeResult = { ok: boolean; ms: number; tools?: McpTool[]; error?: string };

export const useMcpList = () => useQuery({ queryKey: ["mcp"], queryFn: () => api.get<{ servers: McpServer[] }>("/mcp").then((r) => r.servers), staleTime: 60_000 });

function status(s: McpServer): { tone: "ok" | "bad" | "neutral"; label: string } {
  if (!s.enabled) return { tone: "neutral", label: "desabilitado" };
  if (s.lastError) return { tone: "bad", label: "fora do ar" };
  return { tone: "ok", label: "conectado" };
}

export function McpPage() {
  const { isAdmin } = useAuth();
  const [params, setParams] = useSearchParams();
  const selected = params.get("id");
  const select = (id: string | null) => setParams(id ? { id } : {}, { replace: true });
  const [creating, setCreating] = useState(false);
  const [installing, setInstalling] = useState(false);
  const q = useMcpList();

  useEffect(() => {
    if (!selected && q.data?.length) select(q.data[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, selected]);

  return (
    <Page>
      <PageHeader
        icon={<Plug />}
        title="Servidores MCP"
        description="Servidores Model Context Protocol remotos (Streamable HTTP ou SSE). As ferramentas deles ficam disponíveis para os nós dos fluxos, no campo MCP do editor. Servidores stdio precisam ser publicados por HTTP."
        actions={
          isAdmin && (
            <>
              <Button variant="outline" size="sm" onClick={() => setInstalling(true)}>
                <Upload /> Instalar de JSON
              </Button>
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus /> Novo servidor
              </Button>
            </>
          )
        }
      />
      {q.isLoading ? (
        <Loading label="consultando servidores MCP…" />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : !q.data?.length ? (
        <Empty icon={<Plug />}>Nenhum servidor MCP cadastrado.</Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <div className="space-y-1.5">
            {q.data.map((s) => {
              const st = status(s);
              return (
                <button key={s.id} onClick={() => select(s.id)} className={cn("w-full rounded-md border px-3 py-2 text-left transition-colors", s.id === selected ? "border-line bg-ink-800" : "border-transparent hover:bg-ink-850", !s.enabled && "opacity-60")}>
                  <div className="flex items-center gap-2">
                    <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", st.tone === "ok" ? "bg-emerald-400" : st.tone === "bad" ? "bg-rose-400" : "bg-text-dim")} title={st.label} />
                    <span className="truncate text-sm font-medium">{s.name}</span>
                    {s.origin === "system" && <Pill className="ml-auto">sistema</Pill>}
                  </div>
                  <div className="mt-0.5 flex gap-2 pl-3.5 text-[0.68rem] text-text-dim">
                    <span className="truncate font-mono">{s.id}</span>
                    <span className="ml-auto shrink-0 tabular-nums">
                      {s.toolsCache.length} tools · {s.flowCount ?? 0} fl
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="min-w-0">{selected ? <ServerDetail key={selected} id={selected} onDeleted={() => select(null)} /> : <Empty>Selecione um servidor.</Empty>}</div>
        </div>
      )}
      <ServerDialog open={creating} onClose={() => setCreating(false)} onCreated={select} />
      <InstallMcpDialog open={installing} onClose={() => setInstalling(false)} onInstalled={select} />
    </Page>
  );
}

// ── Detalhe ──────────────────────────────────────────────────────────────

function ServerDetail({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["mcp-server", id], queryFn: () => api.get<{ server: McpServer; flows: FlowUse[] }>(`/mcp/${id}`) });
  const [confirmDel, setConfirmDel] = useState(false);
  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ["mcp"] });
    qc.invalidateQueries({ queryKey: ["mcp-server", id] });
  };
  const toggle = useMutation({ mutationFn: (enabled: boolean) => api.put(`/mcp/${id}`, { enabled }), onSuccess: refreshAll, onError: (e) => toast.error(e.message) });
  const reload = useMutation({
    mutationFn: () => api.post<ProbeResult>(`/mcp/${id}/refresh`),
    onSuccess: (r) => {
      if (r.ok) toast.success(`${r.tools?.length ?? 0} ferramenta(s) em ${ms(r.ms)}`);
      else toast.error(r.error ?? "falha ao conectar");
      refreshAll();
    },
    onError: (e) => toast.error(e.message),
  });
  const del = useMutation({
    mutationFn: () => api.del(`/mcp/${id}`),
    onSuccess: () => {
      toast.success("Servidor excluído");
      qc.invalidateQueries({ queryKey: ["mcp"] });
      onDeleted();
    },
    onError: (e) => toast.error(e.message),
  });

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const s = q.data!.server;
  const flows = q.data!.flows;
  const st = status(s);

  return (
    <div className="rounded-[10px] border border-line bg-ink-900">
      <div className="flex flex-wrap items-start gap-3 border-b border-line px-4 py-3">
        <div className="min-w-[14rem] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">{s.name}</h2>
            <Pill tone={st.tone}>{st.label}</Pill>
            <Pill>{s.transport === "sse" ? "SSE" : "Streamable HTTP"}</Pill>
            {s.origin === "system" && <Pill>sistema</Pill>}
          </div>
          <div className="mt-0.5 font-mono text-[0.7rem] break-all text-text-dim">{s.url}</div>
          <div className="mt-0.5 text-[0.7rem] text-text-dim">
            <span className="font-mono">{s.id}</span> · verificado {dateTime(s.checkedAt)}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 rounded-md border border-line px-2.5 py-1">
            <Switch id="mcp-on" checked={s.enabled} onCheckedChange={(v) => toggle.mutate(v)} disabled={!isAdmin || toggle.isPending} />
            <Label htmlFor="mcp-on" className="text-xs text-text-muted">
              {s.enabled ? "habilitado" : "desabilitado"}
            </Label>
          </div>
          {isAdmin && (
            <Button variant="outline" size="sm" onClick={() => reload.mutate()} disabled={!s.enabled || reload.isPending}>
              {reload.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Reconectar
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <a href={`/api/v1/mcp/${s.id}/export`} download>
                  <Download /> Exportar configuração
                </a>
              </DropdownMenuItem>
              {isAdmin && s.origin !== "system" && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setConfirmDel(true)}>
                    <Trash2 /> Excluir
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {s.enabled && s.lastError && <div className="border-b border-rose-500/20 bg-rose-500/5 px-4 py-2 text-xs text-rose-200">Última tentativa de conexão falhou: {s.lastError}</div>}

      <Tabs defaultValue="tools" className="p-4">
        <TabsList className="w-full justify-start overflow-x-auto [&>button]:flex-none">
          <TabsTrigger value="tools">Ferramentas · {s.toolsCache.length}</TabsTrigger>
          <TabsTrigger value="config">Configuração</TabsTrigger>
          <TabsTrigger value="test">Testar</TabsTrigger>
          <TabsTrigger value="usage">Uso</TabsTrigger>
          <TabsTrigger value="flows">Fluxos · {flows.length}</TabsTrigger>
          <TabsTrigger value="history">Histórico</TabsTrigger>
        </TabsList>
        <TabsContent value="tools" className="mt-4">
          <ToolList tools={s.toolsCache} enabled={s.enabled} />
        </TabsContent>
        <TabsContent value="config" className="mt-4">
          <ServerForm key={s.updatedAt} s={s} flows={flows} readOnly={!isAdmin} onSaved={refreshAll} />
        </TabsContent>
        <TabsContent value="test" className="mt-4">
          <ToolTester s={s} readOnly={!isAdmin} />
        </TabsContent>
        <TabsContent value="usage" className="mt-4">
          <UsagePanel path={`/mcp/${s.id}/stats`} nameLabel={(n) => n.replace(`mcp · ${s.id}.`, "")} />
        </TabsContent>
        <TabsContent value="flows" className="mt-4">
          <FlowsUsing flows={flows} what="ferramentas deste servidor" />
        </TabsContent>
        <TabsContent value="history" className="mt-4">
          <HistoryPanel entity="mcp_server" id={s.id} />
        </TabsContent>
      </Tabs>

      <AlertDialog open={confirmDel} onOpenChange={setConfirmDel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir o servidor "{s.name}"?</AlertDialogTitle>
            <AlertDialogDescription>{flows.length ? `Há ${flows.length} fluxo(s) usando ferramentas dele; a exclusão será recusada até elas saírem dos nós.` : "Nenhum fluxo usa este servidor."}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => del.mutate()}>
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ToolList({ tools, enabled }: { tools: McpTool[]; enabled: boolean }) {
  if (!tools.length) return <Empty>{enabled ? "Nenhuma ferramenta listada. Use “Reconectar” para tentar de novo." : "Servidor desabilitado."}</Empty>;
  return (
    <div className="space-y-2">
      {tools.map((t) => (
        <ToolItem key={t.name} t={t} />
      ))}
    </div>
  );
}

function ToolItem({ t }: { t: McpTool }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border border-line-soft bg-ink-950 px-3 py-2">
      <CollapsibleTrigger className="flex w-full items-start gap-2 text-left">
        {open ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-dim" /> : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-dim" />}
        <div className="min-w-0">
          <div className="font-mono text-[0.75rem] text-text">{t.name}</div>
          {t.description && <div className={cn("text-[0.72rem] text-text-muted", !open && "line-clamp-2")}>{t.description}</div>}
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">
        <JsonView value={t.inputSchema ?? {}} maxHeight={260} />
      </CollapsibleContent>
    </Collapsible>
  );
}

// ── Configuracao ─────────────────────────────────────────────────────────

function ServerForm({ s, flows, readOnly, onSaved }: { s: McpServer; flows: FlowUse[]; readOnly: boolean; onSaved: () => void }) {
  const init = useMemo(() => ({ name: s.name, url: s.url, transport: s.transport, description: s.description }), [s]);
  const [f, setF] = useState(init);
  const [headers, setHeaders] = useState<HeaderRow[]>(headerRows(s.headerNames));
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const headersDirty = JSON.stringify(headers) !== JSON.stringify(headerRows(s.headerNames));
  const dirty = JSON.stringify(f) !== JSON.stringify(init) || headersDirty;
  const urlLocked = s.origin === "system" && s.id === "goga-kb";
  const probe = useMutation({ mutationFn: () => api.post<ProbeResult>("/mcp/probe", { id: s.id, url: f.url, transport: f.transport, headers: headersPayload(headers) }) });
  const save = useMutation({
    mutationFn: () => api.put(`/mcp/${s.id}`, { ...f, ...(headersDirty ? { headers: headersPayload(headers) } : {}) }),
    onSuccess: () => {
      toast.success("Servidor salvo");
      onSaved();
    },
  });
  return (
    <div className="space-y-4">
      <ImpactNote flows={flows} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nome">
          <Input value={f.name} onChange={(e) => set("name", e.target.value)} disabled={readOnly} />
        </Field>
        <Field label="Identificador" hint="Fixo: os nós referenciam “id:ferramenta”.">
          <Input value={s.id} disabled className="font-mono" />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
        <Field label="URL" hint={urlLocked ? "Vem de KB_URL na configuração do Studio e é regravada a cada boot." : undefined}>
          <Input value={f.url} onChange={(e) => set("url", e.target.value)} disabled={readOnly || urlLocked} className="font-mono text-xs" />
        </Field>
        <Field label="Transporte">
          <Select value={f.transport} onValueChange={(v) => set("transport", v as "http" | "sse")} disabled={readOnly}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="http">Streamable HTTP</SelectItem>
              <SelectItem value="sse">SSE (legado)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field label="Cabeçalhos" hint="Autenticação (ex.: Authorization: Bearer …). Valores ficam cifrados e nunca voltam para a tela.">
        <HeadersEditor rows={headers} onChange={setHeaders} disabled={readOnly} />
      </Field>
      <Field label="Descrição">
        <Textarea value={f.description} onChange={(e) => set("description", e.target.value)} rows={2} disabled={readOnly} className="text-sm" />
      </Field>
      <ProbeView r={probe.data} />
      <ErrorBox error={save.error ?? probe.error} />
      {!readOnly && (
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => probe.mutate()} disabled={probe.isPending}>
            {probe.isPending ? <Loader2 className="animate-spin" /> : <PlugZap />} Testar conexão
          </Button>
          <Button
            variant="ghost"
            disabled={!dirty}
            onClick={() => {
              setF(init);
              setHeaders(headerRows(s.headerNames));
            }}
          >
            Descartar
          </Button>
          <Button onClick={() => save.mutate()} disabled={!dirty || !f.name.trim() || save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />} Salvar
          </Button>
        </div>
      )}
    </div>
  );
}

function ProbeView({ r }: { r: ProbeResult | undefined }) {
  if (!r) return null;
  return r.ok ? (
    <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
      Conectou em {ms(r.ms)}: {r.tools?.length ?? 0} ferramenta(s){r.tools?.length ? ` — ${r.tools.map((t) => t.name).join(", ")}` : ""}.
    </div>
  ) : (
    <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">Não conectou ({ms(r.ms)}): {r.error}</div>
  );
}

// ── Teste de ferramenta ──────────────────────────────────────────────────

function ToolTester({ s, readOnly }: { s: McpServer; readOnly: boolean }) {
  const [tool, setTool] = useState(s.toolsCache[0]?.name ?? "");
  const current = s.toolsCache.find((t) => t.name === tool);
  const [args, setArgs] = useState(() => JSON.stringify(exampleFromSchema(current?.inputSchema), null, 2));
  const p = parseJson(args);
  const run = useMutation({ mutationFn: () => api.post<{ ok: boolean; ms: number; output?: unknown; error?: string }>(`/mcp/${s.id}/call`, { tool, args: p.ok ? p.value : {} }) });
  if (readOnly) return <Empty>Só administradores executam ferramentas.</Empty>;
  if (!s.enabled) return <Empty>Habilite o servidor para testar.</Empty>;
  if (!s.toolsCache.length) return <Empty>Nenhuma ferramenta listada.</Empty>;
  return (
    <div className="space-y-4">
      <Field label="Ferramenta" hint={current?.description}>
        <Select
          value={tool}
          onValueChange={(v) => {
            setTool(v);
            setArgs(JSON.stringify(exampleFromSchema(s.toolsCache.find((t) => t.name === v)?.inputSchema), null, 2));
            run.reset();
          }}
        >
          <SelectTrigger className="w-full font-mono text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {s.toolsCache.map((t) => (
              <SelectItem key={t.name} value={t.name} className="font-mono text-xs">
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Argumentos (JSON)" hint="Chamada direta, sem o recorte de bases que o fluxo aplica ao goga-kb.">
        <JsonEditor value={args} onChange={setArgs} rows={8} />
      </Field>
      <div className="flex justify-end">
        <Button onClick={() => run.mutate()} disabled={!p.ok || !tool || run.isPending}>
          {run.isPending ? <Loader2 className="animate-spin" /> : <Play />} Executar
        </Button>
      </div>
      <ErrorBox error={run.error} />
      {run.data && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs">
            {run.data.ok ? <Pill tone="ok">ok</Pill> : <Pill tone="bad">erro</Pill>}
            <span className="text-text-dim">{ms(run.data.ms)}</span>
          </div>
          {run.data.ok ? <JsonView value={run.data.output} maxHeight={420} /> : <ErrorBox error={run.data.error} />}
        </div>
      )}
    </div>
  );
}

// ── Novo / instalar ──────────────────────────────────────────────────────

function ServerDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const blank = { id: "", name: "", url: "", transport: "http" as "http" | "sse", description: "" };
  const [f, setF] = useState(blank);
  const [idTouched, setIdTouched] = useState(false);
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
  useEffect(() => {
    if (open) {
      setF(blank);
      setIdTouched(false);
      setHeaders([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const probe = useMutation({ mutationFn: () => api.post<ProbeResult>("/mcp/probe", { url: f.url, transport: f.transport, headers: headersPayload(headers) }) });
  const create = useMutation({
    mutationFn: () => api.post<{ server: McpServer }>("/mcp", { ...f, headers: headersPayload(headers), enabled: true }),
    onSuccess: (r) => {
      toast.success(r.server.lastError ? "Servidor salvo, mas a conexão falhou" : `Servidor salvo: ${r.server.toolsCache.length} ferramenta(s)`);
      qc.invalidateQueries({ queryKey: ["mcp"] });
      onCreated(r.server.id);
      onClose();
    },
  });
  const ok = f.name.trim() && /^[a-z0-9][a-z0-9_-]{1,62}$/.test(f.id) && /^https?:\/\//.test(f.url.trim());
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Novo servidor MCP</DialogTitle>
          <DialogDescription>Endpoint remoto. Teste a conexão antes de salvar; depois, escolha as ferramentas nos nós do fluxo.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nome">
              <Input
                value={f.name}
                onChange={(e) => {
                  set("name", e.target.value);
                  if (!idTouched)
                    set(
                      "id",
                      e.target.value
                        .normalize("NFD")
                        .replace(/[\u0300-\u036f]/g, "")
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, "-")
                        .replace(/^-+|-+$/g, "")
                        .slice(0, 63),
                    );
                }}
                autoFocus
              />
            </Field>
            <Field label="Identificador">
              <Input
                value={f.id}
                onChange={(e) => {
                  setIdTouched(true);
                  set("id", e.target.value);
                }}
                className="font-mono"
              />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
            <Field label="URL">
              <Input value={f.url} onChange={(e) => set("url", e.target.value)} placeholder="https://…/mcp" className="font-mono text-xs" />
            </Field>
            <Field label="Transporte">
              <Select value={f.transport} onValueChange={(v) => set("transport", v as "http" | "sse")}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="http">Streamable HTTP</SelectItem>
                  <SelectItem value="sse">SSE (legado)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Cabeçalhos">
            <HeadersEditor rows={headers} onChange={setHeaders} />
          </Field>
          <Field label="Descrição">
            <Input value={f.description} onChange={(e) => set("description", e.target.value)} />
          </Field>
          <ProbeView r={probe.data} />
          <ErrorBox error={create.error ?? probe.error} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => probe.mutate()} disabled={!/^https?:\/\//.test(f.url.trim()) || probe.isPending}>
            {probe.isPending ? <Loader2 className="animate-spin" /> : <PlugZap />} Testar conexão
          </Button>
          <Button onClick={() => create.mutate()} disabled={!ok || create.isPending}>
            {create.isPending && <Loader2 className="animate-spin" />} Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const INSTALL_EXAMPLE = `{
  "mcpServers": {
    "meu-servidor": {
      "type": "http",
      "url": "https://exemplo.com/mcp",
      "headers": { "Authorization": "Bearer …" }
    }
  }
}`;

function InstallMcpDialog({ open, onClose, onInstalled }: { open: boolean; onClose: () => void; onInstalled: (id: string) => void }) {
  const qc = useQueryClient();
  const [content, setContent] = useState("");
  useEffect(() => {
    if (open) setContent("");
  }, [open]);
  const install = useMutation({
    mutationFn: () => api.post<{ created: string[]; skipped: { name: string; reason: string }[] }>("/mcp/import", { content }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["mcp"] });
      if (r.created.length) {
        toast.success(`${r.created.length} servidor(es) instalado(s)`);
        onInstalled(r.created[0]);
      }
      if (!r.skipped.length) onClose();
    },
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Instalar servidores MCP</DialogTitle>
          <DialogDescription>
            Cole a configuração no formato usual <span className="font-mono">mcpServers</span> (a mesma do Claude, Cursor etc.). Entradas stdio (<span className="font-mono">command</span>) são ignoradas: o Studio só fala com servidores remotos.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Button variant="outline" size="sm" asChild>
            <label className="cursor-pointer">
              <Upload /> Escolher arquivo
              <input
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) setContent(await file.text());
                  e.target.value = "";
                }}
              />
            </label>
          </Button>
          <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={12} placeholder={INSTALL_EXAMPLE} className="font-mono text-[0.72rem]" />
          {install.data?.skipped.length ? (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              <DividerLabel>Não instalados</DividerLabel>
              {install.data.skipped.map((s) => (
                <div key={s.name}>
                  <span className="font-mono">{s.name}</span>: {s.reason}
                </div>
              ))}
            </div>
          ) : null}
          <ErrorBox error={install.error} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Fechar
          </Button>
          <Button onClick={() => install.mutate()} disabled={!content.trim() || install.isPending}>
            {install.isPending && <Loader2 className="animate-spin" />} Instalar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

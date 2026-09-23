import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Code2, Copy, Download, FileText, Globe, Loader2, MoreHorizontal, Play, Plus, RotateCcw, Search, Sparkles, Trash2, Upload, Wrench } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { dateTime, int, ms } from "@/lib/format";
import type { FlowUse, KbSpace, Skill, SkillKind } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Page } from "@/Layout";
import { DividerLabel, Empty, ErrorBox, Field, JsonView, Loading, MultiSelect, PageHeader, Pill } from "@/components/common";
import { exampleFromSchema, FlowsUsing, headerRows, headersPayload, HeadersEditor, HistoryPanel, ImpactNote, JsonEditor, parseJson, UsagePanel, type HeaderRow } from "@/components/capabilities";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export const KIND: Record<SkillKind, { label: string; icon: typeof Wrench; hint: string }> = {
  builtin: { label: "Sistema", icon: Code2, hint: "Execução no código do Studio. Texto, instruções e ativação são editáveis." },
  prompt: { label: "Instruções", icon: FileText, hint: "Texto (formato SKILL.md) injetado no prompt dos agentes que têm a skill." },
  http: { label: "HTTP", icon: Globe, hint: "Ferramenta que chama um endpoint com o JSON montado pelo modelo." },
};

export const useSkillList = () => useQuery({ queryKey: ["skills"], queryFn: () => api.get<{ skills: Skill[] }>("/skills").then((r) => r.skills) });

const ALL = "all";

export function SkillsPage() {
  const { isAdmin } = useAuth();
  const [params, setParams] = useSearchParams();
  const selected = params.get("id");
  const select = (id: string | null) => setParams(id ? { id } : {}, { replace: true });
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<string>(ALL);
  const [creating, setCreating] = useState<null | "prompt" | "http">(null);
  const [installing, setInstalling] = useState(false);
  const q = useSkillList();

  const list = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data ?? []).filter((x) => (kind === ALL || x.kind === kind) && (!s || `${x.id} ${x.name} ${x.description}`.toLowerCase().includes(s)));
  }, [q.data, search, kind]);

  useEffect(() => {
    if (!selected && q.data?.length) select(q.data[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, selected]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { [ALL]: q.data?.length ?? 0 };
    for (const s of q.data ?? []) c[s.kind] = (c[s.kind] ?? 0) + 1;
    return c;
  }, [q.data]);

  return (
    <Page>
      <PageHeader
        icon={<Sparkles />}
        title="Skills"
        description="Capacidades que os agentes dos fluxos usam. As do sistema têm execução no código e texto editável; as de instruções e HTTP são criadas ou instaladas aqui. Alterações valem na próxima execução."
        actions={
          isAdmin && (
            <>
              <Button variant="outline" size="sm" onClick={() => setInstalling(true)}>
                <Upload /> Instalar
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm">
                    <Plus /> Nova skill
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-72">
                  <DropdownMenuItem onClick={() => setCreating("prompt")} className="items-start">
                    <FileText className="mt-0.5" />
                    <div>
                      <div>Instruções</div>
                      <div className="text-xs text-text-dim">{KIND.prompt.hint}</div>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setCreating("http")} className="items-start">
                    <Globe className="mt-0.5" />
                    <div>
                      <div>HTTP</div>
                      <div className="text-xs text-text-dim">{KIND.http.hint}</div>
                    </div>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-text-dim" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar skill…" className="h-8 pl-8 text-sm" />
        </div>
        <div className="flex flex-wrap gap-1">
          {[ALL, "builtin", "prompt", "http"].map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={cn("rounded-md border px-2.5 py-1 text-xs transition-colors", kind === k ? "border-line bg-ink-800 text-text" : "border-transparent text-text-muted hover:text-text")}
            >
              {k === ALL ? "Todas" : KIND[k as SkillKind].label} <span className="text-text-dim tabular-nums">{counts[k] ?? 0}</span>
            </button>
          ))}
        </div>
      </div>

      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <div className="space-y-1.5 lg:max-h-[calc(100vh-15rem)] lg:overflow-y-auto lg:pr-1">
            {list.length === 0 && <Empty icon={<Wrench />}>Nenhuma skill encontrada.</Empty>}
            {list.map((s) => (
              <SkillRowButton key={s.id} s={s} active={s.id === selected} onClick={() => select(s.id)} />
            ))}
          </div>
          <div className="min-w-0">{selected ? <SkillDetail key={selected} id={selected} onDeleted={() => select(null)} onSelect={select} /> : <Empty>Selecione uma skill.</Empty>}</div>
        </div>
      )}

      <CreateSkillDialog kind={creating} onClose={() => setCreating(null)} onCreated={(id) => select(id)} />
      <InstallSkillDialog open={installing} onClose={() => setInstalling(false)} onInstalled={(id) => select(id)} />
    </Page>
  );
}

function SkillRowButton({ s, active, onClick }: { s: Skill; active: boolean; onClick: () => void }) {
  const Icon = KIND[s.kind].icon;
  const u = s.usage30d;
  return (
    <button onClick={onClick} className={cn("w-full rounded-md border px-3 py-2 text-left transition-colors", active ? "border-line bg-ink-800" : "border-transparent hover:bg-ink-850", !s.enabled && "opacity-60")}>
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 shrink-0 text-text-dim" />
        <span className="truncate text-sm font-medium">{s.name}</span>
        {!s.enabled && <Pill className="ml-auto">off</Pill>}
      </div>
      <div className="mt-0.5 flex items-center gap-2 pl-5.5 text-[0.68rem] text-text-dim">
        <span className="truncate font-mono">{s.id}</span>
        <span className="ml-auto shrink-0 tabular-nums" title="chamadas nos últimos 30 dias · fluxos que usam">
          {u?.calls ? `${int(u.calls)}×` : "—"}
          {u?.errors ? <span className="text-rose-300"> · {int(u.errors)} err</span> : null} · {s.flowCount ?? 0} fl
        </span>
      </div>
    </button>
  );
}

// ── Detalhe ──────────────────────────────────────────────────────────────

function SkillDetail({ id, onDeleted, onSelect }: { id: string; onDeleted: () => void; onSelect: (id: string) => void }) {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["skill", id], queryFn: () => api.get<{ skill: Skill; flows: FlowUse[] }>(`/skills/${id}`) });
  const [confirmDel, setConfirmDel] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["skills"] });
    qc.invalidateQueries({ queryKey: ["skill", id] });
  };
  const toggle = useMutation({ mutationFn: (enabled: boolean) => api.put(`/skills/${id}`, { enabled }), onSuccess: (_, v) => (toast.success(v ? "Skill ativada" : "Skill desativada"), refresh()), onError: (e) => toast.error(e.message) });
  const reset = useMutation({ mutationFn: () => api.post(`/skills/${id}/reset`), onSuccess: () => (toast.success("Padrão restaurado"), refresh()), onError: (e) => toast.error(e.message) });
  const dup = useMutation({
    mutationFn: () => api.post<{ skill: Skill }>(`/skills/${id}/duplicate`),
    onSuccess: (r) => {
      toast.success("Cópia criada (desativada)");
      qc.invalidateQueries({ queryKey: ["skills"] });
      onSelect(r.skill.id);
    },
    onError: (e) => toast.error(e.message),
  });
  const del = useMutation({
    mutationFn: () => api.del(`/skills/${id}`),
    onSuccess: () => {
      toast.success("Skill excluída");
      qc.invalidateQueries({ queryKey: ["skills"] });
      onDeleted();
    },
    onError: (e) => toast.error(e.message),
  });

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const s = q.data!.skill;
  const flows = q.data!.flows;
  const K = KIND[s.kind];
  const customized = s.kind === "builtin" && s.defaults && (s.name !== s.defaults.name || s.description !== s.defaults.description || !!s.instructions);

  return (
    <div className="rounded-[10px] border border-line bg-ink-900">
      <div className="flex flex-wrap items-start gap-3 border-b border-line px-4 py-3">
        <div className="min-w-[14rem] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">{s.name}</h2>
            <Pill tone={s.kind === "builtin" ? "neutral" : "info"}>
              <K.icon className="h-3 w-3" /> {K.label}
            </Pill>
            {s.kind !== "prompt" && <Pill title={s.llmTool ? "O modelo decide quando chamar" : "O motor do fluxo chama sozinho"}>{s.llmTool ? "ferramenta do modelo" : "executada pelo motor"}</Pill>}
            {customized && <Pill tone="warn">personalizada</Pill>}
          </div>
          <div className="mt-0.5 text-[0.7rem] text-text-dim">
            <span className="font-mono">{s.id}</span> · v{s.version} · {s.source || "—"} · atualizada {dateTime(s.updatedAt)}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 rounded-md border border-line px-2.5 py-1">
            <Switch id="sk-on" checked={s.enabled} onCheckedChange={(v) => toggle.mutate(v)} disabled={!isAdmin || toggle.isPending} />
            <Label htmlFor="sk-on" className="text-xs text-text-muted">
              {s.enabled ? "ativa" : "desativada"}
            </Label>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <a href={`/api/v1/skills/${s.id}/export`} download>
                  <Download /> Exportar pacote JSON
                </a>
              </DropdownMenuItem>
              {s.kind === "prompt" && (
                <DropdownMenuItem asChild>
                  <a href={`/api/v1/skills/${s.id}/export?format=md`} download>
                    <Download /> Exportar SKILL.md
                  </a>
                </DropdownMenuItem>
              )}
              {isAdmin && s.kind !== "builtin" && (
                <DropdownMenuItem onClick={() => dup.mutate()}>
                  <Copy /> Duplicar
                </DropdownMenuItem>
              )}
              {isAdmin && s.kind === "builtin" && (
                <DropdownMenuItem onClick={() => setConfirmReset(true)} disabled={!customized && s.enabled}>
                  <RotateCcw /> Restaurar padrão
                </DropdownMenuItem>
              )}
              {isAdmin && s.kind !== "builtin" && (
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

      <Tabs defaultValue="def" className="p-4">
        <TabsList className="w-full justify-start overflow-x-auto [&>button]:flex-none">
          <TabsTrigger value="def">Definição</TabsTrigger>
          <TabsTrigger value="test">Testar</TabsTrigger>
          <TabsTrigger value="usage">Uso</TabsTrigger>
          <TabsTrigger value="flows">Fluxos · {flows.length}</TabsTrigger>
          <TabsTrigger value="history">Histórico</TabsTrigger>
        </TabsList>
        <TabsContent value="def" className="mt-4">
          <SkillForm key={`${s.id}-${s.version}`} s={s} flows={flows} readOnly={!isAdmin} onSaved={refresh} />
        </TabsContent>
        <TabsContent value="test" className="mt-4">
          <SkillTester s={s} readOnly={!isAdmin} />
        </TabsContent>
        <TabsContent value="usage" className="mt-4">
          <UsagePanel path={`/skills/${s.id}/stats`} />
        </TabsContent>
        <TabsContent value="flows" className="mt-4">
          <FlowsUsing flows={flows} what="esta skill" />
          <p className="mt-2 text-[0.72rem] text-text-dim">A skill entra no agente pelo campo “Skills” do nó, no editor de fluxos. Especialidades do catálogo podem trazê-la como padrão.</p>
        </TabsContent>
        <TabsContent value="history" className="mt-4">
          <HistoryPanel entity="skill" id={s.id} />
        </TabsContent>
      </Tabs>

      <AlertDialog open={confirmDel} onOpenChange={setConfirmDel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir a skill "{s.name}"?</AlertDialogTitle>
            <AlertDialogDescription>{flows.length ? `Ela está em ${flows.length} fluxo(s); a exclusão será recusada até ela sair dos nós.` : "Nenhum fluxo usa esta skill. Exporte antes se quiser guardar uma cópia."}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => del.mutate()}>
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restaurar o padrão de "{s.name}"?</AlertDialogTitle>
            <AlertDialogDescription>Nome e descrição voltam ao texto do código, as instruções extras são apagadas e a skill fica ativa. O histórico guarda a versão atual.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => reset.mutate()}>Restaurar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Formulario ───────────────────────────────────────────────────────────

function SkillForm({ s, flows, readOnly, onSaved }: { s: Skill; flows: FlowUse[]; readOnly: boolean; onSaved: () => void }) {
  const init = useMemo(
    () => ({
      name: s.name,
      description: s.description,
      instructions: s.instructions,
      llmTool: s.llmTool,
      url: s.config.url ?? "",
      method: s.config.method ?? "POST",
      timeoutMs: String(s.config.timeoutMs ?? 15000),
      schema: JSON.stringify(s.inputSchema, null, 2),
    }),
    [s],
  );
  const [f, setF] = useState(init);
  const [headers, setHeaders] = useState<HeaderRow[]>(headerRows(s.headerNames));
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const headersDirty = JSON.stringify(headers) !== JSON.stringify(headerRows(s.headerNames));
  const dirty = JSON.stringify(f) !== JSON.stringify(init) || headersDirty;
  const schemaP = parseJson(f.schema);

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { name: f.name, description: f.description, instructions: f.instructions };
      if (s.kind === "http") {
        body.llmTool = f.llmTool;
        body.config = { url: f.url.trim(), method: f.method, timeoutMs: Number(f.timeoutMs) || 15000 };
        if (schemaP.ok) body.inputSchema = schemaP.value;
        if (headersDirty) body.headers = headersPayload(headers);
      }
      return api.put(`/skills/${s.id}`, body);
    },
    onSuccess: () => {
      toast.success("Skill salva");
      onSaved();
    },
  });

  const promptPreview = f.instructions.trim() ? `## Skills\n### ${f.name} (${s.id})\n${f.instructions.trim()}` : "";

  return (
    <div className="space-y-4">
      <ImpactNote flows={flows} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nome">
          <Input value={f.name} onChange={(e) => set("name", e.target.value)} disabled={readOnly} />
        </Field>
        <Field label="Identificador" hint="Fixo: é o que os fluxos referenciam.">
          <Input value={s.id} disabled className="font-mono" />
        </Field>
      </div>
      <Field
        label="Descrição"
        hint={s.kind === "prompt" ? "Resumo de uma linha: diz ao agente quando esta skill se aplica." : s.llmTool ? "É o que o modelo lê para decidir quando chamar a ferramenta e como preencher os argumentos. Seja específico." : "Documentação (o motor chama esta skill sozinho; o modelo não a vê como ferramenta)."}
      >
        <Textarea value={f.description} onChange={(e) => set("description", e.target.value)} rows={3} disabled={readOnly} className="text-sm" />
        {s.kind === "builtin" && s.defaults && f.description !== s.defaults.description && <p className="text-[0.7rem] text-amber-300/80">Texto do código: {s.defaults.description}</p>}
      </Field>
      <Field
        label={s.kind === "prompt" ? "Instruções (corpo da skill)" : "Instruções de uso (opcional)"}
        hint={
          s.kind === "prompt"
            ? "Markdown. Vai inteiro no prompt de sistema de cada agente que tem esta skill, na seção “## Skills”."
            : "Se preenchido, entra no prompt dos agentes que têm a skill: quando usar, quando não usar, como interpretar o resultado."
        }
      >
        <Textarea value={f.instructions} onChange={(e) => set("instructions", e.target.value)} rows={s.kind === "prompt" ? 16 : 6} disabled={readOnly} className="font-mono text-[0.75rem] leading-relaxed" />
        <div className="flex justify-end text-[0.68rem] text-text-dim tabular-nums">
          {f.instructions.length.toLocaleString("pt-BR")} caracteres · ~{Math.ceil(f.instructions.length / 4).toLocaleString("pt-BR")} tokens por chamada de agente
        </div>
      </Field>

      {s.kind === "http" && (
        <>
          <DividerLabel>Endpoint</DividerLabel>
          <div className="grid gap-4 sm:grid-cols-[7rem_1fr_8rem]">
            <Field label="Método">
              <Select value={f.method} onValueChange={(v) => set("method", v)} disabled={readOnly}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["POST", "GET", "PUT"].map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="URL" hint={f.method === "GET" ? "Argumentos vão na query string." : "Argumentos vão no corpo, em JSON."}>
              <Input value={f.url} onChange={(e) => set("url", e.target.value)} disabled={readOnly} className="font-mono text-xs" placeholder="https://…" />
            </Field>
            <Field label="Timeout (ms)">
              <Input inputMode="numeric" value={f.timeoutMs} onChange={(e) => set("timeoutMs", e.target.value)} disabled={readOnly} className="tabular-nums" />
            </Field>
          </div>
          <Field label="Cabeçalhos" hint="Valores ficam cifrados no banco e nunca voltam para a tela.">
            <HeadersEditor rows={headers} onChange={setHeaders} disabled={readOnly} />
          </Field>
          <div className="flex items-center gap-2">
            <Switch id="sk-tool" checked={f.llmTool} onCheckedChange={(v) => set("llmTool", v)} disabled={readOnly} />
            <Label htmlFor="sk-tool" className="text-xs text-text-muted">
              Oferecer ao modelo como ferramenta
            </Label>
          </div>
          <Field label="Esquema de entrada (JSON Schema)" hint="O modelo monta os argumentos a partir deste esquema; descreva cada propriedade.">
            <JsonEditor value={f.schema} onChange={(v) => set("schema", v)} rows={10} disabled={readOnly} />
          </Field>
        </>
      )}

      {s.kind === "builtin" && (
        <>
          <DividerLabel>Execução</DividerLabel>
          <p className="text-xs text-text-muted">
            Implementada no código do Studio (<span className="font-mono">api/src/skills</span>). O esquema de entrada acompanha o código e não é editável aqui.
          </p>
          <JsonView value={s.inputSchema} maxHeight={260} />
        </>
      )}

      {promptPreview && (
        <details className="rounded-md border border-line-soft">
          <summary className="cursor-pointer px-3 py-2 text-xs text-text-muted">Prévia do trecho que entra no prompt</summary>
          <JsonView value={promptPreview} maxHeight={260} className="m-2 mt-0" />
        </details>
      )}

      <ErrorBox error={save.error} />
      {!readOnly && (
        <div className="flex justify-end gap-2">
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
          <Button onClick={() => save.mutate()} disabled={!dirty || !f.name.trim() || !f.description.trim() || (s.kind === "http" && (!schemaP.ok || !f.url.trim())) || save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />} Salvar
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Teste isolado ────────────────────────────────────────────────────────

const KB_SKILLS = new Set(["buscar_kb", "buscar_documento_kb", "verificar_citacao"]);

function SkillTester({ s, readOnly }: { s: Skill; readOnly: boolean }) {
  const [input, setInput] = useState(() => JSON.stringify(exampleFromSchema(s.inputSchema), null, 2));
  const [spaces, setSpaces] = useState<string[]>([]);
  const kb = useQuery({ queryKey: ["kb-spaces"], queryFn: () => api.get<{ available: boolean; spaces: KbSpace[] }>("/kb/spaces"), staleTime: 60_000, enabled: KB_SKILLS.has(s.id) });
  const p = parseJson(input);
  const run = useMutation({ mutationFn: () => api.post<{ ok: boolean; ms: number; output?: unknown; error?: string; details?: unknown }>(`/skills/${s.id}/test`, { input: p.ok ? p.value : {}, spaces }) });

  if (!s.testable) return <Empty>Esta skill depende de uma conversa (anexos enviados ou arquivos gerados). Teste pelo Simulador.</Empty>;
  if (readOnly) return <Empty>Só administradores executam testes.</Empty>;
  if (s.kind === "prompt")
    return (
      <div className="space-y-3">
        <p className="text-xs text-text-muted">Skills de instruções não executam: o texto entra no prompt. Para ver o efeito, adicione a skill a um nó e rode o fluxo no Simulador; o trace mostra o prompt completo.</p>
        <JsonView value={`## Skills\n### ${s.name} (${s.id})\n${s.instructions.trim()}`} maxHeight={400} />
      </div>
    );

  return (
    <div className="space-y-4">
      {KB_SKILLS.has(s.id) && (
        <Field label="Bases da KB" hint="No fluxo, as bases vêm do nó. Aqui você escolhe o escopo do teste.">
          <MultiSelect options={(kb.data?.spaces ?? []).map((x) => ({ value: x.slug, label: x.name ?? x.label ?? x.slug, hint: x.slug }))} value={spaces} onChange={setSpaces} placeholder="Selecionar bases…" />
        </Field>
      )}
      <Field label="Argumentos (JSON)" hint="Pré-preenchido a partir do esquema de entrada.">
        <JsonEditor value={input} onChange={setInput} rows={8} />
      </Field>
      <div className="flex justify-end">
        <Button onClick={() => run.mutate()} disabled={!p.ok || run.isPending}>
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
          {run.data.details != null && <JsonView value={run.data.details} maxHeight={200} />}
        </div>
      )}
    </div>
  );
}

// ── Criar ────────────────────────────────────────────────────────────────

const PROMPT_TEMPLATE = `# Quando usar

Descreva a situação em que o agente deve seguir estas instruções.

# Como fazer

1. …
2. …

# Não fazer

- …
`;

const HTTP_SCHEMA = JSON.stringify({ type: "object", properties: { consulta: { type: "string", description: "O que buscar" } }, required: ["consulta"] }, null, 2);

const slugify = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 63);

function CreateSkillDialog({ kind, onClose, onCreated }: { kind: null | "prompt" | "http"; onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState(PROMPT_TEMPLATE);
  const [url, setUrl] = useState("");
  const [schema, setSchema] = useState(HTTP_SCHEMA);
  useEffect(() => {
    if (kind) {
      setName("");
      setId("");
      setIdTouched(false);
      setDescription("");
      setInstructions(PROMPT_TEMPLATE);
      setUrl("");
      setSchema(HTTP_SCHEMA);
    }
  }, [kind]);
  const sp = parseJson(schema);
  const create = useMutation({
    mutationFn: () =>
      api.post<{ skill: Skill }>("/skills", {
        id,
        kind,
        name: name.trim(),
        description: description.trim(),
        instructions: kind === "prompt" ? instructions : "",
        ...(kind === "http" ? { config: { url: url.trim(), method: "POST", timeoutMs: 15000 }, inputSchema: sp.ok ? sp.value : undefined, llmTool: true } : {}),
      }),
    onSuccess: (r) => {
      toast.success("Skill criada");
      qc.invalidateQueries({ queryKey: ["skills"] });
      onCreated(r.skill.id);
      onClose();
    },
  });
  const ok = name.trim() && /^[a-z0-9][a-z0-9_-]{1,62}$/.test(id) && description.trim() && (kind === "prompt" ? instructions.trim() : url.trim() && sp.ok);
  return (
    <Dialog open={!!kind} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Nova skill · {kind ? KIND[kind].label : ""}</DialogTitle>
          <DialogDescription>{kind ? KIND[kind].hint : ""} Depois de criada, adicione-a aos nós no editor de fluxos.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nome">
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!idTouched) setId(slugify(e.target.value));
                }}
                placeholder={kind === "http" ? "Consultar CEP" : "Linguagem simples"}
                autoFocus
              />
            </Field>
            <Field label="Identificador" hint="Minúsculas, números, _ ou -. Não muda depois.">
              <Input
                value={id}
                onChange={(e) => {
                  setIdTouched(true);
                  setId(e.target.value);
                }}
                className="font-mono"
              />
            </Field>
          </div>
          <Field label="Descrição" hint={kind === "http" ? "O modelo lê isto para decidir quando chamar a ferramenta." : "Uma linha: quando esta skill se aplica."}>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="text-sm" />
          </Field>
          {kind === "prompt" && (
            <Field label="Instruções (Markdown)">
              <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={12} className="font-mono text-[0.75rem]" />
            </Field>
          )}
          {kind === "http" && (
            <>
              <Field label="URL (POST com JSON)" hint="Método, timeout e cabeçalhos de autenticação você ajusta depois de criar.">
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" className="font-mono text-xs" />
              </Field>
              <Field label="Esquema de entrada (JSON Schema)">
                <JsonEditor value={schema} onChange={setSchema} rows={8} />
              </Field>
            </>
          )}
          <ErrorBox error={create.error} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => create.mutate()} disabled={!ok || create.isPending}>
            {create.isPending && <Loader2 className="animate-spin" />} Criar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Instalar ─────────────────────────────────────────────────────────────

function InstallSkillDialog({ open, onClose, onInstalled }: { open: boolean; onClose: () => void; onInstalled: (id: string) => void }) {
  const qc = useQueryClient();
  const [content, setContent] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  useEffect(() => {
    if (open) {
      setContent("");
      setOverwrite(false);
    }
  }, [open]);
  const install = useMutation({
    mutationFn: () => api.post<{ imported: { id: string; action: string }[] }>("/skills/import", { content, overwrite }),
    onSuccess: (r) => {
      toast.success(r.imported.map((i) => `${i.id} ${i.action}`).join(", "));
      qc.invalidateQueries({ queryKey: ["skills"] });
      r.imported.forEach((i) => qc.invalidateQueries({ queryKey: ["skill", i.id] }));
      if (r.imported[0]) onInstalled(r.imported[0].id);
      onClose();
    },
  });
  const kind = content.trim().startsWith("---") ? "SKILL.md" : content.trim().startsWith("{") || content.trim().startsWith("[") ? "pacote JSON" : null;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Instalar skill</DialogTitle>
          <DialogDescription>
            Cole ou envie um <span className="font-mono">SKILL.md</span> (frontmatter com <span className="font-mono">name</span> e <span className="font-mono">description</span>, corpo em Markdown) ou um pacote JSON exportado de outro Studio.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <label className="cursor-pointer">
                <Upload /> Escolher arquivo
                <input
                  type="file"
                  accept=".md,.json,text/markdown,application/json"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) setContent(await file.text());
                    e.target.value = "";
                  }}
                />
              </label>
            </Button>
            {kind && <Pill tone="info">{kind}</Pill>}
          </div>
          <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={14} placeholder={"---\nname: linguagem-simples\ndescription: Reescreve respostas jurídicas em linguagem de 8ª série\n---\n\n# Instruções\n…"} className="font-mono text-[0.72rem]" />
          <div className="flex items-center gap-2">
            <Checkbox id="sk-over" checked={overwrite} onCheckedChange={(v) => setOverwrite(v === true)} />
            <Label htmlFor="sk-over" className="text-xs text-text-muted">
              Substituir se já existir uma skill com o mesmo id (vira uma nova versão)
            </Label>
          </div>
          <ErrorBox error={install.error} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => install.mutate()} disabled={!kind || install.isPending}>
            {install.isPending && <Loader2 className="animate-spin" />} Instalar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

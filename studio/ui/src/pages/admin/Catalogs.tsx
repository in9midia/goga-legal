import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BookOpen, Copy, Eye, FileText, Loader2, Plus, RotateCcw, Search, Trash2, Wand2, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { DocTemplate, FlowUse, KbSpace, Specialty, TemplateField } from "@/lib/types";
import { useSkillList } from "@/pages/Skills";
import { Page } from "@/Layout";
import { DividerLabel, Empty, ErrorBox, Field, LinesInput, Loading, MultiSelect, PageHeader, Pill } from "@/components/common";
import { FlowsUsing } from "@/components/capabilities";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

export function CatalogsPage() {
  return (
    <Page>
      <PageHeader
        icon={<BookOpen />}
        title="Catálogos"
        description="Especialidades jurídicas (com prompt, bases e skills padrão) e modelos de documento. Os que vêm do sistema podem ser editados e restaurados; os criados aqui também podem ser excluídos. Skills e servidores MCP têm área própria, em Capacidades."
      />
      <Tabs defaultValue="specialties">
        <TabsList>
          <TabsTrigger value="specialties">Especialidades</TabsTrigger>
          <TabsTrigger value="templates">Modelos de documento</TabsTrigger>
        </TabsList>
        <TabsContent value="specialties" className="mt-4">
          <SpecialtiesTab />
        </TabsContent>
        <TabsContent value="templates" className="mt-4">
          <TemplatesTab />
        </TabsContent>
      </Tabs>
    </Page>
  );
}

const OriginPill = ({ origin }: { origin: "system" | "custom" }) => (origin === "custom" ? <Pill tone="info">criada no Studio</Pill> : null);

/** Confirmacao de exclusao / restauracao, compartilhada pelos dois editores. */
function Confirm({ open, onOpenChange, title, description, action, destructive, onConfirm }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description: string; action: string; destructive?: boolean; onConfirm: () => void }) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction variant={destructive ? "destructive" : "default"} onClick={onConfirm}>
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Especialidades ────────────────────────────────────────────────────

type SpecDraft = Omit<Specialty, "id" | "number" | "origin"> & { number?: number };

const EMPTY_SPEC: SpecDraft = {
  name: "",
  area: "",
  cluster: "",
  role: "specialist",
  routable: true,
  scope: "",
  defaultPrompt: "",
  defaultSpaces: [],
  defaultSkills: [],
  routingHints: { keywords: [], examples: [] },
  escalationRules: [],
  phase: 1,
  zone: "verde",
};

/** Aberto no painel: uma especialidade existente, ou um rascunho novo (vazio ou copia). */
type SpecOpen = { spec: Specialty } | { draft: SpecDraft };

function SpecialtiesTab() {
  const { isAdmin } = useAuth();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<SpecOpen | null>(null);
  const q = useQuery({ queryKey: ["catalog", "specialties"], queryFn: () => api.get<{ specialties: Specialty[] }>("/catalog/specialties").then((r) => r.specialties) });

  const groups = useMemo(() => {
    const s = search.trim().toLowerCase();
    const list = (q.data ?? []).filter((x) => !s || `${x.number} ${x.name} ${x.area} ${x.cluster} ${x.scope}`.toLowerCase().includes(s));
    const m = new Map<string, Specialty[]>();
    for (const x of list) m.set(x.cluster || "Sem agrupamento", [...(m.get(x.cluster || "Sem agrupamento") ?? []), x]);
    return [...m.entries()];
  }, [q.data, search]);
  const clusters = useMemo(() => [...new Set((q.data ?? []).map((x) => x.cluster).filter(Boolean))].sort(), [q.data]);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-text-dim" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por nome, área, escopo…" className="h-8 pl-8 text-sm" />
        </div>
        {isAdmin && (
          <Button size="sm" className="ml-auto" onClick={() => setOpen({ draft: EMPTY_SPEC })}>
            <Plus /> Nova especialidade
          </Button>
        )}
      </div>
      {groups.length === 0 ? (
        <Empty>Nenhuma especialidade encontrada.</Empty>
      ) : (
        groups.map(([cluster, items]) => (
          <div key={cluster}>
            <DividerLabel>
              {cluster} · {items.length}
            </DividerLabel>
            <div className="rounded-[10px] border border-line bg-ink-900">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12 pl-4">Nº</TableHead>
                    <TableHead>Nome</TableHead>
                    <TableHead>Área</TableHead>
                    <TableHead className="text-right">Fase</TableHead>
                    <TableHead>Zona</TableHead>
                    <TableHead>Roteável</TableHead>
                    <TableHead className="pr-4 text-right">Bases</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((s) => (
                    <TableRow key={s.id} className="cursor-pointer" onClick={() => setOpen({ spec: s })}>
                      <TableCell className="pl-4 text-text-dim tabular-nums">{s.number}</TableCell>
                      <TableCell className="font-medium">
                        <span className="mr-2">{s.name}</span>
                        {s.role !== "specialist" && <span className="mr-2 text-xs text-text-dim">{s.role}</span>}
                        <OriginPill origin={s.origin} />
                      </TableCell>
                      <TableCell className="text-text-muted">{s.area || "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.phase}</TableCell>
                      <TableCell>{s.zone === "amarela" ? <Pill tone="warn">amarela</Pill> : <Pill tone="ok">verde</Pill>}</TableCell>
                      <TableCell>{s.routable ? <Pill tone="info">sim</Pill> : <Pill>não</Pill>}</TableCell>
                      <TableCell className="pr-4 text-right tabular-nums">{s.defaultSpaces.length}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        ))
      )}
      <Sheet open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent side="right" className="w-full gap-0 sm:max-w-2xl">
          {open && (
            <SpecialtyEditor
              key={"spec" in open ? open.spec.id : `new-${open.draft.name}`}
              spec={"spec" in open ? open.spec : null}
              draft={"spec" in open ? open.spec : open.draft}
              clusters={clusters}
              onDuplicate={(d) => setOpen({ draft: d })}
              onClose={() => setOpen(null)}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function SpecialtyEditor({ spec, draft, clusters, onDuplicate, onClose }: { spec: Specialty | null; draft: SpecDraft; clusters: string[]; onDuplicate: (d: SpecDraft) => void; onClose: () => void }) {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const ro = !isAdmin;
  const creating = !spec;
  const [f, setF] = useState({
    number: spec ? String(spec.number) : draft.number ? String(draft.number) : "",
    name: draft.name,
    area: draft.area,
    cluster: draft.cluster,
    role: draft.role,
    scope: draft.scope,
    defaultPrompt: draft.defaultPrompt,
    defaultSpaces: draft.defaultSpaces,
    defaultSkills: draft.defaultSkills,
    keywords: draft.routingHints?.keywords ?? [],
    examples: draft.routingHints?.examples ?? [],
    escalationRules: draft.escalationRules,
    zone: draft.zone,
    phase: String(draft.phase),
    routable: draft.routable,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const [confirm, setConfirm] = useState<null | "delete" | "reset">(null);

  const spaces = useQuery({ queryKey: ["kb-spaces-list"], queryFn: () => api.get<{ available: boolean; spaces: KbSpace[]; error?: string }>("/kb/spaces"), staleTime: 60_000 });
  const detail = useQuery({ queryKey: ["catalog", "specialty", spec?.id], queryFn: () => api.get<{ flows: FlowUse[] }>(`/catalog/specialties/${spec!.id}`), enabled: !!spec });
  const flows = detail.data?.flows;
  const skills = useSkillList();
  const spaceOpts = (spaces.data?.spaces ?? []).map((s) => ({ value: s.slug, label: s.name ?? s.label ?? s.slug, hint: s.slug }));
  const skillOpts = (skills.data ?? []).map((s) => ({ value: s.id, label: s.enabled ? s.name : `${s.name} (desativada)`, hint: s.description }));
  const kbDown = spaces.data && !spaces.data.available;

  const payload = () => ({
    name: f.name.trim(),
    area: f.area.trim(),
    cluster: f.cluster.trim(),
    scope: f.scope,
    defaultPrompt: f.defaultPrompt,
    defaultSpaces: f.defaultSpaces,
    defaultSkills: f.defaultSkills,
    routingHints: { keywords: f.keywords, examples: f.examples },
    escalationRules: f.escalationRules,
    zone: f.zone,
    phase: Math.max(1, Math.round(Number(f.phase) || 1)),
    routable: f.routable,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["catalog"] }).then(() => qc.invalidateQueries({ queryKey: ["specialties"] }));

  const save = useMutation({
    mutationFn: () =>
      creating
        ? api.post("/catalog/specialties", { ...payload(), role: f.role, number: f.number.trim() ? Number(f.number) : undefined })
        : api.put(`/catalog/specialties/${spec.id}`, payload()),
    onSuccess: () => {
      toast.success(creating ? "Especialidade criada" : "Especialidade salva");
      refresh();
      onClose();
    },
  });
  const reset = useMutation({
    mutationFn: () => api.post(`/catalog/specialties/${spec!.id}/reset`),
    onSuccess: () => {
      toast.success("Padrão restaurado");
      refresh();
      onClose();
    },
  });
  const del = useMutation({
    mutationFn: () => api.del(`/catalog/specialties/${spec!.id}`),
    onSuccess: () => {
      toast.success("Especialidade excluída");
      refresh();
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Falha ao excluir"),
  });

  return (
    <>
      <SheetHeader className="border-b border-line">
        <SheetTitle className="text-base">
          {creating ? (
            "Nova especialidade"
          ) : (
            <>
              <span className="mr-2 text-text-dim tabular-nums">#{spec.number}</span>
              {spec.name}
            </>
          )}
        </SheetTitle>
        <SheetDescription className="text-xs">
          {creating
            ? "Depois de criada, ela aparece no editor de fluxos para ser ligada a um nó especialista."
            : [spec.cluster, spec.area, spec.origin === "custom" ? "criada no Studio" : "do sistema"].filter(Boolean).join(" · ")}
          {ro && " · somente leitura (apenas administradores editam)"}
        </SheetDescription>
      </SheetHeader>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {!!flows?.length && (
          <div className="rounded-md border border-line bg-ink-900 px-3 py-2 text-xs text-text-muted">
            Usada em {flows.length} fluxo(s){flows.some((x) => x.production) && ", inclusive o de produção"}. Escopo e dicas de roteamento valem na próxima execução; prompt, bases e skills padrão só entram em nós criados a partir daqui.
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-[6rem_1fr]">
          <Field label="Nº" hint={creating ? "Vazio = próximo livre." : undefined}>
            <Input inputMode="numeric" value={f.number} onChange={(e) => set("number", e.target.value.replace(/\D/g, ""))} disabled={!creating || ro} placeholder="auto" className="tabular-nums" />
          </Field>
          <Field label="Nome">
            <Input value={f.name} onChange={(e) => set("name", e.target.value)} disabled={ro} autoFocus={creating} />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Área">
            <Input value={f.area} onChange={(e) => set("area", e.target.value)} disabled={ro} placeholder="ex.: Consumidor" />
          </Field>
          <Field label="Agrupamento">
            <Input value={f.cluster} onChange={(e) => set("cluster", e.target.value)} disabled={ro} list="spec-clusters" placeholder="ex.: contratual" />
            <datalist id="spec-clusters">
              {clusters.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>
          <Field label="Papel">
            <Select value={f.role} onValueChange={(v) => set("role", v)} disabled={!creating || ro}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="specialist">especialista</SelectItem>
                <SelectItem value="support">apoio</SelectItem>
                {!["specialist", "support"].includes(f.role) && <SelectItem value={f.role}>{f.role}</SelectItem>}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field label="Escopo" hint="O que esta especialidade cobre (e o que não cobre). Usado pelo classificador.">
          <Textarea value={f.scope} onChange={(e) => set("scope", e.target.value)} rows={3} disabled={ro} className="text-sm" />
        </Field>
        <Field label="Prompt padrão" hint="Copiado para o nó especialista quando ele é criado a partir desta especialidade.">
          <Textarea value={f.defaultPrompt} onChange={(e) => set("defaultPrompt", e.target.value)} rows={14} disabled={ro} className="font-mono text-[0.75rem] leading-relaxed" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Zona">
            <Select value={f.zone} onValueChange={(v) => set("zone", v)} disabled={ro}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="verde">verde</SelectItem>
                <SelectItem value="amarela">amarela</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Fase">
            <Input inputMode="numeric" value={f.phase} onChange={(e) => set("phase", e.target.value)} disabled={ro} className="tabular-nums" />
          </Field>
          <Field label="Roteável">
            <div className="flex h-9 items-center gap-2">
              <Switch id="spec-routable" checked={f.routable} onCheckedChange={(v) => set("routable", v)} disabled={ro} />
              <Label htmlFor="spec-routable" className="text-xs text-text-muted">
                o classificador pode escolher
              </Label>
            </div>
          </Field>
        </div>
        <Field
          label="Bases padrão (KB)"
          hint={kbDown ? <span className="text-amber-300">KB indisponível: digite os slugs das bases, um por linha.</span> : "Espaços da KB consultados por este especialista."}
        >
          {spaces.isLoading ? (
            <Loading label="carregando bases…" />
          ) : kbDown ? (
            <LinesInput value={f.defaultSpaces} onChange={(v) => set("defaultSpaces", v)} placeholder="slug-da-base" rows={3} disabled={ro} />
          ) : (
            <MultiSelect options={spaceOpts} value={f.defaultSpaces} onChange={(v) => set("defaultSpaces", v)} placeholder="Selecionar bases…" disabled={ro} />
          )}
        </Field>
        <Field label="Skills padrão">
          <MultiSelect options={skillOpts} value={f.defaultSkills} onChange={(v) => set("defaultSkills", v)} placeholder="Selecionar skills…" disabled={ro} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Palavras-chave de roteamento" hint="Uma por linha.">
            <LinesInput value={f.keywords} onChange={(v) => set("keywords", v)} rows={5} disabled={ro} />
          </Field>
          <Field label="Perguntas de exemplo" hint="Uma por linha.">
            <LinesInput value={f.examples} onChange={(v) => set("examples", v)} rows={5} disabled={ro} />
          </Field>
        </div>
        <Field label="Regras de escalonamento" hint="Quando encaminhar para advogado humano. Uma por linha.">
          <LinesInput value={f.escalationRules} onChange={(v) => set("escalationRules", v)} rows={4} disabled={ro} />
        </Field>
        {spec && (
          <Field label="Fluxos que usam">
            <FlowsUsing flows={flows} what="esta especialidade" />
          </Field>
        )}
        <ErrorBox error={save.error ?? reset.error} />
      </div>
      {!ro && (
        <SheetFooter className="flex-row flex-wrap items-center border-t border-line">
          {spec && (
            <>
              <Button variant="ghost" size="sm" onClick={() => onDuplicate({ ...payload(), role: f.role, name: `${f.name.trim()} (cópia)` })}>
                <Copy /> Duplicar
              </Button>
              {spec.origin === "system" ? (
                <Button variant="ghost" size="sm" onClick={() => setConfirm("reset")} disabled={reset.isPending}>
                  <RotateCcw /> Restaurar padrão
                </Button>
              ) : (
                <Button variant="ghost" size="sm" className="text-rose-300 hover:text-rose-200" onClick={() => setConfirm("delete")} disabled={del.isPending}>
                  <Trash2 /> Excluir
                </Button>
              )}
            </>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button onClick={() => save.mutate()} disabled={!f.name.trim() || save.isPending}>
              {save.isPending && <Loader2 className="animate-spin" />} {creating ? "Criar" : "Salvar"}
            </Button>
          </div>
        </SheetFooter>
      )}
      {spec && (
        <>
          <Confirm
            open={confirm === "reset"}
            onOpenChange={(o) => !o && setConfirm(null)}
            title={`Restaurar o padrão de "${spec.name}"?`}
            description="Todos os campos voltam ao conteúdo do seed do sistema. O histórico da auditoria guarda a versão atual."
            action="Restaurar"
            onConfirm={() => reset.mutate()}
          />
          <Confirm
            open={confirm === "delete"}
            onOpenChange={(o) => !o && setConfirm(null)}
            title={`Excluir "${spec.name}"?`}
            description={flows?.length ? `Ela está ligada a nós em ${flows.length} fluxo(s); a exclusão será recusada até desvinculá-los.` : "Nenhum fluxo usa esta especialidade."}
            action="Excluir"
            destructive
            onConfirm={() => del.mutate()}
          />
        </>
      )}
    </>
  );
}

// ── Modelos de documento ──────────────────────────────────────────────

type TplDraft = Pick<DocTemplate, "slug" | "title" | "description" | "fields" | "body" | "enabled">;

const EMPTY_TPL: TplDraft = {
  slug: "",
  title: "",
  description: "",
  enabled: true,
  fields: [{ nome: "nome_usuario", rotulo: "Nome do usuário", obrigatorio: true }],
  body: "# Título do documento\n\nEu, **{{nome_usuario}}**, venho por meio deste…\n\n- item de lista\n\n{{data}}\n",
};

type TplOpen = { tpl: DocTemplate } | { draft: TplDraft };

function TemplatesTab() {
  const { isAdmin } = useAuth();
  const [open, setOpen] = useState<TplOpen | null>(null);
  const q = useQuery({ queryKey: ["catalog", "templates"], queryFn: () => api.get<{ templates: DocTemplate[]; checklists: string[] }>("/catalog/templates") });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const templates = q.data?.templates ?? [];
  const checklists = q.data?.checklists ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-text-muted">O consolidador vê os modelos ativos e pede os que servem ao caso; a skill “Gerar documento” preenche os campos e gera DOCX e PDF.</p>
        {isAdmin && (
          <Button size="sm" className="ml-auto" onClick={() => setOpen({ draft: EMPTY_TPL })}>
            <Plus /> Novo modelo
          </Button>
        )}
      </div>
      {templates.length === 0 ? (
        <Empty icon={<FileText />}>Nenhum modelo de documento cadastrado.</Empty>
      ) : (
        <div className="rounded-[10px] border border-line bg-ink-900">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Modelo</TableHead>
                <TableHead>Campos</TableHead>
                <TableHead className="pr-4 text-right">Tamanho</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {templates.map((t) => (
                <TableRow key={t.slug} className="cursor-pointer" onClick={() => setOpen({ tpl: t })}>
                  <TableCell className="max-w-md pl-4 whitespace-normal">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={t.enabled ? "font-medium" : "font-medium text-text-dim line-through"}>{t.title}</span>
                      {!t.enabled && <Pill>desativado</Pill>}
                      <OriginPill origin={t.origin} />
                    </div>
                    <div className="font-mono text-[0.7rem] text-text-dim">{t.slug}</div>
                    {t.description && <div className="mt-0.5 text-xs text-text-muted">{t.description}</div>}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <div className="flex flex-wrap gap-1">
                      {t.fields.map((c) => (
                        <Pill key={c.nome} tone={c.obrigatorio ? "info" : "neutral"} title={c.obrigatorio ? "obrigatório" : "opcional"}>
                          {c.rotulo}
                        </Pill>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="pr-4 text-right text-text-muted tabular-nums">{t.body.length.toLocaleString("pt-BR")} caracteres</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {checklists.length > 0 && (
        <div>
          <DividerLabel>Checklists de documentos (skill “Checklist documental”) · {checklists.length}</DividerLabel>
          <div className="flex flex-wrap gap-1.5">
            {checklists.map((c) => (
              <Pill key={c}>{c}</Pill>
            ))}
          </div>
        </div>
      )}
      <Sheet open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent side="right" className="w-full gap-0 sm:max-w-3xl">
          {open && (
            <TemplateEditor
              key={"tpl" in open ? open.tpl.slug : `new-${open.draft.slug}`}
              tpl={"tpl" in open ? open.tpl : null}
              draft={"tpl" in open ? open.tpl : open.draft}
              onDuplicate={(d) => setOpen({ draft: d })}
              onClose={() => setOpen(null)}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

const PLACEHOLDER_RE = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;
const placeholdersOf = (body: string) => [...new Set([...body.matchAll(PLACEHOLDER_RE)].map((m) => m[1]))];
/** {{data}} e preenchido pelo gerador; nao precisa ser campo. */
const AUTO_FIELDS = new Set(["data"]);
const humanize = (s: string) => {
  const t = s.replace(/_+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const slugify = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);

function TemplateEditor({ tpl, draft, onDuplicate, onClose }: { tpl: DocTemplate | null; draft: TplDraft; onDuplicate: (d: TplDraft) => void; onClose: () => void }) {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const ro = !isAdmin;
  const creating = !tpl;
  const [f, setF] = useState<TplDraft>({ ...draft, fields: draft.fields.map((x) => ({ ...x })) });
  const [slugTouched, setSlugTouched] = useState(!!draft.slug);
  const set = <K extends keyof TplDraft>(k: K, v: TplDraft[K]) => setF((s) => ({ ...s, [k]: v }));
  const setField = (i: number, patch: Partial<TemplateField>) => set("fields", f.fields.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const [confirm, setConfirm] = useState<null | "delete" | "reset">(null);
  const [previewing, setPreviewing] = useState(false);

  const inBody = placeholdersOf(f.body);
  const declared = new Set(f.fields.map((x) => x.nome));
  const undeclared = inBody.filter((p) => !declared.has(p) && !AUTO_FIELDS.has(p));
  const unused = f.fields.map((x) => x.nome).filter((n) => n && !inBody.includes(n));

  const detect = () => set("fields", [...f.fields, ...undeclared.map((nome) => ({ nome, rotulo: humanize(nome), obrigatorio: true }))]);

  const payload = () => ({ title: f.title.trim(), description: f.description.trim(), fields: f.fields.filter((x) => x.nome.trim()).map((x) => ({ ...x, nome: x.nome.trim(), rotulo: x.rotulo.trim() || humanize(x.nome) })), body: f.body, enabled: f.enabled });
  const refresh = () => qc.invalidateQueries({ queryKey: ["catalog", "templates"] });
  const done = (msg: string) => () => {
    toast.success(msg);
    refresh();
    onClose();
  };

  const save = useMutation({
    mutationFn: () => (creating ? api.post("/catalog/templates", { ...payload(), slug: f.slug }) : api.put(`/catalog/templates/${tpl.slug}`, payload())),
    onSuccess: done(creating ? "Modelo criado" : "Modelo salvo"),
  });
  const reset = useMutation({ mutationFn: () => api.post(`/catalog/templates/${tpl!.slug}/reset`), onSuccess: done("Padrão restaurado") });
  const del = useMutation({
    mutationFn: () => api.del(`/catalog/templates/${tpl!.slug}`),
    onSuccess: done("Modelo excluído"),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Falha ao excluir"),
  });

  // Previa: o mesmo gerador do gerar_documento, com o rotulo de cada campo no lugar do valor.
  const preview = async () => {
    setPreviewing(true);
    const tab = window.open("", "_blank");
    try {
      const values = Object.fromEntries(f.fields.filter((x) => x.nome).map((x) => [x.nome, `‹${x.rotulo || x.nome}›`]));
      const res = await fetch("/api/v1/catalog/templates/preview", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: f.body, values, format: "pdf" }) });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      if (tab) tab.location.href = url;
      else window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      tab?.close();
      toast.error(`Prévia falhou: ${(e as Error).message}`);
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <>
      <SheetHeader className="border-b border-line">
        <SheetTitle className="text-base">{creating ? "Novo modelo de documento" : tpl.title}</SheetTitle>
        <SheetDescription className="text-xs">
          {creating ? "Depois de criado e ativo, o consolidador passa a poder pedi-lo." : [tpl.slug, tpl.origin === "custom" ? "criado no Studio" : "do sistema"].join(" · ")}
          {ro && " · somente leitura (apenas administradores editam)"}
        </SheetDescription>
      </SheetHeader>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Título">
            <Input
              value={f.title}
              onChange={(e) => {
                set("title", e.target.value);
                if (creating && !slugTouched) set("slug", slugify(e.target.value));
              }}
              disabled={ro}
              autoFocus={creating}
            />
          </Field>
          <Field label="Identificador" hint={creating ? "Minúsculas, números e hífen. É o nome que o consolidador usa; não muda depois." : undefined}>
            <Input
              value={f.slug}
              onChange={(e) => {
                setSlugTouched(true);
                set("slug", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
              }}
              disabled={!creating || ro}
              className="font-mono text-sm"
            />
          </Field>
        </div>
        <Field label="Descrição" hint="Quando usar este modelo. O consolidador lê o título; a descrição ajuda a curadoria.">
          <Input value={f.description} onChange={(e) => set("description", e.target.value)} disabled={ro} />
        </Field>
        <div className="flex items-center gap-2">
          <Switch id="tpl-enabled" checked={f.enabled} onCheckedChange={(v) => set("enabled", v)} disabled={ro} />
          <Label htmlFor="tpl-enabled" className="text-xs text-text-muted">
            Ativo (oferecido ao consolidador e aceito pelo “Gerar documento”)
          </Label>
        </div>
        <Field
          label="Corpo"
          hint={
            <>
              Markdown simples: <code># título</code>, <code>## seção</code>, <code>- lista</code>, <code>**negrito**</code>. Campos como <code>{"{{nome_do_campo}}"}</code>; <code>{"{{data}}"}</code> é preenchido com a data de hoje. Campo sem valor sai como [NOME_DO_CAMPO].
            </>
          }
        >
          <Textarea value={f.body} onChange={(e) => set("body", e.target.value)} rows={18} disabled={ro} className="font-mono text-[0.75rem] leading-relaxed" />
        </Field>

        <div>
          <div className="mb-2 flex items-center gap-2">
            <Label className="text-xs">Campos</Label>
            <span className="text-[0.72rem] text-text-dim">O consolidador preenche os campos a partir da conversa; os obrigatórios que faltarem são avisados.</span>
          </div>
          <div className="space-y-2">
            {f.fields.map((c, i) => (
              <div key={i} className="grid grid-cols-[1fr_1.4fr_auto_auto] items-center gap-2">
                <Input value={c.nome} onChange={(e) => setField(i, { nome: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} placeholder="nome_do_campo" disabled={ro} className="h-8 font-mono text-xs" />
                <Input value={c.rotulo} onChange={(e) => setField(i, { rotulo: e.target.value })} placeholder="Rótulo" disabled={ro} className="h-8 text-sm" />
                <label className="flex items-center gap-1.5 text-xs text-text-muted">
                  <Checkbox checked={!!c.obrigatorio} onCheckedChange={(v) => setField(i, { obrigatorio: v === true })} disabled={ro} /> obrigatório
                </label>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => set("fields", f.fields.filter((_, j) => j !== i))} disabled={ro} aria-label="Remover campo">
                  <X />
                </Button>
              </div>
            ))}
          </div>
          {!ro && (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => set("fields", [...f.fields, { nome: "", rotulo: "", obrigatorio: false }])}>
                <Plus /> Campo
              </Button>
              {undeclared.length > 0 && (
                <Button variant="outline" size="sm" onClick={detect}>
                  <Wand2 /> Adicionar os {undeclared.length} campo(s) do corpo
                </Button>
              )}
            </div>
          )}
          {(undeclared.length > 0 || unused.length > 0) && (
            <div className="mt-2 space-y-1 text-[0.72rem] text-amber-300">
              {undeclared.length > 0 && <div>No corpo, sem cadastro como campo: {undeclared.join(", ")}</div>}
              {unused.length > 0 && <div>Campos que o corpo não usa: {unused.join(", ")}</div>}
            </div>
          )}
        </div>
        <ErrorBox error={save.error ?? reset.error} />
      </div>
      <SheetFooter className="flex-row flex-wrap items-center border-t border-line">
        <Button variant="ghost" size="sm" onClick={preview} disabled={!f.body.trim() || previewing}>
          {previewing ? <Loader2 className="animate-spin" /> : <Eye />} Prévia PDF
        </Button>
        {!ro && tpl && (
          <>
            <Button variant="ghost" size="sm" onClick={() => onDuplicate({ ...payload(), slug: `${tpl.slug}-copia`.slice(0, 63), title: `${f.title.trim()} (cópia)`, enabled: false })}>
              <Copy /> Duplicar
            </Button>
            {tpl.origin === "system" ? (
              <Button variant="ghost" size="sm" onClick={() => setConfirm("reset")} disabled={reset.isPending}>
                <RotateCcw /> Restaurar padrão
              </Button>
            ) : (
              <Button variant="ghost" size="sm" className="text-rose-300 hover:text-rose-200" onClick={() => setConfirm("delete")} disabled={del.isPending}>
                <Trash2 /> Excluir
              </Button>
            )}
          </>
        )}
        {!ro && (
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button onClick={() => save.mutate()} disabled={!f.title.trim() || !f.body.trim() || (creating && f.slug.length < 2) || save.isPending}>
              {save.isPending && <Loader2 className="animate-spin" />} {creating ? "Criar" : "Salvar"}
            </Button>
          </div>
        )}
      </SheetFooter>
      {tpl && (
        <>
          <Confirm
            open={confirm === "reset"}
            onOpenChange={(o) => !o && setConfirm(null)}
            title={`Restaurar o padrão de "${tpl.title}"?`}
            description="Título, descrição, campos e corpo voltam ao seed do sistema e o modelo fica ativo. O histórico da auditoria guarda a versão atual."
            action="Restaurar"
            onConfirm={() => reset.mutate()}
          />
          <Confirm
            open={confirm === "delete"}
            onOpenChange={(o) => !o && setConfirm(null)}
            title={`Excluir "${tpl.title}"?`}
            description="O consolidador deixa de poder pedi-lo. Documentos já gerados não são afetados."
            action="Excluir"
            destructive
            onConfirm={() => del.mutate()}
          />
        </>
      )}
    </>
  );
}

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BookOpen, ChevronDown, ChevronRight, FileText, Loader2, Lock, Plug, Search, Wrench } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { KbSpace, McpServer, Skill, Specialty } from "@/lib/types";
import { Page } from "@/Layout";
import { DividerLabel, Empty, ErrorBox, Field, JsonView, LinesInput, Loading, MultiSelect, PageHeader, Pill } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface Template {
  slug: string;
  titulo: string;
  descricao?: string;
  campos: { nome: string; rotulo: string; obrigatorio?: boolean }[];
  tamanho: number;
}

const useSkills = () => useQuery({ queryKey: ["catalog", "skills"], queryFn: () => api.get<{ skills: Skill[] }>("/catalog/skills").then((r) => r.skills) });

export function CatalogsPage() {
  return (
    <Page>
      <PageHeader icon={<BookOpen />} title="Catálogos" description="As peças com que os fluxos são montados: especialidades jurídicas (com prompt, bases e skills padrão), skills e servidores MCP disponíveis, e modelos de documento." />
      <Tabs defaultValue="specialties">
        <TabsList>
          <TabsTrigger value="specialties">Especialidades</TabsTrigger>
          <TabsTrigger value="skills">Skills</TabsTrigger>
          <TabsTrigger value="mcp">MCP</TabsTrigger>
          <TabsTrigger value="templates">Modelos de documento</TabsTrigger>
        </TabsList>
        <TabsContent value="specialties" className="mt-4">
          <SpecialtiesTab />
        </TabsContent>
        <TabsContent value="skills" className="mt-4">
          <SkillsTab />
        </TabsContent>
        <TabsContent value="mcp" className="mt-4">
          <McpTab />
        </TabsContent>
        <TabsContent value="templates" className="mt-4">
          <TemplatesTab />
        </TabsContent>
      </Tabs>
    </Page>
  );
}

const FixedNote = () => (
  <div className="mb-4 flex items-center gap-2 rounded-md border border-line bg-ink-900 px-3 py-2 text-xs text-text-muted">
    <Lock className="h-3.5 w-3.5" /> Lista fixa do sistema: definida no código do Studio, não editável por aqui.
  </div>
);

// ── Especialidades ────────────────────────────────────────────────────

function SpecialtiesTab() {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<Specialty | null>(null);
  const q = useQuery({ queryKey: ["catalog", "specialties"], queryFn: () => api.get<{ specialties: Specialty[] }>("/catalog/specialties").then((r) => r.specialties) });

  const groups = useMemo(() => {
    const s = search.trim().toLowerCase();
    const list = (q.data ?? []).filter((x) => !s || `${x.number} ${x.name} ${x.area} ${x.cluster} ${x.scope}`.toLowerCase().includes(s));
    const m = new Map<string, Specialty[]>();
    for (const x of list) m.set(x.cluster || "Sem agrupamento", [...(m.get(x.cluster || "Sem agrupamento") ?? []), x]);
    return [...m.entries()];
  }, [q.data, search]);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;

  return (
    <div className="space-y-4">
      <div className="relative max-w-sm">
        <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-text-dim" />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por nome, área, escopo…" className="h-8 pl-8 text-sm" />
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
                    <TableRow key={s.id} className="cursor-pointer" onClick={() => setOpen(s)}>
                      <TableCell className="pl-4 text-text-dim tabular-nums">{s.number}</TableCell>
                      <TableCell className="font-medium">
                        {s.name}
                        {s.role !== "specialist" && <span className="ml-2 text-xs text-text-dim">{s.role}</span>}
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
          {open && <SpecialtyEditor key={open.id} spec={open} onClose={() => setOpen(null)} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function SpecialtyEditor({ spec, onClose }: { spec: Specialty; onClose: () => void }) {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const ro = !isAdmin;
  const [f, setF] = useState({
    name: spec.name,
    scope: spec.scope,
    defaultPrompt: spec.defaultPrompt,
    defaultSpaces: spec.defaultSpaces,
    defaultSkills: spec.defaultSkills,
    keywords: spec.routingHints?.keywords ?? [],
    examples: spec.routingHints?.examples ?? [],
    escalationRules: spec.escalationRules,
    zone: spec.zone,
    phase: String(spec.phase),
    routable: spec.routable,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));

  const spaces = useQuery({ queryKey: ["kb-spaces-list"], queryFn: () => api.get<{ available: boolean; spaces: KbSpace[]; error?: string }>("/kb/spaces"), staleTime: 60_000 });
  const skills = useSkills();
  const spaceOpts = (spaces.data?.spaces ?? []).map((s) => ({ value: s.slug, label: s.name ?? s.label ?? s.slug, hint: s.slug }));
  const skillOpts = (skills.data ?? []).map((s) => ({ value: s.id, label: s.name, hint: s.description }));
  const kbDown = spaces.data && !spaces.data.available;

  const save = useMutation({
    mutationFn: () =>
      api.put(`/catalog/specialties/${spec.id}`, {
        name: f.name.trim(),
        scope: f.scope,
        defaultPrompt: f.defaultPrompt,
        defaultSpaces: f.defaultSpaces,
        defaultSkills: f.defaultSkills,
        routingHints: { keywords: f.keywords, examples: f.examples },
        escalationRules: f.escalationRules,
        zone: f.zone,
        phase: Math.max(1, Math.round(Number(f.phase) || 1)),
        routable: f.routable,
      }),
    onSuccess: () => {
      toast.success("Especialidade salva");
      qc.invalidateQueries({ queryKey: ["catalog", "specialties"] });
      onClose();
    },
  });

  return (
    <>
      <SheetHeader className="border-b border-line">
        <SheetTitle className="text-base">
          <span className="mr-2 text-text-dim tabular-nums">#{spec.number}</span>
          {spec.name}
        </SheetTitle>
        <SheetDescription className="text-xs">
          {[spec.cluster, spec.area].filter(Boolean).join(" · ")}
          {ro && " · somente leitura (apenas administradores editam)"}
        </SheetDescription>
      </SheetHeader>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <Field label="Nome">
          <Input value={f.name} onChange={(e) => set("name", e.target.value)} disabled={ro} />
        </Field>
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
        <ErrorBox error={save.error} />
      </div>
      {!ro && (
        <SheetFooter className="flex-row justify-end border-t border-line">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => save.mutate()} disabled={!f.name.trim() || save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />} Salvar
          </Button>
        </SheetFooter>
      )}
    </>
  );
}

// ── Skills ────────────────────────────────────────────────────────────

function SkillsTab() {
  const q = useSkills();
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <>
      <FixedNote />
      {!q.data?.length ? (
        <Empty icon={<Wrench />}>Nenhuma skill cadastrada.</Empty>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {q.data.map((s) => (
            <div key={s.id} className="rounded-[10px] border border-line bg-ink-900 p-4">
              <div className="flex items-center gap-2">
                <Wrench className="h-3.5 w-3.5 text-text-muted" />
                <span className="text-sm font-medium">{s.name}</span>
                <span className="font-mono text-[0.7rem] text-text-dim">{s.id}</span>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-text-muted">{s.description}</p>
              <SchemaToggle value={s.inputSchema} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function SchemaToggle({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-2">
      <CollapsibleTrigger className="flex items-center gap-1 text-xs text-text-muted hover:text-text">
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />} esquema de entrada
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">
        <JsonView value={value} maxHeight={280} />
      </CollapsibleContent>
    </Collapsible>
  );
}

// ── MCP ───────────────────────────────────────────────────────────────

function McpTab() {
  const q = useQuery({ queryKey: ["catalog", "mcp"], queryFn: () => api.get<{ servers: McpServer[] }>("/catalog/mcp").then((r) => r.servers) });
  if (q.isLoading) return <Loading label="consultando servidores MCP…" />;
  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <>
      <FixedNote />
      {!q.data?.length ? (
        <Empty icon={<Plug />}>Nenhum servidor MCP cadastrado.</Empty>
      ) : (
        <div className="space-y-3">
          {q.data.map((s) => (
            <div key={s.id} className="rounded-[10px] border border-line bg-ink-900 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Plug className="h-3.5 w-3.5 text-text-muted" />
                <span className="text-sm font-medium">{s.name}</span>
                <span className="font-mono text-[0.7rem] text-text-dim">{s.id}</span>
                {s.enabled ? <Pill tone="ok">habilitado</Pill> : <Pill>desabilitado</Pill>}
              </div>
              {s.description && <p className="mt-1.5 text-xs text-text-muted">{s.description}</p>}
              <div className="mt-1 font-mono text-[0.72rem] break-all text-text-dim">{s.url}</div>
              <div className="mt-3">
                <div className="mb-1.5 text-xs text-text-muted">Ferramentas ({s.toolsCache?.length ?? 0})</div>
                {!s.toolsCache?.length ? (
                  <div className="text-xs text-text-dim">{s.enabled ? "Nenhuma ferramenta listada (servidor fora do ar?)." : "Servidor desabilitado."}</div>
                ) : (
                  <ul className="grid gap-1.5 sm:grid-cols-2">
                    {s.toolsCache.map((t) => (
                      <li key={t.name} className="rounded-md border border-line-soft bg-ink-950 px-2.5 py-1.5">
                        <div className="font-mono text-[0.72rem] text-text">{t.name}</div>
                        {t.description && <div className="line-clamp-2 text-[0.7rem] text-text-dim">{t.description}</div>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ── Modelos de documento ──────────────────────────────────────────────

function TemplatesTab() {
  const q = useQuery({ queryKey: ["catalog", "templates"], queryFn: () => api.get<{ templates: Template[]; checklists: string[] }>("/catalog/templates") });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const templates = q.data?.templates ?? [];
  const checklists = q.data?.checklists ?? [];
  return (
    <>
      <FixedNote />
      {templates.length === 0 ? (
        <Empty icon={<FileText />}>Nenhum modelo de documento carregado.</Empty>
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
                <TableRow key={t.slug}>
                  <TableCell className="max-w-md pl-4 whitespace-normal">
                    <div className="font-medium">{t.titulo}</div>
                    <div className="font-mono text-[0.7rem] text-text-dim">{t.slug}</div>
                    {t.descricao && <div className="mt-0.5 text-xs text-text-muted">{t.descricao}</div>}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <div className="flex flex-wrap gap-1">
                      {t.campos.map((c) => (
                        <Pill key={c.nome} tone={c.obrigatorio ? "info" : "neutral"} title={c.obrigatorio ? "obrigatório" : "opcional"}>
                          {c.rotulo}
                        </Pill>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="pr-4 text-right text-text-muted tabular-nums">{t.tamanho.toLocaleString("pt-BR")} caracteres</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {checklists.length > 0 && (
        <div className="mt-4">
          <DividerLabel>Checklists de documentos · {checklists.length}</DividerLabel>
          <div className="flex flex-wrap gap-1.5">
            {checklists.map((c) => (
              <Pill key={c}>{c}</Pill>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

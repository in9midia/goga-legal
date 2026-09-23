import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ClipboardList, Search } from "lucide-react";
import { api, qs } from "@/lib/api";
import { dateTime, isoDay } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Page } from "@/Layout";
import { Empty, ErrorBox, Field, JsonView, Loading, PageHeader, Pill, type Tone } from "@/components/common";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface AuditEntry {
  id: string;
  actorId: string | null;
  actorEmail: string;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  at: string;
}

const ENTITIES: Record<string, string> = {
  flow: "Fluxo",
  provider: "Provedor",
  model: "Modelo",
  specialty: "Especialidade",
  doc_template: "Modelo de documento",
  user: "Usuário",
  skill: "Skill",
  mcp_server: "Servidor MCP",
};

const ACTIONS: Record<string, [string, Tone]> = {
  create: ["criou", "ok"],
  update: ["editou", "info"],
  update_key: ["trocou a chave", "warn"],
  update_price: ["alterou preço", "warn"],
  update_with_password: ["editou (com senha)", "warn"],
  change_password: ["trocou a senha", "neutral"],
  delete: ["excluiu", "bad"],
  publish: ["publicou", "ok"],
  duplicate: ["duplicou", "info"],
  import: ["instalou", "ok"],
  reset: ["restaurou padrão", "warn"],
};

const ALL = "__all";

export function AuditPage() {
  const [entity, setEntity] = useState(ALL);
  const [actor, setActor] = useState("");
  const [from, setFrom] = useState(isoDay(new Date(Date.now() - 29 * 864e5)));
  const [to, setTo] = useState(isoDay(new Date()));
  const [open, setOpen] = useState<AuditEntry | null>(null);

  const q = useQuery({
    queryKey: ["audit", entity, actor, from, to],
    queryFn: () => api.get<{ entries: AuditEntry[] }>(`/audit${qs({ entity: entity === ALL ? undefined : entity, actor: actor.trim(), from, to })}`),
    placeholderData: (prev) => prev,
  });
  const entries = q.data?.entries ?? [];

  return (
    <Page>
      <PageHeader icon={<ClipboardList />} title="Auditoria" description="O que foi alterado na configuração, por quem e quando: fluxos, provedores, chaves, modelos, preços, especialidades e usuários. Clique numa linha para ver o antes e o depois." />

      <div className="grid gap-3 rounded-[10px] border border-line bg-ink-900 p-4 sm:grid-cols-4">
        <Field label="Entidade">
          <Select value={entity} onValueChange={setEntity}>
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todas</SelectItem>
              {Object.entries(ENTITIES).map(([k, v]) => (
                <SelectItem key={k} value={k}>
                  {v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Autor (e-mail)">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-text-dim" />
            <Input value={actor} onChange={(e) => setActor(e.target.value)} placeholder="contém…" className="h-8 pl-8 text-sm" />
          </div>
        </Field>
        <Field label="De">
          <Input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className="h-8 text-sm" />
        </Field>
        <Field label="Até">
          <Input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} className="h-8 text-sm" />
        </Field>
      </div>

      <ErrorBox error={q.error} />
      {q.isLoading ? (
        <Loading />
      ) : entries.length === 0 ? (
        <Empty icon={<ClipboardList />}>Nenhuma alteração registrada com esses filtros.</Empty>
      ) : (
        <div className="rounded-[10px] border border-line bg-ink-900">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Quando</TableHead>
                <TableHead>Autor</TableHead>
                <TableHead>Ação</TableHead>
                <TableHead>Entidade</TableHead>
                <TableHead className="pr-4">ID</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => {
                const [label, tone] = ACTIONS[e.action] ?? [e.action, "neutral" as Tone];
                return (
                  <TableRow key={e.id} className="cursor-pointer" onClick={() => setOpen(e)}>
                    <TableCell className="pl-4 whitespace-nowrap text-text-muted tabular-nums">{dateTime(e.at)}</TableCell>
                    <TableCell className="max-w-56 truncate">{e.actorEmail}</TableCell>
                    <TableCell>
                      <Pill tone={tone}>{label}</Pill>
                    </TableCell>
                    <TableCell>{ENTITIES[e.entity] ?? e.entity}</TableCell>
                    <TableCell className="max-w-48 truncate pr-4 font-mono text-[0.72rem] text-text-dim" title={e.entityId ?? ""}>
                      {e.entityId ?? "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {entries.length >= 200 && <div className="border-t border-line px-4 py-2 text-xs text-text-dim">Mostrando as 200 mais recentes. Refine os filtros para ver mais antigas.</div>}
        </div>
      )}

      <Sheet open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-4xl">{open && <AuditDetail entry={open} />}</SheetContent>
      </Sheet>
    </Page>
  );
}

// ── Diff ──────────────────────────────────────────────────────────────

type Flat = Map<string, unknown>;

/** Achata um objeto em caminhos pontuados (a.b[2].c → valor primitivo). */
function flatten(value: unknown, prefix = "", out: Flat = new Map()): Flat {
  if (value === null || typeof value !== "object") {
    if (prefix || value !== undefined) out.set(prefix || "(raiz)", value);
    return out;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) out.set(prefix || "(raiz)", []);
    value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
    return out;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) out.set(prefix || "(raiz)", {});
  for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

type Change = { path: string; kind: "added" | "removed" | "changed"; before: unknown; after: unknown };

function diff(before: unknown, after: unknown): Change[] {
  const a = flatten(before ?? {});
  const b = flatten(after ?? {});
  const out: Change[] = [];
  for (const [path, v] of a) {
    if (!b.has(path)) out.push({ path, kind: "removed", before: v, after: undefined });
    else if (JSON.stringify(v) !== JSON.stringify(b.get(path))) out.push({ path, kind: "changed", before: v, after: b.get(path) });
  }
  for (const [path, v] of b) if (!a.has(path)) out.push({ path, kind: "added", before: undefined, after: v });
  return out.sort((x, y) => x.path.localeCompare(y.path, undefined, { numeric: true }));
}

/** Agrupa pelo primeiro segmento do caminho (ex.: graph.nodes[3] → "graph.nodes[3]"). */
function groupKey(path: string) {
  const m = path.match(/^([^.[]+(?:\.[^.[]+)?(?:\[\d+\])?)/);
  return m ? m[1] : path;
}

const show = (v: unknown) => (v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));

function Value({ v, tone }: { v: unknown; tone: "before" | "after" }) {
  const [full, setFull] = useState(false);
  if (v === undefined) return <span className="text-text-dim">—</span>;
  const s = show(v);
  const long = s.length > 160;
  return (
    <div className={cn("font-mono text-[0.72rem] break-words whitespace-pre-wrap", tone === "before" ? "text-rose-300/90" : "text-emerald-300/90")}>
      {long && !full ? s.slice(0, 160) + "…" : s}
      {long && (
        <button onClick={() => setFull(!full)} className="ml-1 font-sans text-[0.68rem] text-text-muted underline-offset-2 hover:underline">
          {full ? "menos" : `mais (${s.length} caracteres)`}
        </button>
      )}
    </div>
  );
}

function AuditDetail({ entry }: { entry: AuditEntry }) {
  const [showJson, setShowJson] = useState(false);
  const changes = useMemo(() => diff(entry.before, entry.after), [entry]);
  const groups = useMemo(() => {
    const m = new Map<string, Change[]>();
    for (const c of changes) {
      const k = groupKey(c.path);
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    return [...m.entries()];
  }, [changes]);
  const [label, tone] = ACTIONS[entry.action] ?? [entry.action, "neutral" as Tone];
  const noState = entry.before == null && entry.after == null;

  return (
    <>
      <SheetHeader className="border-b border-line">
        <SheetTitle className="flex flex-wrap items-center gap-2 text-base">
          {ENTITIES[entry.entity] ?? entry.entity} <Pill tone={tone}>{label}</Pill>
        </SheetTitle>
        <SheetDescription className="text-xs">
          {entry.actorEmail} · {dateTime(entry.at)}
          {entry.entityId && <span className="ml-2 font-mono text-text-dim">{entry.entityId}</span>}
        </SheetDescription>
      </SheetHeader>

      <div className="space-y-4 p-4">
        {noState ? (
          <Empty>Esta ação não guarda estado (por exemplo, troca de senha).</Empty>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex gap-2 text-xs text-text-muted">
                <Pill tone="info">{changes.filter((c) => c.kind === "changed").length} alterados</Pill>
                <Pill tone="ok">{changes.filter((c) => c.kind === "added").length} adicionados</Pill>
                <Pill tone="bad">{changes.filter((c) => c.kind === "removed").length} removidos</Pill>
              </div>
              <div className="flex items-center gap-2">
                <Switch id="showjson" checked={showJson} onCheckedChange={setShowJson} />
                <Label htmlFor="showjson" className="text-xs text-text-muted">
                  mostrar JSON completo
                </Label>
              </div>
            </div>

            {changes.length === 0 ? (
              <Empty>Nenhuma diferença entre antes e depois.</Empty>
            ) : (
              <div className="overflow-hidden rounded-md border border-line">
                <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3 border-b border-line bg-ink-850 px-3 py-2 text-[0.68rem] font-medium tracking-wider text-text-muted uppercase">
                  <span>Caminho</span>
                  <span>Antes</span>
                  <span>Depois</span>
                </div>
                {groups.map(([k, cs]) => (
                  <DiffGroup key={k} name={k} changes={cs} collapsible={groups.length > 1 && cs.length > 3} />
                ))}
              </div>
            )}

            {showJson && (
              <div className="grid gap-3 md:grid-cols-2">
                <div className="min-w-0 space-y-1">
                  <div className="text-xs text-text-muted">Antes</div>
                  <JsonView value={entry.before ?? null} maxHeight={520} />
                </div>
                <div className="min-w-0 space-y-1">
                  <div className="text-xs text-text-muted">Depois</div>
                  <JsonView value={entry.after ?? null} maxHeight={520} />
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

function DiffGroup({ name, changes, collapsible }: { name: string; changes: Change[]; collapsible: boolean }) {
  const [open, setOpen] = useState(!collapsible);
  return (
    <div className="border-b border-line last:border-b-0">
      {collapsible && (
        <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 bg-ink-900 px-3 py-1.5 text-left font-mono text-[0.72rem] text-text-muted hover:bg-ink-850">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {name}
          <span className="ml-1 font-sans text-text-dim">({changes.length} mudanças)</span>
        </button>
      )}
      {open &&
        changes.map((c) => (
          <div key={c.path} className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3 border-t border-line-soft px-3 py-2 first:border-t-0">
            <div className="flex min-w-0 items-start gap-1.5">
              <span className={cn("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", c.kind === "added" ? "bg-emerald-500" : c.kind === "removed" ? "bg-rose-500" : "bg-blue-500")} />
              <span className="font-mono text-[0.72rem] break-all text-text">{c.path}</span>
            </div>
            <Value v={c.before} tone="before" />
            <Value v={c.after} tone="after" />
          </div>
        ))}
    </div>
  );
}

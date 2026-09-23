import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, Plus, Trash2, Workflow } from "lucide-react";
import { api, qs } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { dateTime, int, ms } from "@/lib/format";
import type { AuditEntry, FlowUse, UsageStats } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DividerLabel, Empty, ErrorBox, JsonView, KPI, Loading, Pill } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// Pecas comuns das telas de Skills e MCP: uso, alcance em fluxos, historico,
// cabecalhos com segredo e editor de JSON.

// ── Uso (spans do trace) ─────────────────────────────────────────────────

export function UsagePanel({ path, nameLabel }: { path: string; nameLabel?: (name: string) => string }) {
  const [days, setDays] = useState("30");
  const q = useQuery({ queryKey: ["usage", path, days], queryFn: () => api.get<UsageStats>(`${path}${qs({ days })}`) });
  const s = q.data;
  const errRate = s && s.calls ? (s.errors / s.calls) * 100 : 0;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-text-muted">Chamadas registradas no trace das execuções (Simulador, avaliação em lote e produção).</p>
        <Select value={days} onValueChange={setDays}>
          <SelectTrigger size="sm" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">7 dias</SelectItem>
            <SelectItem value="30">30 dias</SelectItem>
            <SelectItem value="90">90 dias</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : s && s.calls === 0 ? (
        <Empty>Nenhuma chamada nos últimos {s.days} dias.</Empty>
      ) : (
        s && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <KPI label="Chamadas" value={int(s.calls)} hint={`em ${int(s.runs)} execução(ões)`} />
              <KPI label="Erros" value={int(s.errors)} hint={<span className={cn(errRate > 10 && "text-rose-300")}>{errRate.toFixed(1)}% das chamadas</span>} />
              <KPI label="Latência média" value={ms(s.avgMs == null ? null : Math.round(s.avgMs))} hint={`p95 ${ms(s.p95Ms == null ? null : Math.round(s.p95Ms))}`} />
              <KPI label="Último uso" value={<span className="text-sm">{dateTime(s.lastAt)}</span>} />
            </div>
            <DailyBars daily={s.daily} days={s.days} />
            {nameLabel && s.byName.length > 1 && (
              <div>
                <DividerLabel>Por ferramenta</DividerLabel>
                <div className="divide-y divide-line-soft rounded-md border border-line">
                  {s.byName.map((r) => (
                    <div key={r.name} className="flex items-center gap-3 px-3 py-1.5 text-xs">
                      <span className="flex-1 truncate font-mono text-text">{nameLabel ? nameLabel(r.name) : r.name}</span>
                      <span className="text-text-muted tabular-nums">{int(r.calls)} chamadas</span>
                      <span className={cn("w-16 text-right tabular-nums", r.errors ? "text-rose-300" : "text-text-dim")}>{int(r.errors)} erros</span>
                      <span className="w-16 text-right text-text-dim tabular-nums">{ms(r.avgMs == null ? null : Math.round(r.avgMs))}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {s.recentErrors.length > 0 && (
              <div>
                <DividerLabel>Erros recentes</DividerLabel>
                <div className="space-y-2">
                  {s.recentErrors.map((e, i) => (
                    <div key={i} className="rounded-md border border-rose-500/20 bg-rose-500/5 px-3 py-2">
                      <div className="flex items-center gap-2 text-[0.7rem] text-text-dim">
                        <span>{dateTime(e.at)}</span>
                        {nameLabel && <span className="font-mono">{nameLabel(e.name)}</span>}
                        <Link to={`/history/${e.runId}`} className="ml-auto inline-flex items-center gap-1 text-text-muted hover:text-text">
                          ver execução <ExternalLink className="h-3 w-3" />
                        </Link>
                      </div>
                      <div className="mt-1 text-xs break-words text-rose-200">{e.error}</div>
                      {e.input != null && <JsonView value={e.input} maxHeight={120} className="mt-1.5 p-2 text-[0.68rem]" />}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )
      )}
    </div>
  );
}

function DailyBars({ daily, days }: { daily: UsageStats["daily"]; days: number }) {
  const map = new Map(daily.map((d) => [d.day, d]));
  const series = Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.now() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    return map.get(d) ?? { day: d, calls: 0, errors: 0 };
  });
  const max = Math.max(1, ...series.map((d) => d.calls));
  return (
    <div className="rounded-md border border-line bg-ink-900 p-3">
      <div className="flex h-20 items-end gap-px">
        {series.map((d) => (
          <div key={d.day} className="flex h-full flex-1 flex-col justify-end" title={`${d.day}: ${d.calls} chamada(s), ${d.errors} erro(s)`}>
            <div className="w-full rounded-t-[2px] bg-rose-400/80" style={{ height: `${(d.errors / max) * 100}%` }} />
            <div className="w-full bg-blue-400/60" style={{ height: `${((d.calls - d.errors) / max) * 100}%`, minHeight: d.calls ? 1 : 0 }} />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[0.65rem] text-text-dim">
        <span>{series[0].day.split("-").reverse().slice(0, 2).join("/")}</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-blue-400/60" /> ok
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-rose-400/80" /> erro
          </span>
        </span>
        <span>hoje</span>
      </div>
    </div>
  );
}

// ── Fluxos que usam ───────────────────────────────────────────────────────

export function FlowsUsing({ flows, what }: { flows: FlowUse[] | undefined; what: string }) {
  if (!flows) return null;
  if (!flows.length) return <p className="text-xs text-text-dim">Nenhum fluxo usa {what}.</p>;
  return (
    <div className="divide-y divide-line-soft rounded-md border border-line">
      {flows.map((f) => (
        <Link key={f.id} to={`/flows/${f.id}`} className="flex items-start gap-2 px-3 py-2 text-xs hover:bg-ink-850">
          <Workflow className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-dim" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium text-text">{f.name}</span>
              {f.production && <Pill tone="ok">produção</Pill>}
            </div>
            <div className="truncate text-text-dim">{f.nodes.join(" · ")}</div>
          </div>
        </Link>
      ))}
    </div>
  );
}

/** Aviso de alcance antes de salvar: quem vai sentir a mudanca. */
export function ImpactNote({ flows }: { flows: FlowUse[] | undefined }) {
  if (!flows?.length) return null;
  const prod = flows.some((f) => f.production);
  return (
    <div className={cn("flex items-start gap-2 rounded-md border px-3 py-2 text-xs", prod ? "border-amber-500/30 bg-amber-500/10 text-amber-200" : "border-line bg-ink-900 text-text-muted")}>
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        Usada em {flows.length} fluxo(s){prod && ", inclusive o de produção"}. A alteração vale a partir da próxima execução, sem republicar.
      </span>
    </div>
  );
}

// ── Historico (auditoria) ────────────────────────────────────────────────

const ACTION_LABEL: Record<string, string> = { create: "criou", update: "editou", delete: "excluiu", import: "instalou", reset: "restaurou padrão" };
const HIDDEN = new Set(["updatedAt", "version", "toolsCache", "checkedAt", "lastError"]);

export function HistoryPanel({ entity, id }: { entity: string; id: string }) {
  const { isAdmin } = useAuth();
  const q = useQuery({
    queryKey: ["audit", entity, id],
    queryFn: () => api.get<{ entries: AuditEntry[] }>(`/audit${qs({ entity, entityId: id, from: "2000-01-01", limit: 100 })}`).then((r) => r.entries),
    enabled: isAdmin,
  });
  if (!isAdmin) return <Empty>O histórico de alterações é visível só para administradores.</Empty>;
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data?.length) return <Empty>Sem alterações registradas. O que vem do seed do sistema não entra na auditoria.</Empty>;
  return (
    <ol className="space-y-3">
      {q.data.map((e) => {
        const changed = diffKeys(e.before, e.after);
        return (
          <li key={e.id} className="rounded-md border border-line bg-ink-900 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium text-text">{ACTION_LABEL[e.action] ?? e.action}</span>
              <span className="text-text-muted">{e.actorEmail}</span>
              <span className="ml-auto text-text-dim">{dateTime(e.at)}</span>
              {typeof e.after?.version === "number" && <Pill>v{e.after.version}</Pill>}
            </div>
            {changed.length > 0 && (
              <div className="mt-2 space-y-1.5">
                {changed.map((k) => (
                  <div key={k} className="text-[0.72rem]">
                    <div className="font-mono text-text-dim">{k}</div>
                    <div className="grid gap-1 sm:grid-cols-2">
                      <Snippet value={e.before?.[k]} tone="before" />
                      <Snippet value={e.after?.[k]} tone="after" />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function diffKeys(a: Record<string, unknown> | null, b: Record<string, unknown> | null) {
  if (!a || !b) return [];
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !HIDDEN.has(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

function Snippet({ value, tone }: { value: unknown; tone: "before" | "after" }) {
  const text = value == null ? "—" : typeof value === "string" ? value : JSON.stringify(value);
  return (
    <div className={cn("max-h-24 overflow-auto rounded border px-2 py-1 whitespace-pre-wrap break-words", tone === "before" ? "border-rose-500/20 bg-rose-500/5 text-rose-200/80 line-through decoration-rose-400/30" : "border-emerald-500/20 bg-emerald-500/5 text-emerald-200")}>
      {text.length > 600 ? `${text.slice(0, 600)}…` : text}
    </div>
  );
}

// ── Cabecalhos (valores secretos nunca voltam do servidor) ───────────────

export type HeaderRow = { key: string; value: string; saved: boolean };

export const headerRows = (names: string[]): HeaderRow[] => names.map((key) => ({ key, value: "", saved: true }));
/** Linha salva com valor vazio = "manter o valor atual" no servidor. */
export const headersPayload = (rows: HeaderRow[]) => Object.fromEntries(rows.filter((r) => r.key.trim() && (r.value || r.saved)).map((r) => [r.key.trim(), r.value]));

export function HeadersEditor({ rows, onChange, disabled }: { rows: HeaderRow[]; onChange: (r: HeaderRow[]) => void; disabled?: boolean }) {
  const set = (i: number, patch: Partial<HeaderRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex gap-1.5">
          <Input value={r.key} onChange={(e) => set(i, { key: e.target.value, saved: false })} placeholder="Authorization" className="h-8 w-44 font-mono text-xs" disabled={disabled || r.saved} />
          <Input
            type="password"
            value={r.value}
            onChange={(e) => set(i, { value: e.target.value })}
            placeholder={r.saved ? "•••••• (mantido; digite para trocar)" : "Bearer …"}
            className="h-8 flex-1 font-mono text-xs"
            disabled={disabled}
            autoComplete="off"
          />
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onChange(rows.filter((_, j) => j !== i))} disabled={disabled} title="Remover">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      {!disabled && (
        <Button variant="outline" size="sm" onClick={() => onChange([...rows, { key: "", value: "", saved: false }])}>
          <Plus /> Cabeçalho
        </Button>
      )}
    </div>
  );
}

// ── JSON ─────────────────────────────────────────────────────────────────

export function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: text.trim() ? JSON.parse(text) : {} };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function JsonEditor({ value, onChange, rows = 8, disabled }: { value: string; onChange: (v: string) => void; rows?: number; disabled?: boolean }) {
  const p = parseJson(value);
  return (
    <div className="space-y-1">
      <Textarea value={value} onChange={(e) => onChange(e.target.value)} rows={rows} disabled={disabled} spellCheck={false} className={cn("font-mono text-[0.72rem] leading-relaxed", !p.ok && "border-rose-500/50")} />
      {!p.ok && <p className="text-[0.7rem] text-rose-300">JSON inválido: {p.error}</p>}
    </div>
  );
}

/** Esqueleto de argumentos a partir de um JSON Schema (ponto de partida do teste). */
export function exampleFromSchema(schema: unknown): unknown {
  const s = schema as { type?: string; properties?: Record<string, unknown>; enum?: unknown[]; default?: unknown; items?: unknown; format?: string; description?: string };
  if (!s || typeof s !== "object") return {};
  if (s.default !== undefined) return s.default;
  if (s.enum?.length) return s.enum[0];
  switch (s.type) {
    case "object":
      return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, exampleFromSchema(v)]));
    case "array":
      return [];
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "string":
      return /AAAA-MM-DD/.test(s.description ?? "") || s.format === "date" ? new Date().toISOString().slice(0, 10) : "";
    default:
      return null;
  }
}


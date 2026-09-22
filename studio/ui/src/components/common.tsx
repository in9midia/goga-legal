import { useState, type ReactNode } from "react";
import { Check, ChevronsUpDown, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";

// Padrao SectionHeader/KPI do agentic-sdlc, sobre componentes shadcn.

export function PageHeader({ title, description, icon, actions }: { title: ReactNode; description?: ReactNode; icon?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
      <div className="flex min-w-0 items-start gap-3 sm:flex-1 sm:basis-64">
        {icon && <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-line bg-ink-800 text-text-muted [&>svg]:h-4 [&>svg]:w-4">{icon}</div>}
        <div className="min-w-0">
          <h1 className="text-base leading-tight font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-1 max-w-2xl text-[0.82rem] leading-relaxed text-text-muted">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">{actions}</div>}
    </header>
  );
}

export function KPI({ label, value, hint, icon }: { label: ReactNode; value: ReactNode; hint?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="rounded-[10px] border border-line bg-ink-900 px-4 py-3">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className="text-[0.68rem] font-medium tracking-[0.08em] text-text-muted uppercase">{label}</span>
        {icon && <span className="shrink-0 text-text-dim [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>}
      </div>
      <div className="text-xl font-semibold tracking-tight tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-text-dim">{hint}</div>}
    </div>
  );
}

export function DividerLabel({ children }: { children: ReactNode }) {
  return (
    <div className="my-2 flex items-center gap-3">
      <span className="text-[0.62rem] font-medium tracking-[0.1em] text-text-muted uppercase">{children}</span>
      <span className="h-px flex-1 bg-line-soft" />
    </div>
  );
}

const TONES = {
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  bad: "border-rose-500/30 bg-rose-500/10 text-rose-300",
  info: "border-blue-500/30 bg-blue-500/10 text-blue-300",
  neutral: "border-line bg-ink-800 text-text-muted",
} as const;
export type Tone = keyof typeof TONES;

const STATUS: Record<string, [string, Tone]> = {
  ok: ["ok", "ok"],
  running: ["executando", "info"],
  error: ["erro", "bad"],
  blocked: ["bloqueado", "warn"],
  clarify: ["esclarecimento", "info"],
  skipped: ["pulado", "neutral"],
  done: ["concluído", "ok"],
  cancelled: ["cancelado", "neutral"],
  VERIFICADA: ["VERIFICADA", "ok"],
  EM_VERIFICACAO: ["EM VERIFICAÇÃO", "warn"],
  INCORRETA: ["INCORRETA", "bad"],
  NAO_ENCONTRADA: ["NÃO ENCONTRADA", "bad"],
  KB_INDISPONIVEL: ["KB indisponível", "neutral"],
};

export function Pill({ children, tone = "neutral", className, title }: { children: ReactNode; tone?: Tone; className?: string; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[0.68rem] font-medium tracking-wide whitespace-nowrap", TONES[tone], className)}>
      {children}
    </span>
  );
}

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const [label, tone] = STATUS[status] ?? [status, "neutral" as Tone];
  return (
    <Pill tone={tone} className={className}>
      {status === "running" && <Loader2 className="h-3 w-3 animate-spin" />}
      {label}
    </Pill>
  );
}

export function Empty({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-[10px] border border-dashed border-line px-6 py-12 text-center text-sm text-text-muted">
      {icon && <div className="text-text-dim [&>svg]:h-6 [&>svg]:w-6">{icon}</div>}
      {children}
    </div>
  );
}

export function Loading({ label = "carregando…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 px-1 py-6 text-sm text-text-muted">
      <Loader2 className="h-4 w-4 animate-spin" /> {label}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error instanceof Error ? error.message : String(error)}</div>;
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label className="text-xs text-text-muted">{label}</Label>
      {children}
      {hint && <p className="text-[0.72rem] leading-snug text-text-dim">{hint}</p>}
    </div>
  );
}

export function JsonView({ value, className, maxHeight = 360 }: { value: unknown; className?: string; maxHeight?: number }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <pre className={cn("overflow-auto rounded-md border border-line bg-ink-950 p-3 font-mono text-[0.72rem] leading-relaxed whitespace-pre-wrap break-words text-text-muted", className)} style={{ maxHeight }}>
      {text}
    </pre>
  );
}

export interface Option {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export function MultiSelect({ options, value, onChange, placeholder = "Selecionar…", disabled }: { options: Option[]; value: string[]; onChange: (v: string[]) => void; placeholder?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const known = new Map(options.map((o) => [o.value, o]));
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" disabled={disabled} className="w-full justify-between font-normal text-text-muted">
            {value.length ? `${value.length} selecionado(s)` : placeholder}
            <ChevronsUpDown className="h-3.5 w-3.5 opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-64 p-0" align="start">
          <Command>
            <CommandInput placeholder="Filtrar…" />
            <CommandList>
              <CommandEmpty>Nada encontrado.</CommandEmpty>
              <CommandGroup>
                {options.map((o) => (
                  <CommandItem key={o.value} value={`${o.label} ${o.value}`} disabled={o.disabled} onSelect={() => toggle(o.value)}>
                    <Check className={cn("h-3.5 w-3.5", value.includes(o.value) ? "opacity-100" : "opacity-0")} />
                    <div className="min-w-0">
                      <div className="truncate text-sm">{o.label}</div>
                      {o.hint && <div className="truncate text-[0.7rem] text-text-dim">{o.hint}</div>}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((v) => (
            <Badge key={v} variant="secondary" className={cn("gap-1 font-normal", !known.has(v) && "border-rose-500/40 text-rose-300")} title={known.has(v) ? undefined : "não existe mais no catálogo"}>
              {known.get(v)?.label ?? v}
              {!disabled && (
                <button type="button" onClick={() => toggle(v)} className="opacity-60 hover:opacity-100" aria-label={`remover ${v}`}>
                  <X className="h-3 w-3" />
                </button>
              )}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

/** Lista de strings editavel (uma por linha). */
export function LinesInput({ value, onChange, placeholder, rows = 4, disabled }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; rows?: number; disabled?: boolean }) {
  const [text, setText] = useState(value.join("\n"));
  return (
    <textarea
      className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      rows={rows}
      value={text}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value.split("\n").map((s) => s.trim()).filter(Boolean));
      }}
    />
  );
}

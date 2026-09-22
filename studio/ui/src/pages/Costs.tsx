import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Calculator, Coins, Cpu, Database, Hash, Receipt } from "lucide-react";
import { api, qs } from "@/lib/api";
import { int, isoDay, usd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Page } from "@/Layout";
import { Empty, ErrorBox, KPI, Loading, PageHeader, Pill } from "@/components/common";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";

type GroupBy = "provider" | "model" | "user" | "flow" | "agent";

interface CostsResponse {
  range: { from: string; to: string };
  kpis: { costUsd: number; calls: number; tokensIn: number; tokensOut: number; runs: number; avgRunCostUsd: number };
  byDay: { day: string; provider: string; cost: number; tokens: number }[];
  byModel: { key: string; cost: number; calls: number }[];
  table: { key: string; calls: number; runs: number; tokensIn: number; tokensOut: number; tokensCache: number; cost: number }[];
  groupBy: GroupBy;
  kb: { available: boolean; costUsd: number; tokens: number; error?: string };
}

const GROUPS: { value: GroupBy; label: string }[] = [
  { value: "provider", label: "Provedor" },
  { value: "model", label: "Modelo" },
  { value: "user", label: "Usuário" },
  { value: "flow", label: "Fluxo" },
  { value: "agent", label: "Agente / especialidade" },
];

const PRESETS = [7, 30, 90];
const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
const daysAgo = (n: number) => isoDay(new Date(Date.now() - (n - 1) * 864e5));
const shortDay = (d: string) => d.slice(8, 10) + "/" + d.slice(5, 7);

export function CostsPage() {
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(isoDay(new Date()));
  const [groupBy, setGroupBy] = useState<GroupBy>("provider");
  const preset = to === isoDay(new Date()) ? PRESETS.find((p) => daysAgo(p) === from) : undefined;

  const q = useQuery({
    queryKey: ["costs", from, to, groupBy],
    queryFn: () => api.get<CostsResponse>(`/costs${qs({ from, to, groupBy })}`),
    placeholderData: (prev) => prev,
  });
  const d = q.data;

  // byDay vem em linhas (dia, provedor, custo): pivoto para uma linha por dia
  // com uma coluna por provedor, preenchendo dias sem uso com zero.
  const { series, providers, config } = useMemo(() => {
    const rows = d?.byDay ?? [];
    const provs = [...new Set(rows.map((r) => r.provider))];
    const keyOf = (p: string) => `p${provs.indexOf(p)}`;
    const days: string[] = [];
    for (let t = new Date(`${from}T12:00:00`); isoDay(t) <= to; t = new Date(t.getTime() + 864e5)) days.push(isoDay(t));
    const map = new Map<string, Record<string, number | string>>(days.map((day) => [day, Object.fromEntries([["day", day], ...provs.map((p) => [keyOf(p), 0])])]));
    for (const r of rows) {
      const row = map.get(r.day) ?? Object.fromEntries([["day", r.day], ...provs.map((p) => [keyOf(p), 0])]);
      row[keyOf(r.provider)] = Number(row[keyOf(r.provider)] ?? 0) + r.cost;
      map.set(r.day, row);
    }
    const cfg: ChartConfig = Object.fromEntries(provs.map((p, i) => [keyOf(p), { label: p, color: COLORS[i % COLORS.length] }]));
    return { series: [...map.values()].sort((a, b) => String(a.day).localeCompare(String(b.day))), providers: provs.map(keyOf), config: cfg };
  }, [d, from, to]);

  const modelConfig: ChartConfig = { cost: { label: "Custo (US$)", color: "var(--chart-1)" } };
  const tableTotal = d?.table.reduce((s, r) => s + r.cost, 0) ?? 0;

  return (
    <Page>
      <PageHeader
        icon={<Receipt />}
        title="Custos"
        description="Quanto os agentes gastaram com modelos de IA no período. O custo do Studio é medido aqui, chamada a chamada, com o preço cadastrado de cada modelo."
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex rounded-md border border-line bg-ink-900 p-0.5">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={() => {
                    setFrom(daysAgo(p));
                    setTo(isoDay(new Date()));
                  }}
                  className={cn("rounded px-2.5 py-1 text-xs font-medium", preset === p ? "bg-ink-700 text-text" : "text-text-muted hover:text-text")}
                >
                  {p} dias
                </button>
              ))}
            </div>
            <Input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className="h-8 w-36 text-xs" aria-label="De" />
            <Input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} className="h-8 w-36 text-xs" aria-label="Até" />
          </div>
        }
      />

      <ErrorBox error={q.error} />
      {q.isLoading && <Loading />}

      {d && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <KPI label="Custo no período" value={usd(d.kpis.costUsd)} hint={`${int(d.kpis.calls)} chamadas a modelos`} icon={<Coins />} />
            <KPI label="Execuções" value={int(d.kpis.runs)} icon={<Hash />} />
            <KPI label="Custo médio / execução" value={usd(d.kpis.avgRunCostUsd)} icon={<Calculator />} />
            <KPI label="Tokens de entrada" value={int(d.kpis.tokensIn)} icon={<Cpu />} />
            <KPI label="Tokens de saída" value={int(d.kpis.tokensOut)} icon={<Cpu />} />
          </div>

          <div className="rounded-[10px] border border-line bg-ink-900 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line bg-ink-800 text-text-muted">
                  <Database className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium">
                    Embeddings da base de conhecimento
                    {d.kb.available ? <Pill tone="ok">medido pela KB</Pill> : <Pill tone="neutral">KB indisponível</Pill>}
                  </div>
                  <p className="mt-1 max-w-2xl text-xs leading-relaxed text-text-muted">
                    A indexação e a busca vetorial rodam na KB, que é outro serviço com o seu próprio registro de uso. Este número é o que a KB informa, não é medido pelo Studio e não entra nos totais acima.
                  </p>
                  {!d.kb.available && d.kb.error && <p className="mt-1 font-mono text-[0.7rem] text-text-dim">{d.kb.error}</p>}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xl font-semibold tabular-nums">{d.kb.available ? usd(d.kb.costUsd) : "—"}</div>
                <div className="text-xs text-text-dim tabular-nums">{d.kb.available ? `${int(d.kb.tokens)} tokens` : "sem dados"}</div>
              </div>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-5">
            <div className="rounded-[10px] border border-line bg-ink-900 p-4 lg:col-span-3">
              <div className="mb-3 text-sm font-medium">Custo por dia, por provedor</div>
              {d.byDay.length === 0 ? (
                <Empty>Nenhum uso no período.</Empty>
              ) : (
                <ChartContainer config={config} className="aspect-auto h-64 w-full">
                  <AreaChart data={series} margin={{ left: 4, right: 8, top: 4 }}>
                    <CartesianGrid vertical={false} stroke="var(--color-line)" />
                    <XAxis dataKey="day" tickFormatter={shortDay} tickLine={false} axisLine={false} minTickGap={24} fontSize={11} />
                    <YAxis tickFormatter={(v: number) => `$${v < 1 ? v.toFixed(2) : v.toFixed(0)}`} tickLine={false} axisLine={false} width={44} fontSize={11} />
                    <ChartTooltip content={<ChartTooltipContent labelFormatter={(l) => shortDay(String(l))} formatter={(v, name) => <span className="flex w-full justify-between gap-3"><span className="text-text-muted">{config[String(name)]?.label}</span><span className="tabular-nums">{usd(Number(v))}</span></span>} />} />
                    <ChartLegend content={<ChartLegendContent />} />
                    {providers.map((k) => (
                      <Area key={k} dataKey={k} type="monotone" stackId="1" stroke={`var(--color-${k})`} fill={`var(--color-${k})`} fillOpacity={0.25} />
                    ))}
                  </AreaChart>
                </ChartContainer>
              )}
            </div>
            <div className="rounded-[10px] border border-line bg-ink-900 p-4 lg:col-span-2">
              <div className="mb-3 text-sm font-medium">Custo por modelo</div>
              {d.byModel.length === 0 ? (
                <Empty>Nenhum uso no período.</Empty>
              ) : (
                <ChartContainer config={modelConfig} className="aspect-auto h-64 w-full">
                  <BarChart data={d.byModel.slice(0, 8)} layout="vertical" margin={{ left: 4, right: 12 }}>
                    <CartesianGrid horizontal={false} stroke="var(--color-line)" />
                    <XAxis type="number" tickFormatter={(v: number) => `$${v < 1 ? v.toFixed(2) : v.toFixed(0)}`} tickLine={false} axisLine={false} fontSize={11} />
                    <YAxis type="category" dataKey="key" width={110} tickLine={false} axisLine={false} fontSize={11} tickFormatter={(s: string) => (s.length > 16 ? s.slice(0, 15) + "…" : s)} />
                    <ChartTooltip content={<ChartTooltipContent formatter={(v) => <span className="tabular-nums">{usd(Number(v))}</span>} />} />
                    <Bar dataKey="cost" fill="var(--color-cost)" radius={3} />
                  </BarChart>
                </ChartContainer>
              )}
            </div>
          </div>

          <div className="rounded-[10px] border border-line bg-ink-900">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
              <div className="text-sm font-medium">Detalhamento</div>
              <div className="flex items-center gap-2">
                  <span className="text-xs text-text-muted">Agrupar por</span>
                  <Select value={groupBy} onValueChange={(v) => setGroupBy(v as GroupBy)}>
                    <SelectTrigger size="sm" className="w-52">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {GROUPS.map((g) => (
                        <SelectItem key={g.value} value={g.value}>
                          {g.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
            </div>
            {d.table.length === 0 ? (
              <div className="p-4">
                <Empty>Nenhum uso no período.</Empty>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">{GROUPS.find((g) => g.value === d.groupBy)?.label}</TableHead>
                    <TableHead className="text-right">Chamadas</TableHead>
                    <TableHead className="text-right">Execuções</TableHead>
                    <TableHead className="text-right">Tokens entrada</TableHead>
                    <TableHead className="text-right">Tokens saída</TableHead>
                    <TableHead className="text-right">Cache</TableHead>
                    <TableHead className="text-right">Custo</TableHead>
                    <TableHead className="w-28 pr-4">%</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.table.map((r) => {
                    const pct = tableTotal ? (r.cost / tableTotal) * 100 : 0;
                    return (
                      <TableRow key={r.key}>
                        <TableCell className="max-w-72 truncate pl-4 font-medium" title={r.key}>
                          {r.key}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{int(r.calls)}</TableCell>
                        <TableCell className="text-right tabular-nums">{int(r.runs)}</TableCell>
                        <TableCell className="text-right tabular-nums">{int(r.tokensIn)}</TableCell>
                        <TableCell className="text-right tabular-nums">{int(r.tokensOut)}</TableCell>
                        <TableCell className="text-right text-text-muted tabular-nums">{int(r.tokensCache)}</TableCell>
                        <TableCell className="text-right font-medium tabular-nums">{usd(r.cost)}</TableCell>
                        <TableCell className="pr-4">
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-700">
                              <div className="h-full bg-[var(--chart-1)]" style={{ width: `${pct}%` }} />
                            </div>
                            <span className="w-9 text-right text-[0.7rem] text-text-dim tabular-nums">{pct.toFixed(0)}%</span>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>
          {q.isFetching && !q.isLoading && <div className="text-xs text-text-dim">atualizando…</div>}
        </>
      )}
    </Page>
  );
}

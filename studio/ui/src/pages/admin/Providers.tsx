import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, BrainCircuit, CheckCircle2, KeyRound, Loader2, Pencil, Plus, Plug, Search, Sparkles, Star, Trash2, XCircle } from "lucide-react";
import { api } from "@/lib/api";
import { int, ms } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import type { DiscoveredModel, Model, Provider } from "@/lib/types";
import { Page } from "@/Layout";
import { Empty, ErrorBox, Field, Loading, PageHeader, Pill } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const KINDS: Record<Provider["kind"], string> = {
  deepseek: "DeepSeek",
  gemini: "Google Gemini",
  openai_compat: "Compatível com OpenAI",
  mock: "Simulado",
};
const PURPOSES: Record<Model["purpose"], string> = { chat: "chat", embedding: "embedding", vision: "visão" };

type TestResult = { ok: boolean; ms: number; model?: string; sample?: string; error?: string };

const price = (n: number) => (n ? `$${n.toLocaleString("pt-BR", { maximumFractionDigits: 4 })}` : "—");

export function ProvidersPage() {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["providers"], queryFn: () => api.get<{ providers: Provider[] }>("/providers").then((r) => r.providers) });
  const [editing, setEditing] = useState<Provider | "new" | null>(null);
  const [importing, setImporting] = useState<Provider | null>(null);

  return (
    <Page>
      <PageHeader
        icon={<BrainCircuit />}
        title="Provedores e modelos"
        description="De onde vêm os modelos de IA que os agentes usam, com as chaves de acesso e o preço por milhão de tokens usado no cálculo de custo. A chave nunca volta da API: só os 4 últimos caracteres."
        actions={
          isAdmin && (
            <Button size="sm" onClick={() => setEditing("new")}>
              <Plus /> Novo provedor
            </Button>
          )
        }
      />
      {!isAdmin && <div className="rounded-md border border-line bg-ink-900 px-3 py-2 text-xs text-text-muted">Somente leitura: apenas administradores alteram provedores, chaves e preços.</div>}
      <ErrorBox error={q.error} />
      {q.isLoading ? (
        <Loading />
      ) : !q.data?.length ? (
        <Empty icon={<BrainCircuit />}>Nenhum provedor cadastrado.</Empty>
      ) : (
        <div className="space-y-4">
          {q.data.map((p) => (
            <ProviderCard key={p.id} p={p} isAdmin={isAdmin} onEdit={() => setEditing(p)} onDiscover={() => setImporting(p)} />
          ))}
        </div>
      )}
      {editing && (
        <ProviderDialog
          provider={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved, created) => {
            qc.invalidateQueries({ queryKey: ["providers"] });
            // Provedor novo com chave: ja mostra o que ele oferece para escolher.
            if (created && (saved.hasKey || saved.kind === "mock")) setImporting({ ...saved, models: [] });
          }}
        />
      )}
      {importing && (
        <ImportModelsDialog
          provider={importing}
          onClose={() => setImporting(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["providers"] });
            qc.invalidateQueries({ queryKey: ["models"] });
          }}
        />
      )}
    </Page>
  );
}

function ProviderCard({ p, isAdmin, onEdit, onDiscover }: { p: Provider; isAdmin: boolean; onEdit: () => void; onDiscover: () => void }) {
  const qc = useQueryClient();
  const [test, setTest] = useState<TestResult | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [modelEdit, setModelEdit] = useState<Model | "new" | null>(null);
  const [modelDel, setModelDel] = useState<Model | null>(null);
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["providers"] });
    qc.invalidateQueries({ queryKey: ["models"] });
  };

  const toggle = useMutation({
    mutationFn: (active: boolean) => api.put(`/providers/${p.id}`, { active }),
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message),
  });
  const testM = useMutation({
    mutationFn: () => api.post<TestResult>(`/providers/${p.id}/test`),
    onMutate: () => setTest(null),
    onSuccess: setTest,
    onError: (e) => setTest({ ok: false, ms: 0, error: e.message }),
  });
  const del = useMutation({
    mutationFn: () => api.del(`/providers/${p.id}`),
    onSuccess: () => {
      toast.success("Provedor excluído");
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const delModel = useMutation({
    mutationFn: (id: string) => api.del(`/models/${id}`),
    onSuccess: () => {
      toast.success("Modelo excluído");
      setModelDel(null);
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const isMock = p.kind === "mock";

  return (
    <div className="rounded-[10px] border border-line bg-ink-900">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{p.name}</span>
            <Pill>{KINDS[p.kind] ?? p.kind}</Pill>
            {!p.active && <Pill tone="neutral">inativo</Pill>}
            {isMock && (
              <Pill tone="info" title="Modelo offline e determinístico, para testes e demonstrações. Não chama nenhuma API e não tem custo.">
                offline · determinístico · custo zero
              </Pill>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
            {p.baseUrl ? <span className="font-mono">{p.baseUrl}</span> : <span className="text-text-dim">endpoint padrão do provedor</span>}
            {isMock ? null : p.hasKey ? (
              <span className="flex items-center gap-1 font-mono">
                <KeyRound className="h-3 w-3" />
                ••••{p.apiKeyTail}
              </span>
            ) : (
              <span className="flex items-center gap-1 text-amber-300">
                <AlertTriangle className="h-3 w-3" /> sem chave
              </span>
            )}
          </div>
          {isMock && <p className="max-w-2xl text-xs text-text-dim">O provedor "Simulado" gera respostas fixas a partir da pergunta, sem rede. Serve para testar fluxos e fazer demonstrações sem gastar nada.</p>}
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <>
              <div className="mr-1 flex items-center gap-2">
                <Switch id={`act-${p.id}`} checked={p.active} disabled={toggle.isPending} onCheckedChange={(v) => toggle.mutate(v)} />
                <Label htmlFor={`act-${p.id}`} className="text-xs text-text-muted">
                  ativo
                </Label>
              </div>
              <Button size="sm" variant="outline" onClick={() => testM.mutate()} disabled={testM.isPending}>
                {testM.isPending ? <Loader2 className="animate-spin" /> : <Plug />} Testar
              </Button>
              <Button size="sm" variant="outline" onClick={onEdit}>
                <Pencil /> Editar
              </Button>
              <Button size="icon-sm" variant="ghost" onClick={() => setConfirmDel(true)} title="Excluir">
                <Trash2 className="text-rose-300" />
              </Button>
            </>
          )}
        </div>
      </div>

      {test && (
        <div className={`flex items-start gap-2 border-b border-line px-4 py-2 text-xs ${test.ok ? "bg-emerald-500/5 text-emerald-200" : "bg-rose-500/5 text-rose-200"}`}>
          {test.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          <div className="min-w-0 break-words">
            {test.ok ? (
              <>
                Conexão ok em {ms(test.ms)}
                {test.model && <> com {test.model}</>}
                {test.sample && <span className="text-text-muted"> · resposta: "{test.sample}"</span>}
              </>
            ) : (
              <>
                Falhou{test.ms ? ` em ${ms(test.ms)}` : ""}: {test.error}
              </>
            )}
          </div>
        </div>
      )}

      <div className="px-1 pb-1">
        {p.models.length === 0 ? (
          <div className="px-3 py-4 text-sm text-text-muted">Nenhum modelo cadastrado.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-3">Modelo</TableHead>
                <TableHead>Finalidade</TableHead>
                <TableHead className="text-right">Entrada / 1M</TableHead>
                <TableHead className="text-right">Saída / 1M</TableHead>
                <TableHead className="text-right">Cache / 1M</TableHead>
                <TableHead className="text-right">Contexto</TableHead>
                <TableHead>Estado</TableHead>
                {isAdmin && <TableHead className="w-20 pr-3" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {p.models.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="pl-3">
                    <div className="flex items-center gap-1.5 font-medium">
                      {m.label}
                      {m.isDefault && (
                        <Pill tone="info" title={`Modelo padrão para ${PURPOSES[m.purpose]}`}>
                          <Star className="h-3 w-3" /> padrão
                        </Pill>
                      )}
                    </div>
                    <div className="font-mono text-[0.7rem] text-text-dim">{m.modelId}</div>
                  </TableCell>
                  <TableCell>
                    <Pill>{PURPOSES[m.purpose] ?? m.purpose}</Pill>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{price(m.priceInPer1m)}</TableCell>
                  <TableCell className="text-right tabular-nums">{price(m.priceOutPer1m)}</TableCell>
                  <TableCell className="text-right tabular-nums">{price(m.priceCachePer1m)}</TableCell>
                  <TableCell className="text-right tabular-nums">{m.contextWindow ? int(m.contextWindow) : "—"}</TableCell>
                  <TableCell>{m.active ? <Pill tone="ok">ativo</Pill> : <Pill>inativo</Pill>}</TableCell>
                  {isAdmin && (
                    <TableCell className="pr-3">
                      <div className="flex justify-end gap-0.5">
                        <Button size="icon-xs" variant="ghost" onClick={() => setModelEdit(m)} title="Editar modelo">
                          <Pencil />
                        </Button>
                        <Button size="icon-xs" variant="ghost" onClick={() => setModelDel(m)} title="Excluir modelo">
                          <Trash2 className="text-rose-300" />
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {isAdmin && (
          <div className="flex gap-1 px-3 py-2">
            <Button size="xs" variant="ghost" onClick={onDiscover} disabled={!p.hasKey && !isMock} title={!p.hasKey && !isMock ? "Cadastre a chave para listar os modelos" : "Lista os modelos que a chave alcança, com preço do catálogo"}>
              <Sparkles /> Detectar modelos
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setModelEdit("new")}>
              <Plus /> Adicionar manualmente
            </Button>
          </div>
        )}
      </div>

      <AlertDialog open={confirmDel} onOpenChange={setConfirmDel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir o provedor "{p.name}"?</AlertDialogTitle>
            <AlertDialogDescription>Os {p.models.length} modelo(s) dele também deixam de existir. Fluxos que usam esses modelos vão falhar na validação até serem ajustados.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => del.mutate()}>
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!modelDel} onOpenChange={(o) => !o && setModelDel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir o modelo "{modelDel?.label}"?</AlertDialogTitle>
            <AlertDialogDescription>O histórico de custos continua, mas fluxos que usam este modelo precisarão escolher outro.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => modelDel && delModel.mutate(modelDel.id)}>
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {modelEdit && <ModelDialog providerId={p.id} model={modelEdit === "new" ? null : modelEdit} onClose={() => setModelEdit(null)} onSaved={invalidate} />}
    </div>
  );
}

function ProviderDialog({ provider, onClose, onSaved }: { provider: Provider | null; onClose: () => void; onSaved: (saved: Provider, created: boolean) => void }) {
  const [name, setName] = useState(provider?.name ?? "");
  const [kind, setKind] = useState<Provider["kind"]>(provider?.kind ?? "deepseek");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { name: name.trim(), kind, baseUrl: baseUrl.trim() };
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      return provider ? api.put<{ provider: Provider }>(`/providers/${provider.id}`, body) : api.post<{ provider: Provider }>("/providers", body);
    },
    onSuccess: (r) => {
      toast.success(provider ? "Provedor atualizado" : "Provedor criado");
      onSaved(r.provider, !provider);
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{provider ? "Editar provedor" : "Novo provedor"}</DialogTitle>
          <DialogDescription>A chave é cifrada no banco e nunca é exibida de novo.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label="Nome">
            <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </Field>
          <Field label="Tipo">
            <Select value={kind} onValueChange={(v) => setKind(v as Provider["kind"])}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(KINDS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Endpoint (base URL)" hint="Vazio usa o endpoint padrão do provedor. Obrigatório para 'Compatível com OpenAI'.">
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.exemplo.com/v1" className="font-mono text-xs" />
          </Field>
          {kind !== "mock" && (
            <Field label="Chave de API" hint={provider?.hasKey ? `Atual termina em ${provider.apiKeyTail}. Deixe vazio para manter a chave atual.` : "Nenhuma chave cadastrada ainda."}>
              <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="new-password" placeholder={provider?.hasKey ? `••••${provider.apiKeyTail}` : ""} />
            </Field>
          )}
          <ErrorBox error={save.error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={!name.trim() || save.isPending}>
              {save.isPending && <Loader2 className="animate-spin" />} Salvar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ModelDialog({ providerId, model, onClose, onSaved }: { providerId: string; model: Model | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    label: model?.label ?? "",
    modelId: model?.modelId ?? "",
    purpose: model?.purpose ?? ("chat" as Model["purpose"]),
    priceInPer1m: String(model?.priceInPer1m ?? 0),
    priceOutPer1m: String(model?.priceOutPer1m ?? 0),
    priceCachePer1m: String(model?.priceCachePer1m ?? 0),
    contextWindow: String(model?.contextWindow ?? 0),
    supportsTools: model?.supportsTools ?? true,
    supportsJson: model?.supportsJson ?? true,
    active: model?.active ?? true,
    isDefault: model?.isDefault ?? false,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const num = (s: string) => Number(s.replace(",", ".")) || 0;
  // Sugestoes para o campo de ID; se a listagem falhar, o campo continua livre.
  const avail = useQuery({
    queryKey: ["available-models", providerId],
    queryFn: () => api.get<{ models: DiscoveredModel[] }>(`/providers/${providerId}/available-models`).then((r) => r.models),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const [priceNote, setPriceNote] = useState<string | null>(null);
  const lookup = useMutation({
    mutationFn: (modelId: string) => api.post<Omit<DiscoveredModel, "modelId" | "label" | "registered">>("/models/price-lookup", { providerId, modelId }),
    onSuccess: (r) => {
      if (r.source !== "catalogo") {
        setPriceNote(r.source === "nenhum" ? "O catálogo não conhece este modelo — preencha o preço à mão." : "Catálogo de preços indisponível (sem acesso à internet?).");
        return;
      }
      setPriceNote("Preço preenchido pelo catálogo do LiteLLM. Confira antes de salvar.");
      setF((s) => ({
        ...s,
        priceInPer1m: String(r.priceInPer1m ?? 0),
        priceOutPer1m: String(r.priceOutPer1m ?? 0),
        priceCachePer1m: String(r.priceCachePer1m ?? 0),
        contextWindow: r.contextWindow ? String(r.contextWindow) : s.contextWindow,
        purpose: r.purpose ?? s.purpose,
        supportsTools: r.supportsTools ?? s.supportsTools,
        supportsJson: r.supportsJson ?? s.supportsJson,
      }));
    },
    onError: (e) => setPriceNote(e.message),
  });
  const pickModel = (id: string) => {
    set("modelId", id);
    const d = avail.data?.find((m) => m.modelId === id);
    if (!d) return;
    if (!f.label.trim()) set("label", d.label);
    if (!model) lookup.mutate(id);
  };
  const save = useMutation({
    mutationFn: () => {
      const body = {
        providerId,
        label: f.label.trim(),
        modelId: f.modelId.trim(),
        purpose: f.purpose,
        priceInPer1m: num(f.priceInPer1m),
        priceOutPer1m: num(f.priceOutPer1m),
        priceCachePer1m: num(f.priceCachePer1m),
        contextWindow: Math.round(num(f.contextWindow)),
        supportsTools: f.supportsTools,
        supportsJson: f.supportsJson,
        active: f.active,
        isDefault: f.isDefault,
      };
      return model ? api.put(`/models/${model.id}`, body) : api.post("/models", body);
    },
    onSuccess: () => {
      toast.success(model ? "Modelo atualizado" : "Modelo criado");
      onSaved();
      onClose();
    },
  });
  const checks: [keyof typeof f, string][] = [
    ["supportsTools", "suporta ferramentas"],
    ["supportsJson", "suporta JSON"],
    ["active", "ativo"],
    ["isDefault", "padrão para a finalidade"],
  ];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{model ? "Editar modelo" : "Novo modelo"}</DialogTitle>
          <DialogDescription>Os preços (US$ por 1 milhão de tokens) são usados para calcular o custo de cada chamada.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nome de exibição">
              <Input value={f.label} onChange={(e) => set("label", e.target.value)} required autoFocus />
            </Field>
            <Field label="ID do modelo no provedor">
              <Input value={f.modelId} onChange={(e) => pickModel(e.target.value)} required className="font-mono text-xs" placeholder="deepseek-chat" list={`avail-${providerId}`} />
              <datalist id={`avail-${providerId}`}>
                {avail.data?.map((m) => (
                  <option key={m.modelId} value={m.modelId}>
                    {m.label}
                  </option>
                ))}
              </datalist>
            </Field>
            <Field label="Finalidade">
              <Select value={f.purpose} onValueChange={(v) => set("purpose", v as Model["purpose"])}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(PURPOSES).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Janela de contexto (tokens)">
              <Input inputMode="numeric" value={f.contextWindow} onChange={(e) => set("contextWindow", e.target.value)} className="tabular-nums" />
            </Field>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" size="xs" variant="outline" onClick={() => lookup.mutate(f.modelId.trim())} disabled={!f.modelId.trim() || lookup.isPending}>
              {lookup.isPending ? <Loader2 className="animate-spin" /> : <Search />} Buscar preço no catálogo
            </Button>
            {priceNote && <span className="text-[0.72rem] text-text-dim">{priceNote}</span>}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Entrada (US$/1M)">
              <Input inputMode="decimal" value={f.priceInPer1m} onChange={(e) => set("priceInPer1m", e.target.value)} className="tabular-nums" />
            </Field>
            <Field label="Saída (US$/1M)">
              <Input inputMode="decimal" value={f.priceOutPer1m} onChange={(e) => set("priceOutPer1m", e.target.value)} className="tabular-nums" />
            </Field>
            <Field label="Cache (US$/1M)">
              <Input inputMode="decimal" value={f.priceCachePer1m} onChange={(e) => set("priceCachePer1m", e.target.value)} className="tabular-nums" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {checks.map(([k, label]) => (
              <label key={k} className="flex items-center gap-2 text-sm text-text-muted">
                <Checkbox checked={f[k] as boolean} onCheckedChange={(v) => set(k, (v === true) as never)} />
                {label}
              </label>
            ))}
          </div>
          <ErrorBox error={save.error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={!f.label.trim() || !f.modelId.trim() || save.isPending}>
              {save.isPending && <Loader2 className="animate-spin" />} Salvar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const priceOrDash = (n: number | null) => (n === null ? "—" : `$${n.toLocaleString("pt-BR", { maximumFractionDigits: 4 })}`);

function ImportModelsDialog({ provider, onClose, onSaved }: { provider: Provider; onClose: () => void; onSaved: () => void }) {
  const q = useQuery({
    queryKey: ["available-models", provider.id],
    queryFn: () => api.get<{ models: DiscoveredModel[]; priceSource: "ok" | "indisponivel" }>(`/providers/${provider.id}/available-models`),
    retry: false,
  });
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [onlyPriced, setOnlyPriced] = useState(false);
  const rows = useMemo(() => {
    const t = filter.trim().toLowerCase();
    return (q.data?.models ?? []).filter((m) => (!t || m.modelId.toLowerCase().includes(t) || m.label.toLowerCase().includes(t)) && (!onlyPriced || m.source === "catalogo"));
  }, [q.data, filter, onlyPriced]);
  const toggle = (id: string, on: boolean) =>
    setPicked((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const save = useMutation({
    mutationFn: () => {
      const models = (q.data?.models ?? [])
        .filter((m) => picked.has(m.modelId) && !m.registered)
        .map((m) => ({
          modelId: m.modelId,
          label: m.label,
          purpose: m.purpose ?? "chat",
          priceInPer1m: m.priceInPer1m ?? 0,
          priceOutPer1m: m.priceOutPer1m ?? 0,
          priceCachePer1m: m.priceCachePer1m ?? 0,
          contextWindow: m.contextWindow ?? 0,
          supportsTools: m.supportsTools ?? m.purpose !== "embedding",
          supportsJson: m.supportsJson ?? m.purpose !== "embedding",
          active: true,
        }));
      return api.post<{ models: Model[] }>(`/providers/${provider.id}/models/import`, { models });
    },
    onSuccess: (r) => {
      toast.success(`${r.models.length} modelo(s) adicionado(s)`);
      onSaved();
      onClose();
    },
  });
  const unpriced = (q.data?.models ?? []).filter((m) => picked.has(m.modelId) && m.source !== "catalogo").length;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Modelos disponíveis em "{provider.name}"</DialogTitle>
          <DialogDescription>
            Lista vinda do próprio provedor com a chave cadastrada. Preço, contexto e finalidade vêm do catálogo do LiteLLM quando ele conhece o modelo. Marque os que quer usar.
          </DialogDescription>
        </DialogHeader>
        <ErrorBox error={q.error} />
        {q.isLoading ? (
          <Loading />
        ) : q.data ? (
          <div className="space-y-2">
            {q.data.priceSource === "indisponivel" && (
              <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
                <AlertTriangle className="h-3.5 w-3.5" /> Catálogo de preços indisponível: os modelos entram com preço zero, ajuste depois.
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrar…" className="h-8 max-w-xs text-xs" autoFocus />
              <label className="flex items-center gap-2 text-xs text-text-muted">
                <Checkbox checked={onlyPriced} onCheckedChange={(v) => setOnlyPriced(v === true)} /> só com preço conhecido
              </label>
              <span className="ml-auto text-xs text-text-dim">
                {rows.length} de {q.data.models.length} · {picked.size} marcado(s)
              </span>
            </div>
            <div className="max-h-[50vh] overflow-auto rounded-md border border-line">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8 pl-3" />
                    <TableHead>Modelo</TableHead>
                    <TableHead>Finalidade</TableHead>
                    <TableHead className="text-right">Entrada / 1M</TableHead>
                    <TableHead className="text-right">Saída / 1M</TableHead>
                    <TableHead className="text-right">Cache / 1M</TableHead>
                    <TableHead className="pr-3 text-right">Contexto</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((m) => (
                    <TableRow key={m.modelId} className={m.registered ? "opacity-50" : "cursor-pointer"} onClick={() => !m.registered && toggle(m.modelId, !picked.has(m.modelId))}>
                      <TableCell className="pl-3" onClick={(e) => e.stopPropagation()}>
                        <Checkbox checked={m.registered || picked.has(m.modelId)} disabled={m.registered} onCheckedChange={(v) => toggle(m.modelId, v === true)} />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5 font-medium">
                          {m.label}
                          {m.registered && <Pill tone="ok">já cadastrado</Pill>}
                        </div>
                        {m.label !== m.modelId && <div className="font-mono text-[0.7rem] text-text-dim">{m.modelId}</div>}
                      </TableCell>
                      <TableCell>{m.purpose ? <Pill>{PURPOSES[m.purpose]}</Pill> : <span className="text-text-dim">—</span>}</TableCell>
                      <TableCell className="text-right tabular-nums">{priceOrDash(m.priceInPer1m)}</TableCell>
                      <TableCell className="text-right tabular-nums">{priceOrDash(m.priceOutPer1m)}</TableCell>
                      <TableCell className="text-right tabular-nums">{priceOrDash(m.priceCachePer1m)}</TableCell>
                      <TableCell className="pr-3 text-right tabular-nums">{m.contextWindow ? int(m.contextWindow) : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {unpriced > 0 && <p className="text-[0.72rem] text-amber-300">{unpriced} modelo(s) marcado(s) sem preço no catálogo entram com custo zero — edite depois para o custo ficar certo.</p>}
          </div>
        ) : null}
        <ErrorBox error={save.error} />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {q.data && !picked.size ? "Fechar" : "Cancelar"}
          </Button>
          <Button onClick={() => save.mutate()} disabled={!picked.size || save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />} Adicionar {picked.size || ""} modelo(s)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

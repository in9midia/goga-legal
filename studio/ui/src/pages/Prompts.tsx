import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { AlertTriangle, FileCode2, MessageSquareText, RotateCcw, Save, Search, Undo2 } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { dateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Page } from "@/Layout";
import { Empty, ErrorBox, Loading, PageHeader, Pill } from "@/components/common";
import { HistoryPanel } from "@/components/capabilities";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

// Textos do motor (API /texts): o que fica fora do prompt de cada no e vale
// para todos os fluxos — formatos de saida, Guarda, Retriagem, avisos e
// respostas padrao. Sem rascunho: salvar vale no proximo turno, em producao.

export interface EngineText {
  key: string;
  title: string;
  description: string;
  group: string;
  kind: "prompt" | "texto";
  vars: { name: string; description: string; required?: boolean }[];
  text: string;
  default: string;
  edited: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

const useTexts = () => useQuery({ queryKey: ["texts"], queryFn: () => api.get<{ texts: EngineText[] }>("/texts").then((r) => r.texts) });

export function PromptsPage() {
  const [params, setParams] = useSearchParams();
  const selected = params.get("key");
  const select = (key: string) => setParams({ key }, { replace: true });
  const [search, setSearch] = useState("");
  const q = useTexts();

  useEffect(() => {
    if (!selected && q.data?.length) select(q.data[0].key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, selected]);

  const groups = useMemo(() => {
    const s = search.trim().toLowerCase();
    const m = new Map<string, EngineText[]>();
    for (const t of q.data ?? []) {
      if (s && !`${t.key} ${t.title} ${t.description} ${t.text}`.toLowerCase().includes(s)) continue;
      m.set(t.group, [...(m.get(t.group) ?? []), t]);
    }
    return [...m];
  }, [q.data, search]);
  const edited = (q.data ?? []).filter((t) => t.edited).length;
  const current = q.data?.find((t) => t.key === selected);

  return (
    <Page>
      <PageHeader
        icon={<FileCode2 />}
        title="Prompts do motor"
        description="Os textos que o motor acrescenta a todos os fluxos, fora do prompt de cada nó: formatos de saída dos agentes, a Guarda, a Retriagem, avisos e respostas padrão. Salvar vale no próximo turno, inclusive em produção. O Assistente também lê e altera estes textos (com aprovação)."
        actions={edited ? <Pill tone="warn">{edited} editado(s)</Pill> : <Pill>todos no padrão</Pill>}
      />
      <div className="relative w-full max-w-xs">
        <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-text-dim" />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar texto…" className="h-8 pl-8 text-sm" />
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <div className="space-y-3 lg:max-h-[calc(100vh-14rem)] lg:overflow-y-auto lg:pr-1">
            {groups.length === 0 && <Empty icon={<MessageSquareText />}>Nenhum texto encontrado.</Empty>}
            {groups.map(([group, items]) => (
              <div key={group}>
                <div className="mb-1 px-1 text-[0.65rem] font-medium tracking-[0.08em] text-text-dim uppercase">{group}</div>
                <div className="space-y-1">
                  {items.map((t) => (
                    <button
                      key={t.key}
                      onClick={() => select(t.key)}
                      className={cn("w-full rounded-md border px-3 py-2 text-left transition-colors", t.key === selected ? "border-line bg-ink-800" : "border-transparent hover:bg-ink-850")}
                    >
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{t.title}</span>
                        {t.edited && <Pill tone="warn" className="ml-auto">editado</Pill>}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[0.68rem] text-text-dim">{t.key}</div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="min-w-0">{current ? <TextDetail key={`${current.key}-${current.updatedAt}`} t={current} /> : <Empty>Selecione um texto.</Empty>}</div>
        </div>
      )}
    </Page>
  );
}

function TextDetail({ t }: { t: EngineText }) {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const [draft, setDraft] = useState(t.text);
  const [confirmReset, setConfirmReset] = useState(false);
  const dirty = draft !== t.text;
  const missing = t.vars.filter((v) => v.required && !new RegExp(`\\{\\{\\s*${v.name}\\s*\\}\\}`).test(draft));

  const done = (msg: string) => {
    toast.success(msg);
    qc.invalidateQueries({ queryKey: ["texts"] });
    qc.invalidateQueries({ queryKey: ["audit"] });
  };
  const save = useMutation({ mutationFn: () => api.put<EngineText>(`/texts/${encodeURIComponent(t.key)}`, { text: draft }), onSuccess: () => done("Texto salvo: vale no próximo turno"), onError: (e) => toast.error(e.message) });
  const reset = useMutation({ mutationFn: () => api.del<EngineText>(`/texts/${encodeURIComponent(t.key)}`), onSuccess: () => done("Padrão restaurado"), onError: (e) => toast.error(e.message) });

  return (
    <div className="rounded-[10px] border border-line bg-ink-900">
      <div className="flex flex-wrap items-start gap-3 border-b border-line px-4 py-3">
        <div className="min-w-[14rem] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">{t.title}</h2>
            <Pill tone={t.kind === "prompt" ? "info" : "neutral"}>{t.kind === "prompt" ? "instrução ao modelo" : "resposta ao usuário"}</Pill>
            {t.edited && <Pill tone="warn">editado</Pill>}
          </div>
          <div className="mt-0.5 text-[0.7rem] text-text-dim">
            <span className="font-mono">{t.key}</span>
            {t.edited && ` · por ${t.updatedBy ?? "—"} em ${dateTime(t.updatedAt)}`}
          </div>
          <p className="mt-2 max-w-3xl text-[0.8rem] leading-relaxed text-text-muted">{t.description}</p>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2">
            {dirty && (
              <Button variant="ghost" size="sm" onClick={() => setDraft(t.text)}>
                <Undo2 /> Descartar
              </Button>
            )}
            <Button variant="outline" size="sm" disabled={!t.edited || reset.isPending} onClick={() => setConfirmReset(true)}>
              <RotateCcw /> Restaurar padrão
            </Button>
            <Button size="sm" disabled={!dirty || !draft.trim() || missing.length > 0 || save.isPending} onClick={() => save.mutate()}>
              <Save /> {save.isPending ? "Salvando…" : "Salvar"}
            </Button>
          </div>
        )}
      </div>

      <Tabs defaultValue="text" className="p-4">
        <TabsList className="w-full justify-start overflow-x-auto [&>button]:flex-none">
          <TabsTrigger value="text">Texto</TabsTrigger>
          <TabsTrigger value="diff">Comparar com o padrão</TabsTrigger>
          <TabsTrigger value="history">Histórico</TabsTrigger>
        </TabsList>
        <TabsContent value="text" className="mt-4 space-y-3">
          {t.vars.length > 0 && (
            <div className="rounded-md border border-line px-3 py-2 text-[0.75rem] text-text-muted">
              <div className="mb-1 font-medium text-text">Variáveis que o motor preenche</div>
              {t.vars.map((v) => (
                <div key={v.name}>
                  <code className="font-mono text-text">{`{{${v.name}}}`}</code> — {v.description}
                  {v.required && <span className="text-amber-300"> (obrigatória)</span>}
                </div>
              ))}
            </div>
          )}
          {missing.length > 0 && (
            <div className="flex items-center gap-1.5 text-[0.75rem] text-rose-300">
              <AlertTriangle className="h-3.5 w-3.5" /> Falta {missing.map((v) => `{{${v.name}}}`).join(", ")}: sem isso o modelo não recebe a informação.
            </div>
          )}
          {t.group === "Formatos de saída" && (
            <p className="text-[0.72rem] text-text-dim">O motor lê os campos do JSON pelo nome: mude a explicação e os critérios, não as chaves.</p>
          )}
          <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} readOnly={!isAdmin} rows={Math.min(30, Math.max(6, draft.split("\n").length + 2))} className="font-mono text-[0.78rem] leading-relaxed" />
          {!isAdmin && <p className="text-[0.72rem] text-text-dim">Só administradores alteram os textos do motor.</p>}
        </TabsContent>
        <TabsContent value="diff" className="mt-4">
          <LineDiff before={t.default} after={draft} />
        </TabsContent>
        <TabsContent value="history" className="mt-4">
          <HistoryPanel entity="engine_text" id={t.key} />
        </TabsContent>
      </Tabs>

      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restaurar o padrão de "{t.title}"?</AlertDialogTitle>
            <AlertDialogDescription>O texto volta ao padrão do código e passa a acompanhar as melhorias dele. Vale no próximo turno; o histórico guarda a versão atual.</AlertDialogDescription>
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

/** Diferenca por linha (LCS): os textos tem dezenas de linhas, nao milhares. */
function LineDiff({ before, after }: { before: string; after: string }) {
  const rows = useMemo(() => {
    const a = before.split("\n");
    const b = after.split("\n");
    const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out: { op: " " | "-" | "+"; line: string }[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) (out.push({ op: " ", line: a[i] }), i++, j++);
      else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: "-", line: a[i++] });
      else out.push({ op: "+", line: b[j++] });
    }
    while (i < a.length) out.push({ op: "-", line: a[i++] });
    while (j < b.length) out.push({ op: "+", line: b[j++] });
    return out;
  }, [before, after]);
  if (before === after) return <Empty>Igual ao padrão do código.</Empty>;
  return (
    <div className="overflow-x-auto rounded-md border border-line font-mono text-[0.74rem] leading-relaxed">
      <div className="border-b border-line px-3 py-1.5 text-[0.68rem] text-text-dim">
        <span className="text-rose-300">− padrão do código</span> · <span className="text-emerald-300">+ texto atual</span>
      </div>
      {rows.map((r, k) => (
        <div key={k} className={cn("px-3 whitespace-pre-wrap", r.op === "-" && "bg-rose-500/10 text-rose-200", r.op === "+" && "bg-emerald-500/10 text-emerald-200", r.op === " " && "text-text-muted")}>
          {r.op} {r.line || " "}
        </div>
      ))}
    </div>
  );
}

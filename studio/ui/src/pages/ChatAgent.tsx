import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, MessagesSquare, RotateCcw, Save } from "lucide-react";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import type { Model } from "@/lib/types";
import { Page } from "@/Layout";
import { ErrorBox, Field, Loading, PageHeader, Pill } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface AgentConfig {
  enabled: boolean;
  modelId: string | null;
}

interface TextView {
  key: string;
  text: string;
  default: string;
  edited: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  description: string;
}

const KEY = "conversa.agente";

export function ChatAgentPage() {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const cfg = useQuery({ queryKey: ["chat-agent"], queryFn: () => api.get<{ agent: AgentConfig }>("/chat-agent").then((r) => r.agent) });
  const models = useQuery({ queryKey: ["models"], queryFn: () => api.get<{ models: (Model & { usable: boolean })[] }>("/models").then((r) => r.models) });
  const prompt = useQuery({ queryKey: ["text", KEY], queryFn: () => api.get<TextView>(`/texts/${KEY}`) });
  const [draft, setDraft] = useState("");
  useEffect(() => {
    if (prompt.data) setDraft(prompt.data.text);
  }, [prompt.data]);

  const saveCfg = useMutation({
    mutationFn: (v: Partial<AgentConfig>) => api.put<{ agent: AgentConfig }>("/chat-agent", v),
    onSuccess: () => {
      toast.success("Agente de conversa atualizado");
      qc.invalidateQueries({ queryKey: ["chat-agent"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const savePrompt = useMutation({
    mutationFn: (text: string | null) => (text === null ? api.del<TextView>(`/texts/${KEY}`) : api.put<TextView>(`/texts/${KEY}`, { text })),
    onSuccess: (_r, text) => {
      toast.success(text === null ? "Prompt restaurado ao padrão" : "Prompt salvo");
      qc.invalidateQueries({ queryKey: ["text", KEY] });
      qc.invalidateQueries({ queryKey: ["texts"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const chatModels = (models.data ?? []).filter((m) => m.purpose === "chat");
  const current = chatModels.find((m) => m.id === cfg.data?.modelId);

  return (
    <Page>
      <PageHeader
        icon={<MessagesSquare />}
        title="Agente de conversa"
        description="Fica na frente do fluxo, no Simulador e no WhatsApp. Responde na hora a toda mensagem e decide: só responder (saudação, “e aí?”), iniciar o fluxo, ou acrescentar o que a pessoa disse à análise que já está rodando. Use um modelo rápido."
      />
      <ErrorBox error={cfg.error ?? models.error ?? prompt.error} />
      {cfg.isLoading || prompt.isLoading ? (
        <Loading />
      ) : (
        <div className="grid gap-4">
          <div className="rounded-[10px] border border-line bg-ink-900 p-4">
            <div className="flex flex-wrap items-end gap-6">
              <div className="flex items-center gap-2">
                <Switch id="agent-on" checked={!!cfg.data?.enabled} disabled={!isAdmin || saveCfg.isPending} onCheckedChange={(v) => saveCfg.mutate({ enabled: v })} />
                <Label htmlFor="agent-on">{cfg.data?.enabled ? "Ligado" : "Desligado"}</Label>
              </div>
              <Field label="Modelo" className="min-w-72">
                <Select value={cfg.data?.modelId ?? ""} onValueChange={(v) => saveCfg.mutate({ modelId: v })} disabled={!isAdmin || saveCfg.isPending}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Escolha um modelo de chat" />
                  </SelectTrigger>
                  <SelectContent>
                    {chatModels.map((m) => (
                      <SelectItem key={m.id} value={m.id} disabled={!m.usable}>
                        {m.label} · {m.providerName}
                        {!m.usable ? " (inativo)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {current && !current.usable && <Pill tone="bad">modelo inativo: o agente cai no fluxo direto</Pill>}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-text-muted">
              Desligado (ou com falha do modelo), tudo volta ao jeito antigo: cada mensagem vai direto ao fluxo e, com um turno rodando, espera ele acabar. Comandos do WhatsApp (/nova, /limpar, /cancelar, /ajuda) não passam pelo agente.
            </p>
          </div>

          <div className="rounded-[10px] border border-line bg-ink-900 p-4">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">Prompt</span>
              {prompt.data?.edited ? <Pill tone="info">editado</Pill> : <Pill>padrão</Pill>}
              {prompt.data?.updatedAt && (
                <span className="text-xs text-text-dim">
                  {prompt.data.updatedBy} · {dateTime(prompt.data.updatedAt)}
                </span>
              )}
              <div className="ml-auto flex gap-1.5">
                {prompt.data?.edited && (
                  <Button size="sm" variant="ghost" disabled={!isAdmin || savePrompt.isPending} onClick={() => savePrompt.mutate(null)}>
                    <RotateCcw /> Restaurar padrão
                  </Button>
                )}
                <Button size="sm" disabled={!isAdmin || savePrompt.isPending || draft === prompt.data?.text || !draft.trim()} onClick={() => savePrompt.mutate(draft)}>
                  {savePrompt.isPending ? <Loader2 className="animate-spin" /> : <Save />} Salvar
                </Button>
              </div>
            </div>
            <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} readOnly={!isAdmin} rows={22} className="font-mono text-xs leading-relaxed" />
            <p className="mt-2 text-xs text-text-dim">
              O Studio acrescenta ao fim a conversa recente, se há análise rodando (e o que já foi acrescentado), as opções da última pergunta e a mensagem atual, e pede o JSON com <code>acao</code> (responder | fluxo), <code>resposta</code> e <code>contexto</code>. Vale na hora para a produção.
            </p>
          </div>
        </div>
      )}
    </Page>
  );
}

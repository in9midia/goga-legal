import { useEffect } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Loader2, MessageSquarePlus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { dateTime, usd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useAssistant, useAssistantConversation, useAssistantModel, type ASession } from "@/lib/assistant";
import { ChatPanel, ModelSelect } from "@/components/assistant/Chat";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";

export function AssistantPage() {
  const { sessionId } = useParams();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const a = useAssistant();
  const sessions = useQuery({ queryKey: ["assistant-sessions"], queryFn: () => api.get<{ sessions: ASession[] }>("/assistant/sessions").then((r) => r.sessions) });
  const { detail, messages, running } = useAssistantConversation(sessionId);
  const { models, modelId, model, choose } = useAssistantModel(sessionId, detail.data?.session.modelId);

  // A conversa aberta aqui e a que o painel lateral mostra nas outras telas.
  const { setDock } = a;
  useEffect(() => {
    if (sessionId) setDock({ sessionId });
  }, [sessionId, setDock]);

  // ?q= (atalho "analisar com o assistente") vira rascunho de uma conversa nova.
  useEffect(() => {
    const q = params.get("q");
    if (!q) return;
    localStorage.setItem("assistant-draft:new", JSON.stringify({ text: q, pending: [] }));
    setParams({}, { replace: true });
    if (sessionId) nav("/assistant");
    else window.dispatchEvent(new CustomEvent("assistant:prefill", { detail: q }));
  }, [params, setParams, sessionId, nav]);

  const ensureSession = async () => {
    if (sessionId) return sessionId;
    const r = await api.post<{ session: ASession }>("/assistant/sessions", { modelId });
    qc.invalidateQueries({ queryKey: ["assistant-sessions"] });
    nav(`/assistant/${r.session.id}`, { replace: true });
    return r.session.id;
  };

  const cost = messages.reduce((acc, m) => acc + (m.costUsd ?? 0), 0);
  return (
    <div className="h-full">
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel defaultSize="20%" minSize="14%" maxSize="32%">
          <SessionList
            sessions={sessions.data ?? []}
            current={sessionId}
            live={a.live}
            onNew={() => nav("/assistant")}
            onDeleted={(id) => {
              qc.invalidateQueries({ queryKey: ["assistant-sessions"] });
              if (id === sessionId) nav("/assistant");
            }}
          />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize="80%">
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
              <Bot className="h-4 w-4 text-text-muted" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{detail.data?.session.title ?? "Assistente do Studio"}</div>
                <div className="text-[0.68rem] text-text-dim">
                  Ajusta fluxos, modelos, skills, MCP e catálogos; analisa histórico, conversas e auditoria. Continua trabalhando se você mudar de tela.{cost > 0 && ` · ${usd(cost)} nesta conversa`}
                </div>
              </div>
              <ModelSelect models={models} value={modelId} onChange={choose} disabled={running} />
            </div>
            <ChatPanel sid={sessionId ?? null} ensureSession={ensureSession} modelId={modelId} model={model} />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

function SessionList({ sessions, current, live, onNew, onDeleted }: { sessions: ASession[]; current?: string; live: Record<string, { running: boolean }>; onNew: () => void; onDeleted: (id: string) => void }) {
  const del = useMutation({ mutationFn: (id: string) => api.del(`/assistant/sessions/${id}`), onSuccess: (_, id) => onDeleted(id) });
  return (
    <div className="flex h-full flex-col border-r border-line bg-ink-900/40">
      <div className="border-b border-line p-3">
        <Button size="sm" className="w-full" onClick={onNew}>
          <MessageSquarePlus className="h-4 w-4" /> Nova conversa
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        {sessions.length === 0 && <p className="p-2 text-xs text-text-dim">Nenhuma conversa ainda.</p>}
        {sessions.map((s) => (
          <div key={s.id} className={cn("group flex items-center rounded-md", s.id === current ? "bg-ink-800" : "hover:bg-ink-850")}>
            <Link to={`/assistant/${s.id}`} className="min-w-0 flex-1 px-2.5 py-2">
              <div className="flex items-center gap-1.5 truncate text-[0.8rem]">{live[s.id]?.running && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-blue-300" />}<span className="truncate">{s.title}</span></div>
              <div className="truncate text-[0.66rem] text-text-dim">{dateTime(s.updatedAt)}</div>
            </Link>
            <button className="mr-1 hidden rounded p-1 text-text-dim group-hover:block hover:text-rose-300" title="Excluir conversa" onClick={() => del.mutate(s.id)}>
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}


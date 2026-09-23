import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, Loader2, Maximize2, MessageSquarePlus, X } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useAssistant, useAssistantConversation, useAssistantModel, type ASession } from "@/lib/assistant";
import { ChatPanel, ModelSelect } from "@/components/assistant/Chat";
import { Button } from "@/components/ui/button";

// Painel lateral do Assistente, presente em todas as telas (menos a propria
// /assistant). Nao e modal: da para ver o fluxo mudando no editor enquanto o
// assistente trabalha. Mostra a ultima conversa aberta.
export function AssistantDock() {
  const { pathname } = useLocation();
  const a = useAssistant();
  const qc = useQueryClient();
  const sid = a.dock.sessionId;
  const { detail, running } = useAssistantConversation(sid);
  const { models, modelId, model, choose } = useAssistantModel(sid, detail.data?.session.modelId);
  const anyRunning = Object.values(a.live).some((l) => l.running);

  // Conversa apagada (ou de outro usuario, depois de trocar de login): esquece.
  const { setDock } = a;
  useEffect(() => {
    if (sid && detail.isError) setDock({ sessionId: null });
  }, [sid, detail.isError, setDock]);
  if (pathname.startsWith("/assistant")) return null;

  const ensureSession = async () => {
    if (sid) return sid;
    const r = await api.post<{ session: ASession }>("/assistant/sessions", { modelId });
    qc.invalidateQueries({ queryKey: ["assistant-sessions"] });
    a.setDock({ sessionId: r.session.id });
    return r.session.id;
  };

  if (!a.dock.open) {
    return (
      <button
        onClick={() => a.setDock({ open: true })}
        title="Abrir o assistente"
        className="fixed right-5 bottom-5 z-40 flex h-11 items-center gap-2 rounded-full border border-line bg-ink-800 px-4 text-sm font-medium shadow-lg shadow-black/40 transition-colors hover:border-ink-500 hover:bg-ink-700"
      >
        {anyRunning ? <Loader2 className="h-4 w-4 animate-spin text-blue-300" /> : <Bot className="h-4 w-4" />}
        {anyRunning ? "Assistente trabalhando…" : "Assistente"}
      </button>
    );
  }

  return (
    <aside className="fixed top-0 right-0 z-40 flex h-full w-[min(460px,100vw)] flex-col border-l border-line bg-ink-950 shadow-2xl shadow-black/60">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Bot className="h-4 w-4 shrink-0 text-text-muted" />
        <div className="min-w-0 flex-1 truncate text-sm font-medium">{detail.data?.session.title ?? "Nova conversa"}</div>
        {running && <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-300" />}
        <Button variant="ghost" size="icon" className="h-7 w-7" title="Nova conversa" disabled={running} onClick={() => a.setDock({ sessionId: null })}>
          <MessageSquarePlus className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" title="Abrir em tela cheia" asChild>
          <Link to={sid ? `/assistant/${sid}` : "/assistant"}>
            <Maximize2 className="h-3.5 w-3.5" />
          </Link>
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" title="Fechar (o assistente continua trabalhando)" onClick={() => a.setDock({ open: false })}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className={cn("border-b border-line px-3 py-1.5")}>
        <ModelSelect models={models} value={modelId} onChange={choose} disabled={running} className="h-7 w-full text-xs" />
      </div>
      <ChatPanel sid={sid} ensureSession={ensureSession} modelId={modelId} model={model} compact />
    </aside>
  );
}

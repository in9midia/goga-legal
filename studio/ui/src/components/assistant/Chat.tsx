import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Bot, FileText, Loader2, Paperclip, Send, Square, X } from "lucide-react";
import { toast } from "sonner";
import { api, fileUrl } from "@/lib/api";
import { bytes, dateTime, usd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { LIVE_ID, useAssistant, useAssistantConversation, type AFile, type AMessage, type AModel, type Resolution, type TurnBody } from "@/lib/assistant";
import { Markdown } from "@/components/assistant/Markdown";
import { ApprovalCard, AskCard, DisplayPart, ToolCard } from "@/components/assistant/parts";
import { CopyButton } from "@/components/transcript";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";

// Conversa do Assistente (lista de mensagens + caixa de envio), usada pela
// pagina /assistant e pelo painel lateral que acompanha as outras telas.

const SUGGESTIONS = [
  "Faça um panorama do Studio e aponte riscos de configuração nos fluxos.",
  "Analise a última execução com erro e proponha correções concretas.",
  "O que mudou nos fluxos e catálogos nos últimos 7 dias? Use a auditoria.",
  "Revise o prompt e os limiares do Classificador do fluxo em produção.",
  "Crie um rascunho a partir da produção para eu testar ajustes com segurança.",
  "Mostre um gráfico do custo por agente nos últimos 30 dias.",
];


/** Conversa + envio de uma sessao. `ensureSession` cria a conversa no primeiro envio. */
export function ChatPanel({ sid, ensureSession, modelId, model, compact }: { sid: string | null; ensureSession: () => Promise<string | null>; modelId: string | null; model?: AModel; compact?: boolean }) {
  const a = useAssistant();
  const { messages, files, running } = useAssistantConversation(sid);
  const turn = async (body: TurnBody) => {
    if (running) return;
    if (!modelId) return void toast.error("Nenhum modelo de chat utilizável. Cadastre uma chave em Provedores e modelos.");
    const id = await ensureSession().catch((e) => {
      toast.error((e as Error).message);
      return null;
    });
    if (id) await a.send(id, { modelId, ...body });
  };
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  return (
    <>
      <Conversation messages={messages} files={files} running={running} lastAssistantId={lastAssistant?.id} onResolve={(r) => turn({ resolutions: [r] })} onSuggestion={(s) => turn({ content: s })} model={model} compact={compact} />
      <Composer key={sid ?? "new"} draftKey={sid ?? "new"} running={running} vision={!!model?.vision} onStop={() => sid && a.stop(sid)} onFiles={a.addFiles} onSend={(content, fileIds) => turn({ content, fileIds })} disabled={!modelId} />
    </>
  );
}

export function ModelSelect({ models, value, onChange, disabled, className }: { models: AModel[]; value: string | null; onChange: (id: string) => void; disabled?: boolean; className?: string }) {
  const groups = [...new Set(models.map((m) => m.providerName))];
  return (
    <Select value={value ?? ""} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger size="sm" className={cn("w-64", className)}>
        <SelectValue placeholder="Escolha o modelo" />
      </SelectTrigger>
      <SelectContent>
        {groups.map((g) => (
          <SelectGroup key={g}>
            <SelectLabel>{g}</SelectLabel>
            {models
              .filter((m) => m.providerName === g)
              .map((m) => (
                <SelectItem key={m.id} value={m.id} disabled={!m.usable}>
                  <span className="truncate">{m.label}</span>
                  <span className="ml-1 text-[0.66rem] text-text-dim">
                    {!m.usable ? "sem chave/inativo" : [m.vision && "visão", !m.supportsTools && "sem tools", m.priceInPer1m ? `$${m.priceInPer1m}/${m.priceOutPer1m} por 1M` : null].filter(Boolean).join(" · ")}
                  </span>
                </SelectItem>
              ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

function Conversation({
  messages,
  files,
  running,
  lastAssistantId,
  onResolve,
  onSuggestion,
  model,
  compact,
}: {
  messages: AMessage[];
  files: Map<string, AFile>;
  running: boolean;
  lastAssistantId?: string;
  onResolve: (r: Resolution) => void;
  onSuggestion: (s: string) => void;
  model?: AModel;
  compact?: boolean;
}) {
  const bottom = useRef<HTMLDivElement>(null);
  const tail = messages[messages.length - 1];
  const tailPart = tail?.parts[tail.parts.length - 1] as { text?: string } | undefined;
  const tailSize = (tail?.parts.length ?? 0) * 1e6 + (tailPart?.text?.length ?? 0);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length, tailSize]);

  if (!messages.length) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 overflow-y-auto p-6">
        <div className="text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-line bg-ink-850">
            <Bot className="h-5 w-5 text-text-muted" />
          </div>
          <div className="text-sm font-medium">Como posso refinar o Goga hoje?</div>
          <p className="mt-1 max-w-md text-xs text-text-muted">
            Eu leio e altero fluxos, nós, modelos, skills, MCP, especialidades e modelos de documento, e analiso histórico, conversas do simulador, lotes e auditoria. Publicar em produção e excluir sempre pedem sua aprovação.
          </p>
          {model?.providerKind === "mock" && <p className="mt-2 text-xs text-amber-300">Modelo simulado: bom para ver a tela funcionando, mas não raciocina. Escolha um modelo real para trabalhar.</p>}
        </div>
        <div className={cn("grid w-full max-w-2xl gap-2", !compact && "sm:grid-cols-2")}>
          {SUGGESTIONS.map((s) => (
            <button key={s} disabled={running} onClick={() => onSuggestion(s)} className="rounded-lg border border-line bg-ink-900 px-3 py-2.5 text-left text-xs text-text-muted transition-colors hover:border-ink-500 hover:text-text">
              {s}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className={cn("mx-auto w-full max-w-3xl space-y-5", compact ? "px-3 py-4" : "px-5 py-5")}>
        {messages.map((m) =>
          m.role === "user" ? (
            <UserBubble key={m.id} m={m} files={files} />
          ) : (
            <AssistantMessage key={m.id} m={m} live={m.id === LIVE_ID || m.status === "running"} active={!running && m.id === lastAssistantId} onResolve={onResolve} />
          ),
        )}
        <div ref={bottom} />
      </div>
    </div>
  );
}

function UserBubble({ m, files }: { m: AMessage; files: Map<string, AFile> }) {
  return (
    <div className="group flex flex-col items-end gap-1.5">
      {m.attachments.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {m.attachments.map((id) => (
            <Attachment key={id} f={files.get(id) ?? { id, name: "arquivo", mime: "", size: 0 }} />
          ))}
        </div>
      )}
      {m.content && <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-ink-800 px-3.5 py-2 text-[0.86rem] whitespace-pre-wrap">{m.content}</div>}
      <div className="opacity-0 transition-opacity group-hover:opacity-100">
        <CopyButton text={m.content} title="Copiar mensagem" />
      </div>
    </div>
  );
}

function Attachment({ f, onRemove }: { f: AFile; onRemove?: () => void }) {
  const isImage = f.mime.startsWith("image/");
  return (
    <div className="relative flex items-center gap-2 rounded-md border border-line bg-ink-850 p-1.5 pr-2.5 text-xs" title={f.warning ?? `${f.extractedChars ?? "?"} caracteres extraídos`}>
      {isImage ? (
        <a href={fileUrl(f.id, true)} target="_blank" rel="noreferrer">
          <img src={fileUrl(f.id, true)} alt={f.name} className="h-10 w-10 rounded object-cover" />
        </a>
      ) : (
        <FileText className="h-4 w-4 text-text-muted" />
      )}
      <div className="min-w-0">
        <a href={fileUrl(f.id, true)} target="_blank" rel="noreferrer" className="block max-w-40 truncate hover:underline">
          {f.name}
        </a>
        {f.size > 0 && <div className="text-[0.62rem] text-text-dim">{bytes(f.size)}{f.warning && " · aviso"}</div>}
      </div>
      {f.warning && <AlertTriangle className="h-3 w-3 text-amber-300" />}
      {onRemove && (
        <button onClick={onRemove} className="text-text-dim hover:text-text" title="Remover">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function AssistantMessage({ m, live, active, onResolve }: { m: AMessage; live: boolean; active: boolean; onResolve: (r: Resolution) => void }) {
  const text = m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n\n");
  return (
    <div className="group flex gap-3">
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line bg-ink-850">
        <Bot className="h-3.5 w-3.5 text-text-muted" />
      </div>
      <div className="min-w-0 flex-1">
        {m.parts.map((p, i) => {
          switch (p.type) {
            case "text":
              return <Markdown key={i} text={p.text} />;
            case "tool":
              return <ToolCard key={p.id} part={p} />;
            case "ask":
              return <AskCard key={p.id} part={p} active={active} onAnswer={(resposta) => onResolve({ id: p.id, resposta })} />;
            case "approval":
              return <ApprovalCard key={p.id} part={p} active={active} onDecide={(aprovado) => onResolve({ id: p.id, aprovado })} />;
            case "display":
              return <DisplayPart key={p.id} input={p.input} />;
            case "error":
              return (
                <div key={i} className="my-2 flex items-center gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-300">
                  <AlertTriangle className="h-3.5 w-3.5" /> {p.text}
                </div>
              );
          }
        })}
        {live && (
          <div className="mt-1 flex items-center gap-2 text-xs text-text-dim">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {m.parts.some((p) => p.type === "tool" && p.status === "running") ? "executando ferramenta…" : "pensando…"}
          </div>
        )}
        {!live && (
          <div className="mt-1 flex items-center gap-2 text-[0.66rem] text-text-dim opacity-0 transition-opacity group-hover:opacity-100">
            {text && <CopyButton text={text} title="Copiar resposta" />}
            {m.costUsd > 0 && <span>{usd(m.costUsd)}</span>}
            {(m.tokensIn > 0 || m.tokensOut > 0) && <span>{m.tokensIn.toLocaleString("pt-BR")} in / {m.tokensOut.toLocaleString("pt-BR")} out</span>}
            <span>{dateTime(m.createdAt)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function Composer({
  draftKey,
  running,
  vision,
  disabled,
  onStop,
  onFiles,
  onSend,
}: {
  draftKey: string;
  running: boolean;
  vision: boolean;
  disabled: boolean;
  onStop: () => void;
  onFiles: (f: AFile[]) => void;
  onSend: (content: string, fileIds: string[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  // Rascunho (texto e anexos ainda nao enviados) sobrevive a troca de tela e a recarga.
  const storageKey = `assistant-draft:${draftKey}`;
  const saved = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? "null") as { text: string; pending: AFile[] } | null;
    } catch {
      return null;
    }
  }, [storageKey]);
  const [text, setText] = useState(saved?.text ?? "");
  const [pending, setPending] = useState<AFile[]>(saved?.pending ?? []);
  useEffect(() => {
    if (text || pending.length) localStorage.setItem(storageKey, JSON.stringify({ text, pending }));
    else localStorage.removeItem(storageKey);
  }, [storageKey, text, pending]);
  // ?q= (atalho "analisar com o assistente") chega como evento para preencher a caixa.
  useEffect(() => {
    const h = (e: Event) => {
      setText((e as CustomEvent<string>).detail);
      area.current?.focus();
    };
    window.addEventListener("assistant:prefill", h);
    return () => window.removeEventListener("assistant:prefill", h);
  }, []);
  const [uploading, setUploading] = useState(0);
  const [drag, setDrag] = useState(false);

  const upload = async (list: FileList | File[]) => {
    for (const f of Array.from(list)) {
      setUploading((n) => n + 1);
      try {
        const r = await api.upload<{ file: AFile }>("/assistant/files", f);
        setPending((p) => [...p, r.file]);
        onFiles([r.file]);
        if (r.file.warning) toast.warning(`${r.file.name}: ${r.file.warning}`);
      } catch (e) {
        toast.error(`${f.name}: ${(e as Error).message}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const canSend = !running && !uploading && !disabled && (!!text.trim() || pending.length > 0);
  const send = () => {
    if (!canSend) return;
    onSend(text, pending.map((f) => f.id));
    setText("");
    setPending([]);
  };

  const hasImage = useMemo(() => pending.some((f) => f.mime.startsWith("image/")), [pending]);

  return (
    <div
      className={cn("border-t border-line p-3", drag && "bg-blue-500/5")}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
      }}
    >
      <div className="mx-auto max-w-3xl">
        {(pending.length > 0 || uploading > 0) && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {pending.map((f) => (
              <Attachment key={f.id} f={f} onRemove={() => setPending((p) => p.filter((x) => x.id !== f.id))} />
            ))}
            {uploading > 0 && (
              <div className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-2 text-xs text-text-muted">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> enviando e extraindo texto…
              </div>
            )}
          </div>
        )}
        {hasImage && !vision && <div className="mb-1.5 text-[0.68rem] text-text-dim">Este modelo não vê imagens: ele recebe o texto extraído delas (OCR pelo modelo de visão padrão).</div>}
        <div className="flex items-end gap-2 rounded-xl border border-line bg-ink-900 p-2 focus-within:border-ink-500">
          <input ref={input} type="file" multiple hidden accept=".pdf,.docx,.txt,.md,.csv,.json,.yaml,.yml,image/*" onChange={(e) => e.target.files && upload(e.target.files).then(() => (e.target.value = ""))} />
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" title="Anexar arquivos (ou arraste, ou cole uma imagem)" onClick={() => input.current?.click()}>
            <Paperclip className="h-4 w-4" />
          </Button>
          <Textarea
            ref={area}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const fs = Array.from(e.clipboardData.files);
              if (fs.length) {
                e.preventDefault();
                void upload(fs.map((f, i) => (f.name === "image.png" ? new File([f], `colado-${Date.now()}-${i}.png`, { type: f.type }) : f)));
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={disabled ? "Nenhum modelo utilizável — cadastre uma chave em Provedores e modelos." : "Peça um ajuste, uma análise ou cole um texto… (Enter envia, Shift+Enter quebra linha)"}
            className="max-h-60 min-h-9 resize-none border-0 bg-transparent px-1 py-1.5 text-[0.86rem] shadow-none focus-visible:ring-0"
            rows={1}
          />
          {running ? (
            <Button size="icon" variant="outline" className="h-8 w-8 shrink-0" title="Parar" onClick={onStop}>
              <Square className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button size="icon" className="h-8 w-8 shrink-0" title="Enviar" disabled={!canSend} onClick={send}>
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

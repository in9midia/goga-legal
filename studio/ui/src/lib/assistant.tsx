import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import type { Part } from "@/components/assistant/parts";

// Estado do Assistente que vive ACIMA das telas. O turno roda no servidor e
// os eventos chegam por um stream que este provider segue: trocar de tela nao
// interrompe nada, e ao voltar (ou recarregar a pagina) o stream e retomado do
// inicio. O banco e a fonte da verdade; aqui fica so o que ainda esta em curso.

export interface AModel {
  id: string;
  label: string;
  providerName: string;
  providerKind: string;
  isDefault: boolean;
  supportsTools: boolean;
  vision: boolean;
  usable: boolean;
  priceInPer1m: number;
  priceOutPer1m: number;
}
export interface ASession {
  id: string;
  title: string;
  modelId: string | null;
  updatedAt: string;
}
export interface AMessage {
  id: string;
  role: "user" | "assistant";
  /** "running" = resposta sendo escrita (gravada aos poucos no servidor). */
  status?: "running" | "done";
  content: string;
  parts: Part[];
  attachments: string[];
  modelId: string | null;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  createdAt: string;
}
export interface AFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  extractedChars?: number;
  warning?: string;
}
export interface Detail {
  session: ASession;
  messages: AMessage[];
  files: AFile[];
  busy: boolean;
}
export type Resolution = { id: string; resposta?: string[]; aprovado?: boolean };
export type TurnBody = { content?: string; fileIds?: string[]; resolutions?: Resolution[]; modelId?: string | null };

type TurnEvent =
  | { type: "user"; message: AMessage }
  | { type: "resolved"; messageId: string; parts: Part[] }
  | { type: "text"; text: string }
  | { type: "part"; part: Part }
  | { type: "done"; message: AMessage }
  | { type: "error"; error: string }
  | { type: "idle" };

interface LiveState {
  running: boolean;
  user?: AMessage;
  parts: Part[];
  resolved: Record<string, Part[]>;
  final?: AMessage;
}

export const LIVE_ID = "__live__";

// Ferramentas que mudam dados de outras telas: ao terminarem, as outras telas recarregam.
const MUTATING = new Set(["criar_fluxo", "editar_fluxo", "testar_fluxo", "salvar_modelo_llm", "salvar_skill", "importar_skill", "salvar_mcp", "testar_mcp", "salvar_especialidade", "salvar_modelo_documento"]);

interface Ctx {
  live: Record<string, LiveState>;
  files: Map<string, AFile>;
  addFiles: (f: AFile[]) => void;
  send: (sid: string, body: TurnBody) => Promise<void>;
  follow: (sid: string) => void;
  stop: (sid: string) => void;
  dock: { open: boolean; sessionId: string | null };
  setDock: (d: Partial<{ open: boolean; sessionId: string | null }>) => void;
}

const AssistantCtx = createContext<Ctx | null>(null);

const readDock = () => {
  try {
    return { open: false, sessionId: null, ...JSON.parse(localStorage.getItem("assistant-dock") ?? "{}") };
  } catch {
    return { open: false, sessionId: null };
  }
};

export function AssistantProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const location = useLocation();
  const [live, setLive] = useState<Record<string, LiveState>>({});
  const [files, setFiles] = useState<Map<string, AFile>>(new Map());
  const [dock, setDockState] = useState<{ open: boolean; sessionId: string | null }>(readDock);
  const following = useRef(new Set<string>());
  const where = useRef({ path: location.pathname, dock });
  where.current = { path: location.pathname, dock };

  const setDock = useCallback((d: Partial<{ open: boolean; sessionId: string | null }>) => {
    setDockState((cur) => {
      const next = { ...cur, ...d };
      localStorage.setItem("assistant-dock", JSON.stringify(next));
      return next;
    });
  }, []);

  const patch = useCallback((sid: string, fn: (s: LiveState) => LiveState) => {
    setLive((all) => ({ ...all, [sid]: fn(all[sid] ?? { running: true, parts: [], resolved: {} }) }));
  }, []);

  const refreshOthers = useCallback(() => qc.invalidateQueries({ predicate: (q) => !String(q.queryKey[0]).startsWith("assistant") }), [qc]);

  const follow = useCallback(
    (sid: string) => {
      if (following.current.has(sid)) return;
      following.current.add(sid);
      patch(sid, (s) => ({ ...s, running: true }));
      let lastParts: Part[] = [];
      let hadError = false;
      void (async () => {
        try {
          const res = await fetch(`/api/v1/assistant/sessions/${sid}/stream`, { credentials: "include" });
          if (!res.ok || !res.body) throw new ApiError(res.status, `HTTP ${res.status}`);
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) continue;
              const e = JSON.parse(line) as TurnEvent;
              if (e.type === "text") {
                if (!e.text) continue;
                patch(sid, (s) => {
                  const tail = s.parts[s.parts.length - 1];
                  const parts: Part[] = tail?.type === "text" ? [...s.parts.slice(0, -1), { type: "text", text: tail.text + e.text }] : [...s.parts, { type: "text", text: e.text }];
                  lastParts = parts;
                  return { ...s, parts };
                });
              } else if (e.type === "part") {
                patch(sid, (s) => {
                  const id = "id" in e.part ? e.part.id : null;
                  const i = id ? s.parts.findIndex((p) => "id" in p && p.id === id) : -1;
                  const parts = i >= 0 ? s.parts.map((p, j) => (j === i ? e.part : p)) : [...s.parts, e.part];
                  lastParts = parts;
                  return { ...s, parts };
                });
                if (e.part.type === "tool" && e.part.status === "ok" && MUTATING.has(e.part.name)) void refreshOthers();
              } else if (e.type === "user") {
                patch(sid, (s) => ({ ...s, user: e.message }));
              } else if (e.type === "resolved") {
                patch(sid, (s) => ({ ...s, resolved: { ...s.resolved, [e.messageId]: e.parts } }));
                if (e.parts.some((p) => p.type === "approval" && p.status === "approved")) void refreshOthers();
              } else if (e.type === "done") {
                lastParts = e.message.parts;
                patch(sid, (s) => ({ ...s, final: e.message, running: false }));
              } else if (e.type === "error") {
                hadError = true;
                toast.error(`Assistente: ${e.error}`);
              }
            }
          }
        } catch (err) {
          hadError = true;
          toast.error(`Assistente: ${(err as Error).message}`);
        } finally {
          following.current.delete(sid);
          await Promise.all([qc.invalidateQueries({ queryKey: ["assistant-session", sid] }), qc.invalidateQueries({ queryKey: ["assistant-sessions"] })]);
          setLive((all) => {
            const { [sid]: _gone, ...rest } = all;
            return rest;
          });
          // Aviso so para quem nao esta olhando esta conversa.
          const { path, dock: d } = where.current;
          const watching = path === `/assistant/${sid}` || (d.open && d.sessionId === sid && !path.startsWith("/assistant"));
          if (!watching && !hadError && lastParts.length) {
            const waiting = lastParts.some((p) => (p.type === "ask" || p.type === "approval") && p.status === "pending");
            toast(waiting ? "O assistente está aguardando sua resposta" : "O assistente terminou", {
              action: { label: "Abrir", onClick: () => nav(`/assistant/${sid}`) },
              duration: 10_000,
            });
          }
        }
      })();
    },
    [patch, qc, nav, refreshOthers],
  );

  const send = useCallback(
    async (sid: string, body: TurnBody) => {
      setLive((all) => ({ ...all, [sid]: { running: true, parts: [], resolved: {} } }));
      try {
        await api.post(`/assistant/sessions/${sid}/turn`, body);
      } catch (e) {
        // 409 = ja havia turno em curso (outra aba): segue esse.
        if (!(e instanceof ApiError && e.status === 409)) {
          toast.error((e as Error).message);
          setLive(({ [sid]: _gone, ...rest }) => rest);
          return;
        }
      }
      follow(sid);
    },
    [follow],
  );

  const stop = useCallback((sid: string) => void api.post(`/assistant/sessions/${sid}/stop`).catch((e) => toast.error((e as Error).message)), []);
  const addFiles = useCallback((fs: AFile[]) => setFiles((m) => new Map([...m, ...fs.map((f) => [f.id, f] as const)])), []);

  const value = useMemo(() => ({ live, files, addFiles, send, follow, stop, dock, setDock }), [live, files, addFiles, send, follow, stop, dock, setDock]);
  return <AssistantCtx.Provider value={value}>{children}</AssistantCtx.Provider>;
}

export function useAssistant() {
  const c = useContext(AssistantCtx);
  if (!c) throw new Error("useAssistant fora do AssistantProvider");
  return c;
}

/** Mensagens da conversa = banco + o que ainda esta em curso; retoma o stream se o turno estiver rodando. */
export function useAssistantConversation(sid: string | null | undefined) {
  const a = useAssistant();
  const detail = useQuery({ queryKey: ["assistant-session", sid], queryFn: () => api.get<Detail>(`/assistant/sessions/${sid}`), enabled: !!sid });
  const { follow } = a;
  useEffect(() => {
    if (sid && detail.data?.busy) follow(sid);
  }, [sid, detail.data?.busy, follow]);

  const l = sid ? a.live[sid] : undefined;
  const messages = useMemo(() => {
    // Com o stream em maos, a resposta em curso vem dele (mais atual que a copia gravada).
    let ms = (detail.data?.messages ?? []).filter((m) => !(l && m.status === "running")).map((m) => (l?.resolved[m.id] ? { ...m, parts: l.resolved[m.id] } : m));
    if (l?.user && !ms.some((m) => m.id === l.user!.id)) ms = [...ms, l.user];
    const tail: AMessage | null = l?.final ?? (l ? { id: LIVE_ID, role: "assistant", content: "", parts: l.parts, attachments: [], modelId: null, costUsd: 0, tokensIn: 0, tokensOut: 0, createdAt: new Date().toISOString() } : null);
    if (tail && !ms.some((m) => m.id === tail.id)) ms = [...ms, tail];
    return ms;
  }, [detail.data?.messages, l]);

  const files = useMemo(() => new Map([...a.files, ...(detail.data?.files ?? []).map((f) => [f.id, f] as const)]), [a.files, detail.data?.files]);
  return { detail, messages, files, running: !!l?.running };
}

/** Modelo da conversa, ou (conversa nova) o ultimo escolhido / o padrao utilizavel. */
export function useAssistantModel(sid: string | null | undefined, sessionModelId: string | null | undefined) {
  const qc = useQueryClient();
  const models = useQuery({ queryKey: ["assistant-models"], queryFn: () => api.get<{ models: AModel[] }>("/assistant/models").then((r) => r.models), staleTime: 60_000 });
  const [draft, setDraft] = useState<string | null>(() => localStorage.getItem("assistant-model"));
  const usable = (models.data ?? []).filter((m) => m.usable);
  const fallback = usable.find((m) => m.id === draft)?.id ?? usable.find((m) => m.isDefault)?.id ?? usable[0]?.id ?? null;
  const modelId = sessionModelId ?? fallback;
  const choose = async (id: string) => {
    setDraft(id);
    localStorage.setItem("assistant-model", id);
    if (sid) {
      await api.put(`/assistant/sessions/${sid}`, { modelId: id });
      qc.invalidateQueries({ queryKey: ["assistant-session", sid] });
    }
  };
  return { models: models.data ?? [], modelsLoaded: !!models.data, modelId, model: models.data?.find((m) => m.id === modelId), choose };
}

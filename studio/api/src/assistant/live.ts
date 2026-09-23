import { EventEmitter } from "node:events";
import type { TurnEvent } from "./agent.js";

// Turno do Assistente desacoplado da conexao HTTP: roda em segundo plano e
// guarda os eventos em memoria. Quem abrir o stream (a mesma aba depois de
// trocar de tela, outra aba, a pagina recarregada) recebe tudo desde o inicio
// e segue ao vivo. Fechar a conexao nao aborta o turno; so o "Parar" aborta.
// Depois do fim, o estado final ja esta no banco: o buffer fica mais um pouco
// so para quem se reconectar no meio da troca.

const KEEP_AFTER_DONE_MS = 60_000;

export interface LiveTurn {
  events: TurnEvent[];
  emitter: EventEmitter;
  done: boolean;
  abort: AbortController;
  startedAt: number;
}

const turns = new Map<string, LiveTurn>();

export const liveTurn = (sessionId: string) => turns.get(sessionId);
export const isBusy = (sessionId: string) => !!turns.get(sessionId) && !turns.get(sessionId)!.done;

export function startLiveTurn(sessionId: string, run: (emit: (e: TurnEvent) => void, signal: AbortSignal) => Promise<void>): LiveTurn {
  const t: LiveTurn = { events: [], emitter: new EventEmitter(), done: false, abort: new AbortController(), startedAt: Date.now() };
  t.emitter.setMaxListeners(50);
  turns.set(sessionId, t);
  const emit = (e: TurnEvent) => {
    // Deltas de texto seguidos viram um evento so no buffer: um turno longo
    // tem milhares deles e a reconexao reproduziria cada um.
    const last = t.events[t.events.length - 1];
    if (e.type === "text" && last?.type === "text") last.text += e.text;
    else t.events.push(e.type === "text" ? { ...e } : e);
    t.emitter.emit("event", e);
  };
  void run(emit, t.abort.signal)
    .catch((err: Error) => emit({ type: "error", error: err.message }))
    .finally(() => {
      t.done = true;
      t.emitter.emit("end");
      setTimeout(() => {
        if (turns.get(sessionId) === t) turns.delete(sessionId);
      }, KEEP_AFTER_DONE_MS).unref();
    });
  return t;
}

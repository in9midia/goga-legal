import { useEffect, useState } from "react";
import type { RunEvent, SpanRecord } from "@/lib/types";

/** Assina o SSE de uma execucao e acumula os spans (start e end do mesmo id se fundem). */
export function useRunStream(runId: string | null, onDone?: (status: string) => void) {
  const [spans, setSpans] = useState<Record<string, SpanRecord>>({});
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    setSpans({});
    setStatus(null);
    if (!runId) return;
    const es = new EventSource(`/api/v1/runs/${runId}/stream`, { withCredentials: true });
    const onSpan = (ev: MessageEvent) => {
      const e = JSON.parse(ev.data) as RunEvent;
      if (e.type === "span.start" || e.type === "span.end") setSpans((m) => ({ ...m, [e.span.id]: e.span }));
    };
    es.addEventListener("span.start", onSpan);
    es.addEventListener("span.end", onSpan);
    es.addEventListener("done", (ev) => {
      const e = JSON.parse((ev as MessageEvent).data) as RunEvent;
      if (e.type === "done") {
        setStatus(e.status);
        onDone?.(e.status);
      }
      es.close();
    });
    es.onerror = () => {
      // O servidor fecha o stream ao terminar; o navegador tentaria reconectar
      // e reproduzir tudo de novo.
      es.close();
    };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  return { spans: Object.values(spans).sort((a, b) => a.seq - b.seq), status };
}

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Hourglass, Inbox, Loader2, X } from 'lucide-react';
import { kb } from '../lib/api';
import { fmtBytes, fmtMs, fmtNumber, fmtWhen } from '../lib/format';
import {
  Button,
  Card,
  ErrorBox,
  EstadoVazio,
  Metric,
  Metrics,
  PageHeader,
  Pill,
  Spinner,
} from '../components/Ui';
import type { QueueRun } from '../lib/types';

/**
 * A fila de ingestão da instalação inteira: o que o servidor processa agora, o
 * que espera a vez, e o que acabou de sair — com a etapa e o percentual de cada
 * documento, e o log do que foi feito nele.
 *
 * POR QUE UMA TELA PRÓPRIA, E NÃO SÓ O LOG DA BASE
 *
 * A fila é uma só para todas as bases: o servidor processa um arquivo por vez,
 * venha de onde vier. O log dentro da base mostra só aquela base, e dez livros
 * enviados para `cdc` atrás de três enviados para `juridico` pareciam parados
 * sem motivo. Aqui aparece a fila inteira, na ordem em que o worker vai pegar.
 *
 * O PERCENTUAL É DE TRABALHO FEITO
 *
 * Sai de lotes de página do docling, lotes de embedding e trechos do grafo, não
 * de tempo decorrido. Um livro pode ficar minutos em "extraindo texto 23%" —
 * isso é o lote de 40 páginas em curso, e o detalhe ao lado diz qual.
 */

const ROTULO_ETAPA: Record<string, string> = {
  fila: 'na fila',
  iniciado: 'iniciando',
  extracao: 'extraindo texto',
  corte: 'cortando em trechos',
  embedding: 'gerando embeddings',
  gravacao: 'gravando',
  grafo: 'extraindo grafo',
  wiki: 'destilando wiki',
  concluido: 'concluído',
  falhou: 'falhou',
  cancelado: 'cancelado',
};

function rotuloDoStatus(run: QueueRun): {
  texto: string;
  tom: 'good' | 'bad' | 'warn' | 'neutral';
} {
  switch (run.status) {
    case 'indexed':
      return { texto: 'indexado', tom: 'good' };
    case 'skipped':
      return { texto: 'já indexado', tom: 'neutral' };
    case 'failed':
      return { texto: 'falhou', tom: 'bad' };
    case 'cancelled':
      return { texto: 'cancelado', tom: 'neutral' };
    case 'running':
      return { texto: 'processando', tom: 'warn' };
    default:
      return { texto: 'na fila', tom: 'neutral' };
  }
}

export function QueuePage() {
  const cliente = useQueryClient();
  const [aberto, setAberto] = useState<number | null>(null);
  const fila = useQuery({
    queryKey: ['ingest-queue'],
    queryFn: () => kb.ingestQueue(40),
    // Com trabalho em curso, 2 s: o percentual precisa parecer vivo. Parada,
    // 15 s basta para notar um envio vindo de outra aba ou de um script.
    refetchInterval: (q) => ((q.state.data?.active.length ?? 0) > 0 ? 2_000 : 15_000),
  });
  const cancelar = useMutation({
    mutationFn: kb.cancelIngestRun,
    onSettled: () => cliente.invalidateQueries({ queryKey: ['ingest-queue'] }),
  });

  if (fila.isLoading) return <Spinner label="Lendo a fila…" />;
  if (fila.error) return <ErrorBox>{(fila.error as Error).message}</ErrorBox>;
  if (!fila.data) return null;

  const { active, recent, counts_24h: contagem } = fila.data;
  const rodando = active.filter((r) => r.status === 'running');
  const esperando = active.filter((r) => r.status === 'queued');
  const alternar = (id: number) => setAberto((atual) => (atual === id ? null : id));

  return (
    <>
      <PageHeader title="Fila de ingestão">
        Todo arquivo enviado entra aqui e é processado <strong>um por vez</strong>, de todas as
        bases. Abra um documento para ver o log do que foi feito nele.
      </PageHeader>

      <Card className="mb-4 px-5 py-4">
        <Metrics>
          <Metric value={fmtNumber(rodando.length)} label="processando" />
          <Metric value={fmtNumber(esperando.length)} label="na fila" />
          <Metric value={fmtNumber(contagem.indexed ?? 0)} label="indexados · 24h" />
          <Metric value={fmtNumber(contagem.failed ?? 0)} label="falhas · 24h" />
        </Metrics>
      </Card>

      {cancelar.error ? <ErrorBox>{(cancelar.error as Error).message}</ErrorBox> : null}

      {/* ── em processamento ───────────────────────────────────────────── */}
      <Secao titulo="Em processamento">
        {rodando.length === 0 ? (
          <Card>
            <EstadoVazio icone={Inbox} titulo="Nada sendo processado agora">
              {esperando.length
                ? 'Há arquivos na fila; o próximo começa em instantes.'
                : 'Envie documentos pela tela de uma base e eles aparecem aqui.'}
            </EstadoVazio>
          </Card>
        ) : (
          rodando.map((run) => (
            <Card key={run.id} className="mb-2 px-5 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <Loader2 size={14} className="animate-spin text-amber" />
                <strong className="min-w-0 flex-1 break-words text-[14px]">{run.filename}</strong>
                <code className="text-[12px] text-text-dim">{run.space}</code>
                {run.attempts > 1 ? (
                  <Pill tone="warn" title="o serviço caiu com este arquivo e ele foi retomado">
                    tentativa {run.attempts}
                  </Pill>
                ) : null}
              </div>
              <Progresso run={run} />
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-text-muted">
                <span>{fmtBytes(run.size_bytes)}</span>
                <span>rodando há {fmtMs(run.total_ms)}</span>
                <button
                  type="button"
                  onClick={() => alternar(run.id)}
                  className="ml-auto inline-flex items-center gap-1 text-text-dim hover:text-text"
                >
                  {aberto === run.id ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  log
                </button>
              </div>
              {aberto === run.id ? <Log runId={run.id} vivo /> : null}
            </Card>
          ))
        )}
      </Secao>

      {/* ── na fila ─────────────────────────────────────────────────────── */}
      <Secao titulo={`Na fila${esperando.length ? ` (${esperando.length})` : ''}`}>
        {esperando.length === 0 ? (
          <p className="px-1 text-[13px] text-text-dim">Fila vazia.</p>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <tbody>
                {esperando.map((run) => (
                  <tr key={run.id} className="border-b border-line-soft last:border-0">
                    <td className="w-10 px-4 py-2.5 text-right tabular-nums text-text-dim">
                      {run.position}º
                    </td>
                    <td className="max-w-[26rem] px-2 py-2.5 font-semibold break-words">
                      {run.filename}
                      {run.attempts > 0 ? (
                        <span className="ml-2">
                          <Pill tone="warn">retomado</Pill>
                        </span>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <code className="text-text-dim">{run.space}</code>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right text-text-muted">
                      {fmtBytes(run.size_bytes)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-text-dim">
                      <Hourglass size={12} className="mr-1 inline" />
                      {fmtWhen(run.queued_at ?? run.started_at)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Button onClick={() => cancelar.mutate(run.id)} disabled={cancelar.isPending}>
                        <X size={13} /> tirar da fila
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </Secao>

      {/* ── recentes ────────────────────────────────────────────────────── */}
      <Secao titulo="Concluídos recentemente">
        {recent.length === 0 ? (
          <p className="px-1 text-[13px] text-text-dim">Nada processado ainda.</p>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-[11px] uppercase tracking-wider text-text-dim">
                  <th className="px-4 py-2.5 text-left font-semibold">Arquivo</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Base</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Resultado</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Chegou a</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Tempo</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Quando</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {recent.map((run) => {
                  const { texto, tom } = rotuloDoStatus(run);
                  return (
                    <RecenteRow
                      key={run.id}
                      run={run}
                      texto={texto}
                      tom={tom}
                      aberto={aberto === run.id}
                      alternar={() => alternar(run.id)}
                    />
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}
      </Secao>
    </>
  );
}

function Secao({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-text-dim">
        {titulo}
      </h3>
      {children}
    </section>
  );
}

function Progresso({ run }: { run: QueueRun }) {
  const pct = Math.max(0, Math.min(100, run.progress));
  return (
    <div className="mt-3">
      <div className="mb-1 flex flex-wrap items-baseline gap-2 text-[12.5px]">
        <strong className="text-amber">
          {ROTULO_ETAPA[run.stage] ?? (run.stage || 'iniciando')}
        </strong>
        <span className="min-w-0 flex-1 truncate text-text-muted" title={run.stage_detail}>
          {run.stage_detail}
        </span>
        <span className="mono tabular-nums text-text">{pct.toFixed(0)}%</span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-ink-800"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full bg-amber transition-[width] duration-700"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function RecenteRow({
  run,
  texto,
  tom,
  aberto,
  alternar,
}: {
  run: QueueRun;
  texto: string;
  tom: 'good' | 'bad' | 'warn' | 'neutral';
  aberto: boolean;
  alternar: () => void;
}) {
  return (
    <>
      <tr className={aberto ? '' : 'border-b border-line-soft last:border-0'}>
        <td className="max-w-[22rem] px-4 py-2.5 font-semibold break-words">{run.filename}</td>
        <td className="whitespace-nowrap px-4 py-2.5">
          <code className="text-text-dim">{run.space}</code>
        </td>
        <td className="whitespace-nowrap px-4 py-2.5">
          <Pill tone={tom}>{texto}</Pill>
          {run.status === 'indexed' ? (
            <span className="ml-2 text-text-muted">
              {run.children} trechos{run.pages ? ` · ${run.pages} pág.` : ''}
            </span>
          ) : null}
        </td>
        {/* Numa falha, ATÉ ONDE chegou é o que diz onde olhar: 3% é a extração,
            60% é o embedding (quase sempre cota do provedor). */}
        <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-text-muted">
          {run.status === 'failed'
            ? `${run.progress.toFixed(0)}% · ${ROTULO_ETAPA[run.stage] ?? run.stage}`
            : `${run.progress.toFixed(0)}%`}
        </td>
        <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">
          {fmtMs(run.total_ms)}
        </td>
        <td className="whitespace-nowrap px-4 py-2.5 text-text-dim">
          {fmtWhen(run.finished_at ?? run.started_at)}
        </td>
        <td className="px-4 py-2.5 text-right">
          <button
            type="button"
            onClick={alternar}
            className="inline-flex items-center gap-1 text-[12px] text-text-dim hover:text-text"
          >
            {aberto ? <ChevronUp size={13} /> : <ChevronDown size={13} />} log
          </button>
        </td>
      </tr>
      {aberto ? (
        <tr className="border-b border-line-soft last:border-0">
          <td colSpan={7} className="px-4 pb-3">
            {run.error ? (
              <pre className="mb-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-rose/40 bg-rose/5 px-3 py-2 text-[11.5px] leading-relaxed text-rose">
                {run.error}
              </pre>
            ) : null}
            <Log runId={run.id} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** O log do documento: cada troca de etapa e cada marco, na ordem. */
function Log({ runId, vivo = false }: { runId: number; vivo?: boolean }) {
  const eventos = useQuery({
    queryKey: ['ingest-events', runId],
    queryFn: () => kb.ingestRunEvents(runId),
    refetchInterval: vivo ? 2_000 : false,
  });
  if (eventos.isLoading) return <Spinner label="Lendo o log…" />;
  if (eventos.error) return <ErrorBox>{(eventos.error as Error).message}</ErrorBox>;
  const lista = eventos.data?.events ?? [];
  if (!lista.length) {
    return (
      <p className="mt-2 text-[12px] text-text-dim">
        Sem log detalhado (execução anterior à fila de ingestão).
      </p>
    );
  }
  return (
    <ol className="mt-3 max-h-80 overflow-auto rounded-lg border border-line bg-ink-950 px-3 py-2 font-mono text-[11.5px] leading-relaxed">
      {lista.map((ev, i) => (
        <li key={i} className="flex gap-3">
          <span className="shrink-0 text-text-dim">
            {new Date(ev.at).toLocaleTimeString('pt-BR')}
          </span>
          <span
            className={`w-40 shrink-0 whitespace-nowrap ${
              ev.stage === 'falhou'
                ? 'text-rose'
                : ev.stage === 'concluido'
                  ? 'text-emerald'
                  : 'text-amber'
            }`}
          >
            {ROTULO_ETAPA[ev.stage] ?? ev.stage}
          </span>
          <span className="w-10 shrink-0 text-right tabular-nums text-text-dim">
            {ev.progress !== null ? `${ev.progress.toFixed(0)}%` : ''}
          </span>
          <span className="min-w-0 break-words text-text-muted">{ev.message}</span>
        </li>
      ))}
    </ol>
  );
}

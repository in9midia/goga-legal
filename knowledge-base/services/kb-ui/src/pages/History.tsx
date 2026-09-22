import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronUp, ListChecks, Search } from 'lucide-react';
import { kb } from '../lib/api';
import { fmtMs, fmtScore, fmtWhen } from '../lib/format';
import { StageList } from '../components/StageList';
import {
  Button,
  Card,
  Empty,
  ErrorBox,
  EstadoVazio,
  PageHeader,
  Pill,
  Spinner,
} from '../components/Ui';
import type { SearchRun } from '../lib/types';

export function HistoryPage() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery({ queryKey: ['runs'], queryFn: () => kb.runs(60) });
  const [open, setOpen] = useState<number | null>(null);

  if (isLoading) return <Spinner label="Lendo o histórico…" />;
  if (error) return <ErrorBox>{(error as Error).message}</ErrorBox>;
  if (!data) return null;

  return (
    <>
      <PageHeader title="Histórico de perguntas">
        Toda busca fica registrada com a pergunta, o que a base devolveu, o tempo e o custo —{' '}
        {data.scope === 'todas' ? (
          <>
            você vê <strong>todas</strong> porque seu grupo é de administração.
          </>
        ) : (
          <>
            você vê <strong>apenas as suas</strong>. A pergunta em si revela o que a pessoa
            procurava, então o log não é público.
          </>
        )}
      </PageHeader>

      {data.runs.length === 0 ? (
        <Card>
          <EstadoVazio
            icone={ListChecks}
            titulo="Nenhuma busca registrada ainda"
            acao={
              <Button variant="primary" onClick={() => navigate('/buscar')}>
                <Search size={14} /> Abrir o Simulador
              </Button>
            }
          >
            Cada pergunta feita aqui ou pelo editor entra nesta lista, com o tempo de cada braço e
            os trechos que voltaram.
          </EstadoVazio>
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-wider text-text-dim">
                <th className="px-4 py-2.5 text-left font-semibold">Quando</th>
                <th className="px-4 py-2.5 text-left font-semibold">Pergunta</th>
                <th className="px-4 py-2.5 text-left font-semibold">Espaços</th>
                <th className="px-4 py-2.5 text-left font-semibold">Origem</th>
                <th className="px-4 py-2.5 text-right font-semibold">Trechos</th>
                <th className="px-4 py-2.5 text-right font-semibold">Tempo</th>
                <th className="px-4 py-2.5 text-right font-semibold">Tokens</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {data.runs.map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  open={open === run.id}
                  onToggle={() => setOpen(open === run.id ? null : run.id)}
                />
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

function RunRow({ run, open, onToggle }: { run: SearchRun; open: boolean; onToggle: () => void }) {
  const navigate = useNavigate();
  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer border-b border-line-soft transition-colors hover:bg-ink-850"
      >
        <td className="mono px-4 py-2.5 text-text-dim">{fmtWhen(run.created_at)}</td>
        <td className="px-4 py-2.5 font-semibold">{run.query}</td>
        <td className="px-4 py-2.5">
          <code className="text-text-dim">{(run.spaces ?? []).join(', ') || 'todos'}</code>
        </td>
        <td className="px-4 py-2.5">
          <Pill>{run.surface}</Pill>
        </td>
        <td className="px-4 py-2.5 text-right tabular-nums">{run.result_count}</td>
        <td className="px-4 py-2.5 text-right tabular-nums">{fmtMs(run.total_ms)}</td>
        <td className="px-4 py-2.5 text-right tabular-nums">{run.embed_tokens}</td>
        <td className="px-4 py-2.5 text-text-dim">
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </td>
      </tr>
      {open ? (
        <tr className="border-b border-line-soft bg-ink-950/40">
          <td colSpan={8} className="px-4 py-4">
            <StageList stages={run.stages} />
            {run.results.length === 0 ? (
              <Empty>
                Esta busca não devolveu trecho nenhum
                {run.surface === 'mcp' ? ' — ou é anterior ao registro dos trechos.' : '.'}
              </Empty>
            ) : (
              <div className="mt-3.5 grid gap-2.5">
                {run.results.map((result, index) => (
                  <div key={index} className="border-l-2 border-line pl-3">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <Pill>#{index + 1}</Pill>
                      <strong className="text-[13px]">{result.title || result.filename}</strong>
                      <span className="mono whitespace-nowrap text-[11.5px] text-text-dim">
                        RRF {fmtScore(result.score, 5)} · vet {fmtScore(result.vector_score, 4)} ·
                        lex {fmtScore(result.lexical_score, 4)}
                      </span>
                      {result.page ? <Pill>pág. {result.page}</Pill> : null}
                      {result.document_id ? (
                        <span className="ml-auto">
                          <Button
                            onClick={() =>
                              navigate(
                                `/documentos?espaco=${result.space}&doc=${result.document_id}` +
                                  (result.page ? `&pagina=${result.page}` : '') +
                                  `&trecho=${encodeURIComponent((result.excerpt || '').slice(0, 400))}`,
                              )
                            }
                          >
                            Ver documento
                          </Button>
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 text-[12.5px] text-text-muted">{result.excerpt}</div>
                  </div>
                ))}
              </div>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}

import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  BookText,
  FileSearch,
  FileText,
  Search as SearchIcon,
  SearchX,
  Wand2,
} from 'lucide-react';
import { kb } from '../lib/api';
import { fmtMs, fmtScore } from '../lib/format';
import { StageList } from '../components/StageList';
import {
  Button,
  Card,
  EstadoVazio,
  ErrorBox,
  Field,
  Metric,
  Metrics,
  PageHeader,
  Pill,
  ScoreBar,
  Spinner,
  inputClass,
} from '../components/Ui';
import type { SearchOutcome } from '../lib/types';

export function SearchPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const spacesQuery = useQuery({ queryKey: ['spaces'], queryFn: kb.spaces });
  const spaces = spacesQuery.data?.spaces ?? [];

  // `?q=` chega de outra tela — do grafo, ao clicar num nó. Sem ler daqui, a
  // navegação caía numa busca vazia e quem clicou tinha de redigitar o nome que
  // acabou de clicar.
  const [query, setQuery] = useState(params.get('q') ?? 'como solicitar férias');
  const [space, setSpace] = useState(params.get('espaco') ?? '');
  const [topK, setTopK] = useState(8);
  // O slot de melhoria de query (BUS-02). A especificação diz que é justamente
  // o simulador que "liga e desliga para medir" — aqui dá para ver a diferença
  // de resultado E de custo lado a lado, que é o que decide se vale ligar.
  const [melhorar, setMelhorar] = useState(false);

  const search = useMutation<SearchOutcome, Error>({
    mutationFn: () =>
      kb.search({
        query: query.trim(),
        top_k: topK,
        ...(space ? { spaces: [space] } : {}),
        ...(melhorar ? { rewrite: 'rewrite', query_embedding: 'hyde' } : {}),
      }),
  });

  // Busca automática quando a pergunta veio na URL: quem clicou num nó do grafo
  // já disse o que queria, e pedir para clicar em "Buscar" de novo seria pedir
  // duas vezes a mesma coisa.
  const daUrl = params.get('q');
  useEffect(() => {
    if (daUrl) search.mutate();
    // Só na chegada: sem a lista de dependências vazia, cada render dispararia
    // uma busca nova.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daUrl]);

  const outcome = search.data;
  const max = Math.max(...(outcome?.results ?? []).map((r) => r.score), 0.0001);

  return (
    <>
      <PageHeader title="Simulador de recuperação">
        A mesma busca que os agentes de IA fazem pelo MCP, com os scores e o custo à vista. Devolve{' '}
        <strong>evidência</strong>, não resposta pronta.
      </PageHeader>

      <Card className="mb-4 px-5 py-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (query.trim()) search.mutate();
          }}
        >
          <div className="min-w-[16rem] flex-[3]">
            <Field label="Pergunta">
              <input
                className={inputClass}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="como solicitar férias"
              />
            </Field>
          </div>
          <div className="min-w-[11rem] flex-1">
            <Field label="Espaço">
              <select
                className={inputClass}
                value={space}
                onChange={(event) => setSpace(event.target.value)}
              >
                <option value="">todos os permitidos</option>
                {spaces.map((s) => (
                  <option key={s.slug} value={s.slug}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="w-[6.5rem]">
            <Field label="Trechos">
              <input
                className={inputClass}
                type="number"
                min={1}
                max={50}
                value={topK}
                onChange={(event) => setTopK(Number(event.target.value) || 8)}
              />
            </Field>
          </div>
          <Button variant="primary" type="submit" disabled={search.isPending}>
            <SearchIcon size={14} /> Buscar
          </Button>
        </form>

        {/* O custo fica escrito ao lado do interruptor. Sem o número, ligar
            "para garantir" é o comportamento natural — e aí toda busca passa a
            levar nove segundos, inclusive as que já iam bem. */}
        <label className="mt-3 flex cursor-pointer flex-wrap items-center gap-2 border-t border-line-soft pt-3 text-[12.5px]">
          <input
            type="checkbox"
            checked={melhorar}
            onChange={(e) => setMelhorar(e.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--accent)]"
          />
          <Wand2 size={13} className={melhorar ? 'text-accent' : 'text-text-dim'} />
          <span className={melhorar ? 'font-semibold' : ''}>
            Melhorar a pergunta antes de buscar
          </span>
          <span className="text-text-dim">
            reescreve no vocabulário da documentação e usa HyDE · ~9 s contra ~0,4 s
          </span>
        </label>
        {melhorar ? (
          <p className="mt-1.5 text-[11.5px] text-text-muted">
            Medido numa base de 275 manuais, sobre perguntas escritas com as palavras de quem
            pergunta: a busca crua achava o documento certo em 7 de 16 casos, com a melhoria em 11.
            Compare o resultado e o tempo com e sem — a etapa aparece no rastro abaixo.
          </p>
        ) : null}
      </Card>

      {search.isPending ? <Spinner label="Buscando…" /> : null}
      {search.error ? <ErrorBox>{search.error.message}</ErrorBox> : null}

      {outcome ? (
        <>
          <Card className="mb-3.5 px-5 py-4">
            <Metrics>
              <Metric value={outcome.results.length} label="trechos" />
              <Metric value={fmtMs(outcome.telemetry.total_ms)} label="tempo" />
              <Metric value={outcome.telemetry.embed_tokens} label="tokens" />
              <Metric value={`#${outcome.telemetry.run_id ?? '—'}`} label="execução" />
            </Metrics>
            <div className="mt-3.5 border-t border-line-soft pt-3.5">
              <StageList stages={outcome.telemetry.stages} />
            </div>
          </Card>

          {outcome.results.length === 0 ? (
            <Card>
              <EstadoVazio icone={SearchX} titulo="Nada encontrado no escopo permitido">
                Os dois braços rodaram e não trouxeram candidato. Tente termos que apareçam no
                documento, ou confira acima se o escopo da busca é o que você esperava.
              </EstadoVazio>
            </Card>
          ) : (
            <div className="grid gap-2.5">
              {outcome.results.map((passage, index) => (
                <Card key={passage.chunk_id} className="px-5 py-4">
                  <div className="flex flex-wrap items-baseline gap-2.5">
                    <Pill>#{index + 1}</Pill>
                    <strong className="text-[14px]">{passage.title || passage.filename}</strong>
                    <code className="text-text-dim">{passage.space}</code>
                    {/* De qual representação a evidência veio. Um trecho do
                        índice é texto do documento; uma página da wiki é texto
                        que um modelo escreveu. Chegam na mesma lista e NÃO são
                        a mesma coisa — omitir isso faria o agente citar uma
                        síntese achando que cita a fonte. */}
                    {passage.representation === 'wiki' ? (
                      <Pill tone="warn" title="página destilada por modelo, não texto do documento">
                        <BookText size={10} /> wiki
                      </Pill>
                    ) : (
                      <Pill title="texto do documento canônico">
                        <FileText size={10} /> índice
                      </Pill>
                    )}
                    {passage.page ? <Pill tone="good">pág. {passage.page}</Pill> : null}
                    {passage.armadilha ? (
                      <Pill tone="warn" title={passage.armadilha}>
                        <AlertTriangle size={10} /> armadilha
                      </Pill>
                    ) : null}
                    <div className="ml-auto flex gap-2">
                      {/* Os destinos mudam com a origem: uma página da wiki não
                          tem PDF nem página, e mandar para o documento seria
                          mandar para o lugar errado. */}
                      {passage.representation === 'wiki' ? (
                        <Button
                          onClick={() =>
                            navigate(`/wiki?espaco=${passage.space}&pagina=${passage.chunk_id}`)
                          }
                        >
                          <BookText size={14} /> Abrir a página
                        </Button>
                      ) : (
                        <>
                          {/* Dois destinos diferentes de propósito. "No original"
                              leva ao PDF na página do trecho, com a passagem
                              marcada -- é a pergunta "onde isso está escrito?".
                              "Canônico" leva ao texto que a busca de fato indexou,
                              que é a pergunta "o que a base leu?". */}
                          <Button
                            onClick={() =>
                              navigate(
                                `/documentos?espaco=${passage.space}&doc=${passage.document_id}` +
                                  `&pagina=${passage.page ?? ''}` +
                                  `&trecho=${encodeURIComponent((passage.match || '').slice(0, 400))}`,
                              )
                            }
                          >
                            <FileSearch size={14} /> No original
                          </Button>
                          <Button
                            onClick={() =>
                              navigate(
                                `/documentos?espaco=${passage.space}&doc=${passage.document_id}`,
                              )
                            }
                          >
                            Canônico
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="my-2.5 flex items-center gap-2.5">
                    <span className="mono w-[6.5rem] shrink-0 text-[11.5px] text-text-dim">
                      RRF {fmtScore(passage.score, 5)}
                    </span>
                    <ScoreBar value={passage.score} max={max} />
                    {/* Por MÉTODO, e não dois campos fixos: a lista cresceu
                        (páginas da wiki, travessia de grafo) e "vet · lex" já
                        não descrevia por onde a evidência chegou. */}
                    <span className="mono shrink-0 whitespace-nowrap text-right text-[11.5px] text-text-dim">
                      {Object.entries(passage.scores.by_method ?? {}).map(([metodo, dados]) => (
                        <span key={metodo} className="ml-2.5">
                          {metodo.slice(0, 9)} {fmtScore(dados.score, 4)}
                          <span className="text-text-dim/60">#{dados.rank}</span>
                        </span>
                      ))}
                    </span>
                  </div>
                  {/* ANTES do trecho, e não depois: o aviso só serve se for
                      lido antes da leitura que ele corrige. Quem chega aqui já
                      está lendo o texto — um rodapé chegaria tarde. */}
                  {passage.armadilha ? (
                    <div className="mb-2 flex items-start gap-2 rounded-lg border border-amber/40 bg-amber/10 px-3 py-2 text-[12.5px] leading-relaxed text-text-muted">
                      <AlertTriangle size={14} className="mt-[2px] shrink-0 text-amber" />
                      <span>{passage.armadilha}</span>
                    </div>
                  ) : null}
                  <div className="rounded-r-lg border-l-2 border-blue bg-ink-850 px-3 py-2.5 text-[13px] leading-relaxed">
                    {passage.content.slice(0, 700)}
                    {passage.content.length > 700 ? '…' : ''}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      ) : null}
    </>
  );
}

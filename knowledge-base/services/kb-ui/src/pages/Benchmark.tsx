import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  Check,
  ChevronDown,
  CircleAlert,
  FlaskConical,
  Loader2,
  Play,
  Plus,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { kb } from '../lib/api';
import { ExigeBase } from '../components/ExigeBase';
import { fmtMs, fmtNumber, fmtWhen } from '../lib/format';
import {
  BarraDeDiagnostico,
  BarrasDeMetrica,
  COR_DIAGNOSTICO,
  DispersaoDeQualidade,
  Nota,
  ROTULO_DIAGNOSTICO,
  corDaNota,
} from '../components/Charts';
import {
  Button,
  Card,
  ErrorBox,
  EstadoVazio,
  PageHeader,
  Pill,
  Spinner,
  inputClass,
  selectClass,
} from '../components/Ui';
import type { BenchmarkQuestion, BenchmarkResult } from '../lib/types';

/**
 * Avaliação offline (FUN-07).
 *
 * A telemetria responde "quanto custou e demorou". Esta tela responde a outra
 * pergunta — **"quão boa é a resposta?"** — e ela só se responde contra um
 * conjunto curado, periodicamente, não por consulta.
 *
 * A tela segue as duas fases que a especificação separa, e por isso são duas
 * metades: em cima o **dataset golden**, que muda devagar; embaixo as
 * **execuções**, que se repetem a cada mudança de configuração. É a repetição
 * sobre o mesmo dataset que permite comparar técnicas entre si.
 */

const ROTULO_METRICA: Record<string, string> = {
  context_precision: 'precisão do contexto',
  context_recall: 'cobertura do contexto',
  faithfulness: 'fidelidade ao contexto',
  answer_relevancy: 'relevância da resposta',
  answer_correctness: 'correção da resposta',
};

const RECUPERADOR = ['context_precision', 'context_recall'];
const GERADOR = ['faithfulness', 'answer_relevancy', 'answer_correctness'];

function media(metricas: Record<string, unknown>, nomes: string[]): number | null {
  const valores = nomes.map((n) => metricas[n]).filter((v): v is number => typeof v === 'number');
  return valores.length ? valores.reduce((s, v) => s + v, 0) / valores.length : null;
}

export function BenchmarkPage() {
  const cliente = useQueryClient();
  // A base vem da URL: esta tela é alcançada pelo card do Espaço. Escolher a
  // primeira da lista sozinha, como antes, é atalho caro aqui — gerar perguntas
  // e rodar uma execução GASTAM IA, e fazer isso na base errada custa dinheiro
  // de verdade, não um clique a mais.
  const [params, setParams] = useSearchParams();
  const space = params.get('espaco') ?? '';
  const [erro, setErro] = useState('');
  const [modo, setModo] = useState<'recuperacao' | 'completo'>('recuperacao');
  // Slots de melhoria de query (BUS-02). Desligados por padrão, como a
  // especificação manda — e é justamente aqui que se mede se vale ligar.
  const [rewrite, setRewrite] = useState('nenhuma');
  const [queryEmbedding, setQueryEmbedding] = useState('crua');
  // `null` = todos os documentos que ainda não têm pergunta desta estratégia.
  const [quantidade, setQuantidade] = useState<number | null>(null);
  const [estrategia, setEstrategia] = useState<'direta' | 'dificil'>('dificil');
  const [novaPergunta, setNovaPergunta] = useState('');
  const [novaReferencia, setNovaReferencia] = useState('');
  const [runAberta, setRunAberta] = useState<number | null>(null);
  const [filtro, setFiltro] = useState('');

  const spacesQuery = useQuery({ queryKey: ['spaces'], queryFn: kb.spaces });
  const spaces = spacesQuery.data?.spaces ?? [];

  const perguntas = useQuery({
    queryKey: ['bench-questions', space],
    queryFn: () => kb.benchmarkQuestions(space),
    enabled: !!space,
  });
  const execucoes = useQuery({
    queryKey: ['bench-runs', space],
    queryFn: () => kb.benchmarkRuns(space),
    enabled: !!space,
    // Enquanto roda, acompanha de perto; parado, devagar.
    refetchInterval: (q) => ((q.state.data ?? []).some((r) => r.status === 'running') ? 4_000 : 0),
  });
  const detalhe = useQuery({
    queryKey: ['bench-run', runAberta],
    queryFn: () => kb.benchmarkRun(runAberta!),
    enabled: runAberta !== null,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 4_000 : 0),
  });

  const invalidar = () => {
    void cliente.invalidateQueries({ queryKey: ['bench-questions', space] });
    void cliente.invalidateQueries({ queryKey: ['bench-runs', space] });
  };
  const aoFalhar = (e: unknown) => setErro((e as Error).message);

  const geracao = useQuery({
    queryKey: ['bench-gen', space],
    queryFn: () => kb.benchmarkGenerationStatus(space),
    enabled: !!space,
    refetchInterval: (q) => (q.state.data?.running ? 3_000 : 0),
  });
  const gerando = geracao.data?.running ?? null;
  const faltam = geracao.data?.pendentes?.[estrategia] ?? 0;

  const gerar = useMutation({
    mutationFn: () => kb.generateBenchmarkQuestions(space, quantidade, estrategia),
    onSuccess: (d) => {
      setErro(d.erro ?? '');
      void cliente.invalidateQueries({ queryKey: ['bench-gen', space] });
      invalidar();
    },
    onError: aoFalhar,
  });
  const cancelarGeracao = useMutation({
    mutationFn: () => kb.cancelBenchmarkGeneration(space),
    onSuccess: () => void cliente.invalidateQueries({ queryKey: ['bench-gen', space] }),
    onError: aoFalhar,
  });
  const criar = useMutation({
    mutationFn: () =>
      kb.createBenchmarkQuestion(space, { question: novaPergunta, reference: novaReferencia }),
    onSuccess: () => {
      setNovaPergunta('');
      setNovaReferencia('');
      setErro('');
      invalidar();
    },
    onError: aoFalhar,
  });
  const atualizar = useMutation({
    mutationFn: (v: { id: number; status: string }) =>
      kb.updateBenchmarkQuestion(v.id, { status: v.status }),
    onSuccess: invalidar,
    onError: aoFalhar,
  });
  const remover = useMutation({
    mutationFn: (id: number) => kb.removeBenchmarkQuestion(id),
    onSuccess: invalidar,
    onError: aoFalhar,
  });
  const iniciar = useMutation({
    mutationFn: () =>
      kb.startBenchmarkRun(space, modo, { rewrite, query_embedding: queryEmbedding }),
    onSuccess: (d) => {
      setErro('');
      setRunAberta(d.run_id);
      invalidar();
    },
    onError: aoFalhar,
  });
  const cancelar = useMutation({
    mutationFn: (id: number) => kb.cancelBenchmarkRun(id),
    onSuccess: invalidar,
    onError: aoFalhar,
  });

  if (spacesQuery.isLoading) return <Spinner label="Lendo as bases…" />;

  const lista = perguntas.data ?? [];
  const rascunhos = lista.filter((q) => q.status === 'rascunho');
  const aprovadas = lista.filter((q) => q.status === 'aprovada');
  const rodando = (execucoes.data ?? []).find((r) => r.status === 'running');
  const run = detalhe.data;

  if (!space) {
    return (
      <>
        <PageHeader title="Benchmark">
          Quão boa é a resposta desta base, medida com as métricas do Ragas.
        </PageHeader>
        <ExigeBase oQue="O benchmark" />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Benchmark">
        A telemetria diz quanto custou e demorou. Esta tela responde a outra pergunta —{' '}
        <strong>quão boa é a resposta</strong> — com as métricas do Ragas sobre um conjunto de
        perguntas curado. Ela separa o que é falha de <strong>recuperação</strong> do que é falha de{' '}
        <strong>resposta</strong>, porque o conserto de cada uma é diferente.
      </PageHeader>

      {erro ? <ErrorBox>{erro}</ErrorBox> : null}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          className={`${selectClass} min-w-[15rem]`}
          value={space}
          onChange={(e) => {
            setParams(new URLSearchParams({ espaco: e.target.value }));
            setRunAberta(null);
          }}
          aria-label="Base"
        >
          {spaces.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.label} · {s.documents} documentos
            </option>
          ))}
        </select>
        <Pill tone={aprovadas.length ? 'good' : 'neutral'}>{aprovadas.length} aprovadas</Pill>
        {rascunhos.length ? <Pill tone="warn">{rascunhos.length} para revisar</Pill> : null}
      </div>

      {/* ── FASE 1: o dataset golden ─────────────────────────────────────── */}
      <Card className="mb-4 px-5 py-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <FlaskConical size={15} className="text-text-dim" />
          <strong className="text-[13.5px]">1. O conjunto de perguntas</strong>
          <span className="text-[12px] text-text-dim">
            a IA propõe a partir dos documentos; você decide o que entra
          </span>
        </div>

        {/* DUAS ESTRATÉGIAS, e a diferença entre elas é medida, não estética.
            A primeira execução só com perguntas diretas deu `context_recall`
            1,0 em 16 de 16 — a pergunta gerada herda o vocabulário do documento
            ("em qual tela cadastro Grupos de Descontos?"), então a busca lexical
            acha por coincidência de palavra, sem entender nada. Um benchmark em
            que o recuperador não pode errar não mede recuperador. */}
        <div className="mb-3 grid gap-2 sm:grid-cols-2">
          {(
            [
              {
                id: 'direta' as const,
                titulo: 'Direto do conteúdo',
                texto:
                  'Pergunta tirada do trecho como ele está, com os termos do próprio manual. É a linha de base barata — e o caso real de quem pergunta usando o vocabulário da documentação.',
              },
              {
                id: 'dificil' as const,
                titulo: 'Derivar perguntas difíceis',
                texto:
                  'Pergunta escrita com as palavras de quem tem o problema, não as do manual, e sem citar nome de tela. Paráfrase, exceção, limite, multi-salto. É o que mede se a busca entende em vez de casar palavra.',
              },
            ] as const
          ).map((opcao) => (
            <button
              key={opcao.id}
              type="button"
              onClick={() => setEstrategia(opcao.id)}
              className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                estrategia === opcao.id
                  ? 'border-accent bg-ink-850'
                  : 'border-line bg-ink-950 hover:border-line-strong'
              }`}
            >
              <span className="flex items-center gap-2 text-[13px] font-semibold">
                <span
                  className={`h-2.5 w-2.5 rounded-full ${
                    estrategia === opcao.id ? 'bg-accent' : 'bg-ink-700'
                  }`}
                />
                {opcao.titulo}
              </span>
              <span className="mt-1 block text-[11.5px] leading-relaxed text-text-muted">
                {opcao.texto}
              </span>
            </button>
          ))}
        </div>

        <div className="mb-3 flex flex-wrap items-end gap-2">
          {/* O combo escolhe o TAMANHO DO LOTE, e o padrão é "todos os que
              faltam". Ele não limita o conjunto: cada rodada pega só documentos
              que ainda não têm pergunta desta estratégia, então rodar de novo
              sempre avança a cobertura, e rodar depois de subir documentos novos
              pega só os novos. */}
          <select
            className={selectClass}
            value={quantidade === null ? 'todos' : String(quantidade)}
            onChange={(e) =>
              setQuantidade(e.target.value === 'todos' ? null : Number(e.target.value))
            }
            aria-label="Quantos documentos nesta rodada"
          >
            <option value="todos">todos os que faltam{faltam ? ` (${faltam})` : ''}</option>
            {[3, 5, 10, 20, 50].map((n) => (
              <option key={n} value={n}>
                lote de {n} documentos
              </option>
            ))}
          </select>
          <Button
            variant="primary"
            onClick={() => gerar.mutate()}
            disabled={gerar.isPending || !space || !!gerando || !faltam}
          >
            {gerar.isPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Sparkles size={14} />
            )}
            Gerar {estrategia === 'dificil' ? 'perguntas difíceis' : 'perguntas diretas'}
          </Button>
          {/* A cobertura é o número que importa, e ele não é o tamanho do lote:
              "5 documentos" não diz nada sobre 275. */}
          <span className="text-[12px] text-text-dim">
            {faltam === 0
              ? 'todos os documentos desta base já têm pergunta desta estratégia'
              : `${faltam} ${faltam === 1 ? 'documento ainda sem' : 'documentos ainda sem'} pergunta ${
                  estrategia === 'dificil' ? 'difícil' : 'direta'
                }`}
          </span>
        </div>

        {gerando ? (
          <div className="mb-3 rounded-lg border border-amber/40 bg-amber/10 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-3 text-[12.5px]">
              <Loader2 size={14} className="animate-spin text-amber" />
              <strong className="text-amber">
                gerando {gerando.estrategia === 'dificil' ? 'difíceis' : 'diretas'}
              </strong>
              <span className="mono">
                {gerando.done}/{gerando.total} documentos
              </span>
              <span className="text-text-muted">
                {gerando.criadas} perguntas
                {gerando.descartadas
                  ? ` · ${gerando.descartadas} descartadas por não se sustentarem sozinhas`
                  : ''}
              </span>
              <Button onClick={() => cancelarGeracao.mutate()}>
                <X size={13} /> Cancelar
              </Button>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-850">
              <div
                className="h-full bg-amber transition-all"
                style={{ width: `${(gerando.done / Math.max(1, gerando.total)) * 100}%` }}
              />
            </div>
            <p className="mt-1.5 text-[11.5px] text-text-dim">
              Uma leitura de LLM por documento, cerca de 13 s cada. Pode fechar a tela: o trabalho
              segue no servidor e o que já foi gerado fica.
            </p>
          </div>
        ) : null}

        {/* Cadastro à mão. Fica ao lado da geração, e não escondido: a pergunta
            que alguém escreve porque sabe que a base erra nela é a mais valiosa
            do conjunto. */}
        <div className="mb-3 grid gap-2 rounded-lg border border-line-soft p-3 md:grid-cols-[1fr_1fr_auto]">
          <input
            className={inputClass}
            placeholder="pergunta que alguém faria"
            value={novaPergunta}
            onChange={(e) => setNovaPergunta(e.target.value)}
          />
          <input
            className={inputClass}
            placeholder="resposta de referência (opcional, mas é ela que mede a recuperação)"
            value={novaReferencia}
            onChange={(e) => setNovaReferencia(e.target.value)}
          />
          <Button onClick={() => criar.mutate()} disabled={!novaPergunta.trim() || criar.isPending}>
            <Plus size={14} /> Cadastrar
          </Button>
        </div>

        {perguntas.isLoading ? (
          <Spinner />
        ) : lista.length === 0 ? (
          <EstadoVazio icone={FlaskConical} titulo="Nenhuma pergunta ainda">
            Gere um primeiro lote a partir dos documentos, ou cadastre à mão a pergunta que você
            sabe que a base precisa responder.
          </EstadoVazio>
        ) : (
          <div className="overflow-hidden rounded-lg border border-line-soft">
            {lista
              .filter(
                (q) =>
                  !filtro.trim() || q.question.toLowerCase().includes(filtro.trim().toLowerCase()),
              )
              .map((q) => (
                <LinhaPergunta
                  key={q.id}
                  q={q}
                  onStatus={(status) => atualizar.mutate({ id: q.id, status })}
                  onRemover={() => remover.mutate(q.id)}
                />
              ))}
          </div>
        )}
        {lista.length > 6 ? (
          <input
            className={`${inputClass} mt-2`}
            placeholder="filtrar perguntas"
            value={filtro}
            onChange={(e) => setFiltro(e.target.value)}
          />
        ) : null}
      </Card>

      {/* ── FASE 2: execução ─────────────────────────────────────────────── */}
      <Card className="mb-4 px-5 py-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Play size={15} className="text-text-dim" />
          <strong className="text-[13.5px]">2. Executar</strong>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <select
            className={selectClass}
            value={modo}
            onChange={(e) => setModo(e.target.value as 'recuperacao' | 'completo')}
            aria-label="Modo"
          >
            <option value="recuperacao">só recuperação — barato, 2 métricas</option>
            <option value="completo">completo — sintetiza resposta, 5 métricas</option>
          </select>
          {/* Os dois slots agem em lugares diferentes: a reescrita muda o TEXTO
              da pergunta (vale para o lexical também), o HyDE muda só o VETOR do
              método semântico. Medido nas 16 perguntas difíceis: crua acha 7,
              reescrita 9, HyDE 9, as duas juntas 11 — e `step-back` PIORA para 3,
              porque generalizar afasta do documento específico. */}
          <select
            className={selectClass}
            value={rewrite}
            onChange={(e) => setRewrite(e.target.value)}
            aria-label="Reescrita da pergunta"
          >
            <option value="nenhuma">pergunta crua</option>
            <option value="rewrite">reescrita no vocabulário do manual</option>
            <option value="step_back">step-back (medido: piora nesta base)</option>
          </select>
          <select
            className={selectClass}
            value={queryEmbedding}
            onChange={(e) => setQueryEmbedding(e.target.value)}
            aria-label="Embedding da pergunta"
          >
            <option value="crua">vetor da pergunta</option>
            <option value="hyde">HyDE — vetor de um parágrafo hipotético</option>
          </select>
          <Button
            variant="primary"
            onClick={() => iniciar.mutate()}
            disabled={iniciar.isPending || !aprovadas.length || !!rodando}
          >
            <Play size={14} /> Rodar {aprovadas.length} perguntas
          </Button>
          {rodando ? (
            <span className="inline-flex items-center gap-2 text-[12.5px] text-amber">
              <Loader2 size={13} className="animate-spin" />
              execução {rodando.id}: {rodando.done}/{rodando.total}
              <Button onClick={() => cancelar.mutate(rodando.id)}>
                <Ban size={13} /> Cancelar
              </Button>
            </span>
          ) : null}
        </div>
        <p className="mt-2 text-[12px] text-text-dim">
          {modo === 'completo'
            ? 'O modo completo sintetiza uma resposta a partir das passagens, só para medir — em produção o sistema devolve evidência, não resposta. É o que permite separar a falha do recuperador da falha do gerador. Medido: cerca de um minuto por pergunta.'
            : 'Mede só o recuperador (precisão e cobertura do contexto). Não sintetiza resposta, então custa um terço do completo — é o modo de rodar a cada mudança de configuração.'}
        </p>
      </Card>

      {/* ── execuções ────────────────────────────────────────────────────── */}
      <Card className="mb-4 overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-line text-[11px] uppercase tracking-wider text-text-dim">
              <th className="px-4 py-2.5 text-left font-semibold">Execução</th>
              <th className="whitespace-nowrap px-4 py-2.5 text-left font-semibold">Modo</th>
              <th className="whitespace-nowrap px-4 py-2.5 text-left font-semibold">Estado</th>
              <th className="whitespace-nowrap px-4 py-2.5 text-right font-semibold">Nota</th>
              <th className="px-4 py-2.5 text-left font-semibold">Composição</th>
              <th className="whitespace-nowrap px-4 py-2.5 text-left font-semibold">Quando</th>
            </tr>
          </thead>
          <tbody>
            {(execucoes.data ?? []).map((r) => (
              <tr
                key={r.id}
                onClick={() => setRunAberta(r.id)}
                className={`cursor-pointer border-b border-line-soft last:border-0 hover:bg-ink-850 ${
                  runAberta === r.id ? 'bg-ink-850' : ''
                }`}
              >
                <td className="mono px-4 py-2.5">#{r.id}</td>
                <td className="whitespace-nowrap px-4 py-2.5 text-text-muted">{r.mode}</td>
                <td className="whitespace-nowrap px-4 py-2.5">
                  {r.status === 'running' ? (
                    <Pill tone="warn">
                      <Loader2 size={10} className="animate-spin" /> {r.done}/{r.total}
                    </Pill>
                  ) : r.status === 'done' ? (
                    <Pill tone="good">concluída</Pill>
                  ) : (
                    <Pill tone={r.status === 'failed' ? 'bad' : 'neutral'}>{r.status}</Pill>
                  )}
                </td>
                <td
                  className="mono whitespace-nowrap px-4 py-2.5 text-right font-semibold"
                  style={{
                    color:
                      typeof r.summary?.harmonica === 'number'
                        ? corDaNota(r.summary.harmonica)
                        : undefined,
                  }}
                >
                  {typeof r.summary?.harmonica === 'number' ? r.summary.harmonica.toFixed(3) : '—'}
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex h-3 w-40 overflow-hidden rounded border border-line">
                    {Object.entries(r.summary?.diagnosticos ?? {}).map(([d, n]) => (
                      <div
                        key={d}
                        title={`${ROTULO_DIAGNOSTICO[d] ?? d}: ${n}`}
                        style={{
                          flexGrow: n,
                          background: COR_DIAGNOSTICO[d] ?? '#6b7280',
                        }}
                      />
                    ))}
                  </div>
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-text-dim">
                  {fmtWhen(r.started_at)}
                </td>
              </tr>
            ))}
            {(execucoes.data ?? []).length === 0 ? (
              <tr>
                <td colSpan={6} className="px-5 py-6">
                  <EstadoVazio icone={Play} titulo="Nenhuma execução ainda">
                    Aprove ao menos uma pergunta e rode. A primeira execução vira a linha de base
                    contra a qual as próximas serão comparadas.
                  </EstadoVazio>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Card>

      {/* ── resultado ────────────────────────────────────────────────────── */}
      {run ? <Resultado run={run} /> : null}
    </>
  );
}

function LinhaPergunta({
  q,
  onStatus,
  onRemover,
}: {
  q: BenchmarkQuestion;
  onStatus: (s: string) => void;
  onRemover: () => void;
}) {
  const tom =
    q.status === 'aprovada' ? 'good' : q.status === 'rascunho' ? 'warn' : ('neutral' as const);
  return (
    <div
      className={`flex flex-wrap items-start gap-3 border-b border-line-soft px-3 py-2.5 last:border-0 ${
        q.status === 'descartada' ? 'opacity-50' : ''
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={tom}>{q.status}</Pill>
          <Pill>{q.origin}</Pill>
          {q.strategy === 'dificil' ? (
            <Pill tone="warn">difícil{q.kind ? ` · ${q.kind.replace('_', '-')}` : ''}</Pill>
          ) : null}
          {q.filename ? (
            <span className="truncate text-[11.5px] text-text-dim">de {q.filename}</span>
          ) : null}
        </div>
        <div className="mt-1 text-[13px]">{q.question}</div>
        {q.reference ? (
          <div className="mt-0.5 text-[12px] text-text-muted">↳ {q.reference}</div>
        ) : (
          // Sem gabarito, três das cinco métricas não têm como ser calculadas.
          // Dizer isso aqui evita a execução que volta com metade das colunas
          // vazias e ninguém sabe por quê.
          <div className="mt-0.5 text-[12px] text-amber">
            sem resposta de referência — precisão e cobertura do contexto não serão medidas
          </div>
        )}
      </div>
      <div className="flex shrink-0 gap-1.5">
        {q.status !== 'aprovada' ? (
          <Button onClick={() => onStatus('aprovada')}>
            <Check size={13} /> Aprovar
          </Button>
        ) : null}
        {q.status !== 'descartada' ? (
          <Button onClick={() => onStatus('descartada')}>
            <X size={13} /> Descartar
          </Button>
        ) : null}
        <button
          onClick={onRemover}
          title="remover"
          className="rounded-lg border border-line bg-ink-800 p-1.5 text-text-dim hover:border-rose hover:text-rose"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

function Resultado({ run }: { run: import('../lib/types').BenchmarkRunDetail }) {
  const [aberta, setAberta] = useState<number | null>(null);
  const resumo = run.summary ?? {};
  const medias = resumo.medias ?? {};
  const pontos = run.results
    .map((r) => {
      const x = media(r.metrics, RECUPERADOR);
      const y = media(r.metrics, GERADOR);
      return x === null
        ? null
        : {
            id: r.id,
            x,
            y: y ?? x,
            cor: COR_DIAGNOSTICO[r.diagnosis] ?? '#6b7280',
            titulo: `${r.question.slice(0, 60)} — recuperação ${x.toFixed(2)}${
              y === null ? '' : `, resposta ${y.toFixed(2)}`
            }`,
          };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);

  const problemas = run.results.filter(
    (r) => r.diagnosis !== 'ok' && r.diagnosis !== 'sem_metrica',
  );

  return (
    <>
      <Card className="mb-4 px-5 py-4">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <strong className="text-[14px]">Execução #{run.id}</strong>
          <Pill>{run.mode}</Pill>
          <span className="text-[12px] text-text-dim">
            {resumo.avaliadas ?? 0} perguntas · mediana {fmtMs(resumo.latencia_mediana_ms)} por
            pergunta
          </span>
          {resumo.modelos?.chat ? (
            <span className="mono text-[11.5px] text-text-dim">juiz: {resumo.modelos.chat}</span>
          ) : null}
          {resumo.melhoria_query &&
          (resumo.melhoria_query.rewrite !== 'nenhuma' ||
            resumo.melhoria_query.query_embedding !== 'crua') ? (
            <Pill tone="warn">
              query: {resumo.melhoria_query.rewrite}
              {resumo.melhoria_query.query_embedding !== 'crua'
                ? ` + ${resumo.melhoria_query.query_embedding}`
                : ''}
            </Pill>
          ) : null}
        </div>

        {/* DUAS LINHAS, e não três colunas com largura automática nas pontas.
            O grid `[auto_1fr_auto]` colocava as notas, as barras e a dispersão
            na mesma linha: as pontas pediam a largura que quisessem, a coluna do
            meio ficava com o resto, e as barras (que têm rótulo, barra e número)
            empurravam o cartão para fora da tela. Aqui cada linha tem um
            trabalho, e nenhuma peça depende da largura da outra. */}
        <div className="mb-4 grid gap-2 sm:grid-cols-3">
          <Nota
            valor={resumo.harmonica}
            rotulo="nota geral"
            dica="média harmônica: uma métrica ruim derruba o conjunto"
          />
          <Nota
            valor={media(medias, RECUPERADOR)}
            rotulo="recuperação"
            dica="a busca trouxe o trecho certo?"
          />
          <Nota
            valor={media(medias, GERADOR)}
            rotulo="resposta"
            dica={run.mode === 'recuperacao' ? 'não medida neste modo' : 'usou o que chegou?'}
          />
        </div>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
          <div className="min-w-0">
            <p className="mb-2 text-[11px] uppercase tracking-wide text-text-dim">Por métrica</p>
            <BarrasDeMetrica valores={medias} rotulos={ROTULO_METRICA} />
            <p className="mb-2 mt-5 text-[11px] uppercase tracking-wide text-text-dim">
              Onde estão os problemas
            </p>
            <BarraDeDiagnostico contagem={resumo.diagnosticos ?? {}} />
          </div>

          <div className="min-w-0">
            <p className="mb-2 text-[11px] uppercase tracking-wide text-text-dim">Por pergunta</p>
            <DispersaoDeQualidade pontos={pontos} onSelect={setAberta} />
            <p className="mt-1 text-[11px] leading-relaxed text-text-dim">
              Cada ponto é uma pergunta. À esquerda da linha, a busca não achou — mexer no prompt
              não resolve. Abaixo dela, o contexto chegou e a resposta estragou.
            </p>
          </div>
        </div>

        {/* AS DUAS ESTRATÉGIAS LADO A LADO. Uma nota geral misturando diretas e
            difíceis esconde as duas leituras que interessam: a direta é a linha
            de base (se ELA está ruim, o problema é grave) e a difícil é o teste
            de verdade. */}
        {resumo.por_estrategia && Object.keys(resumo.por_estrategia).length > 1 ? (
          <div className="mt-5 border-t border-line-soft pt-4">
            <p className="mb-3 text-[11px] uppercase tracking-wide text-text-dim">
              Direto do conteúdo × perguntas difíceis
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              {Object.entries(resumo.por_estrategia).map(([nome, dados]) => (
                <div
                  key={nome}
                  className="min-w-0 rounded-lg border border-line bg-ink-950 px-4 py-3"
                >
                  <div className="mb-2 flex items-baseline gap-2">
                    <strong className="text-[13px]">
                      {nome === 'dificil' ? 'perguntas difíceis' : 'direto do conteúdo'}
                    </strong>
                    <span className="text-[12px] text-text-dim">
                      {dados.perguntas} {dados.perguntas === 1 ? 'pergunta' : 'perguntas'}
                    </span>
                    <span
                      className="mono ml-auto text-[16px] font-semibold"
                      style={{
                        color:
                          typeof dados.harmonica === 'number'
                            ? corDaNota(dados.harmonica)
                            : undefined,
                      }}
                    >
                      {typeof dados.harmonica === 'number' ? dados.harmonica.toFixed(3) : '—'}
                    </span>
                  </div>
                  <BarrasDeMetrica valores={dados.medias} rotulos={ROTULO_METRICA} />
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11.5px] text-text-dim">
              A nota da coluna difícil é a que vale como medida de qualidade. Se as duas estiverem
              próximas, a busca está entendendo; se a difícil despencar, ela estava acertando por
              coincidência de palavra.
            </p>
          </div>
        ) : null}

        {/* Qual TIPO de dificuldade quebra a base: paráfrase mal é problema de
            embedding, multi-salto é problema de recuperar uma passagem só. */}
        {resumo.por_tipo && Object.keys(resumo.por_tipo).length ? (
          <div className="mt-4 border-t border-line-soft pt-4">
            <p className="mb-2 text-[11px] uppercase tracking-wide text-text-dim">
              Qual dificuldade quebra a base
            </p>
            <div className="flex flex-wrap gap-2">
              {Object.entries(resumo.por_tipo)
                .sort((a, b) => (a[1].harmonica ?? 1) - (b[1].harmonica ?? 1))
                .map(([tipo, dados]) => (
                  <span
                    key={tipo}
                    className="inline-flex items-center gap-2 rounded-lg border border-line bg-ink-950 px-2.5 py-1.5 text-[12px]"
                  >
                    <span className="font-semibold">{tipo.replace('_', '-')}</span>
                    <span
                      className="mono"
                      style={{
                        color:
                          typeof dados.harmonica === 'number'
                            ? corDaNota(dados.harmonica)
                            : undefined,
                      }}
                    >
                      {typeof dados.harmonica === 'number' ? dados.harmonica.toFixed(2) : '—'}
                    </span>
                    <span className="text-text-dim">
                      {dados.falhas}/{dados.perguntas} falharam
                    </span>
                  </span>
                ))}
            </div>
          </div>
        ) : null}

        {resumo.parametros_recusados?.length ? (
          <p className="mt-4 border-t border-line-soft pt-3 text-[12px] text-text-dim">
            O modelo do juiz recusou <code>{resumo.parametros_recusados.join(', ')}</code> e a
            avaliação seguiu sem eles. Vale saber porque <code>temperature</code> é o que torna o
            juiz reproduzível: sem ela, duas execuções do mesmo conjunto podem divergir um pouco.
          </p>
        ) : null}
      </Card>

      <Card className="px-5 py-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <CircleAlert size={15} className="text-text-dim" />
          <strong className="text-[13.5px]">
            {problemas.length
              ? `${problemas.length} ${problemas.length === 1 ? 'pergunta com problema' : 'perguntas com problema'}`
              : 'Nenhuma pergunta com problema'}
          </strong>
          <span className="text-[12px] text-text-dim">
            a média esconde o caso que interessa — é aqui que se olha para consertar
          </span>
        </div>
        <div className="grid gap-2">
          {[...problemas, ...run.results.filter((r) => r.diagnosis === 'ok')].map((r) => (
            <LinhaResultado
              key={r.id}
              r={r}
              aberta={aberta === r.id}
              onToggle={() => setAberta(aberta === r.id ? null : r.id)}
            />
          ))}
        </div>
      </Card>
    </>
  );
}

const CONSELHO: Record<string, string> = {
  recuperador:
    'A busca não trouxe o trecho que responde. Olhe os trechos abaixo: se o assunto não está na base, é cobertura de conteúdo; se está e não veio, é o corte ou o modelo de embedding.',
  recuperador_fraco:
    'O trecho certo veio junto com muito ruído. Costuma ser chunk grande demais, ou top-k alto demais para a pergunta.',
  gerador:
    'O contexto certo chegou e a resposta não usou. Aqui sim é prompt de resposta ou modelo de chat — mexer na busca não resolve.',
  gerador_fraco: 'A resposta está no caminho, mas incompleta ou com rodeio.',
  erro: 'A avaliação não completou. Veja o erro.',
  sem_metrica:
    'Nenhuma métrica pôde ser calculada. Sem resposta de referência, só as métricas de gerador saem — e no modo recuperação não sai nenhuma.',
};

function LinhaResultado({
  r,
  aberta,
  onToggle,
}: {
  r: BenchmarkResult;
  aberta: boolean;
  onToggle: () => void;
}) {
  const cor = COR_DIAGNOSTICO[r.diagnosis] ?? '#6b7280';
  return (
    <div className="rounded-lg border border-line-soft">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-ink-850"
      >
        <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: cor }} />
        <span className="min-w-0 flex-1">
          <span className="block break-words text-[13px]">{r.question}</span>
          <span className="mt-1 flex flex-wrap items-center gap-2 text-[11.5px]">
            <span style={{ color: cor }}>{ROTULO_DIAGNOSTICO[r.diagnosis] ?? r.diagnosis}</span>
            {r.strategy === 'dificil' ? (
              <span className="rounded border border-amber/40 px-1.5 text-[10.5px] text-amber">
                difícil{r.kind ? ` · ${r.kind.replace('_', '-')}` : ''}
              </span>
            ) : null}
            {Object.entries(r.metrics ?? {}).map(([nome, valor]) => (
              <span key={nome} className="mono text-text-dim">
                {ROTULO_METRICA[nome] ?? nome}{' '}
                <span style={{ color: typeof valor === 'number' ? corDaNota(valor) : '#e05a5a' }}>
                  {typeof valor === 'number' ? valor.toFixed(2) : 'erro'}
                </span>
              </span>
            ))}
          </span>
        </span>
        <ChevronDown
          size={14}
          className={`mt-1 shrink-0 text-text-dim transition-transform ${aberta ? 'rotate-180' : ''}`}
        />
      </button>

      {aberta ? (
        <div className="border-t border-line-soft px-3 py-3 text-[12.5px]">
          {CONSELHO[r.diagnosis] ? (
            <p
              className="mb-3 rounded-lg border px-3 py-2"
              style={{ borderColor: `${cor}55`, background: `${cor}11` }}
            >
              {CONSELHO[r.diagnosis]}
            </p>
          ) : null}
          {r.error ? <ErrorBox>{r.error}</ErrorBox> : null}
          {r.reference ? (
            <p className="mb-2 break-words">
              <span className="text-text-dim">esperado: </span>
              {r.reference}
            </p>
          ) : null}
          {r.answer ? (
            <p className="mb-3 break-words">
              <span className="text-text-dim">respondido: </span>
              {r.answer}
            </p>
          ) : null}
          <p className="mb-1.5 text-[11px] uppercase tracking-wide text-text-dim">
            {r.contexts.length} trechos que a busca devolveu
          </p>
          {/* `overflow-y-auto` e não `overflow-auto`: com os dois eixos, um trecho
              longo criava barra HORIZONTAL dentro do cartão. Vertical é o que se
              quer aqui; a largura tem de caber. */}
          <div className="grid max-h-72 gap-1.5 overflow-y-auto">
            {r.contexts.map((c, i) => (
              <div key={c.chunk_id} className="rounded border border-line bg-ink-950 px-2.5 py-2">
                <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-text-dim">
                  <span className="mono">#{i + 1}</span>
                  <span className="min-w-0 max-w-full truncate">{c.title || c.filename}</span>
                  <Pill>{c.representation}</Pill>
                  <span className="mono">{c.score.toFixed(4)}</span>
                </div>
                <div className="line-clamp-3 break-words text-[12px] text-text-muted">
                  {c.content}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-text-dim">avaliada em {fmtNumber(r.latency_ms)} ms</p>
        </div>
      ) : null}
    </div>
  );
}

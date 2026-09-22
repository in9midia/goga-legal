import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CircleAlert, FileText, Network, RefreshCw, Search, Share2 } from 'lucide-react';
import { kb } from '../lib/api';
import { fmtNumber } from '../lib/format';
import { rotuloDoNo, trechoDoNo } from '../lib/grafo';
import { CORES_DO_GRAFO, GraphCanvas } from '../components/GraphCanvas';
import { ExigeBase } from '../components/ExigeBase';
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
import type { GraphNode } from '../lib/types';

/**
 * O grafo, desenhado (WEB-02).
 *
 * Duas visões, e a ordem entre elas importa: primeiro o **esquema** (que forma
 * este grafo tem), depois a **instância** (os nós de verdade). Abrir direto na
 * instância de uma base cheia mostra um emaranhado que não informa nada — o
 * esquema é o mapa que faz a instância significar alguma coisa.
 *
 * O que esta tela deixa claro, porque é fácil esquecer olhando a figura: o grafo
 * é **estrutura auxiliar**. Ele não guarda texto. Clicar num nó leva ao
 * documento, que é onde o conteúdo vive — o grafo é o caminho, o índice é o
 * destino.
 */
export function GraphPage() {
  const navigate = useNavigate();
  // A base vem da URL, e não de estado local: esta tela é alcançada pelo card
  // do Espaço, e o `?espaco=` é o que carrega a escolha já feita lá. Guardar em
  // `useState` faria o voltar do navegador devolver a tela com outra base
  // desenhada, sem a URL dizer isso.
  const [params, setParams] = useSearchParams();
  const space = params.get('espaco') ?? '';
  const [focoDigitado, setFocoDigitado] = useState('');
  const [foco, setFoco] = useState('');
  const [limite, setLimite] = useState(300);
  /** Rótulos que a pessoa desmarcou. O filtro vai para o SERVIDOR: o corte por
   *  grau acontece antes de a tela receber qualquer coisa, então esconder
   *  `Term` no navegador deixaria uma dezena de documentos numa base onde 93%
   *  dos nós são termo. */
  const [ocultos, setOcultos] = useState<Set<string>>(new Set());
  const [selecionado, setSelecionado] = useState<GraphNode | null>(null);
  const [semente, setSemente] = useState(0);

  const spacesQuery = useQuery({ queryKey: ['spaces'], queryFn: kb.spaces });
  const esquema = useQuery({ queryKey: ['graph-schema'], queryFn: kb.graphSchema });
  const esquemaRotulos = (esquema.data?.nodes ?? []).map((r) => r.label);
  const visiveis = esquemaRotulos.filter((r) => !ocultos.has(r));
  const grafo = useQuery({
    queryKey: ['graph', space, foco, limite, [...ocultos].sort().join(',')],
    queryFn: () =>
      kb.graph({
        space,
        focus: foco,
        limit: limite,
        // Nenhum oculto = não manda filtro. Todos ocultos também não: seria a
        // tela se apagar sozinha em vez de voltar ao completo.
        labels: visiveis.length && visiveis.length < esquemaRotulos.length ? visiveis : undefined,
      }),
  });

  // O grafo NÃO guarda texto (ADR-0012): o nó de trecho só aponta. O conteúdo
  // está gravado no Postgres desde a ingestão, e é de lá que ele vem quando
  // alguém clica — duplicá-lo no Memgraph criaria uma segunda cópia do canônico
  // que envelheceria sozinha a cada reprocessamento.
  const trecho = trechoDoNo(selecionado ?? { label: '', ref: null });
  const conteudo = useQuery({
    queryKey: ['chunk', trecho],
    queryFn: () => kb.locateChunk(trecho!),
    enabled: trecho !== null,
  });

  const spaces = spacesQuery.data?.spaces ?? [];

  // Antes de qualquer consulta pesada: sem base não há grafo a desenhar, e
  // perguntar o esquema inteiro só para mostrar "escolha uma base" é trabalho
  // jogado fora no servidor.
  if (!space) {
    return (
      <>
        <PageHeader title="Grafo">
          Entidades, termos e documentos, e as ligações entre eles.
        </PageHeader>
        <ExigeBase oQue="O grafo" />
      </>
    );
  }

  if (esquema.isLoading) return <Spinner label="Lendo o grafo…" />;

  if (esquema.data && !esquema.data.reachable) {
    return (
      <>
        <PageHeader title="Grafo">
          Entidades, termos e documentos, e as ligações entre eles.
        </PageHeader>
        <Card className="px-5 py-4">
          <EstadoVazio icone={Network} titulo="O grafo não está acessível">
            {esquema.data.enabled
              ? 'O Memgraph não respondeu. O grafo é auxiliar: a busca continua funcionando sem ele.'
              : 'O grafo está desligado nesta instalação (MEMGRAPH_ENABLED). Ele é auxiliar — nada depende dele para funcionar.'}
            {esquema.data.error ? (
              <>
                {' '}
                <code className="text-[11.5px]">{esquema.data.error}</code>
              </>
            ) : null}
          </EstadoVazio>
        </Card>
      </>
    );
  }

  const rotulos = esquema.data?.nodes ?? [];
  const total = rotulos.reduce((s, r) => s + r.total, 0);

  return (
    <>
      <PageHeader title="Grafo">
        Entidades, termos e documentos, e as ligações entre eles. É{' '}
        <strong>estrutura auxiliar</strong>: o grafo não guarda texto — ele abre outro caminho até o
        conteúdo que já está no índice. Clique num nó para ir ao documento.
      </PageHeader>

      {/* O ESQUEMA vem primeiro: é o mapa. Abrir direto na instância de uma base
          cheia mostra um emaranhado que não informa. */}
      <Card className="mb-4 px-5 py-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Share2 size={14} className="text-text-dim" />
          <strong className="text-[13.5px]">Forma do grafo</strong>
          <span className="mono text-[12px] text-text-dim">
            {fmtNumber(total)} nós no seu escopo
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* Os rótulos são INTERRUPTORES, e não legenda. Numa base de manuais
              93% dos nós são termo, e é desligá-los que revela a estrutura de
              documentos e entidades que estava debaixo. */}
          {rotulos.map((r) => {
            const oculto = ocultos.has(r.label);
            return (
              <button
                key={r.label}
                type="button"
                onClick={() =>
                  setOcultos((antes) => {
                    const proximo = new Set(antes);
                    if (oculto) proximo.delete(r.label);
                    else proximo.add(r.label);
                    return proximo;
                  })
                }
                title={oculto ? 'mostrar no desenho' : 'esconder do desenho'}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] transition-colors ${
                  oculto
                    ? 'border-line bg-ink-950 text-text-dim'
                    : 'border-line-strong bg-ink-850 text-text'
                }`}
              >
                <span
                  className="h-2.5 w-2.5 rounded-full transition-opacity"
                  style={{
                    background: CORES_DO_GRAFO[r.label] ?? '#8a8f98',
                    opacity: oculto ? 0.25 : 1,
                  }}
                />
                <span className={oculto ? 'line-through' : ''}>{r.label}</span>
                <span className="mono text-text-dim">{fmtNumber(r.total)}</span>
              </button>
            );
          })}
          {rotulos.length === 0 ? (
            <span className="text-[12.5px] text-text-muted">
              Nenhum nó ainda. O grafo lexical é construído em toda ingestão; entidades e relações
              tipadas exigem a auxiliar ligada na base.
            </span>
          ) : null}
        </div>

        {(esquema.data?.edges ?? []).length > 0 ? (
          <div className="mt-3 border-t border-line-soft pt-3">
            <p className="mb-2 text-[11px] uppercase tracking-wide text-text-dim">Ligações</p>
            <div className="flex flex-wrap gap-1.5">
              {(esquema.data?.edges ?? []).slice(0, 14).map((e, i) => (
                <span
                  key={`${e.de}-${e.tipo}-${e.para}-${i}`}
                  className="mono rounded-lg border border-line bg-ink-950 px-2 py-1 text-[11.5px] text-text-muted"
                >
                  {e.de} <span className="text-accent">─{e.tipo}→</span> {e.para}
                  <span className="ml-1.5 text-text-dim">{fmtNumber(e.total)}</span>
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </Card>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        {/* Trocar de base sem voltar para Bases. NÃO tem mais a opção "todas":
            o grafo é por base, e um desenho misturando Espaços respondia a uma
            pergunta que ninguém faz — além de gastar o teto de nós com termos
            de outra área. */}
        <select
          className={`${selectClass} min-w-[13rem]`}
          value={space}
          onChange={(e) => setParams(new URLSearchParams({ espaco: e.target.value }))}
          aria-label="Espaço"
        >
          {spaces.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.label}
            </option>
          ))}
        </select>

        <form
          className="relative min-w-[16rem] flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            setFoco(focoDigitado.trim());
          }}
        >
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-dim"
          />
          <input
            className={`${inputClass} pl-9`}
            placeholder="focar numa entidade ou termo (e a vizinhança dela)"
            value={focoDigitado}
            onChange={(e) => setFocoDigitado(e.target.value)}
          />
        </form>

        <select
          className={selectClass}
          value={limite}
          onChange={(e) => setLimite(Number(e.target.value))}
          aria-label="Nós"
        >
          {[100, 200, 300, 450, 600].map((n) => (
            <option key={n} value={n}>
              {n} nós
            </option>
          ))}
        </select>

        {/* Relê E remonta. A releitura sozinha não bastava: com o
            compartilhamento estrutural do React Query, dados iguais voltam na
            mesma referência e a tela ficava parada — o clique não fazia nada
            visível, que é pior do que não ter o botão. */}
        <Button
          onClick={() => {
            setSemente((n) => n + 1);
            grafo.refetch();
          }}
          disabled={grafo.isFetching}
        >
          <RefreshCw size={14} className={grafo.isFetching ? 'animate-spin' : undefined} />{' '}
          Redesenhar
        </Button>
      </div>

      {grafo.error ? <ErrorBox>{(grafo.error as Error).message}</ErrorBox> : null}

      <Card className="overflow-hidden p-1.5">
        {grafo.isLoading ? (
          <Spinner label="Montando o grafo…" />
        ) : (grafo.data?.nodes.length ?? 0) === 0 ? (
          <EstadoVazio icone={Network} titulo="Nada para desenhar neste escopo">
            {foco
              ? `Nenhum nó casa com “${foco}”. A busca ignora acento, então tente um termo que apareça nos documentos.`
              : 'Ingira um documento para o grafo lexical ser construído, ou ligue a estrutura auxiliar na configuração da base para extrair entidades e relações tipadas.'}
          </EstadoVazio>
        ) : (
          <GraphCanvas
            nodes={grafo.data!.nodes}
            edges={grafo.data!.edges}
            onSelect={setSelecionado}
            semente={semente}
          />
        )}
      </Card>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <span className="mono text-[12px] text-text-dim">
          {fmtNumber(grafo.data?.nodes.length ?? 0)} nós ·{' '}
          {fmtNumber(grafo.data?.edges.length ?? 0)} ligações desenhadas
        </span>
        {/* O corte precisa aparecer: uma figura que mostra 300 de 2.700 nós sem
            dizer isso passa a impressão de que o grafo é pequeno. */}
        {grafo.data?.truncated ? (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-amber">
            <CircleAlert size={13} />
            de {fmtNumber(grafo.data.total ?? 0)} no escopo — os de maior grau primeiro, porque são
            eles que dão a forma
          </span>
        ) : null}
        <span className="text-[12px] text-text-dim">
          arraste para mover · role para aproximar ·{' '}
          <strong className="text-text-muted">clique num nó para apagar o resto</strong>
        </span>
      </div>

      {selecionado ? (
        <Card className="mt-4 px-5 py-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span
              className="h-3 w-3 rounded-full"
              style={{ background: CORES_DO_GRAFO[selecionado.label] ?? '#8a8f98' }}
            />
            <strong className="text-[14px]">{rotuloDoNo(selecionado)}</strong>
            <Pill>{selecionado.label}</Pill>
            {selecionado.type ? <Pill>{selecionado.type}</Pill> : null}
            {/* O termo não tem base: o nó é compartilhado, e o que o traz
                para cá é a aresta de um documento que você alcança. Imprimir
                um `code` vazio parecia campo quebrado. */}
            {selecionado.space ? (
              <code className="text-[11.5px] text-text-dim">{selecionado.space}</code>
            ) : (
              <span className="text-[11.5px] text-text-dim">compartilhado entre bases</span>
            )}
            <span className="mono text-[12px] text-text-dim">{selecionado.grau} ligações</span>
          </div>

          {/* O grafo é o caminho; o conteúdo está no índice. Documento leva
              direto, trecho mostra o texto aqui mesmo, e entidade leva à busca
              pelo nome — que é onde o texto que a menciona vive. */}
          <div className="flex flex-wrap gap-2">
            {selecionado.label === 'Document' && selecionado.ref !== null ? (
              <Button
                variant="primary"
                onClick={() =>
                  navigate(`/documentos?espaco=${selecionado.space}&doc=${selecionado.ref}`)
                }
              >
                <FileText size={14} /> Abrir o documento
              </Button>
            ) : null}
            {trecho === null ? (
              <Button
                variant="primary"
                onClick={() =>
                  navigate(
                    `/buscar?espaco=${selecionado.space}&q=${encodeURIComponent(rotuloDoNo(selecionado))}`,
                  )
                }
              >
                <Search size={14} /> Buscar por “{rotuloDoNo(selecionado)}”
              </Button>
            ) : null}
            <Button
              onClick={() => {
                setFocoDigitado(rotuloDoNo(selecionado));
                setFoco(rotuloDoNo(selecionado));
              }}
              disabled={!selecionado.name}
            >
              <Network size={14} /> Focar a vizinhança
            </Button>
          </div>

          {/* O TEXTO DO TRECHO.
              Era a pergunta óbvia diante de um nó cinza numerado: "o que é
              isto?". O número sozinho não respondia nada, e o grafo parecia ter
              nós vazios de propósito. */}
          {trecho !== null ? (
            <div className="mt-4 border-t border-line-soft pt-4">
              {conteudo.isLoading ? (
                <Spinner label="Lendo o trecho…" />
              ) : conteudo.error ? (
                <ErrorBox>{(conteudo.error as Error).message}</ErrorBox>
              ) : conteudo.data ? (
                <>
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px] text-text-dim">
                    <FileText size={13} />
                    <span className="text-text-muted">
                      {conteudo.data.title || conteudo.data.filename}
                    </span>
                    {conteudo.data.page ? <Pill>página {conteudo.data.page}</Pill> : null}
                    <Pill>{conteudo.data.is_parent ? 'pai' : 'filho'}</Pill>
                    <span className="mono">
                      {fmtNumber(conteudo.data.content.length)} caracteres
                    </span>
                  </div>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-ink-950 px-3 py-2.5 text-[12.5px] leading-relaxed text-text-muted">
                    {conteudo.data.content}
                  </pre>
                  <div className="mt-2">
                    <Button
                      onClick={() =>
                        navigate(
                          `/documentos?espaco=${conteudo.data.space}&doc=${conteudo.data.document_id}`,
                        )
                      }
                    >
                      <FileText size={14} /> Abrir o documento de origem
                    </Button>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </Card>
      ) : null}
    </>
  );
}

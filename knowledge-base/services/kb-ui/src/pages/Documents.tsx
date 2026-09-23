import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Check,
  Copy,
  Download,
  FileCode,
  FileText,
  Library,
  MousePointerClick,
  Image as ImageIcon,
  RefreshCw,
  Scissors,
  Search,
  SearchX,
  Settings2,
  TriangleAlert,
  Trash2,
  Eye,
  Code2,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { kb } from '../lib/api';
import { fmtBytes, fmtWhen } from '../lib/format';
import { useAuthedBlob } from '../lib/useAuthedBlob';
import { FileViewer } from '../components/FileViewer';
import { FigureGallery } from '../components/FigureGallery';
import { IngestPanel } from '../components/IngestPanel';
import { usePreferencia } from '../lib/preferencia';
import { ExigeBase } from '../components/ExigeBase';
import { Markdown } from '../components/Markdown';
import {
  Button,
  Card,
  EstadoVazio,
  ErrorBox,
  PageHeader,
  Pill,
  Spinner,
  inputClass,
  selectClass,
} from '../components/Ui';
import type { DocumentSummary, OkfConcept, RepresentationStatus } from '../lib/types';

/** A identidade de um conceito OKF: o frontmatter, que saiu da prosa indexada.
 *
 *  O `trust` é o único campo que não vem escrito no arquivo — é derivado de
 *  `verified`, na escala da especificação. Um conceito que escreva
 *  `trust: human-reviewed` no frontmatter continua aparecendo como não
 *  verificado, e é assim que tem de ser: confiança declarada pelo próprio
 *  documento não é confiança. */
/** Por que uma representação deste documento não saiu.
 *
 *  Só aparece quando ALGUMA falhou. Listar as que deram certo seria ruído: a
 *  wiki que saiu já se vê na aba dela. O caso que importa é o silencioso — a
 *  wiki com zero páginas, que até aqui era indistinguível de "esta base não tem
 *  wiki ligada".
 */
function RepresentacoesComFalha({ estados }: { estados: RepresentationStatus[] }) {
  const falhas = estados.filter((e) => e.status === 'falha' && e.error);
  if (!falhas.length) return null;
  return (
    <div className="mt-3 rounded-md border border-warn/40 bg-warn/5 p-3">
      <p className="text-[12px] font-semibold text-warn">
        {falhas.length === 1
          ? 'Uma representação não saiu'
          : `${falhas.length} representações não saíram`}
      </p>
      <ul className="mt-1.5 space-y-1.5">
        {falhas.map((e) => (
          <li key={e.representation} className="text-[12px] leading-relaxed text-text-muted">
            <span className="mono text-[11.5px] text-text-dim">{e.representation}</span>
            {' — '}
            {e.error}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11.5px] text-text-dim">
        Reprocessar o documento tenta de novo. Se a causa for o modelo, vale conferir o provedor de
        chat em Administração antes de insistir.
      </p>
    </div>
  );
}

function ConceitoOkf({ okf }: { okf: OkfConcept }) {
  const CONFIANCA: Record<string, { rotulo: string; tom: 'good' | 'warn' | 'neutral' }> = {
    'human-reviewed': { rotulo: 'revisado por pessoa', tom: 'good' },
    'machine-confirmed': { rotulo: 'confirmado por agente', tom: 'warn' },
    unverified: { rotulo: 'sem verificação', tom: 'neutral' },
  };
  const confianca = CONFIANCA[okf.trust ?? 'unverified'] ?? CONFIANCA.unverified;
  // `generated` é o campo que a própria especificação reserva para conceito
  // produzido por agente. Ler dali em vez de um campo nosso mantém o metadado
  // exportável: um bundle gerado daqui diz a sua procedência em qualquer outro
  // consumidor de OKF.
  const gerado = okf.meta?.generated as { by?: string; at?: string } | undefined;
  const geradoPor = gerado?.by
    ? `gerado por ${gerado.by}${gerado.at ? ` em ${gerado.at}` : ''}`
    : '';

  return (
    <div className="mt-3 rounded-lg border border-line bg-ink-850 px-3.5 py-3">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <Pill tone="good">
          <FileCode size={10} /> {okf.type}
        </Pill>
        {/* Escrito e gerado não valem o mesmo, e a tela tem de dizer qual é
            qual: um veio de quem conhece o documento, o outro é a leitura de um
            modelo que ninguém conferiu. */}
        <Pill
          tone={okf.derived ? 'warn' : 'neutral'}
          title={geradoPor || 'lido do frontmatter do arquivo'}
        >
          {okf.derived ? 'gerado pela IA' : 'escrito no arquivo'}
        </Pill>
        {okf.status ? <Pill>{okf.status}</Pill> : null}
        <Pill tone={confianca.tom} title="derivado de `verified`, não declarado pelo conceito">
          {confianca.rotulo}
        </Pill>
        {(okf.tags ?? []).map((tag) => (
          <Pill key={tag}>{tag}</Pill>
        ))}
      </div>
      {okf.description ? (
        <p className="text-[12.5px] leading-relaxed text-text-muted">{okf.description}</p>
      ) : null}
      {okf.resource ? (
        <p className="mono mt-1 break-all text-[11.5px] text-text-dim">{okf.resource}</p>
      ) : null}
    </div>
  );
}

type Aba = 'canonico' | 'original' | 'figuras';

export function DocumentsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const spaceParam = params.get('espaco') ?? '';
  const docParam = params.get('doc');
  const pageParam = params.get('pagina');
  const highlightParam = params.get('trecho') ?? '';

  // "Está processando agora?" numa consulta MÍNIMA — uma linha, não as 120 do
  // painel de envio. Ela existe só para decidir se a contagem do seletor
  // precisa andar; o log completo continua sendo assunto do `IngestPanel`.
  const emAndamento = useQuery({
    queryKey: ['ingest-running'],
    queryFn: () => kb.ingestRunPage({ limit: 1, offset: 0, status: 'running' }),
    refetchInterval: 5_000,
  });
  const processando = (emAndamento.data?.total ?? 0) > 0;

  // O seletor mostra "Base · N documentos", e esse N ficava parado durante uma
  // carga que roda por fora (script, MCP, outra aba). Ver o comentário em
  // `Spaces.tsx`: número congelado ao lado de um rótulo "processando" é pior
  // que não ter número.
  const spacesQuery = useQuery({
    queryKey: ['spaces'],
    queryFn: kb.spaces,
    refetchInterval: processando ? 10_000 : false,
  });
  const spaces = spacesQuery.data?.spaces ?? [];
  // O Espaço e o documento vivem na URL, não no estado: assim "Ver documento"
  // vindo da busca, o link do histórico e o F5 caem todos no mesmo lugar.
  //
  // Sem `?espaco=` a tela NÃO escolhe uma base sozinha. Cair na primeira
  // alfabética mostrava documentos de um Espaço que ninguém pediu, e aqui o
  // Espaço é a fronteira de permissão — a entrada é pelo card da base.
  const space = spaceParam;

  const documentsQuery = useQuery({
    queryKey: ['documents', space],
    queryFn: () => kb.documents(space),
    enabled: Boolean(space),
  });

  const [filtro, setFiltro] = useState('');
  const [gestao, setGestao] = useState(false);
  /** Esconde a lista de arquivos para o conteúdo ocupar a largura toda.
   *
   *  Fica no navegador, não na URL: mandar o link do documento 282 na página 3
   *  faz sentido; mandar junto "e eu escondi a lista" não — quem recebe não
   *  quer herdar o layout de quem mandou. */
  const [listaOculta, setListaOculta] = usePreferencia('kb.documentos.lista-oculta', false);
  const admin = spacesQuery.data?.principal.unrestricted ?? false;
  const documents = documentsQuery.data ?? [];
  const visiveis = useMemo(() => {
    const alvo = filtro.trim().toLowerCase();
    if (!alvo) return documents;
    return documents.filter(
      (doc) =>
        doc.filename.toLowerCase().includes(alvo) || (doc.title ?? '').toLowerCase().includes(alvo),
    );
  }, [documents, filtro]);

  const falhos = documents.filter((doc) => doc.status !== 'indexed').length;
  const selectedId = docParam ? Number(docParam) : null;

  // Sem documento escolhido não há o que mostrar sozinho: a lista volta, senão
  // a tela ficaria em branco com a preferência guardada de uma visita anterior.
  const esconder = listaOculta && Boolean(selectedId);

  const abrir = (id: number) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('doc', String(id));
      // Página e trecho pertencem à navegação que VEIO da busca. Ao trocar de
      // documento na lista eles deixam de valer, e manter apontaria a página
      // de um documento para dentro de outro.
      next.delete('pagina');
      next.delete('trecho');
      return next;
    });

  return (
    <>
      <PageHeader title="Documentos">
        O <strong>documento canônico</strong> é o texto limpo extraído do arquivo original, e é a
        fonte de verdade da busca. O original fica preservado intacto no object store — dá para
        abrir lado a lado e conferir.
      </PageHeader>

      {spacesQuery.error ? <ErrorBox>{(spacesQuery.error as Error).message}</ErrorBox> : null}

      {/* Sem base nenhuma, a barra inteira é decoração: um combo vazio, um
          filtro que não filtra nada e um contador em zero. Pior, a lista dizia
          "Nenhum documento neste Espaço" quando não havia Espaço — mandando
          procurar no lugar errado. */}
      {!spacesQuery.isLoading && spaces.length === 0 ? (
        <Card className="px-5 py-4">
          <EstadoVazio
            icone={Library}
            titulo="Nenhuma base ainda"
            acao={
              <Button variant="primary" onClick={() => navigate('/bases')}>
                <Library size={14} /> Ir para Bases
              </Button>
            }
          >
            Documento vive dentro de uma base. Crie a primeira em <strong>Bases</strong> e volte
            aqui para enviar os arquivos.
          </EstadoVazio>
        </Card>
      ) : !space ? (
        <ExigeBase oQue="A lista de documentos" />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <select
              className={`${selectClass} min-w-[14rem]`}
              value={space}
              onChange={(event) => setParams(new URLSearchParams({ espaco: event.target.value }))}
              aria-label="Espaço"
            >
              {spaces.map((s) => (
                <option key={s.slug} value={s.slug}>
                  {s.label} · {s.documents} documentos
                </option>
              ))}
            </select>

            <div className="relative min-w-[16rem] flex-1">
              <Search
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-dim"
              />
              <input
                className={`${inputClass} pl-9`}
                placeholder="filtrar por nome do arquivo ou título"
                value={filtro}
                onChange={(event) => setFiltro(event.target.value)}
              />
            </div>

            {/* A lista traz TODOS os documentos, inclusive os que falharam na
            extração — são justamente os que precisam ser vistos para serem
            reprocessados. O seletor acima conta só os indexados, então sem
            separar os dois números a tela mostrava "43" e "44" lado a lado. */}
            <span className="mono inline-flex items-center gap-1.5 text-[12px] text-text-dim">
              <FileText size={13} />
              {visiveis.length === documents.length
                ? `${documents.length} documentos`
                : `${visiveis.length} de ${documents.length}`}
              {falhos > 0 ? (
                <span className="inline-flex items-center gap-1 text-rose">
                  <TriangleAlert size={13} /> {falhos} com falha
                </span>
              ) : null}
            </span>
            {/* ESCONDER A LISTA dá ao conteúdo a largura inteira. Um manual
                com print de tela em página A4 fica ilegível em 60% da tela, e
                era essa a única opção.

                Desabilitado sem documento escolhido, com o motivo no `title`:
                esconder a lista quando não há o que mostrar ao lado deixaria a
                tela vazia, e o botão pareceria quebrado. */}
            <span
              title={
                selectedId
                  ? listaOculta
                    ? 'Mostrar a lista de arquivos'
                    : 'Esconder a lista e usar a largura toda'
                  : 'Escolha um documento para poder esconder a lista'
              }
            >
              <Button
                variant={listaOculta ? 'primary' : 'ghost'}
                disabled={!selectedId}
                onClick={() => setListaOculta(!listaOculta)}
              >
                {listaOculta ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
                {listaOculta ? 'Mostrar lista' : 'Ocultar lista'}
              </Button>
            </span>
            <Button onClick={() => documentsQuery.refetch()}>
              <RefreshCw size={14} /> Recarregar
            </Button>
            {admin ? (
              <Button variant={gestao ? 'primary' : 'ghost'} onClick={() => setGestao((v) => !v)}>
                <Settings2 size={14} /> Gerenciar
              </Button>
            ) : null}
          </div>

          {admin && gestao && space ? (
            <div className="mb-4">
              <IngestPanel space={space} />
            </div>
          ) : null}

          <div
            className={`grid items-start gap-4 ${
              // Uma coluna só quando a lista está escondida. O `hidden` no Card
              // em vez de não renderizar: a consulta e o scroll da lista ficam
              // como estavam, e voltar é instantâneo em vez de remontar tudo.
              esconder ? '' : 'xl:grid-cols-[minmax(20rem,26rem)_1fr]'
            }`}
          >
            <Card className={`min-w-0 overflow-hidden ${esconder ? 'hidden' : ''}`}>
              {documentsQuery.isLoading ? (
                <Spinner />
              ) : documentsQuery.error ? (
                <div className="p-4">
                  <ErrorBox>{(documentsQuery.error as Error).message}</ErrorBox>
                </div>
              ) : visiveis.length === 0 ? (
                documents.length === 0 ? (
                  <EstadoVazio
                    icone={FileText}
                    titulo="Base vazia"
                    acao={
                      admin && !gestao ? (
                        <Button variant="primary" onClick={() => setGestao(true)}>
                          <Settings2 size={14} /> Enviar documentos
                        </Button>
                      ) : undefined
                    }
                  >
                    {admin
                      ? 'Envie arquivos por Gerenciar — PDF, docx, planilha, Markdown. Vários de uma vez, arrastando.'
                      : 'Nenhum documento foi enviado para esta base ainda.'}
                  </EstadoVazio>
                ) : (
                  <EstadoVazio icone={SearchX} titulo="Nada casa com esse filtro">
                    Nenhum dos {documents.length} documentos desta base bate com{' '}
                    <code>{filtro}</code>.
                  </EstadoVazio>
                )
              ) : (
                <ul className="max-h-[72vh] overflow-y-auto">
                  {visiveis.map((doc) => (
                    <DocumentRow
                      key={doc.id}
                      doc={doc}
                      motorDaBase={spaces.find((s) => s.slug === space)?.chunking?.engine ?? ''}
                      enriquecimentoDaBase={
                        spaces.find((s) => s.slug === space)?.chunking?.enrichment ?? ''
                      }
                      selected={doc.id === selectedId}
                      onClick={() => abrir(doc.id)}
                    />
                  ))}
                </ul>
              )}
            </Card>

            <Card className="min-w-0 px-5 py-4">
              {selectedId ? (
                <DocumentDetail
                  id={selectedId}
                  amplo={esconder}
                  page={pageParam ? Number(pageParam) : null}
                  highlight={highlightParam}
                  admin={admin}
                  space={space}
                  onOpen={abrir}
                  onRemoved={() =>
                    setParams((prev) => {
                      const next = new URLSearchParams(prev);
                      next.delete('doc');
                      next.delete('pagina');
                      next.delete('trecho');
                      return next;
                    })
                  }
                />
              ) : (
                <EstadoVazio icone={MousePointerClick} titulo="Escolha um documento à esquerda">
                  O canônico, o arquivo original e as figuras aparecem aqui, lado a lado.
                </EstadoVazio>
              )}
            </Card>
          </div>
        </>
      )}
    </>
  );
}

/** Uma linha da lista.
 *
 *  O NOME DO ARQUIVO vem primeiro e inteiro (quebra em duas linhas se
 *  precisar), porque é ele a identidade estável do documento. O título vem
 *  abaixo, em uma linha só: ele é extraído do primeiro cabeçalho e às vezes sai
 *  torto ("| Dia | TEMA |"), então não pode empurrar o nome do arquivo para
 *  fora da tela — que era exatamente o defeito da versão anterior. */
function DocumentRow({
  doc,
  motorDaBase,
  enriquecimentoDaBase,
  selected,
  onClick,
}: {
  doc: DocumentSummary;
  /** O motor de corte que a base usa HOJE — nem sempre o que cortou este. */
  motorDaBase: string;
  enriquecimentoDaBase: string;
  selected: boolean;
  onClick: () => void;
}) {
  const falhou = doc.status !== 'indexed';
  return (
    <li>
      <button
        onClick={onClick}
        aria-current={selected ? 'true' : undefined}
        className={`block w-full border-b border-line-soft px-4 py-3 text-left transition-colors ${
          selected ? 'bg-ink-800' : 'hover:bg-ink-850'
        }`}
      >
        <div className="flex items-start gap-2">
          <FileText size={14} className="mt-[3px] shrink-0 text-text-dim" />
          <div className="min-w-0 flex-1">
            <div className="break-words text-[13px] font-semibold leading-snug text-text">
              {doc.filename}
            </div>
            {doc.title && doc.title !== doc.filename ? (
              <div className="truncate text-[12px] text-text-muted" title={doc.title}>
                {doc.title}
              </div>
            ) : null}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {falhou ? (
                <Pill tone="bad" title={doc.error ?? undefined}>
                  {doc.status}
                </Pill>
              ) : null}
              <Pill>{doc.extractor || '—'}</Pill>
              {/* Trocar o motor da base não reprocessa o que já está indexado.
                  Sem marcar aqui quais ficaram para trás, a diferença some — e
                  a base passa a ter dois cortes convivendo sem ninguém saber. */}
              {/* O ENRIQUECIMENTO desalinhado pesa mais que o motor
                  desalinhado, e por isso vem antes: o motor muda onde o trecho
                  começa e termina; o enriquecimento muda o TEXTO INDEXADO. Medido com `ts_rank_cd`, a mesma
                  pergunta pontua 0,0000 num trecho sem o cabeçalho do conceito
                  e 0,4000 com ele — numa base com os dois modos convivendo,
                  metade dos documentos responde e a outra metade não. */}
              {/* Documento que falhou nunca foi indexado: nao ha enriquecimento
                  a comparar, e a etiqueta so escondia o erro real. */}
              {!falhou &&
              doc.chunk_enrichment !== undefined &&
              enriquecimentoDaBase &&
              doc.chunk_enrichment !== enriquecimentoDaBase ? (
                <Pill
                  tone="warn"
                  title={
                    doc.chunk_enrichment
                      ? `enriquecido com "${doc.chunk_enrichment}"; a base usa "${enriquecimentoDaBase}" hoje — reprocesse para alinhar`
                      : `ingerido antes de a variante ser registrada; a base usa "${enriquecimentoDaBase}" hoje — reprocesse para alinhar`
                  }
                >
                  <Settings2 size={10} /> {doc.chunk_enrichment || 'enriquecimento desconhecido'}
                </Pill>
              ) : null}
              {doc.chunk_engine && motorDaBase && doc.chunk_engine !== motorDaBase ? (
                <Pill
                  tone="warn"
                  title={`cortado por "${doc.chunk_engine}"; a base usa "${motorDaBase}" hoje — reprocesse para alinhar`}
                >
                  <Scissors size={10} /> {doc.chunk_engine}
                </Pill>
              ) : null}
              {/* O tipo do conceito, e não um "OKF" genérico: numa base em
                  modo OKF o que interessa é ver QUAIS arquivos foram
                  reconhecidos e como. Bundle em que o modo não pegou fica
                  visível na hora, porque a etiqueta simplesmente não aparece. */}
              {doc.okf_type ? (
                <Pill tone="good" title="conceito reconhecido no formato de entrada OKF">
                  <FileCode size={10} /> {doc.okf_type}
                </Pill>
              ) : null}
              {doc.pages ? <Pill>{doc.pages} pág.</Pill> : null}
              {doc.figures ? (
                <Pill tone="good" title="imagens com texto lido por OCR">
                  <ImageIcon size={10} /> {doc.figures}
                </Pill>
              ) : null}
              <span className="mono text-[11px] text-text-dim">{fmtBytes(doc.size_bytes)}</span>
            </div>
            {falhou && doc.error ? (
              <div className="mt-1 line-clamp-2 text-[11px] text-rose" title={doc.error}>
                {doc.error}
              </div>
            ) : null}
          </div>
        </div>
      </button>
    </li>
  );
}

function DocumentDetail({
  id,
  page,
  highlight,
  admin,
  amplo,
  space,
  onOpen,
  onRemoved,
}: {
  id: number;
  page: number | null;
  highlight: string;
  admin: boolean;
  /** A lista de arquivos está escondida: o conteúdo pode usar mais altura.
   *
   *  Sem isto, esconder a lista daria só LARGURA — e o teto de altura
   *  continuaria cortando o documento na mesma linha, o que faria o botão
   *  parecer que mexeu em metade do problema.
   *
   *  A altura viaja como VARIÁVEL CSS, e não como prop até cada visor. São
   *  cinco componentes (canônico, PDF, docx, planilha, galeria de imagens) com
   *  o teto próprio; passar a flag por todos seria encanamento em cinco
   *  assinaturas para uma decisão de layout, e o próximo visor nasceria sem
   *  ela. Com a variável, quem define é um lugar só e quem usa é CSS. */
  amplo: boolean;
  space: string;
  onOpen: (id: number) => void;
  onRemoved: () => void;
}) {
  const cliente = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['document', id],
    queryFn: () => kb.document(id),
  });
  const figuras = useQuery({
    queryKey: ['figures', id],
    queryFn: () => kb.figures(id),
  });

  // Quem chega pela busca quer ver o ORIGINAL na página do trecho; quem chega
  // pela lista quer ver o canônico. A aba inicial segue essa intenção.
  const [aba, setAba] = useState<Aba>(page ? 'original' : 'canonico');
  /** Formatado ou markdown cru. Fica fora da URL: é preferência de leitura, e
   *  não algo que valha compartilhar num link. */
  const [visao, setVisao] = useState<'formatado' | 'cru'>('formatado');
  useEffect(() => setAba(page ? 'original' : 'canonico'), [id, page]);

  const [copiado, setCopiado] = useState(false);
  const [erroLocal, setErroLocal] = useState('');
  const raw = useAuthedBlob(id, aba === 'original');

  const invalidar = () => {
    void cliente.invalidateQueries({ queryKey: ['documents', space] });
    void cliente.invalidateQueries({ queryKey: ['spaces'] });
    void cliente.invalidateQueries({ queryKey: ['ingest-runs'] });
    void cliente.invalidateQueries({ queryKey: ['stack'] });
  };

  const remover = useMutation({
    mutationFn: () => kb.removeDocument(id),
    onSuccess: () => {
      invalidar();
      onRemoved();
    },
    onError: (err) => setErroLocal((err as Error).message),
  });

  const reprocessar = useMutation({
    mutationFn: () => kb.reprocess(id),
    onSuccess: () => {
      invalidar();
      // O reprocessamento cria um documento NOVO (id novo): o anterior é
      // apagado antes, senão o mesmo sha faria a ingestão devolver "já
      // indexado" e nada aconteceria. Por isso a seleção é solta.
      onRemoved();
    },
    onError: (err) => setErroLocal((err as Error).message),
  });

  if (isLoading) return <Spinner label="Abrindo o documento…" />;
  if (error) return <ErrorBox>{(error as Error).message}</ErrorBox>;
  if (!data) return null;

  const baixar = async () => {
    setErroLocal('');
    try {
      const blob = await kb.raw(data.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = data.filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setErroLocal((err as Error).message);
    }
  };

  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(data.canonical_md);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1500);
    } catch {
      setErroLocal('o navegador bloqueou a área de transferência');
    }
  };

  const abas: { key: Aba; label: string; disabled?: boolean; hint?: string }[] = [
    { key: 'canonico', label: 'Canônico' },
    { key: 'original', label: 'Original' },
    {
      key: 'figuras',
      label: `Imagens${figuras.data?.length ? ` (${figuras.data.length})` : ''}`,
      disabled: !figuras.data?.length,
      hint: figuras.data?.length ? undefined : 'este documento não tem imagem extraída',
    },
  ];

  return (
    <div style={{ '--altura-conteudo': amplo ? '80vh' : '62vh' } as CSSProperties}>
      <h2 className="break-words text-[15px] font-semibold leading-snug">{data.filename}</h2>
      {data.title && data.title !== data.filename ? (
        <p className="mt-0.5 text-[13px] text-text-muted">{data.title}</p>
      ) : null}
      <p className="mono mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-text-dim">
        <span>v{data.version}</span>
        <span>·</span>
        <span>{data.extractor}</span>
        <span>·</span>
        <span>{fmtBytes(data.size_bytes)}</span>
        {data.pages ? (
          <>
            <span>·</span>
            <span>{data.pages} páginas</span>
          </>
        ) : null}
        <span>·</span>
        <span>sha {(data.content_sha ?? '').slice(0, 12)}</span>
        <span>·</span>
        <span>indexado {fmtWhen(data.indexed_at)}</span>
      </p>

      {/* O conceito OKF, quando há um. Fica acima das abas, e não dentro da do
          canônico, porque é a identidade do documento: o frontmatter foi
          retirado da prosa indexada justamente para não virar texto, e sem
          mostrá-lo aqui ele desapareceria da tela por completo. */}
      {data.okf?.type ? <ConceitoOkf okf={data.okf} /> : null}

      <RepresentacoesComFalha estados={data.representation_status ?? []} />

      <div className="mt-3.5 flex flex-wrap items-center gap-2 border-b border-line pb-3.5">
        {abas.map((item) => (
          <button
            key={item.key}
            onClick={() => !item.disabled && setAba(item.key)}
            disabled={item.disabled}
            title={item.hint}
            aria-current={aba === item.key ? 'page' : undefined}
            className={`rounded-lg border px-3 py-1.5 text-[13px] transition-colors disabled:opacity-40 ${
              aba === item.key
                ? 'border-line bg-ink-800 font-semibold text-text'
                : 'border-transparent text-text-muted hover:bg-ink-850'
            }`}
          >
            {item.label}
          </button>
        ))}
        <div className="ml-auto flex flex-wrap gap-2">
          <Button onClick={baixar}>
            <Download size={14} /> Baixar
          </Button>
          {aba === 'canonico' ? (
            <Button onClick={copiar}>
              {copiado ? <Check size={14} /> : <Copy size={14} />}
              {copiado ? 'Copiado' : 'Copiar'}
            </Button>
          ) : null}
          {admin ? (
            <>
              <Button
                onClick={() => {
                  if (
                    confirm(
                      `Reprocessar "${data.filename}" a partir do arquivo original guardado?\n\n` +
                        'Com OCR, um documento grande pode levar vários minutos.',
                    )
                  )
                    reprocessar.mutate();
                }}
                disabled={reprocessar.isPending || remover.isPending}
              >
                <RefreshCw size={14} className={reprocessar.isPending ? 'animate-spin' : ''} />
                {reprocessar.isPending ? 'Reprocessando…' : 'Reprocessar'}
              </Button>
              <Button
                onClick={() => {
                  if (
                    confirm(
                      `Remover "${data.filename}" da base?\n\n` +
                        'Saem os trechos, os vetores, as imagens e o arquivo original. Não dá para desfazer.',
                    )
                  )
                    remover.mutate();
                }}
                disabled={remover.isPending || reprocessar.isPending}
              >
                <Trash2 size={14} /> {remover.isPending ? 'Removendo…' : 'Remover'}
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {erroLocal ? <ErrorBox>{erroLocal}</ErrorBox> : null}

      {aba === 'canonico' ? (
        <div className="mt-3.5">
          {data.related && data.related.length > 0 ? (
            <div className="mb-3.5">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-dim">
                Relacionados pelo grafo
              </div>
              <div className="flex flex-wrap gap-2">
                {data.related.map((rel) => (
                  <button
                    key={rel.id}
                    onClick={() => onOpen(rel.id)}
                    title={rel.title ?? undefined}
                    className="flex max-w-[20rem] items-baseline gap-1.5 rounded-lg border border-line bg-ink-800 px-2.5 py-1 text-[12px] text-text hover:border-ink-500"
                  >
                    <span className="truncate">{rel.title?.trim() || `Documento #${rel.id}`}</span>
                    {/* Link declarado no bundle e termo em comum não valem o
                        mesmo: o primeiro é o que o autor escreveu, o segundo é
                        inferência estatística. Mostrar os dois como "relacionado"
                        sem dizer qual é qual esconde essa diferença. */}
                    <span className="shrink-0 text-text-dim">
                      {rel.via === 'okf'
                        ? `· ${rel.shared} link${rel.shared > 1 ? 's' : ''} OKF`
                        : `· ${rel.shared} termo${rel.shared > 1 ? 's' : ''}`}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {/* FORMATADO POR PADRÃO, com o cru a um clique.
              O canônico é o que a busca indexa, então ver o texto exato importa
              e continua disponível. Mas ler um manual de 30 páginas com as
              tabelas em pipe e os prints como `<!-- figura -->` é ler o
              esqueleto, não o documento — e era a única opção. */}
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-text-dim">
              {data.canonical_md.length.toLocaleString('pt-BR')} caracteres
            </div>
            <div className="ml-auto inline-flex overflow-hidden rounded-lg border border-line">
              {(['formatado', 'cru'] as const).map((modo) => (
                <button
                  key={modo}
                  type="button"
                  onClick={() => setVisao(modo)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[12px] transition-colors ${
                    visao === modo
                      ? 'bg-ink-800 text-text'
                      : 'bg-ink-850 text-text-dim hover:text-text'
                  }`}
                >
                  {modo === 'formatado' ? <Eye size={13} /> : <Code2 size={13} />}
                  {modo === 'formatado' ? 'Formatado' : 'Markdown'}
                </button>
              ))}
            </div>
          </div>
          {visao === 'formatado' ? (
            <div className="max-h-[var(--altura-conteudo,62vh)] overflow-auto rounded-lg border border-line bg-ink-850 p-4">
              <Markdown md={data.canonical_md} documentId={data.id} />
            </div>
          ) : (
            <pre className="canonical max-h-[var(--altura-conteudo,62vh)] overflow-auto rounded-lg border border-line bg-ink-850 p-3.5">
              {data.canonical_md || '(vazio)'}
            </pre>
          )}
        </div>
      ) : null}

      {aba === 'original' ? (
        <div className="mt-3.5">
          {raw.error ? (
            <ErrorBox>{raw.error}</ErrorBox>
          ) : !raw.url ? (
            <Spinner label="Buscando o arquivo original…" />
          ) : (
            <FileViewer
              url={raw.url}
              filename={data.filename}
              mime={data.mime ?? ''}
              page={page}
              highlight={highlight}
            />
          )}
        </div>
      ) : null}

      {aba === 'figuras' ? (
        <div className="mt-3.5">
          <FigureGallery documentId={id} figures={figuras.data ?? []} />
        </div>
      ) : null}
    </div>
  );
}

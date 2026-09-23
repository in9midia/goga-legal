import { type ReactNode, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  FileText,
  Library,
  Lock,
  Plus,
  RefreshCw,
  Scissors,
  Search,
  Settings2,
  Trash2,
  TriangleAlert,
  CircleCheck,
  CircleDashed,
  Loader2,
  BookText,
  Network,
  FlaskConical,
  ImagePlus,
  type LucideIcon,
} from 'lucide-react';
import { kb } from '../lib/api';
import { LADO, TIPOS_ACEITOS, ehImagem, nomeLucide, reduzirParaIcone } from '../lib/icone';
import { ICONES, NOMES, iconeDaBiblioteca } from '../lib/iconeCatalogo';
import { fmtMs, fmtNumber, fmtWhen } from '../lib/format';
import { emAndamento } from '../lib/types';
import type {
  IngestRun,
  AiProvider,
  ChunkConfig,
  ChunkEngine,
  Enrichment,
  Space,
  SpaceProvider,
} from '../lib/types';
import {
  Button,
  Card,
  Dialog,
  EstadoVazio,
  ErrorBox,
  Field,
  Metric,
  Metrics,
  PageHeader,
  Pill,
  Spinner,
  inputClass,
  selectClass,
} from '../components/Ui';

export function SpacesPage() {
  const navigate = useNavigate();
  const cliente = useQueryClient();
  // O log de ingestão é a ÚNICA fonte de "está processando agora": a ingestão é
  // síncrona, então enquanto o POST não volta não há nada no `space` que diga
  // isso. Mesma cadência do painel de envio — rápido enquanto roda, devagar
  // parado — para a tela não consultar à toa o dia inteiro.
  //
  // Ele vem ANTES da consulta dos Espaços de propósito: é ele que decide se a
  // contagem precisa ser atualizada.
  const runs = useQuery({
    queryKey: ['ingest-runs'],
    queryFn: () => kb.ingestRuns(120),
    refetchInterval: (query) => ((query.state.data ?? []).some(emAndamento) ? 3_000 : 20_000),
  });
  const processando = (runs.data ?? []).some(emAndamento);

  // ⚠ A CONTAGEM PRECISA ANDAR ENQUANTO A INGESTÃO ANDA.
  //
  // `documents` e `chunks` vêm daqui, e esta consulta só era refeita quando
  // alguém invalidava — o que não acontece durante uma carga que roda por fora
  // (script, MCP, outra aba). Numa carga de 45 arquivos o cartão dizia "40
  // documentos · 639 trechos" enquanto a base já tinha 44 e 660: o rótulo
  // "processando" piscava ao lado de um número parado, que é pior que não ter
  // número — parece que o trabalho não está rendendo.
  //
  // Dez segundos, e não os três do log: a contagem é agregação sobre `chunk`,
  // mais cara que ler as últimas linhas de `ingest_run`, e ninguém precisa dela
  // com precisão de segundo.
  const { data, isLoading, error } = useQuery({
    queryKey: ['spaces'],
    queryFn: kb.spaces,
    refetchInterval: processando ? 10_000 : false,
  });
  const [criando, setCriando] = useState(false);
  const [motorAberto, setMotorAberto] = useState('');
  const [erroGestao, setErroGestao] = useState('');

  const invalidar = () => {
    void cliente.invalidateQueries({ queryKey: ['spaces'] });
    void cliente.invalidateQueries({ queryKey: ['grants'] });
    void cliente.invalidateQueries({ queryKey: ['stack'] });
  };

  const remover = useMutation({
    mutationFn: (slug: string) => kb.removeSpace(slug),
    onSuccess: invalidar,
    onError: (err) => setErroGestao((err as Error).message),
  });

  if (isLoading) return <Spinner label="Lendo os Espaços…" />;
  if (error) return <ErrorBox>{(error as Error).message}</ErrorBox>;
  if (!data) return null;

  const { spaces, principal } = data;
  const admin = principal.unrestricted;
  const documents = spaces.reduce((sum, s) => sum + s.documents, 0);
  const chunks = spaces.reduce((sum, s) => sum + s.chunks, 0);
  const failed = spaces.reduce((sum, s) => sum + s.failed, 0);

  return (
    <>
      <PageHeader title="Bases de conhecimento">
        Cada base é um Espaço: unidade de configuração e <strong>fronteira de permissão</strong>.
        Você vê {spaces.length}{' '}
        {principal.unrestricted
          ? 'porque seu grupo dá acesso a todos'
          : `porque seus grupos (${principal.groups.join(', ') || 'nenhum'}) alcançam esses`}
        .
      </PageHeader>

      {/* Zero Espaço com token válido é quase sempre uma coisa só: o token não
          traz grupo. Dizer isso na tela evita a conclusão errada de que a base
          está vazia. */}
      {spaces.length === 0 && principal.groups.length === 0 ? (
        <ErrorBox>
          Seu token chegou <strong>sem nenhum grupo</strong>
          {principal.roles?.length ? (
            <>
              {' '}
              (só roles: <code>{principal.roles.slice(0, 4).join(', ')}</code>)
            </>
          ) : null}
          . O escopo por Espaço é resolvido pelo claim <code>groups</code>; sem ele nada é
          alcançável. Se o realm tem grupos, falta o <strong>mapper de group membership</strong> no
          client do Identity — peça a quem administra o realm.
        </ErrorBox>
      ) : null}

      <Card className="mb-4 px-5 py-4">
        <div className="flex flex-wrap items-center gap-4">
          <Metrics>
            <Metric value={spaces.length} label="Espaços" />
            <Metric value={fmtNumber(documents)} label="documentos" />
            <Metric value={fmtNumber(chunks)} label="trechos" />
            <Metric value={failed} label="falhas" />
          </Metrics>
          {admin ? (
            <div className="ml-auto">
              <Button variant="primary" onClick={() => setCriando((v) => !v)}>
                <Plus size={14} /> Nova base
              </Button>
            </div>
          ) : null}
        </div>
      </Card>

      {admin && criando ? (
        <NovaBase
          onPronto={() => {
            setCriando(false);
            invalidar();
          }}
        />
      ) : null}

      {erroGestao ? <ErrorBox>{erroGestao}</ErrorBox> : null}

      {spaces.length === 0 ? (
        <Card className="px-5 py-4">
          {/* Duas causas, duas saídas. Sem separar, quem não tem acesso lia
              "crie uma base" e criava — em vez de pedir acesso à que já existe;
              e quem podia criar não via o caminho. A referência ao script de
              carga saiu: ele roda na máquina de quem desenvolve, e esta tela é
              a mesma que abre no cluster. */}
          {admin ? (
            <EstadoVazio
              icone={Library}
              titulo="Nenhuma base ainda"
              acao={
                <Button variant="primary" onClick={() => setCriando(true)}>
                  <Plus size={14} /> Criar a primeira base
                </Button>
              }
            >
              Cada base é um Espaço: tem a própria configuração de ingestão e é a fronteira de
              permissão. Crie uma e envie os documentos em <strong>Documentos</strong>.
            </EstadoVazio>
          ) : (
            <EstadoVazio icone={Lock} titulo="Nenhuma base alcançável por este acesso">
              As bases existem, mas o seu grupo ainda não alcança nenhuma. Peça a um administrador
              para liberar em <strong>Acessos</strong>.
            </EstadoVazio>
          )}
        </Card>
      ) : (
        // UMA LINHA POR BASE, e não uma grade de cartões.
        //
        // A grade 3x3 gastava a largura inteira com três bases e empurrava a
        // quarta para baixo da dobra. Em linha, a lista cresce na direção em
        // que a tela tem espaço de sobra, e o olho compara documentos e trechos
        // na mesma coluna em vez de caçar o número dentro de cada quadrado.
        <div className="flex flex-col gap-2">
          {spaces.map((space) => (
            <Card key={space.slug} className="px-4 py-3">
              <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
                <IconeDaBase space={space} admin={admin} onSalvo={invalidar} />

                <div className="min-w-[12rem] flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <strong className="text-[15px]">{space.label}</strong>
                    <code className="text-[12px] text-text-dim">{space.slug}</code>
                  </div>
                  <div className="mt-1">
                    <StatusDaBase space={space} runs={runs.data ?? []} />
                  </div>
                </div>

                {/* Os números em largura fixa: alinhados entre as linhas, dá
                    para comparar as bases de cima para baixo sem ler rótulo. */}
                {/* TRÊS NÚMEROS SEMPRE, inclusive o zero de falhas.
                    Esconder o slot quando não há falha mudava a largura da
                    linha e desalinhava a coluna inteira — o preço de comparar
                    as bases de cima para baixo é o slot existir sempre. */}
                <div className="flex shrink-0 items-center gap-5 text-right">
                  <NumeroDaBase valor={space.documents} rotulo="documentos" />
                  <NumeroDaBase valor={fmtNumber(space.chunks)} rotulo="trechos" />
                  <NumeroDaBase
                    valor={
                      space.failed > 0 ? (
                        <span className="inline-flex items-center gap-1 text-rose">
                          <TriangleAlert size={14} />
                          {space.failed}
                        </span>
                      ) : (
                        <span className="text-text-dim">—</span>
                      )
                    }
                    rotulo="falhas"
                  />
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {/* AS TELAS POR BASE ENTRAM POR AQUI, e não pelo menu
                      esquerdo. Documentos, wiki, grafo e benchmark não
                      respondem nada sem um Espaço; no menu elas abriam com um
                      seletor pedindo de novo a escolha que já foi feita aqui.

                      OS CINCO APARECEM SEMPRE, e os que a base não tem ficam
                      desabilitados dizendo por quê. Omitir os inativos fazia
                      cada linha ter uma fila de botões diferente: "Buscar"
                      mudava de lugar de uma base para a outra, e comparar a
                      lista virava caçar o botão. Desabilitado também ensina o
                      que existe — some não ensina nada. */}
                  <AtalhoDaBase
                    icone={FileText}
                    rotulo="Documentos"
                    onClick={() => navigate(`/documentos?espaco=${space.slug}`)}
                  />
                  <AtalhoDaBase
                    icone={BookText}
                    rotulo="Wiki"
                    desabilitadoPorque={
                      space.representations?.wiki
                        ? ''
                        : 'esta base não tem a wiki ligada (mude em configuração)'
                    }
                    onClick={() => navigate(`/wiki?espaco=${space.slug}`)}
                  />
                  <AtalhoDaBase
                    icone={Network}
                    rotulo="Grafo"
                    desabilitadoPorque={
                      space.representations?.grafo
                        ? ''
                        : 'esta base não tem o grafo ligado (mude em configuração)'
                    }
                    onClick={() => navigate(`/grafo?espaco=${space.slug}`)}
                  />
                  <AtalhoDaBase
                    icone={Search}
                    rotulo="Buscar"
                    onClick={() => navigate(`/buscar?espaco=${space.slug}`)}
                  />
                  <AtalhoDaBase
                    icone={FlaskConical}
                    rotulo="Benchmark"
                    desabilitadoPorque={
                      admin ? '' : 'o benchmark gasta IA e é restrito a administrador'
                    }
                    onClick={() => navigate(`/benchmark?espaco=${space.slug}`)}
                  />

                  {/* O chip de configuração perdeu as etiquetas de
                      representação: elas tinham largura variável e eram o que
                      mais desalinhava a linha — e agora são redundantes, porque
                      os botões Wiki e Grafo já dizem o que a base tem ligado.
                      Sobra o motor de corte, que é o que muda com frequência. */}
                  <button
                    type="button"
                    onClick={() =>
                      setMotorAberto((atual) => (atual === space.slug ? '' : space.slug))
                    }
                    className="inline-flex w-[9.5rem] items-center gap-1.5 truncate rounded-lg border border-line bg-ink-800 px-2.5 py-1.5 text-[12px] text-text-muted transition-colors hover:border-ink-500 hover:text-text"
                    title="Modelos de IA, formato de entrada e motor de corte desta base"
                  >
                    <Settings2 size={13} className="shrink-0" />
                    <Scissors size={11} className="shrink-0 text-text-dim" />
                    <strong className="truncate text-text">
                      {rotuloMotor(space.chunking?.engine)}
                    </strong>
                  </button>

                  {/* O slot do remover existe em toda linha, mesmo para quem
                      não administra: sem ele, a fila de botões de um admin e a
                      de um leitor teriam larguras diferentes na mesma tela. */}
                  {admin ? (
                    <button
                      title="Remover a base"
                      disabled={remover.isPending}
                      onClick={() => {
                        // Confirmação por DIGITAÇÃO do slug, não por "ok". Isto
                        // apaga documentos, vetores, imagens e os arquivos
                        // originais de uma área inteira, e não tem desfazer — um
                        // clique acidental num diálogo de "tem certeza?" é fácil
                        // demais para o tamanho do estrago.
                        const digitado = prompt(
                          `Remover a base "${space.label}" e TUDO dentro dela?\n\n` +
                            `Saem ${space.documents} documentos, os trechos, os vetores, as imagens ` +
                            `e os arquivos originais. Não dá para desfazer.\n\n` +
                            `Digite ${space.slug} para confirmar:`,
                        );
                        if (digitado?.trim() === space.slug) remover.mutate(space.slug);
                      }}
                      className="rounded-lg border border-line bg-ink-800 p-2 text-text-dim transition-colors hover:border-rose hover:text-rose disabled:opacity-40"
                    >
                      <Trash2 size={14} />
                    </button>
                  ) : (
                    <span className="w-[2.1rem]" aria-hidden />
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Um único diálogo, fora do laço: o conteúdo é o Espaço escolhido. Um por
          card criaria N elementos na top layer para exibir um. */}
      <ConfiguracaoDaBase
        space={spaces.find((s) => s.slug === motorAberto)}
        admin={admin}
        onFechar={() => setMotorAberto('')}
        onSalvo={invalidar}
      />
    </>
  );
}

/** Um número da base, em coluna estreita para alinhar entre as linhas. */
function NumeroDaBase({ valor, rotulo }: { valor: ReactNode; rotulo: string }) {
  return (
    <div className="min-w-[4.5rem]">
      <div className="text-[17px] font-semibold leading-none">{valor}</div>
      <div className="mt-1 text-[11px] uppercase tracking-wider text-text-dim">{rotulo}</div>
    </div>
  );
}

/** Link para uma tela por base. Ícone com rótulo, não só ícone: numa fila de
 *  cinco atalhos, adivinhar qual é a wiki pelo desenho custa mais que ler. */
function AtalhoDaBase({
  icone: Icone,
  rotulo,
  onClick,
  desabilitadoPorque = '',
}: {
  icone: LucideIcon;
  rotulo: string;
  onClick: () => void;
  /** Vazio = habilitado. Com texto, o botão fica apagado e o motivo vira o
   *  `title` — desabilitado sem motivo visível é o mesmo que quebrado. */
  desabilitadoPorque?: string;
}) {
  const off = Boolean(desabilitadoPorque);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={off}
      title={desabilitadoPorque || undefined}
      className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-ink-800 px-2.5 py-1.5 text-[12px] text-text-muted transition-colors enabled:hover:border-ink-500 enabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-35"
    >
      <Icone size={13} />
      {rotulo}
    </button>
  );
}

/**
 * A marca da base, e o seletor dela.
 *
 * TRÊS FORMAS: ícone da biblioteca da interface (`lucide:Nome`), imagem
 * enviada (`data:` já reduzido), ou nada — e nada cai para a INICIAL do
 * rótulo, não para um ícone genérico: numa lista onde ninguém escolheu, trinta
 * ícones iguais não distinguem nada, e a letra pelo menos separa "Jurídico" de
 * "RH".
 *
 * Quem não administra vê a marca e não o botão. Trocar o ícone muda o que TODO
 * mundo vê — ele identifica a base, não a preferência de quem olha —, e por
 * isso passa pelo mesmo `require_write` das outras mudanças de base.
 */
function MarcaDaBase({ space, tamanho = 22 }: { space: Space; tamanho?: number }) {
  const icone = (space.icon ?? '').trim();
  if (ehImagem(icone)) {
    return <img src={icone} alt="" className="h-7 w-7 rounded object-contain" />;
  }
  const Componente = iconeDaBiblioteca(nomeLucide(icone));
  if (Componente) return <Componente size={tamanho} className="text-text-muted" />;
  if (icone) return <span className="text-[20px] leading-none">{icone}</span>;
  return (
    <span className="text-[17px] font-semibold text-text-dim">
      {(space.label || space.slug).slice(0, 1).toUpperCase()}
    </span>
  );
}

function IconeDaBase({
  space,
  admin,
  onSalvo,
}: {
  space: Space;
  admin: boolean;
  onSalvo: () => void;
}) {
  const [aberto, setAberto] = useState(false);
  const [erro, setErro] = useState('');
  const [preparando, setPreparando] = useState(false);

  const salvar = useMutation({
    mutationFn: (icone: string) => kb.setSpaceIcon(space.slug, icone),
    onSuccess: () => {
      setErro('');
      setAberto(false);
      onSalvo();
    },
    onError: (e) => setErro((e as Error).message),
  });

  async function escolherArquivo(arquivo: File | undefined) {
    if (!arquivo) return;
    setErro('');
    setPreparando(true);
    try {
      // Reduz ANTES de mandar: uma foto de celular tem 4 MB e o ícone gravado
      // tem poucos kB. O servidor reduz de novo — isto aqui poupa a rede, não
      // substitui a validação de lá.
      salvar.mutate(await reduzirParaIcone(arquivo));
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setPreparando(false);
    }
  }

  const caixa = (
    <div className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-line bg-ink-850">
      <MarcaDaBase space={space} />
    </div>
  );
  if (!admin) return caixa;

  const atual = (space.icon ?? '').trim();
  return (
    <>
      <button
        type="button"
        title="Trocar o ícone desta base"
        onClick={() => {
          setErro('');
          setAberto(true);
        }}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-line bg-ink-850 transition-colors hover:border-ink-500"
      >
        <MarcaDaBase space={space} />
      </button>

      <Dialog
        aberto={aberto}
        titulo={`Ícone de ${space.label}`}
        onClose={() => setAberto(false)}
        largura="max-w-lg"
      >
        <div className="grid grid-cols-8 gap-1.5">
          {NOMES.map((nome) => {
            const Icone = ICONES[nome];
            const escolhido = atual === `lucide:${nome}`;
            return (
              <button
                key={nome}
                type="button"
                title={nome}
                disabled={salvar.isPending}
                onClick={() => salvar.mutate(`lucide:${nome}`)}
                className={`grid h-9 place-items-center rounded-lg border transition-colors disabled:opacity-40 ${
                  escolhido
                    ? 'border-accent bg-ink-800 text-text'
                    : 'border-line bg-ink-850 text-text-muted hover:border-ink-500 hover:text-text'
                }`}
              >
                <Icone size={16} />
              </button>
            );
          })}
        </div>

        <div className="mt-4 rounded-lg border border-line bg-ink-850 p-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-lg border border-line bg-ink-950">
              <MarcaDaBase space={space} tamanho={24} />
            </div>
            <div className="min-w-[12rem] flex-1">
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-ink-800 px-2.5 py-1.5 text-[12px] text-text-muted transition-colors hover:border-ink-500 hover:text-text">
                <ImagePlus size={13} />
                {preparando ? 'preparando…' : 'Enviar uma imagem'}
                <input
                  type="file"
                  className="hidden"
                  accept={TIPOS_ACEITOS.join(',')}
                  disabled={salvar.isPending || preparando}
                  onChange={(e) => {
                    void escolherArquivo(e.target.files?.[0]);
                    // Zera o input: escolher o MESMO arquivo de novo depois de
                    // um erro não dispara `change`, e o botão pareceria morto.
                    e.target.value = '';
                  }}
                />
              </label>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-text-dim">
                PNG, JPEG, GIF ou WebP até 8 MB. A imagem é reduzida para {LADO}px aqui e de novo no
                servidor — o que fica gravado tem poucos kB.
              </p>
            </div>
          </div>
        </div>

        {erro ? <ErrorBox>{erro}</ErrorBox> : null}

        <div className="mt-4">
          {/* Tirar é uma ação própria, e não "salvar vazio": sem ela a única
              forma de voltar à inicial seria adivinhar que existe. */}
          <Button disabled={salvar.isPending || !atual} onClick={() => salvar.mutate('')}>
            Tirar o ícone
          </Button>
        </div>
      </Dialog>
    </>
  );
}

const ROTULOS: Record<string, string> = {
  markdown: 'estrutura',
  sentence: 'sentenças',
  semantic: 'assunto',
  fixed: 'tamanho fixo',
};

/**
 * O que está acontecendo nesta base agora.
 *
 * O `space` não guarda estado de processamento; quem sabe é o log de ingestão,
 * que agora também é a fila do servidor:
 *
 * - **processando**: há uma execução `running` (ou `queued`, esperando a vez)
 *   nesta base;
 * - **na fila**: as linhas `queued` desta base. O servidor conhece a fila
 *   inteira, então esse número é verdadeiro, venha a carga de onde vier;
 * - **em dia**: nada em `running` nem `queued`.
 */
function StatusDaBase({ space, runs }: { space: Space; runs: IngestRun[] }) {
  const meus = runs.filter((r) => r.space === space.slug);
  const rodando =
    meus.find((r) => r.status === 'running') ?? meus.find((r) => r.status === 'queued');
  const naFila = meus.filter((r) => r.status === 'queued').length;
  const ultima = meus.find((r) => !emAndamento(r));

  if (rodando) {
    return (
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber/40 bg-amber/10 px-2.5 py-1.5 text-[12px]">
        <Loader2 size={13} className="animate-spin text-amber" />
        <strong className="text-amber">
          {rodando.status === 'queued' ? 'na fila' : 'processando'}
        </strong>
        <span className="min-w-0 flex-1 truncate text-text-muted" title={rodando.filename}>
          {rodando.filename}
        </span>
        {naFila > (rodando.status === 'queued' ? 1 : 0) ? (
          <span className="mono text-text-dim">
            +{naFila - (rodando.status === 'queued' ? 1 : 0)} na fila
          </span>
        ) : null}
        <span className="mono text-text-dim">{fmtMs(rodando.total_ms)}</span>
      </div>
    );
  }

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-[12px]">
      {space.documents === 0 ? (
        <span className="inline-flex items-center gap-1.5 text-text-dim">
          <CircleDashed size={13} /> vazia — nenhum documento ainda
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 text-emerald">
          <CircleCheck size={13} /> processada
        </span>
      )}
      {/* A contagem de falhas saiu daqui: a coluna FALHAS da mesma linha já diz
          o número, e dois lugares dizendo a mesma coisa a dois centímetros um
          do outro fazem parecer que são coisas diferentes. O detalhe de cada
          falha continua onde ele é acionável — no log, dentro de Documentos. */}
      {ultima?.started_at ? (
        <span className="text-text-dim">· última em {fmtWhen(ultima.started_at)}</span>
      ) : null}
    </div>
  );
}

function rotuloMotor(engine?: string): string {
  return ROTULOS[engine ?? ''] ?? engine ?? 'estrutura';
}

/** O diálogo de configuração de uma base: quatro decisões, em seções.
 *
 *  Chamava-se "motor de corte", e deixou de ser verdade. Hoje decide também com
 *  que modelos a base fala e o que o pipeline faz com o documento antes de
 *  cortar — e esses são eixos diferentes, não variações de um só.
 *
 *  Fica por Espaço, e não numa configuração global, porque não existe uma
 *  resposta boa para tudo: um manual com heading e uma ata em texto corrido
 *  pedem cortes diferentes, e uma base de conceitos pede um modo que uma base
 *  de contratos não pede. E porque este projeto existe para comparar técnicas —
 *  com tudo fixo no serviço, não dá para rodar duas lado a lado. */
function ConfiguracaoDaBase({
  space,
  admin,
  onFechar,
  onSalvo,
}: {
  /** `undefined` = nenhum Espaço escolhido, e o diálogo fica fechado. */
  space?: Space;
  admin: boolean;
  onFechar: () => void;
  onSalvo: () => void;
}) {
  return (
    <Dialog
      aberto={!!space}
      onClose={onFechar}
      largura="max-w-4xl"
      titulo={space ? `Ingestão · ${space.label}` : 'Ingestão'}
      descricao="Quatro decisões, na ordem em que o pipeline as toma. Tudo aqui vale para o que for ingerido a partir de agora — o que já está indexado só muda ao reprocessar."
    >
      {/* `key` pelo slug FORÇA a remontagem ao trocar de Espaço. Sem isso, os
          `useState` do formulário guardariam os valores do Espaço anterior: os
          inicializadores só rodam na montagem, e o diálogo é um só, reaproveitado
          por todos os cards. */}
      {space ? (
        <FormularioDeCorte key={space.slug} space={space} admin={admin} onSalvo={onSalvo} />
      ) : null}
    </Dialog>
  );
}

/** Uma seção do diálogo, numerada.
 *
 *  A numeração não é enfeite: as quatro decisões acontecem NESTA ordem no
 *  pipeline (com quem falar, o que fazer com o documento, onde cortar, de que
 *  tamanho), e a versão anterior desta tela empilhava tudo sem hierarquia —
 *  três blocos de texto corrido em que nada dizia o que dependia do quê. */
function Secao({
  numero,
  titulo,
  descricao,
  children,
}: {
  numero: number;
  titulo: string;
  descricao: string;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-line-soft py-4 first:border-t-0 first:pt-0">
      <div className="mb-3 flex items-baseline gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-line text-[11px] text-text-dim">
          {numero}
        </span>
        <div>
          <h3 className="text-[13.5px] font-semibold">{titulo}</h3>
          <p className="text-[12px] leading-relaxed text-text-muted">{descricao}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

/** Um dos dois modelos da base, com o que está em vigor logo abaixo.
 *
 *  O vazio é "usar o padrão da instalação", e é um estado legítimo — não um
 *  campo por preencher. A maioria das bases não escolhe. */
function EscolhaDeModelo({
  rotulo,
  valor,
  opcoes,
  atual,
  admin,
  vazio,
  onTrocar,
}: {
  rotulo: string;
  valor: string;
  opcoes: AiProvider[];
  atual: SpaceProvider | null;
  admin: boolean;
  vazio: string;
  onTrocar: (v: string) => void;
}) {
  return (
    <Field label={rotulo}>
      {admin ? (
        <select className={selectClass} value={valor} onChange={(e) => onTrocar(e.target.value)}>
          <option value="">padrão da instalação</option>
          {opcoes.map((p) => (
            <option key={p.id} value={String(p.id)}>
              {p.name} · {p.model}
            </option>
          ))}
        </select>
      ) : null}
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-text-dim">
        {atual ? (
          <>
            em vigor: <strong className="text-text">{atual.model}</strong>
            <span className="text-text-dim">
              {' '}
              — {atual.from_space ? 'escolhido nesta base' : 'padrão da instalação'}
            </span>
          </>
        ) : (
          <span className="text-amber">{vazio}</span>
        )}
      </p>
    </Field>
  );
}

/** O que o modo escolhido faz, e o que ele custa.
 *
 *  Só o modo ESCOLHIDO é descrito. A versão anterior mostrava o parágrafo
 *  inteiro do OKF o tempo todo, e ele ocupava mais tela do que as quatro
 *  decisões juntas — quem já sabia o que era lia tudo de novo a cada abertura. */
function DetalheDoEnriquecimento({
  modo,
  temChat,
  tipos,
  admin,
  onTipos,
}: {
  modo: Enrichment;
  temChat: boolean;
  tipos: string;
  admin: boolean;
  onTipos: (v: string) => void;
}) {
  const faltaChat = modo.needs_chat && !temChat;
  return (
    <div className="mt-3 rounded-lg border border-line bg-ink-950 p-3">
      <p className="text-[12px] leading-relaxed text-text-muted">{modo.does}.</p>
      <dl className="mt-2 grid gap-1 text-[11.5px] leading-relaxed sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="w-[3.5rem] shrink-0 text-text-dim">serve para</dt>
          <dd className="text-text-muted">{modo.good_for}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-[3.5rem] shrink-0 text-text-dim">custo</dt>
          <dd className={modo.cost === 'nenhum' ? 'text-text-muted' : 'text-amber'}>{modo.cost}</dd>
        </div>
        {modo.spec ? (
          <div className="flex gap-2 sm:col-span-2">
            <dt className="w-[3.5rem] shrink-0 text-text-dim">segue</dt>
            <dd>
              <code className="text-[11px] text-text-dim">{modo.spec}</code>
            </dd>
          </div>
        ) : null}
      </dl>

      {/* Sem o modelo que o modo exige, metade dele não acontece — e em
          silêncio, se a tela não avisar. Aparece aqui, colado na escolha, e não
          no rodapé: avisar depois de salvar seria avisar tarde. */}
      {faltaChat ? (
        <p className="mt-3 rounded-md border border-amber/40 px-2.5 py-2 text-[11.5px] leading-relaxed text-amber">
          Esta base não tem modelo de <strong>chat</strong> em vigor. Escolha um na seção 1, ou
          cadastre em <em>Administração &gt; Modelos de IA</em>. Sem ele, este modo só reconhece o
          que já vier pronto no arquivo.
        </p>
      ) : null}

      {/* O vocabulário só existe para modo que classifica documento. Quem não
          declara `default_types` não mostra campo nenhum — é assim que um modo
          novo entra sem tocar nesta tela. */}
      {modo.default_types ? (
        <div className="mt-3 border-t border-line-soft pt-3">
          <Field label="Tipos que o modelo pode escolher">
            <input
              className={inputClass}
              value={tipos}
              disabled={!admin}
              placeholder={modo.default_types.join(', ')}
              onChange={(event) => onTipos(event.target.value)}
            />
          </Field>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-text-dim">
            Separados por vírgula. O modelo escolhe <strong>um da lista</strong>; quando nenhum
            serve, cai em <code>{modo.generic_type}</code> — ver muitos deles é o sinal de que falta
            um tipo aqui. Com tipo livre, 40 documentos rendem 31 tipos quase iguais e a etiqueta
            deixa de agrupar. Vazio usa o padrão da casa.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** As quatro decisões de ingestão de uma base, na ordem em que o pipeline as
 *  toma: com quem falar, o que fazer com o documento, onde cortar, de que
 *  tamanho.
 *
 *  Modo e motor são EIXOS SEPARADOS, e a tela precisa mostrar isso. O motor diz
 *  onde cortar a prosa; o modo diz o que o pipeline faz com o documento antes
 *  disso. Juntá-los num seletor só obrigaria a escolher entre reconhecer um
 *  conceito e cortar por estrutura — coisas que se somam.
 *
 *  O combo de modo desenha o que o servidor mandar. Um modo novo (destilação em
 *  wiki, ingestão que só alimenta o grafo) é uma entrada no catálogo da API, e
 *  esta tela não muda.
 *
 *  A troca vale para o que for ingerido DEPOIS. Reprocessar sozinho o que já
 *  está indexado levaria horas sem ninguém pedir, então a tela diz isso em vez
 *  de fingir que a mudança é retroativa. */
function FormularioDeCorte({
  space,
  admin,
  onSalvo,
}: {
  space: Space;
  admin: boolean;
  onSalvo: () => void;
}) {
  const atual = space.chunking;
  const catalogo = useQuery({ queryKey: ['chunking-engines'], queryFn: kb.chunkingEngines });
  const provedores = useQuery({
    queryKey: ['ai-providers'],
    queryFn: kb.aiProviders,
    enabled: admin,
  });

  const [engine, setEngine] = useState(atual?.engine ?? 'markdown');
  const [enrichment, setEnrichment] = useState(atual?.enrichment ?? 'nenhum');
  // Representações e auxiliares ativas, como conjunto. Salvam por rota
  // própria — são recurso do Espaço, não configuração do índice.
  const [reps, setReps] = useState<Record<string, boolean>>(space.representations ?? {});
  const [filho, setFilho] = useState(String(atual?.child_chars ?? ''));
  const [pai, setPai] = useState(String(atual?.parent_chars ?? ''));
  const [sobreposicao, setSobreposicao] = useState(String(atual?.child_overlap ?? ''));
  const [percentil, setPercentil] = useState(String(atual?.breakpoint_percentile ?? 95));
  // O vocabulário é editado como texto separado por vírgula, e não como lista
  // de campos: são três a oito valores curtos, e um editor de itens com botão
  // de remover custaria mais tela do que a coisa vale.
  const [tipos, setTipos] = useState((atual?.okf_types ?? []).join(', '));
  // `''` = usar o padrão da instalação. Estado diferente de "nenhum": a maioria
  // das bases não escolhe, e continua não escolhendo.
  const [embedding, setEmbedding] = useState(
    space.ai?.embedding?.from_space ? String(space.ai.embedding.id) : '',
  );
  const [chat, setChat] = useState(space.ai?.chat?.from_space ? String(space.ai.chat.id) : '');
  const [erro, setErro] = useState('');
  const [salvo, setSalvo] = useState(false);

  const enriquecimentos = catalogo.data?.enrichments ?? [];
  const enriquecimentoEscolhido = enriquecimentos.find((e) => e.id === enrichment);
  const motores = catalogo.data?.engines ?? [];
  const motorEscolhido: ChunkEngine | undefined = motores.find((e) => e.id === engine);
  const porProposito = (purpose: string): AiProvider[] =>
    (provedores.data ?? []).filter((p) => p.purpose === purpose && p.active);

  const listaDeTipos = tipos
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const modelosMudaram =
    embedding !== (space.ai?.embedding?.from_space ? String(space.ai.embedding.id) : '') ||
    chat !== (space.ai?.chat?.from_space ? String(space.ai.chat.id) : '');
  const corteMudou =
    engine !== atual?.engine ||
    enrichment !== (atual?.enrichment ?? 'nenhum') ||
    Number(filho) !== atual?.child_chars ||
    Number(pai) !== atual?.parent_chars ||
    Number(sobreposicao) !== atual?.child_overlap ||
    Number(percentil) !== atual?.breakpoint_percentile ||
    listaDeTipos.join(' ') !== (atual?.okf_types ?? []).join(' ');
  const mudou = modelosMudaram || corteMudou;

  // Um botão só, e duas rotas por baixo. São recursos diferentes na API (os
  // modelos são do Espaço, o corte é da configuração de ingestão), mas para
  // quem opera é uma tela — dois botões de salvar convidavam a mexer nos dois
  // lados e publicar só metade.
  const salvar = useMutation({
    mutationFn: async () => {
      if (modelosMudaram) {
        await kb.setSpaceAi(space.slug, {
          embedding_provider_id: embedding ? Number(embedding) : null,
          chat_provider_id: chat ? Number(chat) : null,
        });
      }
      if (corteMudou) {
        await kb.setChunking(space.slug, {
          engine,
          enrichment,
          child_chars: Number(filho) || undefined,
          child_overlap: Number(sobreposicao) || 0,
          parent_chars: Number(pai) || undefined,
          breakpoint_percentile: Number(percentil) || undefined,
          okf_types: listaDeTipos,
        } as ChunkConfig & { engine: string });
      }
    },
    onSuccess: () => {
      setErro('');
      setSalvo(true);
      onSalvo();
    },
    onError: (err) => {
      setSalvo(false);
      setErro((err as Error).message);
    },
  });

  const trocarRepresentacao = (id: string, ligada: boolean) => {
    // Salva na hora, e não junto com o botão de baixo: é outra rota e outro
    // recurso, e agrupar faria um erro de validação do corte desfazer, na
    // cabeça de quem opera, uma escolha de representação que já valeu.
    const antes = reps;
    setReps({ ...reps, [id]: ligada });
    kb.setRepresentations(space.slug, { [id]: ligada })
      .then((r) => {
        setErro('');
        setReps(r.representations);
        onSalvo();
      })
      .catch((e) => {
        setReps(antes);
        setErro((e as Error).message);
      });
  };

  const numerico = (setter: (valor: string) => void) => (event: { target: { value: string } }) => {
    setter(event.target.value.replace(/[^0-9]/g, ''));
    setSalvo(false);
  };
  const mexeu =
    <T,>(setter: (v: T) => void) =>
    (valor: T) => {
      setter(valor);
      setSalvo(false);
    };

  return (
    <>
      <fieldset disabled={!admin} className="contents">
        <Secao
          numero={1}
          titulo="Modelos de IA"
          descricao="Com quem esta base fala. Vazio usa o padrão da instalação."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <EscolhaDeModelo
              rotulo="Embedding"
              valor={embedding}
              opcoes={porProposito('embedding')}
              atual={space.ai?.embedding ?? null}
              admin={admin}
              vazio="nenhum — sem embedding a busca fica só lexical"
              onTrocar={mexeu(setEmbedding)}
            />
            <EscolhaDeModelo
              rotulo="Chat"
              valor={chat}
              opcoes={porProposito('chat')}
              atual={space.ai?.chat ?? null}
              admin={admin}
              vazio="nenhum — modos que classificam documento não vão funcionar"
              onTrocar={mexeu(setChat)}
            />
          </div>
        </Secao>

        <Secao
          numero={2}
          titulo="Representações"
          descricao="O que a ingestão constrói a partir de cada documento. Uma não substitui a outra — elas se somam, e a busca consulta todas as ativas."
        >
          <div className="grid gap-2">
            {(catalogo.data?.representations ?? []).map((r) => {
              const ligada = r.optional ? !!reps[r.id] : true;
              const faltaChat = r.needs_chat && !space.ai?.chat;
              return (
                <label
                  key={r.id}
                  className={`flex gap-3 rounded-lg border p-3 transition-colors ${
                    ligada ? 'border-accent/50 bg-ink-800' : 'border-line bg-ink-950'
                  } ${admin && r.optional ? 'cursor-pointer hover:border-ink-500' : ''}`}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-accent"
                    checked={ligada}
                    disabled={!admin || !r.optional}
                    onChange={(e) => trocarRepresentacao(r.id, e.target.checked)}
                  />
                  <div className="min-w-0">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <strong className="text-[13.5px]">{r.label}</strong>
                      {/* O índice não tem interruptor, e a tela diz por quê em
                          vez de mostrar um checkbox travado sem explicação. */}
                      {!r.optional ? <Pill>sempre ativa</Pill> : null}
                      <code className="text-[11px] text-text-dim">{r.requirement}</code>
                    </div>
                    <p className="text-[12px] leading-relaxed text-text-muted">{r.builds}.</p>
                    <p className="mt-1 text-[11.5px] text-text-dim">
                      Busca por: {r.methods.map((m) => m.label).join(', ')} — entrega{' '}
                      {r.methods[0]?.delivers}.
                    </p>
                    <p
                      className={`mt-1 text-[11.5px] ${
                        r.cost === 'nenhum' ? 'text-text-dim' : 'text-amber'
                      }`}
                    >
                      Custo: {r.cost}.
                    </p>
                    {ligada && faltaChat ? (
                      <p className="mt-2 rounded-md border border-amber/40 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-amber">
                        Esta base não tem modelo de <strong>chat</strong> em vigor — escolha um na
                        seção 1, senão esta representação não é construída.
                      </p>
                    ) : null}
                  </div>
                </label>
              );
            })}
          </div>

          {/* Auxiliares em bloco separado, e não como mais um item da lista: a
              diferença é o que a tela precisa ensinar — auxiliar NÃO cria
              conteúdo, só abre outro caminho até o conteúdo que já existe. */}
          {(catalogo.data?.auxiliaries ?? []).length > 0 ? (
            <div className="mt-4 border-t border-line-soft pt-3">
              <p className="mb-2 text-[11px] uppercase tracking-wide text-text-dim">
                Estruturas auxiliares
              </p>
              <div className="grid gap-2">
                {(catalogo.data?.auxiliaries ?? []).map((a) => {
                  const ligada = !!reps[a.id];
                  const faltaChat = a.needs_chat && !space.ai?.chat;
                  return (
                    <label
                      key={a.id}
                      className={`flex gap-3 rounded-lg border p-3 transition-colors ${
                        ligada ? 'border-accent/50 bg-ink-800' : 'border-line bg-ink-950'
                      } ${admin ? 'cursor-pointer hover:border-ink-500' : ''}`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-accent"
                        checked={ligada}
                        disabled={!admin}
                        onChange={(e) => trocarRepresentacao(a.id, e.target.checked)}
                      />
                      <div className="min-w-0">
                        <div className="mb-1 flex flex-wrap items-center gap-2">
                          <strong className="text-[13.5px]">{a.label}</strong>
                          <Pill>de {a.of}</Pill>
                          <code className="text-[11px] text-text-dim">{a.requirement}</code>
                        </div>
                        <p className="text-[12px] leading-relaxed text-text-muted">
                          {a.summary}. <strong>Não cria conteúdo novo</strong>: os nós apontam para
                          trechos que já existem, e a busca ganha{' '}
                          {a.methods
                            .map((m) => m.label)
                            .join(', ')
                            .toLowerCase()}
                          .
                        </p>
                        <p className="mt-1 text-[11.5px] text-amber">Custo: {a.cost}.</p>
                        {ligada && faltaChat ? (
                          <p className="mt-2 rounded-md border border-amber/40 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-amber">
                            Sem modelo de <strong>chat</strong> nesta base, a extração não acontece.
                          </p>
                        ) : null}
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          ) : null}
        </Secao>

        <Secao
          numero={3}
          titulo="Índice: corte e enriquecimento"
          descricao="Dois slots em sequência, dentro da representação-índice: onde cortar a prosa, e o que prepender a cada trecho antes do embedding."
        >
          {/* Cartões, e não um `select`: a diferença entre os motores está no
              que cada um custa e em que tipo de documento serve, e isso não cabe
              no rótulo de uma opção. */}
          <div className="grid gap-2 sm:grid-cols-2">
            {motores.map((motor) => {
              const ativo = motor.id === engine;
              const gratis = motor.cost === 'nenhum';
              return (
                <button
                  key={motor.id}
                  type="button"
                  disabled={!admin}
                  aria-pressed={ativo}
                  onClick={() => mexeu(setEngine)(motor.id)}
                  className={`rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed ${
                    ativo
                      ? 'border-accent/50 bg-ink-800'
                      : 'border-line bg-ink-950 hover:border-ink-500'
                  }`}
                >
                  <div className="mb-1 flex items-center gap-2">
                    <strong className="text-[13.5px]">{motor.label}</strong>
                    {atual?.engine === motor.id ? <Pill tone="good">atual</Pill> : null}
                  </div>
                  <p className="text-[12px] leading-relaxed text-text-muted">
                    Corta por {motor.cuts_by}. Serve para {motor.good_for}.
                  </p>
                  <p className={`mt-1.5 text-[11.5px] ${gratis ? 'text-text-dim' : 'text-amber'}`}>
                    {gratis ? 'Sem custo por chamada.' : `Custo: ${motor.cost}.`}
                  </p>
                </button>
              );
            })}
          </div>
          <div className="mt-4 border-t border-line-soft pt-3">
            <p className="mb-2 text-[11px] uppercase tracking-wide text-text-dim">
              Enriquecimento de chunk
            </p>
            <select
              className={`${selectClass} sm:max-w-sm`}
              value={enrichment}
              onChange={(e) => mexeu(setEnrichment)(e.target.value)}
            >
              {enriquecimentos.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label} — {e.summary}
                </option>
              ))}
            </select>
            {enriquecimentoEscolhido ? (
              <DetalheDoEnriquecimento
                modo={enriquecimentoEscolhido}
                temChat={!!space.ai?.chat}
                tipos={tipos}
                admin={admin}
                onTipos={mexeu(setTipos)}
              />
            ) : null}
          </div>

          {motorEscolhido ? (
            <>
              <p className="mt-2.5 text-[11.5px] text-text-dim">
                Biblioteca: <code>{motorEscolhido.lib}</code>
              </p>
              {/* A pergunta que esta tela não respondia: "com o cabeçalho de
                  conceito o motor ainda é necessário?". É — o conceito é
                  metadado do documento inteiro e não diz nada sobre onde cortar
                  o corpo. O que muda é o peso da escolha. */}
              {enriquecimentoEscolhido?.default_types ? (
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-text-dim">
                  O conceito diz <strong>o que o documento é</strong>; o motor corta o{' '}
                  <strong>corpo</strong> dele — um conceito longo continua virando vários trechos.
                  Conceito que já cabe num trecho só sai igual em qualquer motor.
                </p>
              ) : null}
            </>
          ) : null}
        </Secao>

        <Secao
          numero={4}
          titulo="Tamanhos"
          descricao="A busca casa no filho (vetor mais preciso) e entrega o pai (com contexto em volta), então o filho precisa ser menor que o pai."
        >
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Filho (caracteres)">
              <input
                className={inputClass}
                value={filho}
                inputMode="numeric"
                onChange={numerico(setFilho)}
              />
            </Field>
            <Field label="Pai (caracteres)">
              <input
                className={inputClass}
                value={pai}
                inputMode="numeric"
                onChange={numerico(setPai)}
              />
            </Field>
            <Field label="Sobreposição">
              <input
                className={inputClass}
                value={sobreposicao}
                inputMode="numeric"
                onChange={numerico(setSobreposicao)}
              />
            </Field>
            {engine === 'semantic' ? (
              <Field label="Percentil de quebra">
                <input
                  className={inputClass}
                  value={percentil}
                  inputMode="numeric"
                  onChange={numerico(setPercentil)}
                />
                <p className="mt-1.5 text-[11.5px] text-text-dim">
                  Menor corta mais: 95 quebra só onde o assunto muda de verdade.
                </p>
              </Field>
            ) : null}
          </div>
        </Secao>
      </fieldset>

      {erro ? <ErrorBox>{erro}</ErrorBox> : null}

      <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-line-soft pt-4">
        {admin ? (
          <>
            <Button
              variant="primary"
              disabled={!mudou || salvar.isPending}
              onClick={() => salvar.mutate()}
            >
              {salvar.isPending ? 'Salvando…' : 'Salvar'}
            </Button>
            <span className="max-w-lg text-[12px] leading-relaxed text-text-muted">
              {salvo ? (
                <>Salvo. Vale para o que entrar a partir de agora.</>
              ) : mudou ? (
                <>
                  Os {fmtNumber(space.chunks)} trechos já indexados não mudam ao salvar
                  {modelosMudaram ? ' — inclusive os vetores, se você trocou o embedding' : ''}.
                  Reprocesse abaixo para alinhar.
                </>
              ) : null}
            </span>
          </>
        ) : (
          <p className="text-[12px] text-text-dim">Só administradores mudam a configuração.</p>
        )}
      </div>

      {admin ? <Reprocessamento space={space} /> : null}
    </>
  );
}

function Reprocessamento({ space }: { space: Space }) {
  const cliente = useQueryClient();
  const [erro, setErro] = useState('');

  const status = useQuery({
    queryKey: ['reprocess', space.slug],
    queryFn: () => kb.reprocessStatus(space.slug),
    // Polling só enquanto roda. Permanente, numa tela aberta o dia inteiro,
    // seria uma requisição a cada 3s sem nada novo para mostrar.
    refetchInterval: (consulta) => (consulta.state.data?.status === 'rodando' ? 3000 : false),
  });

  const iniciar = useMutation({
    mutationFn: (apenasDesalinhados: boolean) => kb.startReprocess(space.slug, apenasDesalinhados),
    onSuccess: (resposta) => {
      setErro(resposta.started ? '' : (resposta.reason ?? ''));
      void status.refetch();
    },
    onError: (e) => setErro((e as Error).message),
  });

  const cancelar = useMutation({
    mutationFn: () => kb.cancelReprocess(space.slug),
    onSuccess: () => void status.refetch(),
    onError: (e) => setErro((e as Error).message),
  });

  const dados = status.data;
  const rodando = dados?.status === 'rodando';
  const desalinhados = dados?.outdated ?? 0;
  const feitos = (dados?.done ?? 0) + (dados?.failed ?? 0);
  const total = dados?.total ?? 0;

  // Ao terminar, os números do card e a lista de documentos mudaram.
  useEffect(() => {
    if (dados?.status === 'concluido' || dados?.status === 'cancelado') {
      void cliente.invalidateQueries({ queryKey: ['spaces'] });
      void cliente.invalidateQueries({ queryKey: ['documents'] });
    }
  }, [dados?.status, cliente]);

  return (
    <section className="mt-4 rounded-lg border border-line bg-ink-950 p-4">
      <h3 className="mb-1 text-[13.5px] font-semibold">Alinhar o que já está indexado</h3>
      <p className="mb-3 text-[12px] leading-relaxed text-text-muted">
        Salvar o motor vale para o que entrar depois. Para aplicar ao que já existe é preciso
        reprocessar a partir do arquivo original, que está guardado.{' '}
        {desalinhados > 0 ? (
          <strong className="text-amber">
            {desalinhados}{' '}
            {desalinhados === 1 ? 'documento está cortado' : 'documentos estão cortados'} por outro
            motor.
          </strong>
        ) : (
          <span className="text-text-dim">Tudo alinhado com o motor atual.</span>
        )}
      </p>

      {rodando ? (
        <>
          <div className="mb-2 h-1.5 overflow-hidden rounded bg-ink-800">
            <div
              className="h-full bg-accent/70 transition-[width] duration-500"
              style={{ width: `${total ? Math.round((feitos / total) * 100) : 0}%` }}
            />
          </div>
          <p className="text-[12px] text-text-muted">
            {feitos} de {total}
            {dados?.failed ? ` · ${dados.failed} com falha` : ''}
            {dados?.current ? (
              <>
                {' · '}
                <span className="text-text-dim">processando {dados.current}</span>
              </>
            ) : null}
          </p>
          <p className="mt-1 text-[11.5px] text-text-dim">
            Roda no servidor. Fechar esta janela ou o navegador não interrompe.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button onClick={() => cancelar.mutate()} disabled={cancelar.isPending}>
              Cancelar
            </Button>
            <span className="text-[11.5px] text-text-dim">
              O documento em curso termina; a fila para depois dele.
            </span>
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              disabled={iniciar.isPending || desalinhados === 0}
              onClick={() => iniciar.mutate(true)}
            >
              <RefreshCw size={13} /> Reprocessar desalinhados
              {desalinhados > 0 ? ` (${desalinhados})` : ''}
            </Button>
            <Button
              disabled={iniciar.isPending || space.documents === 0}
              onClick={() => {
                // Confirmação porque este é o caminho de uma hora, e a diferença
                // entre os dois botões é fácil de não notar.
                if (
                  confirm(
                    `Reprocessar TODOS os ${space.documents} documentos de "${space.label}"?\n\n` +
                      `Cada um é extraído e vetorizado de novo, em série. Na base de RH desta ` +
                      `instalação isso levou cerca de uma hora.\n\n` +
                      `A busca continua funcionando durante o processo.`,
                  )
                )
                  iniciar.mutate(false);
              }}
            >
              Reprocessar todos ({space.documents})
            </Button>
          </div>
          {dados && dados.status !== 'parado' ? (
            <p className="mt-2 text-[12px] text-text-muted">
              Última execução: {dados.status} · {dados.done ?? 0} reprocessados
              {dados.failed ? `, ${dados.failed} com falha` : ''}
              {dados.finished_at ? ` · ${fmtWhen(dados.finished_at)}` : ''}
            </p>
          ) : null}
          {dados?.errors?.length ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-[12px] text-rose">
                {dados.errors.length} {dados.errors.length === 1 ? 'falha' : 'falhas'}
              </summary>
              <ul className="mt-1 space-y-1 text-[11.5px] text-text-muted">
                {dados.errors.map((linha) => (
                  <li key={linha} className="break-words">
                    {linha}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}

      {erro ? <ErrorBox>{erro}</ErrorBox> : null}
    </section>
  );
}

/** Formulário de criação de base.
 *
 *  O slug é derivado do nome e não pedido separado: ele vira parte da URL, do
 *  escopo do MCP e do caminho no object store, e digitar dois campos que
 *  precisam combinar é convite a erro. Continua editável para quem precisar. */
function NovaBase({ onPronto }: { onPronto: () => void }) {
  const [label, setLabel] = useState('');
  const [slug, setSlug] = useState('');
  const [slugManual, setSlugManual] = useState(false);
  const [descricao, setDescricao] = useState('');
  const [erro, setErro] = useState('');

  const criar = useMutation({
    mutationFn: () =>
      kb.createSpace({
        slug: slug.trim(),
        label: label.trim() || slug.trim(),
        description: descricao.trim(),
      }),
    onSuccess: onPronto,
    onError: (err) => setErro((err as Error).message),
  });

  return (
    <Card className="mb-4 px-5 py-4">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!slug.trim()) {
            setErro('informe o nome da base');
            return;
          }
          criar.mutate();
        }}
      >
        <div className="min-w-[14rem] flex-1">
          <Field label="Nome">
            <input
              className={inputClass}
              value={label}
              placeholder="Base Financeiro"
              onChange={(event) => {
                setLabel(event.target.value);
                if (!slugManual) setSlug(paraSlug(event.target.value));
              }}
            />
          </Field>
        </div>
        <div className="w-[12rem]">
          <Field label="Identificador">
            <input
              className={inputClass}
              value={slug}
              placeholder="financeiro"
              onChange={(event) => {
                setSlugManual(true);
                setSlug(paraSlug(event.target.value));
              }}
            />
          </Field>
        </div>
        <div className="min-w-[14rem] flex-1">
          <Field label="Descrição (opcional)">
            <input
              className={inputClass}
              value={descricao}
              onChange={(event) => setDescricao(event.target.value)}
            />
          </Field>
        </div>
        <Button variant="primary" type="submit" disabled={criar.isPending}>
          <Plus size={14} /> Criar
        </Button>
      </form>
      <p className="mt-2.5 text-[12.5px] text-text-dim">
        A base nasce <strong>sem nenhum vínculo</strong>: só administradores a alcançam até alguém
        dar acesso em <code>Acessos</code>. É o contrário do que seria conveniente, e é de propósito
        — base nova com conteúdo visível por engano é mais caro que base invisível.
      </p>
      {erro ? <ErrorBox>{erro}</ErrorBox> : null}
    </Card>
  );
}

/** "Base Financeiro" -> "financeiro". Sem acento, sem espaço, sem maiúscula. */
function paraSlug(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^base\s+/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

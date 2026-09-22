import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CircleAlert,
  FileUp,
  FlaskConical,
  Loader2,
  Square,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { kb } from '../lib/api';
import { fmtBytes, fmtMs, fmtNumber, fmtWhen } from '../lib/format';
import { progressoDaIngestao } from '../lib/progresso';
import { ehAmbienteLocal, leituraDaIngestao, leituraSimulada } from '../lib/leitura';
import { Button, Card, Empty, ErrorBox, Pill, Spinner } from './Ui';
import { RobotReader } from './RobotReader';
import type { IngestRun } from '../lib/types';

/**
 * Enviar documentos e acompanhar o processamento.
 *
 * A ingestão é síncrona: quando o POST volta, o documento já está buscável. O
 * preço é que um arquivo grande com OCR segura a conexão por minutos — e sem
 * esta tela quem enviou fica sem saber se travou. O log de ingestão é a janela
 * para o que acontece enquanto a chamada não volta, e é também onde aparece a
 * tentativa que FALHOU: essa não vira documento, então não estaria em lugar
 * nenhum.
 *
 * ESCOLHER NÃO É ENVIAR
 *
 * A versão anterior disparava a carga no instante do `change` do input. Com
 * quarenta arquivos selecionados de uma vez isso é irreversível e cego: não dava
 * para ver o que tinha sido pego, tirar o errado da lista, nem saber quantos
 * faltavam. Agora há duas fases — a seleção fica numa área de conferência, com
 * tamanho e extensão de cada arquivo, e só o botão de envio começa o trabalho.
 */

/** Extensão em minúsculas, sem o ponto. `""` quando o arquivo não tem. */
function extensaoDe(nome: string): string {
  const ponto = nome.lastIndexOf('.');
  return ponto > 0 ? nome.slice(ponto + 1).toLowerCase() : '';
}

type Resultado = { nome: string; ok: boolean; detalhe: string };

export function IngestPanel({ space }: { space: string }) {
  const cliente = useQueryClient();
  const input = useRef<HTMLInputElement | null>(null);
  /** O que foi escolhido e ainda NÃO foi enviado. */
  const [escolhidos, setEscolhidos] = useState<File[]>([]);
  const [filtro, setFiltro] = useState('');
  const [extsOcultas, setExtsOcultas] = useState<Set<string>>(new Set());
  /** O que está sendo enviado agora, na ordem. Vazio quando não há envio. */
  const [fila, setFila] = useState<File[]>([]);
  const [indice, setIndice] = useState(0);
  const [resultados, setResultados] = useState<Resultado[]>([]);
  const [erro, setErro] = useState('');
  const [arrastando, setArrastando] = useState(false);
  /** Cancelar tem duas partes: soltar a espera do que está no ar (`abort`) e
   *  não mandar o resto (`parar`). Sem a segunda, cancelar um arquivo só
   *  passaria para o próximo. */
  const abortar = useRef<AbortController | null>(null);
  const parar = useRef(false);

  // O log PAGINA, e não mostra "os últimos quarenta". Numa carga de 273
  // arquivos o teto fixo escondia 233 deles — justamente na hora em que o log
  // serve para alguma coisa.
  const [pagina, setPagina] = useState(0);
  const [porPagina, setPorPagina] = useState(50);
  const [soFalhas, setSoFalhas] = useState(false);

  // Trocar de base com a paginação no meio deixaria a tela vazia sem explicação:
  // a página 5 da base grande não existe na base de quatro documentos.
  useEffect(() => {
    setPagina(0);
  }, [space]);

  const runs = useQuery({
    // O log segue a BASE escolhida. Esta tela inteira é sobre uma base — o
    // seletor no topo, a lista de documentos, o envio — e um log com o
    // processamento de todas as outras respondia a uma pergunta que ninguém fez
    // ali: com `jurídico` selecionado, apareciam os 273 arquivos do `lyceum-okf`.
    //
    // O filtro vai no SERVIDOR, e não na página recebida: filtrar depois de
    // cortar mostraria só o que desta base por acaso caísse nas 50 primeiras
    // linhas de todas as bases juntas.
    queryKey: ['ingest-runs', space, pagina, porPagina, soFalhas],
    queryFn: () =>
      kb.ingestRunPage({
        limit: porPagina,
        offset: pagina * porPagina,
        space,
        status: soFalhas ? 'failed' : '',
      }),
    // Enquanto houver algo processando, atualiza rápido; parado, devagar. Sem
    // isso, ou a tela fica estática durante 13 minutos ou consulta à toa o dia
    // inteiro.
    refetchInterval: (query) =>
      (query.state.data?.runs ?? []).some((r) => r.status === 'running') ? 3_000 : 20_000,
  });
  const linhas = runs.data?.runs ?? [];
  const totalRuns = runs.data?.total ?? 0;
  const ultimaPagina = Math.max(0, Math.ceil(totalRuns / porPagina) - 1);

  const enviando = fila.length > 0;

  const extensoes = useMemo(() => {
    const conta = new Map<string, number>();
    for (const f of escolhidos) {
      const ext = extensaoDe(f.name) || 'sem extensão';
      conta.set(ext, (conta.get(ext) ?? 0) + 1);
    }
    return [...conta.entries()].sort((a, b) => b[1] - a[1]);
  }, [escolhidos]);

  /** O que sobra depois do pré-filtro da tela: é ISTO que vai ser enviado. */
  const aEnviar = useMemo(() => {
    const alvo = filtro.trim().toLowerCase();
    return escolhidos.filter((f) => {
      const ext = extensaoDe(f.name) || 'sem extensão';
      if (extsOcultas.has(ext)) return false;
      return !alvo || f.name.toLowerCase().includes(alvo);
    });
  }, [escolhidos, filtro, extsOcultas]);

  const bytes = aEnviar.reduce((s, f) => s + f.size, 0);

  function acrescentar(novos: File[]) {
    setErro('');
    setResultados([]);
    // Acumula em vez de substituir: escolher duas vezes (ou arrastar depois de
    // escolher) é o gesto natural de quem monta uma carga de pastas diferentes.
    // E deduplica por nome+tamanho, senão o mesmo arquivo entra duas vezes e
    // gasta uma ingestão inteira para o servidor responder "já indexado".
    setEscolhidos((antes) => {
      const chave = (f: File) => `${f.name}:${f.size}`;
      const vistos = new Set(antes.map(chave));
      return [...antes, ...novos.filter((f) => !vistos.has(chave(f)))];
    });
  }

  async function enviar() {
    const lote = aEnviar;
    if (!lote.length) return;
    setErro('');
    setResultados([]);
    setFila(lote);
    setIndice(0);
    parar.current = false;

    // Um por vez, em série. Em paralelo, cada arquivo carrega o pipeline de
    // extração no mesmo pod: dois arquivos grandes ao mesmo tempo foi o que já
    // derrubou o serviço por falta de memória.
    const tentados = new Set<string>();
    for (let i = 0; i < lote.length; i += 1) {
      if (parar.current) break;
      const arquivo = lote[i];
      tentados.add(`${arquivo.name}:${arquivo.size}`);
      setIndice(i);
      const controle = new AbortController();
      abortar.current = controle;
      try {
        const corpo = await kb.upload(space, arquivo, controle.signal);
        const detalhe = corpo.already_indexed
          ? 'já estava indexado (mesmo conteúdo)'
          : `${corpo.extractor} · ${corpo.children} ${corpo.children === 1 ? 'trecho' : 'trechos'}${
              corpo.figures ? ` · ${corpo.figures} imagens` : ''
            } · ${fmtMs(corpo.total_ms)}`;
        setResultados((antes) => [...antes, { nome: arquivo.name, ok: true, detalhe }]);
      } catch (err) {
        const cancelado = controle.signal.aborted;
        setResultados((antes) => [
          ...antes,
          {
            nome: arquivo.name,
            ok: false,
            detalhe: cancelado
              ? 'espera cancelada — o servidor termina este arquivo mesmo assim'
              : (err as Error).message,
          },
        ]);
      }
      abortar.current = null;
      void runs.refetch();
    }

    // Só sai da lista o que de fato foi TENTADO. Cancelar no meio precisa
    // deixar o resto escolhido, senão a pessoa seleciona os noventa de novo.
    setEscolhidos((antes) => antes.filter((f) => !tentados.has(`${f.name}:${f.size}`)));
    setFila([]);
    parar.current = false;
    void cliente.invalidateQueries({ queryKey: ['documents', space] });
    void cliente.invalidateQueries({ queryKey: ['spaces'] });
    void cliente.invalidateQueries({ queryKey: ['stack'] });
  }

  function cancelar() {
    parar.current = true;
    abortar.current?.abort();
  }

  // A ATIVIDADE, para o progresso. Consulta própria, sem filtro e sem
  // paginação: o log da tabela abaixo pode estar na página 3 ou filtrado por
  // falhas, e calcular ritmo em cima de uma fatia dessas daria um número que
  // não descreve a rodada.
  const atividade = useQuery({
    queryKey: ['ingest-atividade', space],
    queryFn: () => kb.ingestRunPage({ limit: 60, offset: 0, space }),
    enabled: !!space,
    refetchInterval: (q) =>
      (q.state.data?.runs ?? []).some((r) => r.status === 'running') ? 3_000 : 30_000,
  });
  const progresso = progressoDaIngestao(
    atividade.data?.runs ?? [],
    enviando ? { total: fila.length, indice } : null,
  );

  /** O que a animação do robô leitor mostra. Sai do que já existia nesta tela
   *  (a fila local e o log de ingestão), sem uma consulta a mais ao servidor. */
  const real = leituraDaIngestao(
    enviando ? { fila: fila.map((f) => f.name), indice, concluidos: resultados.length } : null,
    linhas,
  );

  // ── o robô ──────────────────────────────────────────────────────────────
  /** A cena fica aberta por vontade de quem está olhando, e não só enquanto há
   *  trabalho: um robô ocioso na poltrona é o que o botão mostra. Processamento
   *  abre sozinho; fechar continua possível no meio dele, para quem só quer a
   *  tabela. */
  const [roboAberto, setRoboAberto] = useState(false);
  const [simulando, setSimulando] = useState(false);
  const [passoSimulado, setPassoSimulado] = useState(0);
  const local = ehAmbienteLocal(window.location.hostname);

  useEffect(() => {
    if (real.ativo) setRoboAberto(true);
  }, [real.ativo]);

  useEffect(() => {
    if (!simulando) return;
    // 4,2 s por arquivo: a troca de livro leva cerca de 1,6 s, e um intervalo
    // mais curto deixaria o robô trocando sem nunca chegar a ler.
    const id = window.setInterval(() => setPassoSimulado((n) => n + 1), 4_200);
    return () => window.clearInterval(id);
  }, [simulando]);

  const simulacaoVisivel = simulando && !real.ativo;
  const leitura = simulacaoVisivel
    ? leituraSimulada(
        linhas.map((r) => r.filename),
        passoSimulado,
      )
    : real;

  const limpar = useMutation({
    mutationFn: kb.clearIngestRuns,
    onSuccess: () => runs.refetch(),
    onError: (err) => setErro((err as Error).message),
  });

  return (
    <div className="grid gap-4">
      {/* ── área de arraste ─────────────────────────────────────────────── */}
      <Card
        className={`px-5 py-4 transition-colors ${arrastando ? 'border-blue bg-ink-850' : ''}`}
        onDragOver={(event: React.DragEvent) => {
          event.preventDefault();
          setArrastando(true);
        }}
        onDragLeave={() => setArrastando(false)}
        onDrop={(event: React.DragEvent) => {
          event.preventDefault();
          setArrastando(false);
          const arquivos = Array.from(event.dataTransfer.files);
          if (arquivos.length) acrescentar(arquivos);
        }}
      >
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={enviando}
          className={`flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors ${
            arrastando
              ? 'border-blue bg-ink-900'
              : 'border-line hover:border-line-strong hover:bg-ink-900/60'
          } disabled:cursor-not-allowed disabled:opacity-50`}
        >
          <FileUp size={26} className={arrastando ? 'text-blue' : 'text-text-dim'} />
          <span className="text-[14px] font-semibold">
            Arraste os arquivos para cá, ou <span className="text-accent">escolha documentos</span>
          </span>
          <span className="text-[12.5px] text-text-muted">
            Você confere a lista antes de enviar. Nada sai daqui até você clicar em enviar.
          </span>
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const arquivos = Array.from(event.target.files ?? []);
            event.target.value = '';
            if (arquivos.length) acrescentar(arquivos);
          }}
        />
        {erro ? <ErrorBox>{erro}</ErrorBox> : null}
      </Card>

      {/* ── conferência: o que foi escolhido, antes de enviar ───────────── */}
      {escolhidos.length > 0 ? (
        <Card className="px-5 py-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <strong className="text-[13.5px]">
              {escolhidos.length} {escolhidos.length === 1 ? 'arquivo' : 'arquivos'} escolhidos
            </strong>
            {aEnviar.length !== escolhidos.length ? (
              <Pill tone="warn">{aEnviar.length} passam pelo filtro</Pill>
            ) : null}
            <span className="mono text-[12px] text-text-dim">{fmtBytes(bytes)}</span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Button onClick={() => setEscolhidos([])} disabled={enviando}>
                <X size={14} /> Limpar seleção
              </Button>
              <Button
                variant="primary"
                onClick={() => void enviar()}
                disabled={enviando || !aEnviar.length}
              >
                {enviando ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                Enviar {aEnviar.length} {aEnviar.length === 1 ? 'arquivo' : 'arquivos'}
              </Button>
            </div>
          </div>

          {/* Pré-filtro em tela: com cem arquivos escolhidos, tirar os cinco
              errados um a um é pior do que filtrar e limpar o resto. */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input
              className="w-full max-w-xs rounded-lg border border-line bg-ink-950 px-3 py-1.5 text-[13px] outline-none focus:border-line-strong"
              placeholder="filtrar por nome"
              value={filtro}
              onChange={(e) => setFiltro(e.target.value)}
            />
            {extensoes.map(([ext, n]) => {
              const oculta = extsOcultas.has(ext);
              return (
                <button
                  key={ext}
                  type="button"
                  onClick={() =>
                    setExtsOcultas((antes) => {
                      const proximo = new Set(antes);
                      if (oculta) proximo.delete(ext);
                      else proximo.add(ext);
                      return proximo;
                    })
                  }
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] transition-colors ${
                    oculta
                      ? 'border-line bg-ink-950 text-text-dim line-through'
                      : 'border-line-strong bg-ink-850 text-text'
                  }`}
                  title={oculta ? 'incluir de volta' : 'tirar do envio'}
                >
                  <span className="mono">.{ext}</span>
                  <span className="text-text-dim">{n}</span>
                </button>
              );
            })}
          </div>

          <ul className="max-h-72 overflow-y-auto rounded-lg border border-line-soft">
            {aEnviar.map((f, i) => {
              const posicao = enviando ? fila.findIndex((x) => x.name === f.name) : -1;
              const feito = resultados.find((r) => r.nome === f.name);
              const atual = enviando && posicao === indice;
              return (
                <li
                  key={`${f.name}:${f.size}:${i}`}
                  className={`flex items-center gap-3 border-b border-line-soft px-3 py-2 text-[12.5px] last:border-0 ${
                    atual ? 'bg-ink-850' : ''
                  }`}
                >
                  <span className="w-6 shrink-0 text-center">
                    {feito?.ok ? (
                      <Check size={14} className="mx-auto text-emerald" />
                    ) : feito ? (
                      <CircleAlert size={14} className="mx-auto text-rose" />
                    ) : atual ? (
                      <Loader2 size={14} className="mx-auto animate-spin text-amber" />
                    ) : (
                      <span className="mono text-text-dim">{i + 1}</span>
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={f.name}>
                    {f.name}
                  </span>
                  <span className="mono shrink-0 rounded border border-line px-1.5 text-[11px] text-text-dim">
                    {extensaoDe(f.name) || '—'}
                  </span>
                  <span className="mono w-20 shrink-0 text-right text-text-dim">
                    {fmtBytes(f.size)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setEscolhidos((antes) => antes.filter((x) => x !== f))}
                    disabled={enviando}
                    className="shrink-0 rounded p-1 text-text-dim hover:bg-ink-800 hover:text-text disabled:opacity-30"
                    title="tirar da lista"
                  >
                    <X size={13} />
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      {/* ── fila em andamento ───────────────────────────────────────────── */}
      {enviando ? (
        <Card className="px-5 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <Loader2 size={16} className="animate-spin text-amber" />
            <strong className="text-[13.5px]">
              {indice + 1} de {fila.length}
            </strong>
            <span className="min-w-0 flex-1 truncate text-[13px] text-text-muted">
              {fila[indice]?.name}
            </span>
            <span className="mono text-[12px] text-text-dim">
              faltam {Math.max(0, fila.length - indice - 1)}
            </span>
            <Button onClick={cancelar}>
              <Ban size={14} /> Cancelar envio
            </Button>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-ink-850">
            <div
              className="h-full bg-accent transition-all"
              style={{ width: `${((indice + 1) / fila.length) * 100}%` }}
            />
          </div>
          {/* Precisa estar escrito: abortar solta a ESPERA, não o trabalho. Sem
              este aviso, o arquivo aparece indexado depois do cancelamento e a
              tela parece ter mentido. */}
          <p className="mt-2 text-[12px] text-text-dim">
            Cancelar interrompe a fila. O arquivo que já está no servidor termina de ser processado
            — ele vai aparecer no log abaixo.
          </p>
        </Card>
      ) : null}

      {resultados.length > 0 && !enviando ? (
        <Card className="px-5 py-4">
          <ul className="grid gap-1">
            {resultados.map((item, i) => (
              <li
                key={`${item.nome}:${i}`}
                className="flex flex-wrap items-baseline gap-2 text-[12.5px]"
              >
                {item.ok ? <Pill tone="good">ok</Pill> : <Pill tone="bad">falhou</Pill>}
                <span className="font-semibold">{item.nome}</span>
                <span className="text-text-muted">{item.detalhe}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* ── quanto já andou, e quanto falta ────────────────────────────── */}
      {progresso && (progresso.ativo || progresso.concluidos > 0) ? (
        <Card className="px-5 py-3.5">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <span className="flex items-baseline gap-1.5">
              <strong className="text-[17px]">{progresso.concluidos}</strong>
              <span className="text-[12px] text-text-muted">
                {progresso.faltam === null
                  ? 'processados nesta rodada'
                  : `de ${progresso.concluidos + progresso.faltam + (progresso.ativo ? 1 : 0)}`}
              </span>
            </span>

            {progresso.faltam !== null ? (
              <span className="flex items-baseline gap-1.5">
                <strong className="text-[17px] text-amber">{progresso.faltam}</strong>
                <span className="text-[12px] text-text-muted">na fila</span>
              </span>
            ) : null}

            <span className="flex items-baseline gap-1.5">
              <strong className="mono text-[15px]">{fmtMs(progresso.decorrido_ms)}</strong>
              <span className="text-[12px] text-text-muted">decorridos</span>
            </span>

            {progresso.media_ms !== null ? (
              <span className="flex items-baseline gap-1.5">
                <strong className="mono text-[15px]">{fmtMs(progresso.media_ms)}</strong>
                <span className="text-[12px] text-text-muted">por arquivo, em média</span>
              </span>
            ) : null}

            {progresso.restante_ms !== null ? (
              <span className="flex items-baseline gap-1.5">
                <strong className="mono text-[15px] text-amber">
                  ~{fmtMs(progresso.restante_ms)}
                </strong>
                <span className="text-[12px] text-text-muted">para terminar</span>
              </span>
            ) : null}
          </div>

          {progresso.faltam !== null ? (
            <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-ink-850">
              <div
                className="h-full bg-accent transition-all"
                style={{
                  width: `${
                    (progresso.concluidos /
                      Math.max(
                        1,
                        progresso.concluidos + progresso.faltam + (progresso.ativo ? 1 : 0),
                      )) *
                    100
                  }%`,
                }}
              />
            </div>
          ) : (
            // SEM BARRA quando a carga vem de fora, e isto é deliberado: o
            // servidor processa um arquivo por requisição e não sabe quantos
            // virão. Uma barra com total chutado andaria para trás a cada
            // arquivo novo, que é pior que não ter barra.
            <p className="mt-2 text-[11.5px] text-text-dim">
              A carga veio de fora desta tela (script, MCP ou outra aba), então o total não é
              conhecido aqui — o servidor recebe um arquivo por vez. O ritmo acima é medido, e serve
              para estimar: a{' '}
              <strong className="text-text-muted">{fmtMs(progresso.media_ms ?? 0)}</strong> por
              arquivo, cem documentos levariam cerca de{' '}
              <strong className="text-text-muted">{fmtMs((progresso.media_ms ?? 0) * 100)}</strong>.
            </p>
          )}
        </Card>
      ) : null}

      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="text-[13px] font-semibold uppercase tracking-wider text-text-dim">
            Processamento
          </h3>
          {/* O total é o que faz "50 linhas" deixar de ser confundível com "só
              houve 50 arquivos". */}
          <span className="mono text-[12px] text-text-dim">
            {fmtNumber(totalRuns)} {totalRuns === 1 ? 'registro' : 'registros'} nesta base
          </span>
          {linhas.some((r) => r.status === 'running') ? (
            <Pill tone="warn">
              <Loader2 size={10} className="animate-spin" /> em andamento
            </Pill>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setSoFalhas((v) => !v);
              setPagina(0);
            }}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] transition-colors ${
              soFalhas
                ? 'border-rose/60 bg-rose/10 text-rose'
                : 'border-line bg-ink-950 text-text-dim hover:text-text'
            }`}
          >
            <CircleAlert size={12} /> só as falhas
          </button>
          {/* Só o ícone: é um adorno com utilidade, e um rótulo escrito ao lado
              dos controles do log daria a ele um peso que ele não tem. */}
          <button
            type="button"
            onClick={() => setRoboAberto((v) => !v)}
            aria-pressed={roboAberto}
            aria-label={roboAberto ? 'esconder o robô leitor' : 'mostrar o robô leitor'}
            title={roboAberto ? 'esconder o robô leitor' : 'mostrar o robô leitor'}
            className={`inline-flex items-center justify-center rounded-lg border p-1.5 transition-colors ${
              roboAberto
                ? 'border-line bg-ink-800 text-text'
                : 'border-line bg-ink-950 text-text-dim hover:text-text'
            }`}
          >
            <Bot size={14} />
          </button>
          {/* Só na máquina de quem desenvolve. Não manda nada para o servidor:
              alimenta a cena com nomes do próprio log, para dar para ver a troca
              de livro sem queimar uma ingestão de verdade. */}
          {local ? (
            <button
              type="button"
              onClick={() => {
                setSimulando((v) => !v);
                setRoboAberto(true);
              }}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] transition-colors ${
                simulando
                  ? 'border-amber/60 bg-amber/10 text-amber'
                  : 'border-line bg-ink-950 text-text-dim hover:text-text'
              }`}
              title="só aparece em localhost"
            >
              {simulando ? <Square size={12} /> : <FlaskConical size={12} />}
              {simulando ? 'parar simulação' : 'simular atividade'}
            </button>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <select
              className="rounded-lg border border-line bg-ink-950 px-2 py-1 text-[12px] outline-none"
              value={porPagina}
              onChange={(e) => {
                setPorPagina(Number(e.target.value));
                setPagina(0);
              }}
              aria-label="linhas por página"
            >
              {[50, 100, 250, 500].map((n) => (
                <option key={n} value={n}>
                  {n} por página
                </option>
              ))}
            </select>
            <Button onClick={() => limpar.mutate()} disabled={limpar.isPending}>
              <Trash2 size={14} /> Limpar log
            </Button>
          </div>
        </div>

        {/* A cena existe enquanto o botão estiver ligado, e o botão liga sozinho
            quando começa um processamento. Desligado, nada disso é carregado:
            nem o chunk do three, nem contexto de WebGL. */}
        {roboAberto ? (
          <div className="mb-3">
            <RobotReader leitura={leitura} imediato={!real.ativo} simulado={simulacaoVisivel} />
          </div>
        ) : null}

        <Card className="overflow-x-auto">
          {runs.isLoading ? (
            <Spinner />
          ) : runs.error ? (
            <div className="p-4">
              <ErrorBox>{(runs.error as Error).message}</ErrorBox>
            </div>
          ) : linhas.length === 0 ? (
            <div className="px-5">
              <Empty>
                {soFalhas
                  ? 'Nenhuma falha registrada nesta base.'
                  : 'Nenhuma ingestão registrada nesta base.'}
              </Empty>
            </div>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-[11px] uppercase tracking-wider text-text-dim">
                  <th className="px-4 py-2.5 text-left font-semibold">Arquivo</th>
                  <th className="whitespace-nowrap px-4 py-2.5 text-left font-semibold">Espaço</th>
                  <th className="whitespace-nowrap px-4 py-2.5 text-left font-semibold">Estado</th>
                  <th className="whitespace-nowrap px-4 py-2.5 text-right font-semibold">Tempo</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Resultado</th>
                  <th className="whitespace-nowrap px-4 py-2.5 text-left font-semibold">Quando</th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((run) => (
                  <LinhaRun key={run.id} run={run} />
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {ultimaPagina > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px]">
            <Button onClick={() => setPagina(0)} disabled={pagina === 0}>
              <ChevronsLeft size={14} />
            </Button>
            <Button onClick={() => setPagina((n) => Math.max(0, n - 1))} disabled={pagina === 0}>
              <ChevronLeft size={14} /> anterior
            </Button>
            <span className="mono text-text-dim">
              {pagina * porPagina + 1}–{Math.min((pagina + 1) * porPagina, totalRuns)} de{' '}
              {fmtNumber(totalRuns)}
            </span>
            <Button
              onClick={() => setPagina((n) => Math.min(ultimaPagina, n + 1))}
              disabled={pagina >= ultimaPagina}
            >
              próxima <ChevronRight size={14} />
            </Button>
            <Button onClick={() => setPagina(ultimaPagina)} disabled={pagina >= ultimaPagina}>
              <ChevronsRight size={14} />
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LinhaRun({ run }: { run: IngestRun }) {
  // O erro fica GUARDADO até alguém pedir. Ele é longo (stack de extrator,
  // resposta do provedor) e aparecia sempre, embaixo do nome: numa página de 50
  // linhas com muitas falhas, a tabela virava parede de texto vermelho e o que
  // se procurava — qual arquivo falhou — sumia no meio. Cortá-lo em 220
  // caracteres resolvia a parede e criava outro problema: a causa costuma estar
  // no fim da mensagem, e o corte a escondia.
  const [erroAberto, setErroAberto] = useState(false);
  const tone =
    run.status === 'indexed'
      ? 'good'
      : run.status === 'failed'
        ? 'bad'
        : run.status === 'running'
          ? 'warn'
          : 'neutral';
  const rotulo =
    run.status === 'running'
      ? 'processando'
      : run.status === 'skipped'
        ? 'já indexado'
        : run.status === 'indexed'
          ? 'indexado'
          : 'falhou';
  return (
    <>
      <tr className={erroAberto ? '' : 'border-b border-line-soft last:border-0'}>
        <td className="max-w-[22rem] px-4 py-2.5">
          <div className="break-words font-semibold">{run.filename}</div>
        </td>
        {/* O slug é um identificador: quebrá-lo em duas linhas transforma
          `lyceum-okf` em `lyceum-` / `okf`, que se lê como outra base. */}
        <td className="whitespace-nowrap px-4 py-2.5">
          <code className="text-text-dim">{run.space}</code>
        </td>
        <td className="whitespace-nowrap px-4 py-2.5">
          {/* Com erro, a etiqueta É o botão: é nela que a pessoa clica por
            instinto quando quer saber o que houve. Sem erro ela continua sendo
            só etiqueta — um botão que não faz nada ensina a não clicar. */}
          {run.error ? (
            <button
              type="button"
              onClick={() => setErroAberto((v) => !v)}
              aria-expanded={erroAberto}
              className="inline-flex items-center gap-1 rounded-lg transition-opacity hover:opacity-80"
              title={erroAberto ? 'esconder o erro' : 'ver o erro'}
            >
              <Pill tone={tone}>
                {rotulo}
                <ChevronDown
                  size={11}
                  className={`transition-transform ${erroAberto ? 'rotate-180' : ''}`}
                />
              </Pill>
            </button>
          ) : (
            <Pill tone={tone}>
              {run.status === 'running' ? <Loader2 size={10} className="animate-spin" /> : null}
              {rotulo}
            </Pill>
          )}
        </td>
        <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">
          {fmtMs(run.total_ms)}
        </td>
        <td className="px-4 py-2.5 text-text-muted">
          {run.status === 'indexed' ? (
            <>
              {run.extractor} · {run.children} {run.children === 1 ? 'trecho' : 'trechos'}
              {/* O motor de corte fica ao lado do tempo de propósito: é o par que
                permite comparar técnicas — "semantic levou 34 s e deu 20
                trechos; markdown levou 3 s e deu 15". */}
              {run.chunk_engine ? ` · corte ${run.chunk_engine}` : ''}
              {run.pages ? ` · ${run.pages} pág.` : ''}
              {run.figures ? ` · ${run.figures} imagens` : ''}
            </>
          ) : run.status === 'running' ? (
            fmtBytes(run.size_bytes)
          ) : (
            '—'
          )}
        </td>
        <td className="whitespace-nowrap px-4 py-2.5 text-text-dim">{fmtWhen(run.started_at)}</td>
      </tr>
      {/* O erro INTEIRO, sem corte: a causa costuma estar no fim da mensagem
          (o "tentados: docling, plain" que diz o que foi testado, a resposta do
          provedor), e era justamente o fim que o corte em 220 caracteres
          escondia. Numa linha própria porque a coluna do arquivo tem 22rem e
          uma stack não cabe ali sem virar uma coluna de letras. */}
      {erroAberto && run.error ? (
        <tr className="border-b border-line-soft last:border-0">
          <td colSpan={6} className="px-4 pb-3">
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-rose/40 bg-rose/5 px-3 py-2 text-[11.5px] leading-relaxed text-rose">
              {run.error}
            </pre>
          </td>
        </tr>
      ) : null}
    </>
  );
}

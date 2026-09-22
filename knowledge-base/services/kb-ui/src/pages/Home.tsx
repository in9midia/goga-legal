import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, History, Library, Plug, ScanText, Search, ShieldCheck } from 'lucide-react';
import { kb } from '../lib/api';
import { currentUser } from '../lib/auth';
import { fmtNumber } from '../lib/format';
import { Card, ErrorBox, Metric, Metrics, Spinner } from '../components/Ui';

/**
 * A primeira tela.
 *
 * Ela responde três perguntas, nesta ordem: **o que é isto**, **o que já tem
 * dentro** e **o que eu faço agora**. Um painel de números sozinho não serve
 * como início — quem chega pela primeira vez não sabe o que é um "Espaço" nem
 * por que a busca devolve trecho em vez de resposta.
 */
export function Home() {
  const user = currentUser();
  const navigate = useNavigate();
  const spaces = useQuery({ queryKey: ['spaces'], queryFn: kb.spaces });

  const bases = spaces.data?.spaces ?? [];
  const documentos = bases.reduce((soma, s) => soma + s.documents, 0);
  const trechos = bases.reduce((soma, s) => soma + s.chunks, 0);
  const admin = spaces.data?.principal.unrestricted ?? false;
  const primeiroNome = (user?.displayName ?? '').split(' ')[0];

  return (
    <>
      <header className="mb-7">
        <h1 className="text-2xl font-semibold tracking-tight">
          {primeiroNome ? `Olá, ${primeiroNome}.` : 'Base de conhecimento'}
        </h1>
        <p className="mt-2 max-w-3xl text-[14px] leading-relaxed text-text-muted">
          Esta é a base de conhecimento do Goga Legal. Ela guarda os documentos como eles são,
          extrai deles um texto limpo que a busca indexa, e devolve{' '}
          <strong className="text-text">o trecho e a página de onde a resposta saiu</strong> — para
          uma pessoa aqui, ou para o agente de IA do seu editor, pelo MCP.
        </p>
      </header>

      {spaces.isLoading ? <Spinner label="Lendo as suas bases…" /> : null}
      {spaces.error ? <ErrorBox>{(spaces.error as Error).message}</ErrorBox> : null}

      {spaces.data ? (
        <Card className="mb-7 px-5 py-4">
          <div className="flex flex-wrap items-center gap-5">
            <Metrics>
              <Metric value={bases.length} label="bases que você alcança" />
              <Metric value={fmtNumber(documentos)} label="documentos" />
              <Metric value={fmtNumber(trechos)} label="trechos indexados" />
            </Metrics>
            <p className="ml-auto max-w-sm text-[12.5px] text-text-dim">
              {bases.length === 0 ? (
                <>
                  Você não alcança nenhuma base ainda. O acesso é por grupo do Identity — quem
                  administra pode incluir o seu.
                </>
              ) : (
                <>
                  Você vê estas porque{' '}
                  {admin ? 'seu grupo dá acesso a todas' : 'seus grupos as alcançam'}. A fronteira é
                  aplicada no servidor, em toda leitura — inclusive pelo MCP.
                </>
              )}
            </p>
          </div>
        </Card>
      ) : null}

      {/* ── por onde começar ── */}
      <h2 className="mb-1 text-[15px] font-semibold">Por onde começar</h2>
      <p className="mb-3.5 text-[13px] text-text-muted">
        As duas primeiras respondem “o que tem na base?”. A terceira é a que muda o dia a dia.
      </p>
      <div className="mb-7 grid gap-3 md:grid-cols-3">
        <Atalho
          para="/buscar"
          icone={Search}
          titulo="Fazer uma pergunta"
          texto="O simulador roda a mesma busca que o agente faz, com os scores e o tempo à vista. É o jeito mais rápido de ver se a base sabe o que você precisa."
        />
        {/* Leva a BASES, e não direto a Documentos: documento vive dentro de
            um Espaço, e a tela sem `?espaco=` só saberia pedir que se escolha
            um. Um atalho que leva a outro pedido de escolha não é atalho. */}
        <Atalho
          para="/bases"
          icone={Library}
          titulo="Ver o que está indexado"
          texto="Cada base com seus documentos, a wiki e o grafo ao lado. Dentro do documento, o texto que a busca leu, o arquivo original e as imagens com o que o OCR extraiu."
        />
        <Atalho
          para="/conectar"
          icone={Plug}
          titulo="Conectar o seu editor"
          texto="Claude Desktop, Cursor, Claude Code. O agente passa a consultar a base com o SEU acesso — e cita a fonte."
          destaque
        />
      </div>

      {/* ── como funciona ── */}
      <h2 className="mb-1 text-[15px] font-semibold">Como funciona</h2>
      <p className="mb-3.5 max-w-3xl text-[13px] text-text-muted">
        Três escolhas explicam quase tudo o que você vai ver nas outras telas.
      </p>
      <div className="mb-7 grid gap-3 md:grid-cols-3">
        <Explicacao
          icone={ScanText}
          titulo="O documento canônico"
          texto="De cada arquivo sai um texto limpo em Markdown — com tabela preservada e o texto que o OCR leu dentro das imagens. É ele que a busca indexa, e o original fica intacto ao lado para conferir."
        />
        <Explicacao
          icone={Library}
          titulo="Evidência, não resposta"
          texto="A busca devolve trechos com score, documento e página. Quem redige a resposta é o modelo que você já usa — com a fonte à vista, dá para checar."
        />
        <Explicacao
          icone={ShieldCheck}
          titulo="A permissão é do servidor"
          texto="Cada base é uma fronteira, resolvida pelos seus grupos do Identity a cada leitura. Pedir uma base que você não alcança devolve vazio, não erro — e nenhum parâmetro contorna isso."
        />
      </div>

      {/* ── bases ── */}
      {bases.length > 0 ? (
        <>
          <h2 className="mb-3.5 text-[15px] font-semibold">Suas bases</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {bases.map((base) => (
              <button
                key={base.slug}
                onClick={() => navigate(`/documentos?espaco=${base.slug}`)}
                className="rounded-xl border border-line bg-ink-900 px-5 py-4 text-left shadow-card transition-colors hover:border-ink-500"
              >
                <div className="mb-2 flex items-baseline gap-2">
                  <strong className="text-[14px]">{base.label}</strong>
                  <code className="text-text-dim">{base.slug}</code>
                </div>
                <div className="text-[12.5px] text-text-muted">
                  {base.documents} documentos · {fmtNumber(base.chunks)} trechos
                  {base.failed ? ` · ${base.failed} com falha` : ''}
                </div>
              </button>
            ))}
          </div>
        </>
      ) : null}

      <p className="mt-8 flex flex-wrap items-center gap-2 border-t border-line pt-4 text-[12.5px] text-text-dim">
        <History size={13} />
        Toda busca fica registrada em <Link to="/historico">Histórico</Link> — a sua, e a dos
        agentes.{' '}
        {admin ? (
          <>
            Os números da instalação estão em <Link to="/stack">Stack</Link>.
          </>
        ) : null}
      </p>
    </>
  );
}

function Atalho({
  para,
  icone: Icone,
  titulo,
  texto,
  destaque,
}: {
  para: string;
  icone: typeof Search;
  titulo: string;
  texto: string;
  destaque?: boolean;
}) {
  return (
    <Link
      to={para}
      className={`group flex flex-col rounded-xl border bg-ink-900 px-5 py-4 no-underline shadow-card transition-colors ${
        destaque ? 'border-accent/40 hover:border-accent' : 'border-line hover:border-ink-500'
      }`}
    >
      <div className="mb-2 flex items-center gap-2">
        <Icone size={16} className="text-text-muted" />
        <strong className="text-[14px] text-text">{titulo}</strong>
      </div>
      <p className="text-[12.5px] leading-relaxed text-text-muted">{texto}</p>
      <span className="mt-3 inline-flex items-center gap-1 text-[12.5px] font-semibold text-text-muted transition-colors group-hover:text-text">
        abrir <ArrowRight size={13} />
      </span>
    </Link>
  );
}

function Explicacao({
  icone: Icone,
  titulo,
  texto,
}: {
  icone: typeof ScanText;
  titulo: string;
  texto: string;
}) {
  return (
    <Card className="px-5 py-4">
      <div className="mb-2 flex items-center gap-2">
        <Icone size={16} className="text-text-muted" />
        <strong className="text-[14px]">{titulo}</strong>
      </div>
      <p className="text-[12.5px] leading-relaxed text-text-muted">{texto}</p>
    </Card>
  );
}

import { useEffect, useRef, type ReactNode } from 'react';
import { AlertTriangle, Loader2, X, type LucideIcon } from 'lucide-react';

/** Card aceita os atributos de uma div: o painel de envio precisa dos eventos
 *  de arrastar-e-soltar, e sem isso teria de duplicar o estilo numa div solta. */
export function Card({
  children,
  className = '',
  ...resto
}: { children: ReactNode; className?: string } & Omit<
  React.HTMLAttributes<HTMLDivElement>,
  'className' | 'children'
>) {
  return (
    <div className={`rounded-xl border border-line bg-ink-900 shadow-card ${className}`} {...resto}>
      {children}
    </div>
  );
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="mb-6">
      <h1 className="text-xl font-semibold tracking-tight text-text">{title}</h1>
      {children ? <p className="mt-1 max-w-3xl text-sm text-text-muted">{children}</p> : null}
    </header>
  );
}

export function Metric({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className="min-w-[3.5rem]">
      <div className="text-xl font-semibold tabular-nums tracking-tight text-text">{value}</div>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-text-dim">
        {label}
      </div>
    </div>
  );
}

export function Metrics({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-x-7 gap-y-3">{children}</div>;
}

type PillTone = 'neutral' | 'good' | 'warn' | 'bad';

const PILL_TONE: Record<PillTone, string> = {
  neutral: 'border-line text-text-muted',
  good: 'border-emerald/40 text-emerald',
  warn: 'border-amber/40 text-amber',
  bad: 'border-rose/40 text-rose',
};

export function Pill({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: PillTone;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-[1px] text-[11px] font-semibold ${PILL_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  variant = 'ghost',
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'ghost';
  type?: 'button' | 'submit';
}) {
  const base =
    'inline-flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] font-semibold transition-colors disabled:opacity-50';
  const look =
    variant === 'primary'
      ? 'bg-accent text-ink-950 hover:bg-accent-strong'
      : 'border border-line bg-ink-800 text-text hover:border-ink-500';
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${look}`}>
      {children}
    </button>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-text-dim">
        {label}
      </span>
      {children}
    </label>
  );
}

const controlBase =
  'rounded-lg border border-line bg-ink-850 px-3 py-2 text-sm text-text outline-none focus:border-ink-500';

export const inputClass = `w-full ${controlBase}`;

/** Igual ao input, mas sem largura fixa.
 *
 *  Existe porque `w-full` e `w-auto` juntos na mesma classe brigam, e quem
 *  ganha é a ordem no CSS gerado, não a última escrita — o select do Espaço
 *  esticava pela linha inteira mesmo com `w-auto` depois. */
export const selectClass = controlBase;

export function Spinner({ label = 'Carregando…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 px-1 py-6 text-sm text-text-muted">
      <Loader2 size={15} className="animate-spin" />
      {label}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-1 py-6 text-sm text-text-muted">{children}</div>;
}

/** Estado vazio com ícone, título e o próximo passo.
 *
 *  Existe porque a frase solta não bastava: "Nenhum documento neste Espaço" numa
 *  instalação sem Espaço nenhum manda procurar no lugar errado. Um estado vazio
 *  útil diz três coisas — o que não há, por quê, e o que fazer agora — e a
 *  terceira é a que faltava em toda a tela. */
export function EstadoVazio({
  icone: Icone,
  titulo,
  children,
  acao,
}: {
  icone: LucideIcon;
  titulo: string;
  children?: ReactNode;
  acao?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <span className="mb-1 flex h-10 w-10 items-center justify-center rounded-full border border-line bg-ink-850">
        <Icone size={18} className="text-text-dim" />
      </span>
      <strong className="text-[14px]">{titulo}</strong>
      {children ? (
        <p className="max-w-md text-[12.5px] leading-relaxed text-text-muted">{children}</p>
      ) : null}
      {acao ? <div className="mt-1.5">{acao}</div> : null}
    </div>
  );
}

/** Erro visivel e PERSISTENTE: erro que desaparece sozinho e erro que ninguem leu. */
export function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div className="my-3 flex items-start gap-2 rounded-r-lg border-l-2 border-rose bg-ink-850 px-3 py-2.5 text-sm text-text">
      <AlertTriangle size={15} className="mt-[2px] shrink-0 text-rose" />
      <span>{children}</span>
    </div>
  );
}

/** Barra de score. A escala e o MAIOR score da lista, nao 0–1: os valores de RRF
 *  vivem em torno de 0,016 e uma escala absoluta deixaria todas as barras
 *  invisiveis. O numero exato fica ao lado, para a barra nao ser a unica
 *  fonte. */
export function ScoreBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.max(2, (100 * value) / max) : 0;
  return (
    <span className="block h-1.5 flex-1 overflow-hidden rounded-full bg-ink-700">
      <span className="block h-full rounded-full bg-blue" style={{ width: `${pct.toFixed(1)}%` }} />
    </span>
  );
}

/**
 * Diálogo modal, sobre o `<dialog>` NATIVO.
 *
 * O elemento nativo entrega de graça três coisas que uma div com `position:
 * fixed` exigiria escrever à mão e que quase sempre saem incompletas: fechar no
 * Esc, prender o foco dentro do diálogo (`showModal`) e empilhar acima de todo
 * `z-index` da página, na top layer do navegador.
 *
 * `onClose` é ligado ao evento nativo, e não só ao botão de fechar, porque o Esc
 * fecha o elemento sem passar por nenhum handler nosso. Sem isso o React
 * continuaria achando que o diálogo está aberto e ele não reabriria.
 */
export function Dialog({
  aberto,
  titulo,
  descricao,
  onClose,
  children,
  largura = 'max-w-2xl',
}: {
  aberto: boolean;
  titulo: string;
  descricao?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  largura?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const elemento = ref.current;
    if (!elemento) return;
    if (aberto && !elemento.open) elemento.showModal();
    if (!aberto && elemento.open) elemento.close();
  }, [aberto]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      // Clique no backdrop fecha. O `<dialog>` não distingue backdrop de
      // conteúdo no evento, então a checagem é: o alvo é o próprio elemento?
      // (o conteúdo real vive na div de dentro).
      onClick={(evento) => {
        if (evento.target === ref.current) onClose();
      }}
      // `m-auto` NAO e enfeite: o `<dialog>` nativo se centraliza por
      // `margin: auto`, e o reset do Tailwind zera a margem de tudo. Sem isto
      // o dialogo abre colado no canto superior esquerdo.
      // `max-h` + `overflow-y-auto` para o conteudo nao vazar da viewport em
      // tela baixa (o formulario cresce quando o motor semantico e escolhido).
      className={`m-auto max-h-[calc(100vh-4rem)] w-[calc(100vw-2rem)] ${largura} overflow-y-auto rounded-xl border border-line bg-ink-900 p-0 text-text shadow-card backdrop:bg-black/60`}
    >
      <div className="flex items-start gap-4 border-b border-line-soft px-6 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold">{titulo}</h2>
          {descricao ? (
            <p className="mt-1 text-[12.5px] leading-relaxed text-text-muted">{descricao}</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Fechar"
          className="rounded-lg border border-line bg-ink-800 p-1.5 text-text-dim transition-colors hover:border-ink-500 hover:text-text"
        >
          <X size={15} />
        </button>
      </div>
      <div className="px-6 py-5">{children}</div>
    </dialog>
  );
}

import { Component, Suspense, lazy, useEffect, useState, type ReactNode } from 'react';
import { BookOpen, Coffee, FlaskConical, Loader2 } from 'lucide-react';
import { Card, Pill } from './Ui';
import type { Leitura } from '../lib/leitura';

/**
 * O robô leitor: a cena 3D que mostra, enquanto a ingestão roda, QUAL arquivo
 * está sendo processado neste instante.
 *
 * Este arquivo é a fronteira, e é ele que justifica a funcionalidade existir
 * sem custo para o resto do sistema:
 *
 * - o `three` (≈600 KB) entra por `import()` dinâmico, num chunk próprio. Quem
 *   abre Busca, Grafo ou Documentos sem ingestão em curso nunca baixa a lib;
 * - a cena só é montada quando há processamento, e é destruída quando acaba —
 *   contexto WebGL é recurso escasso (o navegador derruba o mais antigo depois
 *   de ~16) e não pode ficar de pé ocioso;
 * - qualquer erro dentro da cena (WebGL bloqueado, driver antigo, chunk que não
 *   baixou) morre na barreira abaixo. O painel de ingestão continua inteiro:
 *   esta é uma animação, e animação não derruba a tela que informa se o
 *   documento entrou na base.
 *
 * O texto embaixo da cena não é legenda decorativa: é a informação de verdade,
 * em HTML, para quem usa leitor de tela e para quando o WebGL não sobe.
 */

const Cena = lazy(() => import('./RobotReaderScene'));

class BarreiraDaCena extends Component<{ children: ReactNode }, { caiu: boolean }> {
  state = { caiu: false };

  static getDerivedStateFromError() {
    return { caiu: true };
  }

  componentDidCatch(erro: unknown) {
    // Sem `console.error` do React aqui não sobra rastro nenhum de por que a
    // cena sumiu, e "sumiu silenciosamente" é o pior modo de falha para quem
    // for investigar depois.
    console.warn('robô leitor: cena desligada', erro);
  }

  render() {
    if (this.state.caiu) return null;
    return this.props.children;
  }
}

export function RobotReader({
  leitura,
  imediato = false,
  simulado = false,
}: {
  /** Com `ativo: false` o robô aparece ocioso, sem livro. É o que o botão do
   *  painel mostra quando não há nada processando. */
  leitura: Leitura;
  /** Pula a espera. Quem clicou no botão já disse que quer ver. */
  imediato?: boolean;
  simulado?: boolean;
}) {
  // A cena entra depois de um respiro. Numa ingestão de arquivo pequeno o
  // estado "processando" dura menos de um segundo, e montar WebGL para piscar
  // uma vez é pior do que não mostrar nada.
  const [liberado, setLiberado] = useState(imediato);
  useEffect(() => {
    if (imediato) return;
    const id = window.setTimeout(() => setLiberado(true), 600);
    return () => window.clearTimeout(id);
  }, [imediato]);

  const total = leitura.lidos + leitura.restantes + 1;

  return (
    <Card className="overflow-hidden">
      <div className="relative h-[260px] w-full bg-gradient-to-b from-ink-950 to-ink-900 sm:h-[300px]">
        {liberado ? (
          <BarreiraDaCena>
            <Suspense fallback={null}>
              <Cena
                arquivo={leitura.ativo ? leitura.arquivo : ''}
                lidos={leitura.ativo ? leitura.lidos : 0}
                restantes={leitura.ativo ? leitura.restantes : 0}
              />
            </Suspense>
          </BarreiraDaCena>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-5 py-3">
        {leitura.ativo ? (
          <>
            <Loader2 size={14} className="shrink-0 animate-spin text-amber" />
            <BookOpen size={14} className="shrink-0 text-text-dim" />
            <span className="min-w-0 flex-1 truncate text-[13px]" title={leitura.arquivo}>
              Lendo <strong className="font-semibold">{leitura.arquivo}</strong>
            </span>
            {/* Quem chega na tela com a simulação ligada precisa saber que
                aquele nome não é um documento entrando na base. */}
            {simulado ? (
              <Pill tone="warn" title="nada está sendo enviado para a base">
                <FlaskConical size={11} /> simulação
              </Pill>
            ) : null}
            <span className="mono shrink-0 text-[12px] text-text-dim">
              {total > 1 ? `${leitura.lidos + 1} de ${total}` : 'um documento'}
            </span>
          </>
        ) : (
          <>
            <Coffee size={14} className="shrink-0 text-text-dim" />
            <span className="min-w-0 flex-1 text-[13px] text-text-muted">
              Nada em processamento. O robô fica de folga até o próximo envio.
            </span>
          </>
        )}
      </div>
    </Card>
  );
}

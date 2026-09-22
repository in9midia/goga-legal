import type { ReactNode } from 'react';

/**
 * Gráficos do benchmark, em SVG puro.
 *
 * POR QUE SEM BIBLIOTECA
 *
 * São três formas simples (barra horizontal, barra empilhada e dispersão) sobre
 * no máximo algumas dezenas de pontos. Uma biblioteca de gráficos custa de 100
 * a 400 KB no bundle e traz um sistema de temas que teria de ser reconciliado
 * com o daqui. O `vis-network` do grafo entrou porque física, clusterização e
 * seleção de vizinhança são dias de trabalho cada; desenhar uma barra não é.
 *
 * O QUE ESTAS FORMAS PRECISAM RESPONDER
 *
 * Não é "mostrar o número" — o número já está na tabela. É responder onde está
 * o problema: qual métrica puxou a nota para baixo, quantas perguntas falharam
 * por recuperação e quantas por geração, e se a nota ruim é de todas ou de
 * poucas perguntas muito ruins. Uma média não distingue esses casos, e é
 * exatamente a distinção que decide o que consertar.
 */

/** Verde → âmbar → vermelho por FAIXA, e não um gradiente contínuo: a leitura
 *  que interessa é "isto está bom, isto está ruim", e um degradê suave faz 0,45
 *  e 0,65 parecerem a mesma coisa. Os cortes são os mesmos do diagnóstico. */
export function corDaNota(valor: number): string {
  if (valor >= 0.7) return '#31b57a';
  if (valor >= 0.4) return '#e0a03a';
  return '#e05a5a';
}

export const COR_DIAGNOSTICO: Record<string, string> = {
  ok: '#31b57a',
  recuperador_fraco: '#e0a03a',
  gerador_fraco: '#d9883a',
  recuperador: '#e05a5a',
  gerador: '#c04bd0',
  sem_metrica: '#6b7280',
  erro: '#6b7280',
};

export const ROTULO_DIAGNOSTICO: Record<string, string> = {
  ok: 'sem problema',
  recuperador: 'recuperação falhou',
  recuperador_fraco: 'recuperação fraca',
  gerador: 'resposta falhou',
  gerador_fraco: 'resposta fraca',
  sem_metrica: 'sem métrica',
  erro: 'erro na execução',
};

/** Barras horizontais de 0 a 1. A escala é FIXA nesse intervalo, e não ajustada
 *  ao maior valor: as métricas já vivem em 0–1, e reescalar faria 0,3 parecer
 *  uma barra cheia. */
export function BarrasDeMetrica({
  valores,
  rotulos = {},
}: {
  valores: Record<string, number>;
  rotulos?: Record<string, string>;
}) {
  const itens = Object.entries(valores);
  if (!itens.length) return null;
  return (
    <div className="grid gap-2">
      {itens.map(([nome, valor]) => (
        <div key={nome} className="flex items-center gap-3">
          <span className="w-44 shrink-0 text-right text-[12px] text-text-muted">
            {rotulos[nome] ?? nome}
          </span>
          <div className="relative h-5 flex-1 overflow-hidden rounded bg-ink-850">
            <div
              className="h-full rounded transition-all"
              style={{
                width: `${Math.max(0, Math.min(1, valor)) * 100}%`,
                background: corDaNota(valor),
              }}
            />
            {/* A marca dos 0,7: sem uma referência no desenho, "0,66" não
                informa se é bom. Com ela, vê-se que ficou abaixo do corte. */}
            <div className="absolute inset-y-0 w-px bg-line-strong/70" style={{ left: '70%' }} />
          </div>
          <span className="mono w-12 shrink-0 text-right text-[12px]">{valor.toFixed(3)}</span>
        </div>
      ))}
    </div>
  );
}

/** Barra empilhada com a composição dos diagnósticos. Responde "de onde vem a
 *  nota ruim" numa olhada, que é a pergunta que a média não responde. */
export function BarraDeDiagnostico({ contagem }: { contagem: Record<string, number> }) {
  const total = Object.values(contagem).reduce((s, n) => s + n, 0);
  if (!total) return null;
  const ordem = [
    'ok',
    'recuperador_fraco',
    'gerador_fraco',
    'gerador',
    'recuperador',
    'sem_metrica',
    'erro',
  ];
  const itens = ordem.filter((d) => contagem[d]).map((d) => [d, contagem[d]] as const);
  return (
    <div>
      <div className="flex h-6 overflow-hidden rounded border border-line">
        {itens.map(([d, n]) => (
          <div
            key={d}
            style={{ width: `${(n / total) * 100}%`, background: COR_DIAGNOSTICO[d] ?? '#6b7280' }}
            title={`${ROTULO_DIAGNOSTICO[d] ?? d}: ${n}`}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-3">
        {itens.map(([d, n]) => (
          <span key={d} className="inline-flex items-center gap-1.5 text-[12px]">
            <span
              className="h-2.5 w-2.5 rounded-sm"
              style={{ background: COR_DIAGNOSTICO[d] ?? '#6b7280' }}
            />
            {ROTULO_DIAGNOSTICO[d] ?? d}
            <span className="mono text-text-dim">{n}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Dispersão: recuperação no eixo X, geração no eixo Y.
 *
 * É o gráfico que dá o diagnóstico de relance, porque cada quadrante tem um
 * significado e um conserto diferente:
 *
 *   alto/alto  — está funcionando
 *   baixo/alto — a busca não achou, e a resposta "acertou" por outro caminho.
 *                Mexer no prompt aqui é trabalho jogado fora
 *   alto/baixo — o contexto certo chegou e a resposta estragou. Aqui sim é
 *                prompt, ou modelo de chat
 *   baixo/baixo— a base não cobre o assunto
 */
export function DispersaoDeQualidade({
  pontos,
  onSelect,
}: {
  pontos: { id: number; x: number; y: number; cor: string; titulo: string }[];
  onSelect?: (id: number) => void;
}) {
  const L = 260;
  const M = 28;
  if (!pontos.length) return null;
  const px = (v: number) => M + v * (L - M - 8);
  const py = (v: number) => L - M - v * (L - M - 8);
  return (
    // `w-full` com proporção, e não 256px fixos: numa coluna estreita o tamanho
    // fixo era o que empurrava o cartão para fora da largura da tela.
    <svg
      viewBox={`0 0 ${L} ${L}`}
      className="aspect-square w-full max-w-[15rem]"
      role="img"
      aria-label="qualidade por pergunta"
    >
      {/* Fundo, grade e rótulos saem do tema por `var()`, e não em hex aqui: com
          o valor repetido no componente, uma troca de marca acerta o CSS e
          deixa o gráfico na cor anterior — que foi exatamente o que aconteceu
          na troca da marca antiga. As cores dos PONTOS continuam em hex de
          propósito: elas são estado (bom/ruim), não marca. */}
      <rect
        x={px(0)}
        y={py(1)}
        width={px(1) - px(0)}
        height={py(0) - py(1)}
        fill="var(--color-ink-900)"
      />
      {/* Os cortes de 0,7 nos dois eixos: são eles que dividem os quadrantes, e
          sem as linhas o gráfico vira uma nuvem sem leitura. */}
      <line
        x1={px(0.7)}
        y1={py(0)}
        x2={px(0.7)}
        y2={py(1)}
        stroke="var(--color-line)"
        strokeDasharray="3 3"
      />
      <line
        x1={px(0)}
        y1={py(0.7)}
        x2={px(1)}
        y2={py(0.7)}
        stroke="var(--color-line)"
        strokeDasharray="3 3"
      />
      <line x1={px(0)} y1={py(0)} x2={px(1)} y2={py(0)} stroke="var(--color-line)" />
      <line x1={px(0)} y1={py(0)} x2={px(0)} y2={py(1)} stroke="var(--color-line)" />
      {pontos.map((p) => (
        <circle
          key={p.id}
          cx={px(p.x)}
          cy={py(p.y)}
          r={5}
          fill={p.cor}
          fillOpacity={0.85}
          stroke="var(--color-ink-950)"
          strokeWidth={1}
          className={onSelect ? 'cursor-pointer' : undefined}
          onClick={() => onSelect?.(p.id)}
        >
          <title>{p.titulo}</title>
        </circle>
      ))}
      <text x={px(0.5)} y={L - 6} textAnchor="middle" fontSize="9" fill="var(--color-text-dim)">
        recuperação →
      </text>
      <text
        x={10}
        y={py(0.5)}
        textAnchor="middle"
        fontSize="9"
        fill="var(--color-text-dim)"
        transform={`rotate(-90 10 ${py(0.5)})`}
      >
        resposta →
      </text>
    </svg>
  );
}

/** Nota grande, com a cor da faixa. O número que responde "e aí, está bom?". */
export function Nota({
  valor,
  rotulo,
  dica,
}: {
  valor: number | null | undefined;
  rotulo: string;
  dica?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-line bg-ink-950 px-4 py-3">
      <div
        className="text-[26px] font-semibold leading-none"
        style={{ color: valor === null || valor === undefined ? '#6b7280' : corDaNota(valor) }}
      >
        {valor === null || valor === undefined ? '—' : valor.toFixed(3)}
      </div>
      <div className="mt-1 text-[12px] text-text-muted">{rotulo}</div>
      {dica ? <div className="mt-1 text-[11px] text-text-dim">{dica}</div> : null}
    </div>
  );
}

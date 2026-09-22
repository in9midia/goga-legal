import { useEffect, useRef, useState } from 'react';
import { rotuloCurto, rotuloDoNo } from '../lib/grafo';
import type { GraphEdge, GraphNode } from '../lib/types';

/**
 * Grafo interativo, sobre o `vis-network`.
 *
 * POR QUE UMA BIBLIOTECA, E POR QUE ESTA
 *
 * A primeira versão desta tela tinha uma simulação de forças própria em canvas,
 * para não pesar o bundle. Funcionava, e entregava menos: física estável,
 * clusterização, arestas curvas com seta, rótulo que some e volta conforme o
 * zoom, seleção com vizinhança destacada — cada um desses é um dia de trabalho,
 * e o `vis-network` traz todos prontos e testados. É a mesma base do Memgraph
 * Lab, então quem opera os dois vê a mesma coisa.
 *
 * O CUSTO ESTÁ CONTIDO POR IMPORT DINÂMICO
 *
 * A biblioteca passa de meio megabyte. `import()` dentro do efeito faz o Vite
 * emitir um chunk separado: **só quem abre a tela do grafo paga**. Um import
 * estático no topo colocaria esse peso no carregamento inicial de todo mundo,
 * inclusive de quem nunca vai olhar o grafo.
 *
 * UM EMARANHADO NÃO INFORMA, E O CONSERTO NÃO É MAIS FÍSICA
 *
 * Com 100 nós e 557 arestas a figura vira tinta: rótulo cobre rótulo, e não dá
 * para seguir uma ligação com o olho. Três coisas resolvem, e nenhuma delas é
 * mexer na simulação:
 *
 * 1. **rótulo só onde informa.** Escrever o nome dos 100 nós cobre o desenho de
 *    texto. Só os de maior grau ganham nome fixo; o resto aparece ao passar o
 *    mouse ou ao selecionar, que é quando a pessoa está perguntando por aquele;
 * 2. **rótulo de aresta some quando vira ruído.** Quinhentos `MENTIONS`
 *    escritos por cima do grafo escondem a estrutura que se veio ver;
 * 3. **selecionar apaga o resto.** É o ganho maior: clicar num nó apaga tudo que
 *    não é vizinho dele, e a vizinhança — que estava lá o tempo todo — aparece.
 *
 * A FÍSICA PRECISA PARAR
 *
 * `stabilization` roda a simulação antes de desenhar e `physics` é desligada
 * quando ela assenta. Sem isso o grafo treme para sempre, e clicar num nó vira
 * uma questão de sorte — foi o primeiro problema que apareceu ao testar.
 */

/** Cor por rótulo. Fixa, e não gerada: a mesma entidade precisa ter a mesma cor
 *  entre sessões, senão comparar duas telas deixa de ser possível. */
const CORES: Record<string, string> = {
  Document: '#e0a03a',
  Entity: '#7c5cff',
  Term: '#3aa0e0',
  Concept: '#31b57a',
  Chunk: '#8a8f98',
};
const COR_PADRAO = '#8a8f98';
/** Cor de quem está fora da vizinhança selecionada: presente, mas calado. */
const APAGADO = 'rgba(120,128,140,0.18)';
/** Quantos nós ganham nome fixo. Acima disto o texto cobre o desenho. */
const ROTULOS_FIXOS = 28;
/** Acima daqui, o nome do tipo de ligação some: quinhentos `MENTIONS` escritos
 *  por cima do grafo escondem justamente a estrutura. */
const MAX_ROTULOS_DE_ARESTA = 70;

export function GraphCanvas({
  nodes,
  edges,
  onSelect,
  altura = 600,
  semente = 0,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onSelect?: (no: GraphNode | null) => void;
  altura?: number;
  /** Muda para forçar um novo desenho com os MESMOS dados. Sem isto o botão
   *  "Redesenhar" não fazia nada visível: o React Query faz compartilhamento
   *  estrutural, então uma releitura que volta igual devolve a **mesma
   *  referência**, as dependências do efeito não mudam e a rede nunca é
   *  remontada. Quem pediu para redesenhar viu a tela parada. */
  semente?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const aoSelecionar = useRef(onSelect);
  aoSelecionar.current = onSelect;
  const [estabilizando, setEstabilizando] = useState(true);

  useEffect(() => {
    const alvo = ref.current;
    if (!alvo) return;
    setEstabilizando(true);
    // O tipo mínimo que este componente usa da rede. Tipar assim, e não com o
    // `Network` da lib, mantém o import dinâmico sem arrastar os tipos dela
    // para o carregamento inicial.
    type Rede = {
      destroy: () => void;
      setOptions: (o: object) => void;
      on: (evento: string, fn: (p: { nodes: number[] }) => void) => void;
      getConnectedNodes: (id: number) => number[];
      getConnectedEdges: (id: number) => number[];
    };
    type Conjunto<T> = { update: (itens: T[]) => void };
    let rede: Rede | null = null;
    let vivo = true;

    (async () => {
      const { Network, DataSet } = await import('vis-network/standalone');
      if (!vivo || !alvo) return;

      const porId = new Map(nodes.map((n) => [n.id, n]));
      // O corte de rótulo é por POSIÇÃO no ranking de grau, não por um grau
      // absoluto: um limiar fixo escreveria tudo numa base densa e nada numa
      // esparsa. Assim a quantidade de texto na tela é sempre a mesma.
      const corte =
        [...nodes].sort((a, b) => (b.grau ?? 0) - (a.grau ?? 0))[
          Math.min(ROTULOS_FIXOS, nodes.length) - 1
        ]?.grau ?? 0;
      const nomeia = (n: GraphNode) => (n.grau ?? 0) >= corte;
      const visNodes = nodes.map((n) => ({
        id: n.id,
        label: nomeia(n) ? rotuloCurto(n) : ' ',
        // O tamanho carrega o GRAU: o nó que liga muita coisa tem de saltar aos
        // olhos, porque é ele que explica a forma do grafo.
        value: Math.max(1, n.grau ?? 1),
        color: {
          background: CORES[n.label] ?? COR_PADRAO,
          border: CORES[n.label] ?? COR_PADRAO,
          highlight: { background: '#ffffff', border: CORES[n.label] ?? COR_PADRAO },
        },
        title: `${n.label}${n.type ? ` · ${n.type}` : ''}\n${rotuloDoNo(n)}\n${n.space} · ${n.grau} ligações`,
      }));
      const mostraRotuloDeAresta = edges.length <= MAX_ROTULOS_DE_ARESTA;
      const visEdges = edges.map((e, i) => ({
        id: i,
        from: e.source,
        to: e.target,
        label: mostraRotuloDeAresta ? e.type : undefined,
        title: e.type,
      }));

      const conjuntoNos = new DataSet(visNodes);
      const conjuntoArestas = new DataSet(visEdges);

      rede = new Network(
        alvo,
        { nodes: conjuntoNos, edges: conjuntoArestas },
        {
          nodes: {
            shape: 'dot',
            // `scaling` mapeia `value` para o raio. O teto baixo é de propósito:
            // sem ele, um nó com grau 200 vira um disco que cobre a tela e
            // esconde justamente a vizinhança que explica por que ele é grande.
            scaling: { min: 6, max: 26, label: { enabled: true, min: 11, max: 18 } },
            font: { color: '#cbd5e1', size: 12, face: 'ui-sans-serif, system-ui', strokeWidth: 0 },
            borderWidth: 0,
          },
          edges: {
            color: { color: 'rgba(160,170,185,0.30)', highlight: '#7c5cff' },
            width: 0.6,
            smooth: { enabled: true, type: 'continuous', roundness: 0.35 },
            arrows: { to: { enabled: true, scaleFactor: 0.35 } },
            font: {
              color: '#8a8f98',
              size: 9,
              strokeWidth: 0,
              align: 'middle',
            },
            // Rótulo de aresta só aparece com zoom: desenhá-los sempre cobre o
            // grafo de texto e some com a estrutura, que é o que se veio ver.
            scaling: { label: { enabled: true, min: 0, max: 12 } },
          },
          physics: {
            solver: 'barnesHut',
            // Mais repulsão e mola mais longa quanto mais denso: com 500
            // arestas os parâmetros de um grafo pequeno empilham tudo no centro,
            // e foi exatamente o que a primeira carga de verdade mostrou.
            barnesHut: {
              gravitationalConstant: nodes.length > 60 ? -26000 : -9000,
              springLength: nodes.length > 60 ? 220 : 130,
              springConstant: 0.015,
              avoidOverlap: 0.6,
            },
            stabilization: { enabled: true, iterations: 220, updateInterval: 30 },
          },
          interaction: {
            hover: true,
            // Passar o mouse já acende a vizinhança, antes de clicar: é o gesto
            // de quem está explorando, e clicar em cada nó para descobrir se
            // vale a pena é caro demais.
            hoverConnectedEdges: true,
            tooltipDelay: 120,
            navigationButtons: false,
            keyboard: false,
          },
          layout: { improvedLayout: nodes.length <= 200 },
        },
      ) as unknown as Rede;

      rede.on('stabilizationIterationsDone', () => {
        // Desliga a física depois de assentar. Deixá-la ligada faz o grafo
        // tremer para sempre e transforma clicar num nó em questão de sorte.
        rede?.setOptions({ physics: false });
        setEstabilizando(false);
      });
      /** Apaga tudo que não é vizinho do nó escolhido.
       *
       *  É o ganho de legibilidade maior desta tela, e nada no layout muda: a
       *  vizinhança sempre esteve desenhada, só estava afogada nas outras 500
       *  arestas. O nó escolhido e os vizinhos recuperam o nome mesmo quando
       *  não estavam entre os nomeados. */
      const destacar = (alvoId: number | null) => {
        const conjuntoN = conjuntoNos as unknown as Conjunto<Record<string, unknown>>;
        const conjuntoA = conjuntoArestas as unknown as Conjunto<Record<string, unknown>>;
        if (alvoId === null) {
          conjuntoN.update(visNodes);
          conjuntoA.update(visEdges);
          return;
        }
        const vizinhos = new Set<number>([alvoId, ...(rede?.getConnectedNodes(alvoId) ?? [])]);
        const arestasVivas = new Set<number>(rede?.getConnectedEdges(alvoId) ?? []);
        conjuntoN.update(
          visNodes.map((n) => {
            if (!vizinhos.has(n.id as number)) {
              return { ...n, label: ' ', color: { background: APAGADO, border: APAGADO } };
            }
            const original = porId.get(n.id as number);
            return { ...n, label: original ? rotuloCurto(original) : n.label };
          }),
        );
        conjuntoA.update(
          visEdges.map((e) =>
            arestasVivas.has(e.id)
              ? { ...e, label: e.title, color: { color: '#7c5cff', opacity: 1 }, width: 1.4 }
              : { ...e, label: undefined, color: { color: 'rgba(120,128,140,0.07)' }, width: 0.4 },
          ),
        );
      };

      rede.on('selectNode', (p) => {
        destacar(p.nodes[0]);
        aoSelecionar.current?.(porId.get(p.nodes[0]) ?? null);
      });
      rede.on('deselectNode', () => {
        destacar(null);
        aoSelecionar.current?.(null);
      });
    })();

    return () => {
      vivo = false;
      rede?.destroy();
    };
  }, [nodes, edges, semente]);

  return (
    <div className="relative">
      <div ref={ref} style={{ height: altura }} className="w-full rounded-lg bg-ink-950" />
      {estabilizando ? (
        <div className="pointer-events-none absolute left-3 top-3 rounded-lg border border-line bg-ink-900/95 px-3 py-1.5 text-[12px] text-text-muted">
          organizando o grafo…
        </div>
      ) : null}
    </div>
  );
}

export { CORES as CORES_DO_GRAFO };

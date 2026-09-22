import type { GraphNode } from './types';

/**
 * O que se escreve num nó, e para onde ele leva.
 *
 * Isto vive aqui, e não dentro do componente, por dois motivos: é lógica pura e
 * dá para testar sem montar um canvas, e o rótulo aparece em três lugares (no
 * desenho, no tooltip e no painel de seleção) que precisam concordar.
 */

/** Rótulos que ninguém nomeia: o nó existe, mas o nome dele é um id. */
const SEM_NOME: Record<string, string> = {
  Chunk: 'trecho',
  Document: 'documento',
};

/**
 * O texto do nó.
 *
 * Um `Chunk` não tem nome: ele é um pedaço de texto identificado por número. A
 * versão anterior caía no id interno do Memgraph, e a tela ficava salpicada de
 * "34", "58", "78" — números que não existem em lugar nenhum do sistema e que
 * não davam para procurar. Agora o número é o `ref`, que é o id do trecho de
 * verdade, e vem com a palavra na frente para dizer o que ele é.
 */
export function rotuloDoNo(no: Pick<GraphNode, 'label' | 'name' | 'ref' | 'id'>): string {
  if (no.name) return no.name;
  const especie = SEM_NOME[no.label];
  if (especie && no.ref !== null && no.ref !== undefined) return `${especie} #${no.ref}`;
  // Sem nome e sem `ref` não deveria acontecer; se acontecer, é melhor a tela
  // mostrar o rótulo do que um espaço em branco que parece defeito de desenho.
  return no.label;
}

/** Corta o rótulo para caber no desenho. Nome longo vira uma faixa de texto que
 *  cobre os vizinhos, e o grafo deixa de mostrar a estrutura. */
export function rotuloCurto(no: Parameters<typeof rotuloDoNo>[0], teto = 28): string {
  const texto = rotuloDoNo(no);
  return texto.length > teto ? `${texto.slice(0, teto - 1)}…` : texto;
}

/** Um nó de trecho tem texto para mostrar; os outros não. O grafo não guarda
 *  conteúdo (ADR-0012) — o texto do trecho está no Postgres, e `ref` é a chave
 *  para buscá-lo. */
export function trechoDoNo(no: Pick<GraphNode, 'label' | 'ref'>): number | null {
  return no.label === 'Chunk' && no.ref !== null && no.ref !== undefined ? no.ref : null;
}

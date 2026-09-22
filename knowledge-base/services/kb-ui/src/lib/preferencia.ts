import { useEffect, useState } from 'react';

/**
 * Preferência de leitura que sobrevive ao F5, guardada no navegador de quem
 * olha.
 *
 * POR QUE NÃO NA URL, como o Espaço e o documento
 *
 * A URL é para o que vale a pena COMPARTILHAR: mandar um link do documento 282
 * na página 3 faz sentido. "Eu escondi a lista de arquivos" não — quem recebe o
 * link não quer herdar o layout de quem mandou.
 *
 * POR QUE NÃO NO SERVIDOR
 *
 * Porque é do olho, não da instalação. Guardar lá gastaria uma tabela, uma rota
 * e uma migração para lembrar de um botão.
 */

/**
 * ⚠ `localStorage` NÃO é garantido, e o modo de falha é levantar — não devolver
 * vazio. Aba anônima, cookie bloqueado por política de empresa e armazenamento
 * cheio fazem `getItem` e `setItem` estourarem. Sem isto, a tela inteira
 * quebraria por causa de uma preferência de layout, e quebraria só para algumas
 * pessoas — o pior tipo de defeito para reproduzir.
 */
export function lerPreferencia(chave: string, inicial: boolean): boolean {
  try {
    const guardado = window.localStorage.getItem(chave);
    return guardado === null ? inicial : guardado === '1';
  } catch {
    return inicial;
  }
}

export function gravarPreferencia(chave: string, valor: boolean): void {
  try {
    window.localStorage.setItem(chave, valor ? '1' : '0');
  } catch {
    // Sem armazenamento, a preferência vale enquanto a aba estiver aberta. É uma
    // degradação aceitável; falhar aqui não seria.
  }
}

export function usePreferencia(chave: string, inicial: boolean): [boolean, (v: boolean) => void] {
  const [valor, setValor] = useState<boolean>(() => lerPreferencia(chave, inicial));
  useEffect(() => gravarPreferencia(chave, valor), [chave, valor]);
  return [valor, setValor];
}

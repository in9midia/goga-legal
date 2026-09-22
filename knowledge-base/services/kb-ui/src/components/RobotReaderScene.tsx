import { useEffect, useRef } from 'react';
import { montarCenaRobo, type CenaRobo } from '../lib/robotScene';

/**
 * A casca React da cena. É o `default export` do chunk que carrega o three.
 *
 * Faz três coisas e nenhuma a mais: monta a cena uma vez, avisa quando o
 * arquivo em processamento muda, e destrói tudo ao desmontar.
 */
export default function RobotReaderScene({
  arquivo,
  lidos,
  restantes,
}: {
  arquivo: string;
  lidos: number;
  restantes: number;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const cena = useRef<CenaRobo | null>(null);
  /** O arquivo que já estava lá na montagem não pode disparar a animação de
   *  troca: a cena precisa abrir já lendo, e não fechando um livro invisível. */
  const primeira = useRef(true);

  useEffect(() => {
    if (!host.current) return;
    cena.current = montarCenaRobo(host.current);
    return () => {
      cena.current?.destruir();
      cena.current = null;
    };
  }, []);

  // Arquivo vazio é um estado legítimo, não "ainda não sei": é o robô ocioso,
  // sem livro nas mãos. Um `if (!arquivo) return` aqui deixava o robô lendo
  // para sempre o último arquivo depois que a ingestão terminava.
  useEffect(() => {
    cena.current?.lerArquivo(arquivo, primeira.current);
    primeira.current = false;
  }, [arquivo]);

  useEffect(() => {
    cena.current?.atualizarPilhas(lidos, restantes);
  }, [lidos, restantes]);

  return <div ref={host} className="h-full w-full" aria-hidden="true" />;
}

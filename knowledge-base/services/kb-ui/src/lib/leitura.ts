/** O que a animação do robô leitor precisa saber sobre a ingestão em curso.
 *
 *  Vive fora do componente de cena de propósito: é a única parte com regra de
 *  negócio ("qual arquivo está sendo lido agora"), e é a única que dá para
 *  testar sem WebGL. A cena 3D recebe isto pronto e não decide nada.
 */

export type Leitura = {
  /** Há algo sendo processado agora. Enquanto for `false`, a cena nem carrega. */
  ativo: boolean;
  /** O arquivo que está no pipeline neste instante. Chave da troca de livro. */
  arquivo: string;
  /** Quantos já terminaram neste ciclo — vira a pilha de livros lidos. */
  lidos: number;
  /** Quantos ainda esperam — vira a pilha de livros por ler. */
  restantes: number;
};

export const LEITURA_PARADA: Leitura = { ativo: false, arquivo: '', lidos: 0, restantes: 0 };

type Envio = {
  /** Nomes na ordem em que serão enviados. */
  fila: string[];
  /** Índice do que está no ar. */
  indice: number;
  /** Quantos já voltaram do servidor, com sucesso ou não. */
  concluidos: number;
};

type RunEmCurso = { status: string; filename: string };

/**
 * Duas fontes dizem o que está sendo processado, e elas não são equivalentes.
 *
 * O envio desta aba sabe o lote inteiro: quantos faltam, quantos já voltaram. O
 * log de ingestão só sabe o que o servidor está mastigando agora — pode ser de
 * outra aba, de outra pessoa, ou o resto de um envio cuja aba já foi fechada.
 *
 * Por isso o envio local ganha quando existe: só ele consegue dizer "3 de 40".
 * Sem essa precedência, um envio de quarenta arquivos apareceria como uma
 * leitura solitária, porque o servidor processa um de cada vez.
 */
export function leituraDaIngestao(envio: Envio | null, runs: RunEmCurso[]): Leitura {
  if (envio && envio.fila.length > 0) {
    const arquivo = envio.fila[envio.indice] ?? '';
    return {
      ativo: arquivo !== '',
      arquivo,
      lidos: envio.concluidos,
      restantes: Math.max(0, envio.fila.length - envio.indice - 1),
    };
  }

  const rodando = runs.filter((r) => r.status === 'running');
  if (rodando.length === 0) return LEITURA_PARADA;
  return {
    ativo: true,
    arquivo: rodando[0].filename,
    lidos: 0,
    // O primeiro é o que está sendo lido; os outros são fila de verdade.
    restantes: rodando.length - 1,
  };
}

/** Paleta das lombadas. Sai da escala da interface, não do arco-íris: o card
 *  onde a cena mora é grafite, e livro saturado ao lado dele parece outro
 *  produto. */
const LOMBADAS = [
  '#2f6f9f',
  '#3f8f6f',
  '#a04f4f',
  '#9f7f3f',
  '#6f4f9f',
  '#3f7f8f',
  '#8f5f8f',
  '#4f6f4f',
];

/**
 * Cor estável para um nome de arquivo.
 *
 * Estável importa mais do que bonita: o mesmo arquivo tem de sair da pilha com
 * a cor com que entrou, senão a troca de livro não se lê como "trocou de
 * livro", e sim como um piscar aleatório.
 */
export function corDoArquivo(nome: string): string {
  let soma = 0;
  for (let i = 0; i < nome.length; i += 1) soma = (soma * 31 + nome.charCodeAt(i)) >>> 0;
  return LOMBADAS[soma % LOMBADAS.length];
}

/** O nome como ele cabe na capa do livro: sem a extensão (que vai no rodapé da
 *  capa) e sem caminho. */
export function tituloDaCapa(nome: string): { titulo: string; extensao: string } {
  const base = nome.split(/[/\\]/).pop() ?? nome;
  const ponto = base.lastIndexOf('.');
  if (ponto <= 0) return { titulo: base, extensao: '' };
  return { titulo: base.slice(0, ponto), extensao: base.slice(ponto + 1).toLowerCase() };
}

/** A máquina é a de quem está desenvolvendo?
 *
 *  Serve para liberar o botão de simular ingestão, que existe só para ver a
 *  animação sem gastar um documento de verdade. O teste é pelo HOSTNAME, e não
 *  por `import.meta.env.DEV`: a stack local roda o build de produção atrás do
 *  nginx em `localhost:8890`, onde `DEV` é falso e o botão sumiria justamente
 *  no lugar em que ele é usado.
 */
export function ehAmbienteLocal(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(hostname);
}

/** Nomes para a simulação, quando não há nem histórico de onde tirá-los. */
const ARQUIVOS_DE_MENTIRA = [
  'APL 01 - Visão Geral.docx',
  'Manual de Matrícula.pdf',
  'planilha-de-turmas.xlsx',
  'politica-de-ferias.md',
  '99Taxi-PassoAPasso.pptx',
];

/**
 * A leitura fingida do botão "simular atividade".
 *
 * Usa nomes do histórico quando existem: uma simulação com `arquivo-1.pdf` não
 * mostra o que a cena faz com o nome comprido e cheio de espaço que é a regra
 * nesta base, e era esse o caso que quebrava a capa do livro.
 */
export function leituraSimulada(nomes: string[], passo: number): Leitura {
  // Os nomes saem REPETIDOS do log: reprocessar o mesmo arquivo é a coisa mais
  // comum que acontece ali, e o log guarda uma linha por tentativa. Sem
  // deduplicar, dois passos seguidos caíam no mesmo nome — o contador andava,
  // o robô não trocava de livro, e a simulação parecia quebrada.
  const lista: string[] = [];
  for (const nome of nomes) {
    if (lista.length >= 6) break;
    if (nome && !lista.includes(nome)) lista.push(nome);
  }
  // Com menos de três nomes distintos a troca fica pobre demais para mostrar o
  // que a cena faz. Completa com os de mentira em vez de repetir os de verdade.
  for (const nome of ARQUIVOS_DE_MENTIRA) {
    if (lista.length >= 3) break;
    if (!lista.includes(nome)) lista.push(nome);
  }
  const i = ((passo % lista.length) + lista.length) % lista.length;
  return { ativo: true, arquivo: lista[i], lidos: i, restantes: lista.length - i - 1 };
}

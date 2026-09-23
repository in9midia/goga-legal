import { describe, expect, it } from 'vitest';
import {
  corDoArquivo,
  ehAmbienteLocal,
  leituraDaIngestao,
  leituraSimulada,
  tituloDaCapa,
} from './leitura';

describe('leituraDaIngestao', () => {
  it('conta a fila do servidor: um processando, os queued esperando', () => {
    const leitura = leituraDaIngestao(null, [
      { status: 'queued', filename: 'c.pdf' },
      { status: 'queued', filename: 'b.pdf' },
      { status: 'running', filename: 'a.pdf' },
    ]);
    expect(leitura).toEqual({ ativo: true, arquivo: 'a.pdf', lidos: 0, restantes: 2 });
  });

  it('com só queued (worker ainda não pegou), mostra o mais antigo', () => {
    const leitura = leituraDaIngestao(null, [
      { status: 'queued', filename: 'b.pdf' },
      { status: 'queued', filename: 'a.pdf' },
    ]);
    expect(leitura).toEqual({ ativo: true, arquivo: 'a.pdf', lidos: 0, restantes: 1 });
  });

  it('fica parada quando não há envio local nem run rodando', () => {
    expect(leituraDaIngestao(null, []).ativo).toBe(false);
    expect(leituraDaIngestao(null, [{ status: 'indexed', filename: 'a.pdf' }]).ativo).toBe(false);
  });

  it('usa o envio local quando ele existe, com o lote inteiro', () => {
    const leitura = leituraDaIngestao(
      { fila: ['a.pdf', 'b.docx', 'c.md'], indice: 1, concluidos: 1 },
      [{ status: 'running', filename: 'b.docx' }],
    );
    expect(leitura).toEqual({ ativo: true, arquivo: 'b.docx', lidos: 1, restantes: 1 });
  });

  it('cai para o log de ingestão quando o envio não é desta aba', () => {
    // Aqui só dá para saber o que o servidor está mastigando agora: o lote
    // original ficou na aba de quem enviou.
    const leitura = leituraDaIngestao(null, [
      { status: 'running', filename: 'grande.pdf' },
      { status: 'indexed', filename: 'antigo.pdf' },
    ]);
    expect(leitura).toEqual({ ativo: true, arquivo: 'grande.pdf', lidos: 0, restantes: 0 });
  });

  it('não conta o que está sendo lido como restante', () => {
    const leitura = leituraDaIngestao(null, [
      { status: 'running', filename: 'um.pdf' },
      { status: 'running', filename: 'dois.pdf' },
    ]);
    expect(leitura.restantes).toBe(1);
  });

  it('trata índice além do fim sem inventar arquivo', () => {
    // Acontece no instante entre o último arquivo voltar e a fila ser limpa.
    const leitura = leituraDaIngestao({ fila: ['a.pdf'], indice: 3, concluidos: 1 }, []);
    expect(leitura.ativo).toBe(false);
    expect(leitura.restantes).toBe(0);
  });
});

describe('corDoArquivo', () => {
  it('devolve sempre a mesma cor para o mesmo nome', () => {
    // O livro tem de sair da pilha com a cor com que entrou, senão a troca não
    // se lê como troca de livro.
    expect(corDoArquivo('APL 01 - Visão Geral.docx')).toBe(
      corDoArquivo('APL 01 - Visão Geral.docx'),
    );
    expect(corDoArquivo('a.pdf')).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('separa nomes diferentes em cores diferentes na maioria dos casos', () => {
    const cores = new Set(['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf'].map(corDoArquivo));
    expect(cores.size).toBeGreaterThan(1);
  });
});

describe('tituloDaCapa', () => {
  it('separa o nome da extensão', () => {
    expect(tituloDaCapa('APL 02 - Períodos Letivos.docx')).toEqual({
      titulo: 'APL 02 - Períodos Letivos',
      extensao: 'docx',
    });
  });

  it('aceita nome sem extensão e nome com ponto inicial', () => {
    expect(tituloDaCapa('LEIAME')).toEqual({ titulo: 'LEIAME', extensao: '' });
    expect(tituloDaCapa('.env')).toEqual({ titulo: '.env', extensao: '' });
  });
});

describe('ehAmbienteLocal', () => {
  it('reconhece as formas de localhost', () => {
    expect(ehAmbienteLocal('localhost')).toBe(true);
    expect(ehAmbienteLocal('127.0.0.1')).toBe(true);
    expect(ehAmbienteLocal('[::1]')).toBe(true);
  });

  it('não reconhece host de verdade', () => {
    // O botão de simular não pode vazar para a instalação da empresa: ele
    // mostra na tela nomes de arquivo que NÃO estão sendo processados.
    expect(ehAmbienteLocal('kb.exemplo.br')).toBe(false);
    expect(ehAmbienteLocal('localhost.exemplo.br')).toBe(false);
  });
});

describe('leituraSimulada', () => {
  it('caminha pela lista e fecha a volta', () => {
    const nomes = ['a.pdf', 'b.pdf', 'c.pdf'];
    expect(leituraSimulada(nomes, 0)).toEqual({
      ativo: true,
      arquivo: 'a.pdf',
      lidos: 0,
      restantes: 2,
    });
    expect(leituraSimulada(nomes, 2).arquivo).toBe('c.pdf');
    expect(leituraSimulada(nomes, 3).arquivo).toBe('a.pdf');
  });

  it('não repete o mesmo nome em passos seguidos quando o log repete', () => {
    // O log guarda uma linha por TENTATIVA, então o mesmo arquivo aparece
    // várias vezes. Repetido, o robô não trocava de livro e a simulação parecia
    // quebrada.
    const log = ['a.pdf', 'a.pdf', 'b.pdf', 'a.pdf'];
    const vistos = [0, 1, 2].map((n) => leituraSimulada(log, n).arquivo);
    expect(new Set(vistos).size).toBe(3);
  });

  it('completa com nomes próprios quando o log tem poucos distintos', () => {
    const leitura = leituraSimulada(['unico.pdf'], 1);
    expect(leitura.arquivo).not.toBe('unico.pdf');
    expect(leitura.restantes + leitura.lidos + 1).toBeGreaterThanOrEqual(3);
  });

  it('tem nomes próprios quando o log está vazio', () => {
    const leitura = leituraSimulada([], 1);
    expect(leitura.ativo).toBe(true);
    expect(leitura.arquivo).not.toBe('');
  });
});

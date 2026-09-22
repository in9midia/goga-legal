import { Library } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, EstadoVazio } from './Ui';

/**
 * O que aparece quando uma tela "por base" é aberta sem base.
 *
 * Documentos, Wiki, Grafo e Benchmark não respondem nada sem um Espaço: elas
 * saíram do menu esquerdo justamente por isso. Mas a URL continua existindo —
 * favorito antigo, link colado, `/grafo` digitado à mão —, e cair numa tela
 * vazia sem explicação é pior que não ter a rota.
 *
 * Manda para Bases em vez de escolher uma base sozinha. Escolher a primeira
 * alfabética mostraria conteúdo de um Espaço que ninguém pediu, e numa
 * ferramenta onde o Espaço é a fronteira de permissão isso é exatamente o tipo
 * de atalho que não se toma.
 */
export function ExigeBase({ oQue }: { oQue: string }) {
  const navigate = useNavigate();
  return (
    <Card>
      <EstadoVazio
        icone={Library}
        titulo="Escolha uma base primeiro"
        acao={
          <Button onClick={() => navigate('/bases')}>
            <Library size={14} /> Ir para Bases
          </Button>
        }
      >
        {oQue} é conteúdo de uma base específica. Abra a base em <strong>Bases</strong> e entre por
        ela — assim a tela já sabe de qual Espaço está falando.
      </EstadoVazio>
    </Card>
  );
}

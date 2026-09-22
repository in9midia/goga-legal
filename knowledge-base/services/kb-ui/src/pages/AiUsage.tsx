import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CircleAlert, RefreshCw, Timer } from 'lucide-react';
import { kb } from '../lib/api';
import { fmtMs, fmtNumber, fmtUsd } from '../lib/format';
import type { AiUsage, AiUsageBucket, RecalculoDeCusto } from '../lib/types';
import {
  Button,
  Card,
  Empty,
  ErrorBox,
  Metric,
  Metrics,
  PageHeader,
  Spinner,
} from '../components/Ui';

type DiaDaSerie = {
  day: string;
  rotulo: string;
  tokens: number;
  calls: number;
  errors: number;
};

/**
 * Preenche a janela inteira de dias, não só os que tiveram uso.
 *
 * A API devolve apenas os dias com registro. Sem preencher, "30 dias" com um
 * único dia de uso desenhava uma barra só, ocupando toda a largura, e lia-se
 * como consumo constante no mês.
 *
 * Função pura, e NÃO um `useMemo` dentro do componente: os hooks teriam de vir
 * antes dos early returns de carregamento, e chamar `useMemo` depois deles
 * muda a contagem de hooks entre renderizações. O React derruba a árvore
 * inteira nesse caso, e a tela fica em branco sem nada no console. Para no
 * máximo 90 itens, recalcular a cada render não custa nada.
 */
function montarSerie(diario: AiUsage['daily'], dias: number): DiaDaSerie[] {
  const porDia = new Map(diario.map((d) => [d.day, d]));
  const hoje = new Date();
  const serie: DiaDaSerie[] = [];
  for (let atras = dias - 1; atras >= 0; atras -= 1) {
    const dia = new Date(hoje);
    dia.setDate(hoje.getDate() - atras);
    // ISO local, não `toISOString`: em UTC a data viraria o dia anterior à
    // noite no fuso de São Paulo, e a última coluna deixaria de ser hoje.
    const chave = `${dia.getFullYear()}-${String(dia.getMonth() + 1).padStart(2, '0')}-${String(
      dia.getDate(),
    ).padStart(2, '0')}`;
    const encontrado = porDia.get(chave);
    serie.push({
      day: chave,
      rotulo: dia.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
      tokens: encontrado?.tokens ?? 0,
      calls: encontrado?.calls ?? 0,
      errors: encontrado?.errors ?? 0,
    });
  }
  return serie;
}

const JANELAS = [7, 30, 90] as const;

// A trilha de barras e a régua de datas TÊM de usar os mesmos valores: é o que
// garante que o rótulo caia sob a barra. Separá-los foi o que desalinhou a
// primeira versão desta tela.
const ESPACO_ENTRE_COLUNAS = 'gap-[2px]';
// Teto de largura da barra. Sem ele, uma janela de 7 dias daria barras de
// ~150px, que lê como bloco e não como gráfico.
const LARGURA_MAXIMA_BARRA = 'max-w-[26px]';

/**
 * Quanto de IA este projeto gastou, por dia.
 *
 * POR QUE É BARATO: a API lê uma tabela de **rollup** (`ai_usage_daily`) em que
 * cada chamada de IA soma num contador do dia. São algumas dezenas de linhas
 * por mês — a tela custa o mesmo com a base vazia e com ela cheia.
 *
 * O caminho alternativo (gravar um evento por chamada e agregar na leitura)
 * começa mais simples e fica caro exatamente quando o número passa a importar:
 * com a base cheia, somar os tokens do mês viraria uma varredura de milhões de
 * linhas a cada F5.
 *
 * O que se perde: não dá para perguntar "quais foram as chamadas das 14h05".
 * Granularidade de dia é o que a tela promete, e é o que cabe num contador.
 */
export function AiUsagePage() {
  const [dias, setDias] = useState<number>(30);
  const cliente = useQueryClient();
  const [recalculo, setRecalculo] = useState<RecalculoDeCusto | null>(null);
  const [erroRecalculo, setErroRecalculo] = useState('');

  // O recálculo MUDA número de histórico, então é um clique e não um efeito.
  // Ninguém deve descobrir depois que os valores de ontem mudaram sozinhos.
  const recalcular = useMutation({
    mutationFn: () => kb.recalcularCusto(),
    onSuccess: (r) => {
      setErroRecalculo('');
      setRecalculo(r);
      void cliente.invalidateQueries({ queryKey: ['ai-usage'] });
    },
    onError: (e) => {
      setRecalculo(null);
      setErroRecalculo((e as Error).message);
    },
  });
  const { data, isLoading, error } = useQuery({
    queryKey: ['ai-usage', dias],
    queryFn: () => kb.aiUsage(dias),
    refetchInterval: 60_000,
  });

  if (isLoading) return <Spinner label="Somando o uso…" />;
  if (error) return <ErrorBox>{(error as Error).message}</ErrorBox>;
  if (!data) return null;

  const serie = montarSerie(data.daily, data.days);
  const pico = Math.max(1, ...serie.map((d) => d.tokens));
  const diasComUso = data.daily.filter((d) => d.tokens > 0).length;

  return (
    <>
      <PageHeader title="Uso de IA">
        Quanto de IA esta instalação gastou, em <strong>dólar</strong> e em tokens. O custo sai do
        preço cadastrado em cada provedor e é <strong>congelado na hora do uso</strong>: mudar o
        preço amanhã não reescreve o gasto de hoje. Cadastre o preço em{' '}
        <Link to="/modelos-ia">Modelos de IA</Link>.
      </PageHeader>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {JANELAS.map((janela) => (
          <button
            key={janela}
            onClick={() => setDias(janela)}
            aria-current={dias === janela ? 'true' : undefined}
            className={`rounded-lg border px-3 py-1.5 text-[12.5px] transition-colors ${
              dias === janela
                ? 'border-accent/50 bg-ink-800 text-text'
                : 'border-line bg-ink-900 text-text-muted hover:border-ink-500'
            }`}
          >
            {janela} dias
          </button>
        ))}

        {/* APLICAR O PREÇO AO QUE JÁ PASSOU.
            O custo é congelado na hora do uso, e isso é o comportamento certo —
            o dinheiro de ontem saiu pelo preço de ontem. O efeito colateral é
            que quem cadastra o preço depois de rodar fica com um histórico
            inteiro em zero, o que na tela parece "não gastou" em vez de
            "ninguém tinha dito quanto custava". */}
        {data.total.sem_preco > 0 || recalculo ? (
          <span
            className="ml-auto"
            title="Reaplica o preço cadastrado hoje ao uso que já foi gravado"
          >
            <Button disabled={recalcular.isPending} onClick={() => recalcular.mutate()}>
              <RefreshCw size={13} className={recalcular.isPending ? 'animate-spin' : undefined} />
              {recalcular.isPending ? 'recalculando…' : 'Aplicar preço ao histórico'}
            </Button>
          </span>
        ) : null}
      </div>

      {erroRecalculo ? <ErrorBox>{erroRecalculo}</ErrorBox> : null}

      {recalculo ? (
        <Card className="mb-4 px-5 py-4">
          <p className="text-[13px] text-text">
            {recalculo.atualizadas} de {recalculo.linhas} linhas recalculadas ·{' '}
            <strong>{fmtUsd(recalculo.custo_usd)}</strong> no total
          </p>
          <ul className="mt-2 space-y-1 text-[12.5px] leading-relaxed text-text-muted">
            <li>
              <strong className="text-text">{recalculo.exatas}</strong> exatas (
              {fmtNumber(recalculo.tokens_exatos)} tokens) — embedding não tem saída, então todo
              token é de entrada por definição da chamada.
            </li>
            {recalculo.estimadas > 0 ? (
              <li>
                <strong className="text-amber">{recalculo.estimadas}</strong> estimadas (
                {fmtNumber(recalculo.tokens_estimados)} tokens) — o chat antigo guardava só o total,
                e entrada e saída custam diferente. A divisão usada foi{' '}
                {Math.round(recalculo.fracao_entrada * 100)}% de entrada, que é a forma das nossas
                chamadas: documento inteiro no prompt, JSON curto na resposta.
              </li>
            ) : null}
            {recalculo.sem_preco > 0 ? (
              <li>
                <strong className="text-amber">{recalculo.sem_preco}</strong> sem preço cadastrado —
                a ação aqui é cadastrar o preço em <Link to="/modelos-ia">Modelos de IA</Link>, não
                recalcular de novo.
              </li>
            ) : null}
            {recalculo.sem_provedor > 0 ? (
              <li>
                <strong>{recalculo.sem_provedor}</strong> de provedor que não existe mais — o gasto
                fica no histórico, mas sem cadastro não há preço a aplicar.
              </li>
            ) : null}
          </ul>
        </Card>
      ) : null}

      <Card className="mb-6 px-5 py-4">
        <Metrics>
          <Metric value={fmtUsd(data.total.cost_usd)} label="custo no período" />
          <Metric value={fmtNumber(data.total.tokens)} label="tokens" />
          <Metric value={fmtNumber(data.total.calls)} label="chamadas" />
          <Metric
            value={
              data.total.errors
                ? `${fmtNumber(data.total.errors)} (${Math.round(
                    (data.total.errors / Math.max(1, data.total.calls)) * 100,
                  )}%)`
                : '0'
            }
            label="falhas"
          />
          <Metric value={fmtMs(data.total.avg_latency_ms)} label="latência média" />
        </Metrics>
        <p className="mt-3.5 flex flex-wrap items-center gap-x-3 border-t border-line-soft pt-3 text-[12px] text-text-dim">
          <span className="flex items-center gap-1.5">
            <Timer size={12} /> janela de {data.days} dias
          </span>
          {/* CUSTO ZERO E CUSTO DESCONHECIDO SOMAM IGUAL, e é isso que este
              aviso separa. Sem ele, uma conta sem preço cadastrado apareceria
              como economia, e o total do mês ficaria abaixo da fatura sem nada
              na tela sugerindo por quê.

              Vale também para o passado: as linhas anteriores à migração que
              criou o custo não têm o valor gravado e caem aqui. */}
          {data.total.sem_preco > 0 ? (
            <span className="flex items-center gap-1.5 text-amber">
              <CircleAlert size={12} />
              {fmtNumber(data.total.sem_preco)} tokens sem custo aplicado — o valor acima está
              incompleto
            </span>
          ) : null}
          {/* O QUE FOI ESTIMADO APARECE SEPARADO DO QUE FOI APURADO.
              Os dois somam igual, e só um sustenta uma conversa de orçamento.
              Misturar sem dizer seria pior que não ter o número. */}
          {data.total.tokens_estimados > 0 ? (
            <span
              className="flex items-center gap-1.5 text-text-dim"
              title="Chat antigo guardava só o total de tokens; a divisão entre entrada e saída foi suposta no recálculo"
            >
              <CircleAlert size={12} />
              {fmtNumber(data.total.tokens_estimados)} tokens com divisão estimada
            </span>
          ) : null}
          <span className="flex items-center gap-1.5">
            {fmtNumber(data.total.tokens_in)} entrada · {fmtNumber(data.total.tokens_out)} saída
          </span>
          {data.total.errors > 0 ? (
            <>
              <span>·</span>
              <span className="flex items-center gap-1.5 text-amber">
                <CircleAlert size={12} />
                as falhas também contam: uma sequência de 429 aparece aqui, não só no log
              </span>
            </>
          ) : null}
        </p>
      </Card>

      {data.total.calls === 0 ? (
        <Card className="px-5 py-4">
          <Empty>
            Nenhuma chamada de IA nesta janela. Ou a base ainda não foi consultada, ou não há
            provedor marcado como em uso.
          </Empty>
        </Card>
      ) : (
        <>
          <h2 className="mb-1 text-[15px] font-semibold">Por dia</h2>
          <p className="mb-3 text-[12.5px] text-text-muted">
            {diasComUso === 1
              ? 'Houve uso em um único dia desta janela.'
              : `Houve uso em ${diasComUso} dos ${data.days} dias.`}{' '}
            <span className="text-text-dim">Pico de {fmtNumber(pico)} tokens em um dia.</span>
          </p>
          <Card className="mb-6 px-5 py-4">
            {/* Barras em CSS puro, sem biblioteca de gráfico: são no máximo 90
                colunas, e uma dependência a mais no bundle custaria mais do que
                entregaria aqui.

                A JANELA INTEIRA é desenhada, não só os dias com dado. Antes o
                gráfico mostrava apenas os dias que voltaram da API, e com um
                único dia de uso a barra ocupava a largura toda: parecia consumo
                constante em 30 dias, quando era um dia só. Dia sem uso aparece
                como linha de base.

                A trilha e a régua de datas usam a MESMA estrutura de colunas, e
                o rótulo é centralizado na coluna dele. Alinhar por
                `justify-between` no rodapé deixava a data 15px fora do centro
                da barra, porque a barra é centralizada na coluna e o texto era
                encostado na borda da trilha. */}
            <div className={`flex items-end ${ESPACO_ENTRE_COLUNAS}`} style={{ height: 150 }}>
              {serie.map((dia) => {
                const altura = dia.tokens ? Math.max(3, Math.round((dia.tokens / pico) * 140)) : 1;
                return (
                  <div
                    key={dia.day}
                    className="flex flex-1 items-end justify-center"
                    style={{ height: '100%' }}
                    title={
                      dia.tokens
                        ? `${dia.rotulo}\n${fmtNumber(dia.tokens)} tokens · ${dia.calls} chamadas${
                            dia.errors ? ` · ${dia.errors} falhas` : ''
                          }`
                        : `${dia.rotulo}\nsem uso`
                    }
                  >
                    <div
                      className={`w-full ${LARGURA_MAXIMA_BARRA} rounded-t-[2px] ${
                        dia.tokens ? 'bg-accent/60 transition-colors hover:bg-accent' : 'bg-ink-700'
                      }`}
                      style={{ height: altura }}
                    />
                  </div>
                );
              })}
            </div>

            {/* Régua de datas: mesma estrutura da trilha, então o rótulo cai
                exatamente sob a barra. Só as três posições de referência
                recebem texto; o resto é coluna vazia para manter o alinhamento. */}
            <div
              className={`relative mt-2 flex h-4 ${ESPACO_ENTRE_COLUNAS} text-[11.5px] text-text-dim`}
            >
              {serie.map((dia, indice) => {
                const meio = Math.floor((serie.length - 1) / 2);
                const rotulo =
                  indice === 0
                    ? dia.rotulo
                    : indice === serie.length - 1
                      ? `${dia.rotulo} (hoje)`
                      : indice === meio
                        ? dia.rotulo
                        : '';
                return (
                  <div key={dia.day} className="relative min-w-0 flex-1">
                    {/* O rótulo é ABSOLUTO, e não item de flex.
                        "10/09 (hoje)" tem 65px contra uma coluna de 36px: como
                        item de flex ele esticava a própria coluna e empurrava
                        as outras, deslocando toda a régua 16px em relação às
                        barras. Fora do fluxo, a coluna mantém a largura e o
                        texto se centraliza no meio dela, transbordando para os
                        lados sem afetar ninguém. */}
                    {rotulo ? (
                      <span className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap">
                        {rotulo}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            <Reparticao
              titulo="Por operação"
              descricao="De onde veio a chamada. `index` é ingestão, `search` é pergunta, `chunking` é o motor de corte semântico, `test` é o botão Testar."
              itens={data.by_operation}
            />
            <Reparticao
              titulo="Por provedor"
              descricao="Provedor e modelo que atenderam. Um provedor removido continua aqui — o gasto já aconteceu."
              itens={data.by_provider}
            />
          </div>
        </>
      )}
    </>
  );
}

function Reparticao({
  titulo,
  descricao,
  itens,
}: {
  titulo: string;
  descricao: string;
  itens: AiUsageBucket[];
}) {
  const total = itens.reduce((soma, item) => soma + item.tokens, 0) || 1;
  return (
    <section>
      <h2 className="mb-1 text-[15px] font-semibold">{titulo}</h2>
      <p className="mb-3 text-[12.5px] text-text-muted">{descricao}</p>
      <Card className="overflow-hidden">
        {itens.length === 0 ? (
          <Empty>Nada nesta janela.</Empty>
        ) : (
          <ul>
            {itens.map((item) => {
              const parte = (item.tokens / total) * 100;
              return (
                <li key={item.name} className="border-b border-line-soft px-5 py-3 last:border-0">
                  <div className="mb-1.5 flex items-baseline justify-between gap-3">
                    <code className="min-w-0 truncate text-text">{item.name}</code>
                    <span className="shrink-0 tabular-nums text-text-muted">
                      {/* O dólar vem primeiro: é a unidade que alguém aprova ou
                          recusa. Token fica ao lado porque explica o dólar. */}
                      {item.cost_usd > 0 ? (
                        <span className="mr-2 text-text">{fmtUsd(item.cost_usd)}</span>
                      ) : item.sem_preco > 0 ? (
                        <span className="mr-2 text-amber" title="provedor sem preço cadastrado">
                          sem preço
                        </span>
                      ) : null}
                      {fmtNumber(item.tokens)}
                      <span className="ml-1.5 text-text-dim">
                        {parte >= 1 ? `${Math.round(parte)}%` : '<1%'}
                      </span>
                    </span>
                  </div>
                  <div className="h-1 overflow-hidden rounded bg-ink-800">
                    {/* Mínimo de 2%: uma fatia de 3 tokens contra 2.116 dá 0,1%
                        e a barra desaparece por completo, fazendo a linha
                        parecer um erro de renderização. A porcentagem ao lado
                        é que carrega o número exato. */}
                    <div
                      className="h-full bg-accent/60"
                      style={{ width: `${Math.max(2, Math.round(parte))}%` }}
                    />
                  </div>
                  <div className="mt-1.5 text-[11.5px] text-text-dim">
                    {fmtNumber(item.calls)} {item.calls === 1 ? 'chamada' : 'chamadas'}
                    {item.errors ? (
                      <span className="text-rose"> · {item.errors} com falha</span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </section>
  );
}

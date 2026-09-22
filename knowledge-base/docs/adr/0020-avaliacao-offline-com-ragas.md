# ADR-0020 — Avaliação offline: dataset golden e métricas Ragas

- **Status:** Aceito
- **Data:** 2026-09-13
- **Relacionado:** [0004](0004-busca-hibrida-fundida-por-rrf.md),
  [0006](0006-mcp-devolve-evidencia-nao-resposta.md),
  [0009](0009-credencial-de-provedor-cifrada-em-repouso.md),
  [0017](0017-representacoes-por-espaco-e-busca-que-funde-metodos.md),
  requisitos FUN-07, BUS-04

## Contexto

A especificação separa quatro planos transversais
([conceptual-model §5](../proposal/docs/system-design/conceptual-model.md)). A
telemetria, que já existe, responde *quanto custou e demorou*. Faltava o plano
que responde a outra pergunta: **quão boa é a resposta?**

FUN-07 pede "avaliação offline reproduzível, com dataset golden e métricas de
retrieval, capaz de comparar técnicas entre si; Ragas como referência", e
[taxonomy §7](../proposal/docs/system-design/taxonomy.md) nomeia as métricas —
`faithfulness`, `answer_relevancy`, `context_precision`, `context_recall`,
`answer_correctness` — a agregação (média harmônica) e o desacoplamento entre a
fase de geração e a de avaliação.

Havia uma tensão a resolver antes de escrever qualquer código: **três das cinco
métricas exigem uma resposta, e este sistema não responde.** Ele devolve
evidência (ADR-0006). Sem uma resposta não há como medir fidelidade, e sem
medir fidelidade não há o "diagnóstico do gerador separado do diagnóstico do
retriever" que a especificação pede.

## Decisão

**Ragas de verdade, e não uma reimplementação das métricas.** A alternativa era
escrever os cinco juízes como prompts no `llm.py` que já existe — mais barato em
dependência, e com números que só valeriam entre execuções nossas. Ficou a
biblioteca, pelo que a especificação diz (framework primário) e porque números
canônicos comparam com a literatura.

**O harness sintetiza uma resposta, só para medir.** O gerador existe apenas no
benchmark; produção continua devolvendo evidência. O prompt dele é
deliberadamente estrito ("responda SOMENTE pelos trechos", com frase de escape
para "não encontrei"): um gerador permissivo produziria respostas certas a
partir do conhecimento do modelo, com contexto ruim — e a nota diria que a base
vai bem quando quem foi bem foi o modelo.

**Dois modos, porque a diferença é de custo.** `recuperacao` mede só o
recuperador (duas métricas, sem gerador) e é o modo de rodar a cada mudança de
configuração; `completo` mede as cinco. Medido: cerca de um minuto por pergunta
no completo, com paralelismo de quatro.

**A pergunta gerada nasce `rascunho`.** A especificação pede "geração assistida
por LLM e **seleção humana**". Dataset golden que ninguém leu não é golden, e a
nota que sai dele mede o gerador de perguntas, não a base.

**A execução guarda o retrato da configuração.** Sem ele, comparar duas
execuções de meses diferentes não diz nada: a nota pode ter caído por regressão
ou por outro motor de corte, e não haveria como distinguir.

**O diagnóstico vem do PADRÃO das métricas, não de uma delas.** Foi verificado
com três cenários construídos de propósito, contra o provedor real:

| cenário | faithfulness | ctx_precision | ctx_recall | answer_correctness |
|---|---|---|---|---|
| resposta boa, contexto certo | 1,000 | 1,000 | 1,000 | 0,950 |
| resposta ruim, contexto certo | 0,000 | 1,000 | 1,000 | 0,124 |
| resposta boa, contexto errado | 0,000 | 0,000 | 0,000 | 0,950 |

`faithfulness` cai nos **dois** casos ruins — ela sozinha não distingue. Quem
distingue é o contexto. E o caso mais instrutivo apareceu numa execução real:
uma pergunta fora do domínio da base teve `faithfulness` **1,0**, porque o
gerador foi honestamente fiel a um contexto que não tinha a resposta. Lida
sozinha, essa métrica diria "perfeito".

**A média é harmônica.** Quatro métricas em 1,0 e uma em 0,0 dão 0,80 na
aritmética e **0,0** na harmônica. Um sistema que não recupera o contexto certo
não é 80% bom.

## A ponte com os provedores desta casa

O Ragas fala com um cliente do SDK oficial da OpenAI; o kb-api fala quatro
dialetos, decifra credencial do banco e conta tokens. A ponte é
`ragas_client.py`, e ela precisou resolver um problema medido:

O modelo de chat em uso (`gpt-5.6-luna`, de raciocínio) **recusa** a família de
parâmetros de amostragem que o Ragas envia, um de cada vez:

```
Unsupported parameter: 'max_tokens' is not supported with this model.
Unsupported parameter: 'top_p' is not supported with this model.
Unsupported value: 'temperature' does not support 0.01 ... Only the default
```

Tirar a lista preventivamente seria pior: `temperature=0` é o que faz o juiz ser
reproduzível, e jogar fora o determinismo de um benchmark para agradar um modelo
que talvez nem esteja em uso é o pior dos dois mundos. Por isso o transporte
**aprende**: manda como veio e, quando recusam, tira o parâmetro que a mensagem
nomeia e reenvia. Num modelo que aceita, nada é removido. O que foi recusado vai
para o resumo da execução, porque explica uma avaliação rodada com temperatura
diferente da pedida.

A credencial vai do banco para o cliente **em processo**, e não entra em log nem
em mensagem de erro (ADR-0009).

## Consequências

Ganhos:

- **o diagnóstico aponta o que consertar.** "A nota caiu" vira "a busca não
  achou nestas seis perguntas" ou "o contexto chegou e a resposta estragou
  nestas duas" — e o conserto de cada uma é em lugar diferente;
- **comparar técnicas passa a ser possível**, que é o objetivo declarado de
  FUN-07: o mesmo dataset contra configurações diferentes, com o retrato de cada
  uma guardado;
- **a tela mostra o caso concreto.** A média esconde a pergunta que falhou, e é
  nela que se olha: o resultado por pergunta traz os trechos que a busca
  devolveu.

Custos e armadilhas:

- **é caro e é lento.** Uma métrica sozinha levou de 8 a 53 s contra o provedor
  real. Por isso roda em segundo plano, com paralelismo de quatro — e quatro, e
  não "o máximo que der", porque o provedor é compartilhado com a ingestão e com
  a busca de quem está usando o sistema;
- **`langchain-community<0.4` está no `pyproject` e não é usado.** O ragas 0.4.3
  importa `langchain_community.chat_models.vertexai`, módulo que sumiu na 0.4.
  Sem o teto, `import ragas` quebra;
- **os limiares do diagnóstico (0,7 e 0,4) são ponto de partida, não calibração.**
  Vale aqui a mesma regra do ADR-0017: número chutado esconde resultado, e o
  valor definitivo vem da medição;
- **o juiz é um LLM, com as limitações de um.** Duas execuções do mesmo conjunto
  podem divergir, e mais ainda quando o modelo recusa `temperature`. A nota
  serve para comparar configurações no mesmo dia, não como número absoluto.

## O viés do dataset gerado, medido

Numa execução completa sobre a base de 275 manuais (16 perguntas, 12,5 min,
nota harmônica 0,810), `context_recall` deu **1,0 em todas as dezesseis**.
Métrica que nunca varia não mede nada, e a causa é estrutural: a pergunta foi
escrita a partir de um documento que está na base, então o documento de origem
quase sempre aparece nas dez passagens recuperadas. O dataset gerado é **fácil
por construção**.

Isso não invalida a geração — ela dá cobertura barata e serve de linha de base.
Mas explica por que a especificação insiste em **seleção humana**, e por que a
tela põe o cadastro manual ao lado do botão de gerar, com o mesmo destaque: a
pergunta que alguém escreve porque *sabe* que a base erra nela é a que move a
agulha. Numa execução anterior, uma pergunta plantada fora do domínio foi a
única a acusar `recuperador`, com `context_recall` 0,0.

A leitura prática: `context_recall` alto num dataset só-gerado é o esperado, não
um atestado. Quem quiser medir de verdade precisa acrescentar as perguntas
difíceis à mão.

## Perguntas difíceis, e a armadilha de gerá-las

A geração direta produz um dataset fácil por construção (acima). A correção foi
uma segunda estratégia, `dificil`, instruída a **não reusar o vocabulário do
documento** — é ele que a busca lexical usa para acertar sem entender. Medido
sobre a mesma base, com 16 perguntas de cada:

| | harmônica | `context_recall` médio | zeros |
|---|---|---|---|
| direta | 0,830 | 1,000 | 0 |
| difícil | 0,297 | 0,406 | 9 |

A métrica saiu de constante para discriminante — que era o objetivo.

**Mas a primeira versão do prompt overshootou**, e isso quase produziu uma
conclusão errada. Inspecionando os nove fracassos, três dos cinco examinados não
eram falha de busca: eram perguntas escritas como se continuassem o documento —
*"o que acontece quando **essa configuração** é ativada?"*, sem antecedente
nenhum. Tirar o vocabulário sem exigir que a pergunta **se sustente sozinha**
troca "difícil" por "impossível", e a nota passa a medir o gerador de perguntas.

Duas correções, porque instrução sozinha não bastou:

1. o prompt ganhou a regra de autossuficiência, o teste do "caberia em dez
   documentos diferentes?" e os exemplos reais de pergunta ruim;
2. uma trava **determinística** recusa, antes de gravar, a pergunta em que um
   demonstrativo aponta para um substantivo genérico que não está nela
   (`autossuficiente`). A regra é estreita de propósito: ela não julga se a
   pergunta é boa — isso é a curadoria humana — só se ela referencia o que não
   existe.

## O que a medição sustenta, e o que ela desmente

Dos nove fracassos, **zero** eram de ranking: o documento correto não aparecia
nem no top-40. O experimento decisivo foi buscar o mesmo documento com dois
vocabulários:

| consulta | posição |
|---|---|
| "fazer um **intervalo do calendário** valer para uma instituição" | fora do top-40 |
| "vincular um **subperíodo letivo** a uma **unidade de ensino**" | 3ª |
| "o que muda quando o usuário **envia** uma rotina" | fora do top-40 |
| "procedimentos executados de forma **assíncrona**" | 1ª |

O conteúdo é achável; o que falha é a distância de vocabulário. Consequências
diretas para o roadmap, e as duas são o tipo de evidência que a especificação
exige para promover item de onda 2:

- **melhoria de query / HyDE (BUS-02) tem evidência medida a favor**;
- **reranking (BUS-06) não resolveria nenhum destes casos.** Reranquear não muda
  nada quando o documento não está entre os candidatos. É um achado negativo, e
  ele economiza o trabalho que a intuição mandaria fazer primeiro.

## Alternativas consideradas

**Implementar as cinco métricas como prompts próprios.** Evitaria a dependência
e manteria a contagem de tokens no caminho da casa. Descartada pela
especificação e porque os números não seriam comparáveis com nada externo.

**Medir só recuperação.** Barato e determinístico, sem gerador nenhum.
Descartada por deixar de fora três das cinco métricas nomeadas — mas sobreviveu
como **modo**, que é onde ela é a escolha certa.

**Rodar síncrono.** Descartada pelo tempo medido: o navegador ficaria esperando
dezenas de minutos e fechar a aba perderia a execução.

## O que ficou de fora

- **grid-search de hiperparâmetros com LLM-judge** (taxonomy §7): é onda 2
  explicitamente, e o critério para promover é evidência medida na onda 1;
- **comparação lado a lado entre execuções** na tela. Os dados estão gravados
  (dataset estável + retrato de configuração), e a tela ainda mostra uma
  execução por vez;
- **calibração dos limiares**, pelo motivo acima.

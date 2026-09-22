# ADR-0003 — Busca no filho, entrega do pai, motor escolhido por base

- **Status:** Aceito
- **Data:** 2026-09-10
- **Relacionado:** [0001](0001-documento-canonico-como-fonte-de-verdade.md),
  [0002](0002-indice-unico-em-postgres-com-pgvector.md), requisito ING-07

## Contexto

O tamanho do trecho é um tensionamento direto: trecho pequeno dá vetor preciso e
resposta sem contexto; trecho grande dá contexto e vetor impreciso, porque a
média de muitos assuntos não fica perto de nenhum deles.

Havia um segundo problema, descoberto depois. O pipeline aplicava a **mesma**
estratégia de corte em todo documento, e um manual com cabeçalhos não pede o
mesmo corte que uma ata em texto corrido. Com o motor fixo em variável de
ambiente, testar outra abordagem exigia reconfigurar o serviço inteiro, e duas
bases nunca podiam usar cortes diferentes ao mesmo tempo.

## Decisão

**Dois níveis.** O canônico é cortado em pais (até 4800 caracteres) e cada pai em
filhos (até 1200, com 150 de sobreposição). Ambos vivem na tabela `chunk`, com
`parent_id` nulo marcando o pai. A busca casa no **filho** e entrega o **pai**.

**Motor por Espaço.** `space.chunking` é um JSONB com o motor e os tamanhos,
editável na tela de Bases. Quatro motores:

| Motor | Corta por | Biblioteca | Custo |
|---|---|---|---|
| `markdown` (padrão) | cabeçalho, depois sentença | LlamaIndex `MarkdownNodeParser` | nenhum |
| `sentence` | fronteira de sentença | `SentenceSplitter` | nenhum |
| `semantic` | queda de similaridade entre sentenças | `SemanticSplitterNodeParser` | embeda cada sentença na ingestão |
| `fixed` | número de caracteres | corte próprio | nenhum |

Medido no mesmo arquivo desta base: 15, 17, 20 e 16 filhos, em 3,0 s, 3,3 s,
**34,1 s** e 2,6 s.

## Consequências

Ganhos:

- **precisão sem perder contexto.** O vetor do filho é específico, e quem lê
  recebe o pai;
- **cada base usa o corte que o formato dela pede**, e trocar uma não mexe na
  outra;
- **dá para comparar técnicas na mesma instalação**, que era impossível antes.

Custos:

- **duas vezes mais linhas em `chunk`.** Só o filho recebe vetor, então o custo
  de embedding não dobra;
- **a troca não é retroativa.** O que já está indexado mantém o corte antigo até
  ser reprocessado. Reprocessar sozinho levaria horas sem ninguém pedir, então a
  tela diz isso e marca o documento desalinhado com uma etiqueta;
- **o `semantic` custa dinheiro para decidir onde cortar.** É o único, e por isso
  não é o padrão.

Três armadilhas que só apareceram implementando:

1. o `SemanticSplitterNodeParser` traz o embedding da OpenAI por padrão. Um
   adaptador embrulha o `embed()` do projeto, para o corte usar o **mesmo**
   modelo que indexa. Dois modelos decidindo sobre o mesmo texto seria um defeito
   silencioso;
2. `ensure_space(chunking=None)` **preserva** o que está gravado, via `COALESCE`.
   A ingestão chama essa função a cada rodada sem saber de chunking, e sem isso
   apagaria em silêncio o motor escolhido na tela;
3. `fixed` usa corte mecânico nos **dois** níveis. Manter sentença no filho
   misturaria as técnicas, e a linha de base deixaria de medir o que promete.

## Desdobramento

O mesmo JSONB ganhou depois uma chave `okf`, que **não** é um quinto motor:
[ADR-0015](0015-okf-como-formato-de-entrada.md) registra por que formato de
entrada e motor de corte são perguntas diferentes, e o que quebraria ao juntá-las.

## Alternativas consideradas

**Um nível só, com trecho médio.** Descartada: é o pior dos dois mundos, vetor
mediano e contexto mediano.

**Janela deslizante sobre o documento inteiro.** Descartada por custo de
armazenamento e por devolver trechos que se sobrepõem no resultado, o que
polui a lista de evidências.

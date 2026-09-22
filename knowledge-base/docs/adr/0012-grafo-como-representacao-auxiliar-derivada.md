# ADR-0012 — O Memgraph pode ser perdido sem custo de dado

- **Status:** Aceito
- **Data:** 2026-09-10
- **Relacionado:** [0001](0001-documento-canonico-como-fonte-de-verdade.md),
  [0014](0014-ambiente-local-espelha-o-cluster.md), requisitos ING-12 e BUS-04

## Contexto

O requisito pede travessia de grafo como método de acesso complementar. A
tentação é tratar o grafo como fonte de verdade de relação entre documentos, com
extração de entidade por modelo de linguagem alimentando nós ricos.

Isso cria dependência dura: se o grafo é fonte, perdê-lo é perder dado, e ele
passa a precisar de backup, migração e consistência transacional com o Postgres.

## Decisão

O grafo é **representação auxiliar e derivada**. Escopo deliberadamente pequeno:

- nós `(:Space)`, `(:Document)` e `(:Term)`, com arestas `MENTIONS`;
- os termos são **lexicais**, extraídos do canônico sem modelo de linguagem;
- serve a uma coisa concreta: os "documentos relacionados" na tela de documento;
- é reconstruído a partir do canônico, que está no Postgres.

Consequência direta: **perder o Memgraph inteiro não custa dado.** Há um
`scripts/rebuild-graph.py` que o refaz em segundos.

Isso permitiu reusar o Memgraph **compartilhado** da plataforma em vez de subir
um próprio. É seguro porque os rótulos não colidem: o agentic-sdlc grava
`(:Project) (:WorkItem) (:Execution) (:File) (:Slice) (:Decision) (:Concept)`,
conferido nos dois repositórios antes de apontar para lá.

## Consequências

Ganhos:

- **uma peça a menos para operar.** Nada de backup, nada de plano de recuperação;
- **dá para dividir a instância** com outra stack, o que já é o caso em dev;
- **falha do grafo não derruba a busca.** `MEMGRAPH_ENABLED=false` desliga, e a
  tela diz que está desligado em vez de mostrar erro.

Custos:

- **o grafo não sobrevive a um stop do cluster.** O Memgraph não fez snapshot, e
  os "relacionados" desaparecem até alguém rodar o rebuild. Já aconteceu, e é
  aceitável exatamente porque é derivado;
- **termo lexical é pobre.** Sem extração de entidade, "Programa Excelência" e
  "gestão de performance" não se ligam. A wiki destilada e a extração por modelo
  ficaram de fora conscientemente;
- **dividir instância é dividir recurso.** Uma carga do vizinho afeta o tempo de
  resposta dos relacionados.

## Alternativas consideradas

**Grafo como fonte de verdade, com extração por modelo.** Descartada por
inverter a relação de custo: passaria a exigir backup e consistência para
entregar um recurso complementar.

**Sem grafo, relacionados por similaridade de vetor.** Tecnicamente viável e
mais barato de operar. Descartada porque o requisito pede travessia como método
de acesso distinto, e porque similaridade de vetor já é o que a busca faz.

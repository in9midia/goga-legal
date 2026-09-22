# ADR-0017 — Representações ativas por Espaço, e uma busca que funde os métodos

- **Status:** Aceito
- **Data:** 2026-09-11
- **Substitui:** [0015](0015-okf-como-formato-de-entrada.md) no que ele chamava
  de "modo de ingestão". O resto do 0015 (o OKF em si, a derivação de conceito)
  continua valendo, reposicionado.
- **Relacionado:** [0003](0003-chunking-pai-filho-com-motor-por-espaco.md),
  [0004](0004-busca-hibrida-fundida-por-rrf.md),
  [0012](0012-grafo-como-representacao-auxiliar-derivada.md),
  [0018](0018-wiki-destilada-como-segunda-representacao.md), requisitos FUN-03,
  BUS-01, BUS-04, BUS-05, ING-12

## Contexto

O ADR-0015 modelou a escolha de ingestão como um **modo único por Espaço**
(`padrao` ou `okf`). A especificação do projeto
([`docs/proposal/docs/system-design/conceptual-model.md`](../proposal/docs/system-design/conceptual-model.md)),
que é normativa, modela de outro jeito — e a diferença não é de nome:

- **representação** é uma estrutura derivada do canônico, construída na
  ingestão. São duas na v1: o **índice** (chunks + vetores + BM25), que é a
  representação de base e existe em **todo** Espaço, e a **wiki** (páginas OKF
  destiladas), ligável por Espaço;
- elas **não competem**: um Espaço pode ter as duas ativas, e o fan-out da
  ingestão constrói cada uma em separado, com estado próprio;
- o **grafo não é representação**. É *estrutura auxiliar* do índice: seus nós
  apontam para chunks pais que já existem e **não criam conteúdo novo**.

Um enum não expressa isso. `índice + wiki` não é um terceiro valor: é o conjunto
com os dois, e três representações dariam sete valores para descrever três
interruptores.

Havia um segundo problema, e é o que motivou a entrega: **como uma pergunta
atravessa trinta bases com representações diferentes?** A tentação é uma consulta
por base, ou uma tela de busca por tipo de base. As duas estão erradas, e a
especificação já dizia por quê (BUS-01: uma tool unificada, passagens de qualquer
representação num contrato comum).

## Decisão

**`space.representations` é um conjunto** (migração 0006), não um enum.
`{"indice": true, "wiki": false, "grafo": false}`. O `indice` entra sempre, venha
o que vier no JSON: aceitar desligá-lo seria aceitar quebrar a base em silêncio.

**O que o ADR-0015 chamava de modo virou o slot certo.** Prepender a identidade
do conceito antes do embedding tem nome na taxonomia do projeto: **Contextual
Chunk Headers**, variante do slot de *enriquecimento de chunk*, interno à
representação-índice. `space.chunking.enrichment` (`nenhum` | `conceito`). O
comportamento é o mesmo; mudou o nome e o lugar conceitual.

**A busca agrupa por método de acesso, não por base.** `representations.py`
registra as representações e os métodos que cada uma oferece; `retrieval.py`
registra os recuperadores. A busca:

```
Espaços alcançáveis → agrupa por MÉTODO disponível
                    → cada método roda UMA vez, sobre o seu grupo, em paralelo
                    → threshold POR MÉTODO
                    → RRF + dedup pela unidade de entrega
```

Com trinta bases e duas representações são **cinco métodos**, não trinta buscas.
E o embedding da pergunta é calculado **uma vez por modelo**, compartilhado entre
os métodos: o vetor da pergunta não depende de qual representação vai ser
consultada.

**A fusão é por posição, e o threshold é por método**, pela mesma razão: as
escalas não são comparáveis. Similaridade de cosseno, `ts_rank_cd` e "quantas
entidades alcançaram este trecho" não querem dizer a mesma coisa, e um corte
global ou zeraria um método ou não cortaria nada do outro.

**A passagem carrega a representação de origem.** Um trecho do índice é texto do
documento; uma página da wiki é texto que um modelo escreveu. Chegam na mesma
lista e não são a mesma coisa — omitir isso faria o agente citar uma síntese
achando que cita a fonte.

**O grafo entra como auxiliar, desligado.** Extração de entidades e relações
tipadas por LLM sobre os chunks **pais**, e travessia como método de acesso. Os
nós apontam para chunks que já existem: o grafo é o caminho, o índice é o
destino. Desligado por padrão porque a especificação põe isso em onda 2 e diz
que "o critério para promover algo de onda 2 é sempre uma evidência medida na
onda 1, nunca antecipação".

## Consequências

Ganhos:

- **o caso das trinta bases tem resposta, e ela é barata.** Medido no e2e: cinco
  métodos, uma vetorização, fusão única;
- **acrescentar representação não toca a busca.** Uma entrada em
  `representations.CATALOGO`, uma em `retrieval.RECUPERADORES`, e o
  comportamento na ingestão. A tela desenha o que o servidor mandar;
- **o agente sabe o que recebeu.** Cada passagem diz a representação e por quais
  métodos chegou.

Custos e armadilhas:

- **paralelismo tem teto.** Quatro métodos ao mesmo tempo (`MAX_PARALELO`), sobre
  um pool de oito conexões. Sem o teto, uma busca numa instalação com muitas
  representações tomaria o pool inteiro e travaria o resto da API;
- **um método que falha não derruba a busca.** Ele sai da fusão e o trace diz o
  que aconteceu. Uma busca sem o braço lexical é pior que uma completa e muito
  melhor que um erro;
- **a mesma escolha já teve três formatos gravados** (`okf: true`,
  `mode: okf`, `enrichment: conceito`), e os três foram para produção. A leitura
  dos antigos fica em `chunking._enriquecimento`: sem ela, um Espaço gravado num
  formato antigo voltaria em silêncio ao padrão e seria reindexado com outro
  texto;
- **a travessia precisou de normalização de acento.** O modelo extrai
  "Política de Férias" e a pergunta chega "ferias". O `CONTAINS` do Cypher é
  literal: sem normalizar os dois lados, a travessia devolvia **zero** em quase
  toda pergunta em português, sem erro nenhum. Medido no e2e antes da correção.

## Alternativas consideradas

**Manter o enum de modo.** Descartada por contrariar documento normativo, e
porque a primeira combinação real (`índice + wiki`) já não cabia nele.

**Uma tela de consulta por tipo de base.** Foi a pergunta que originou a
entrega, e a especificação responde melhor: uma tool só, com métodos por
representação. Telas separadas obrigariam quem pergunta a saber de que tipo é
cada base — que é exatamente o que a fronteira de Espaço existe para esconder.

**Uma consulta por base.** Descartada por custo: trinta bases dariam trinta idas
ao banco e trinta vetorizações por pergunta.

**Normalizar os scores para fundir por valor.** Descartada pela mesma razão de
sempre (ADR-0004): normalizar escalas incomparáveis inventa uma comparação que
não existe. RRF combina por posição, que é o que sobrevive à diferença de escala.

## O que ficou de fora

- **reranking** (BUS-06, F5): o pool fundido vai direto para a resposta;
- **melhoria de query** (BUS-02, F1): rewrite e step-back não existem;
- **`consult`** (BUS-08): a superfície agêntica segue prevista e dispensável;
- **threshold calibrado**: os valores estão em zero (desligado). Um número
  chutado esconderia resultado bom numa base pequena; ele vem da medição.

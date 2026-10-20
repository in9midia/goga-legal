# ADR-0033 — O OR lexical leva os termos mais raros até um orçamento, e cada método de acesso tem prazo

- **Status:** Aceito
- **Data:** 2026-10-20
- **Relacionado:** ADR-0004 (OR no braço lexical), ADR-0017 (métodos em paralelo), ADR-0019 (índice lexical "o próximo lugar a olhar"), requisito BUS-01

## Contexto

O Studio desistia de buscas na KB. O cliente dele espera 30 s, tenta de novo
por mais 20 s, e na noite de 19/10 várias chamadas de `buscar_kb` morreram
exatamente nesses 50 s. O registro de `search_run` mostrou o padrão:

- busca em uma ou duas bases, sozinha: de 0,5 a 3 s;
- busca em 16 a 23 bases (especialistas de apoio e a consulta do
  Classificador): de 50 a 271 s;
- busca em uma base enquanto as grandes rodavam: de 50 a 80 s.

Medido no banco de produção (231 mil trechos filhos), com a pergunta
"manifestação sobre embargos em agravo em recurso especial no STJ":

| Método | uma base | todas as bases |
|---|---|---|
| semântico (HNSW) | 0,2 s | 0,7 s frio, 7 ms quente |
| **lexical** | 0,06 s | **18,6 s com o banco ocioso, 1,4 milhão de buffers** |

O motivo é o OR do ADR-0004. A pergunta vira `agrav | embarg | empres |
especial | manifestaca | processual | recurs | regular | representaca | sobr |
stj`, e "sobre" sozinho está em 57% dos trechos ("processual" em 33%,
"recurso" em 21%). **187 mil dos 231 mil trechos casavam**, e o `ts_rank_cd`
ranqueava todos para devolver 40. Com quatro métodos por busca, várias buscas
ao mesmo tempo e o Postgres limitado a 1 CPU e 1 GiB, isso virava minutos.

Cortar só o termo que passa de 10% não bastou: os que sobram ainda casavam com
58 mil trechos, e só contá-los levou 11 s. O que manda no custo é a **soma** dos
trechos casados pelos termos que ficam, e não a frequência de cada um.

## Decisão

**1. O OR lexical tem orçamento de linhas.** Os lexemas da pergunta entram do
mais raro para o mais comum enquanto a soma estimada de trechos casados couber
em `KB_LEXICAL_MAX_LINHAS` (padrão 15000). A estimativa é a frequência do lexema
vezes os trechos dos Espaços pedidos:

- a frequência vem de `pg_stats.most_common_elems`, que o ANALYZE já calcula
  para colunas tsvector. Contar os trechos de cada termo na hora custaria o que
  se queria evitar. Lexema fora da lista vale metade do menos comum dela, a mesma
  estimativa do planejador;
- a escala é a das bases pedidas, e não a da base inteira: numa busca só em
  `cdc`, "consumidor" cabe e fica; em todas as bases, não;
- sem estatística (base nova, nunca analisada) nada é cortado, o comportamento
  de antes;
- termo que sozinho estoura o orçamento não distingue nada e sai. Pergunta só
  de termos comuns fica sem braço lexical, e o trace diz isso
  (`estado: so termos comuns`); o semântico cobre.

O número veio de medida em produção, com as perguntas que estouravam, em todas
as bases:

| Orçamento | Termos que ficaram (CNH; embargos no STJ) | Trechos casados de fato | Tempo do lexical |
|---|---|---|---|
| 5000 (primeira versão) | `cassaca`; `manifestaca` | não medido | 10 a 45 ms |
| **15000** | `cassaca`, `cnh`, `excess`; `manifestaca`, `regular`, `representaca` | 4,5 a 7,2 mil | 0,2 a 0,6 s, com cache em parte quente |
| 20000 | igual na CNH; + `agrav` nos embargos | 16 mil | 5 s com cache frio |

Com 5000 a busca em todas as bases ficava com um termo só, e saía até "cnh".
Com 20000 o tempo encostava no prazo do método. A estimativa erra para cima (o
orçamento de 15000 escolhe termos que casam 4 a 7 mil trechos), o que deixa
folga sob concorrência.

O trace do método mostra os `termos` que entraram e os `termos_comuns_fora`.
Vale para os dois braços lexicais (trechos e páginas da wiki).

**2. Cada método de acesso tem prazo** (`KB_METODO_TIMEOUT_MS`, padrão 8000),
aplicado em dois lugares:

- como `statement_timeout` das consultas do método, por `set_config(..., true)`,
  que vale só na transação. Um `SET` de sessão ficaria na conexão do pool e
  derrubaria a ingestão, que roda consultas longas de propósito;
- como prazo da busca para esperar o método. O `statement_timeout` não cobre o
  resto do método (embedding, Memgraph). O método atrasado sai da fusão com
  `estado: tempo esgotado`, e a busca não espera por ele: o executor é fechado
  com `shutdown(wait=False)`, porque o `with` esperaria o atrasado terminar.

## Consequências

Ganhos:

- a busca em muitas bases deixa de custar o ranqueamento da base inteira;
- nenhum método segura a busca por mais de 8 s, então o cliente de 30 s não
  desiste mais por causa de um braço só.

Custos:

- **o lexical perde termos comuns que às vezes importavam.** Uma pergunta só de
  termos comuns fica sem braço lexical. O semântico e a travessia continuam;
- **a estatística é aproximada e envelhece.** Vem do último ANALYZE, fica uma
  hora em cache e supõe o termo distribuído por igual entre as bases. Termo
  concentrado numa base pode passar do orçamento real nela. O prazo do item 2
  é a rede de segurança;
- **o método que estourou continua rodando até o banco cancelar**, numa thread
  do executor e com uma conexão do pool. O `statement_timeout` limita isso ao
  mesmo prazo.

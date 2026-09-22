# ADR-0019 — Uma busca que continua rápida com milhares de arquivos

- **Status:** Aceito
- **Data:** 2026-09-12
- **Relacionado:** [0004](0004-busca-hibrida-fundida-por-rrf.md),
  [0017](0017-representacoes-por-espaco-e-busca-que-funde-metodos.md),
  [0018](0018-wiki-destilada-como-segunda-representacao.md), requisitos BUS-01,
  BUS-04, FUN-08

## Contexto

A busca respondia em cerca de um segundo com 365 documentos, e isso parecia
aceitável. A medição contra a stack real mostrou que o número escondia duas
coisas, e as duas pioram com escala.

**Primeiro: o tempo da busca não era a busca.** A ida e volta ao provedor de
embedding levava 1.033 ms, 1.119 ms e 8.435 ms em três tentativas seguidas,
enquanto a consulta inteira levava ~1.030 ms. O Postgres respondia em 21 ms. O
serviço passava 97% do tempo esperando a vetorização da pergunta, e boa parte
disso era aperto de mão TLS — `urllib` abre conexão nova a cada chamada.

**Segundo: o braço vetorial fazia varredura sequencial.** Sem índice, o custo é
linear no número de vetores. Com 3.972 vetores são 21 ms e 53 MB lidos; com 100
mil seriam mais de meio segundo e mais de um gigabyte **por busca**. O caso de
uso declarado é "milhares de arquivos indexados".

Havia ainda duas coisas erradas de menor porte. O ADR-0017 prometia que "o
embedding da pergunta é calculado uma vez por modelo, compartilhado entre os
métodos", e o código não fazia isso: `semantica` e `paginas` chamavam o provedor
cada um, e uma base com índice + wiki pagava duas idas e cobrava os tokens duas
vezes. E o teto de espera do embedding era único: 180 s com três tentativas, o
que faz sentido na ingestão (onde um blip custa o documento inteiro) e na busca
significa até nove minutos de tela parada.

## Decisão

**Índice HNSW sobre `halfvec`** (migração 0008). O impedimento anterior era real
e está registrado no ADR-0018: `column cannot have more than 2000 dimensions for
ivfflat index`, e o modelo devolve 3072. O que destrava é o tipo `halfvec` do
pgvector 0.7+ (aqui roda 0.8.6), indexável até 4000 dimensões. O índice é sobre a
**expressão** `embedding::halfvec(3072)`, então a coluna continua `vector(3072)`
com o valor exato: a meia precisão vale para a comparação dentro do índice, não
para o dado. Vale para `chunk_embedding` e para `wiki_page_vector`.

**A consulta escreve a mesma expressão do índice.** Índice de expressão só entra
se o `ORDER BY` a repete literalmente, e voltar à forma antiga **não dá erro
nenhum** — só devolve a varredura sequencial. Há teste travando a consulta e a
migração juntas, porque este é o modo de falha mais difícil de perceber: a busca
continua correta e fica lenta.

**`hnsw.iterative_scan = relaxed_order` por conexão.** A busca sempre filtra por
Espaço, e índice aproximado com filtro é o caso clássico de "o índice devolve 40
vizinhos e o filtro deixa três". O scan iterativo continua puxando até o `LIMIT`
ser satisfeito **depois** dos filtros. `relaxed_order` e não `strict_order`
porque o que sai do método vai para o RRF, que funde por posição: pagar por ordem
estrita para embaralhar na linha seguinte é desperdício.

**Conexão persistente com o provedor de IA.** Uma `requests.Session` no módulo,
com pool, no lugar do `urllib`. `requests` passou a ser dependência declarada —
ele já estava na árvore por transitividade, e depender disso sem declarar
deixaria a busca lenta no dia em que a árvore mudasse, sem nada no diff sugerindo
a causa.

**Cache do vetor da pergunta, com voo único.** LRU de 256 entradas, TTL de cinco
minutos, chaveado por `(provedor, pergunta)`. Voo único, e não um dicionário: os
métodos rodam em paralelo, então dois threads pedem o mesmo vetor no mesmo
instante e um cache ingênuo deixaria os dois chamarem o provedor. É também o que
finalmente cumpre a promessa do ADR-0017.

**O cache não cobra tokens.** Servir do cache devolve um sinal dizendo que veio
de lá, e quem soma o uso conta zero. Contar de novo o que não foi gasto inflaria
a conta do provedor na tela de consumo, que é justamente a tela onde alguém vai
olhar para decidir sobre custo.

**O teto de espera depende de quem espera.** Busca: 8 s e duas tentativas.
Ingestão: 180 s e três, como era. A degradação da busca existe e é boa — sem
vetor, o Espaço sai do braço semântico e segue pelo lexical, o que é muito melhor
que um erro depois de nove minutos.

## Consequências

Medido contra a stack, na mesma base de 276 documentos:

- **pergunta repetida: 1.633 ms → 63 ms**, e zero token cobrado;
- **plano do Postgres: `Seq Scan` → `Index Scan using chunk_embedding_hnsw`**,
  215 entradas de índice varridas para devolver 40 linhas, 11,6 ms contra
  21,2 ms. O ganho que importa não é esse: é deixar de ser linear;
- **a pior busca do benchmark caiu de 32,5 s para 11,2 s** só com o teto por
  operação, antes da conexão persistente.

Custos e armadilhas:

- **meia precisão custa recall.** É o compromisso padrão da técnica, e perder um
  pouco de recall é muito melhor que varrer a tabela inteira. Se algum dia
  incomodar, o caminho é reduzir a dimensão do embedding na origem (a API do
  modelo aceita `dimensions`), não voltar à varredura;
- **o índice precisa ser construído.** `CREATE INDEX CONCURRENTLY`, fora de
  transação, para não travar ingestão e busca durante a construção. Numa base
  grande isso leva tempo, e a migração é reexecutável;
- **cache de cinco minutos é uma janela de inconsistência**, se alguém trocar o
  modelo de um provedor. Trocar modelo já obriga a reindexar tudo, então a janela
  é teórica — mas está limitada de propósito, e não deixada em aberto;
- **o cache é por processo.** Com mais de uma réplica, cada uma tem o seu. Isso é
  aceitável e até desejável: um cache compartilhado exigiria Redis para guardar
  aquilo que custa uma chamada de 60 ms quando quente.

## Portabilidade: o que é migração e o que não é

Verificado contra um banco criado vazio: as oito migrações aplicam e os dois
índices HNSW nascem com a definição correta. O banco zerado ficou com as mesmas
20 tabelas e os mesmos 57 índices do que estava em uso, com definições idênticas.

Tudo que este ADR decide viaja: o índice está na migração 0008, os ajustes de
sessão (`ef_search`, `iterative_scan`) estão no código do recuperador, e o cache,
a conexão persistente e os tetos por operação são código. `requests` passou a ser
dependência declarada, com entrada no `uv.lock`.

**A migração 0008 é acessória** (`-- kb:opcional`). Um servidor com pgvector
anterior ao 0.7 não tem `halfvec` e não pode criar o índice — e derrubar o serviço
por causa de um índice inverteria a lógica do projeto, que é a mesma do grafo e
de um método de busca que falha: acessório degrada, não derruba. A falha não entra
no ledger, então a próxima subida tenta de novo e o índice aparece sozinho no dia
em que o servidor for atualizado. Há teste contra Postgres de verdade cobrindo os
dois lados: a acessória que falha não derruba nem interrompe a fila, e a
obrigatória que falha continua derrubando.

O ambiente de destino é PostgreSQL gerenciado da OCI, e a medição de 2026-09-10
registrada no README do overlay de GitOps diz `vector 0.8.0` — tem `halfvec` e
tem scan iterativo.

**O que NÃO é migração, e por quê.** O Memgraph é inteiramente derivado e não tem
esquema a versionar. Num ambiente que vinha de uma versão anterior, duas
correções alcançam só o que for ingerido depois delas (`Term.norm` e o `:Chunk`
repetido do MERGE de caminho), e o caminho para o resto é
`scripts/rebuild-graph.py`. As duas falham em silêncio, o que é justamente o
motivo de estarem escritas em `docs/desenvolvimento.md` em vez de confiadas à
memória.

## O que continua de fora

- **reranking** (BUS-06) e **melhoria de query** (BUS-02);
- **threshold calibrado**: segue em zero, e o número vem da medição;
- **índice lexical dedicado.** O braço lexical usa `ts_rank_cd` sem índice GIN
  sobre `to_tsvector`. Não apareceu como gargalo na medição (o vetorial dominava
  tudo), e criar índice antes de medir é o erro que este ADR existe para não
  repetir. É o próximo lugar a olhar quando a base crescer.

# ADR-0002 — Vetor e texto no mesmo banco e na mesma transação

- **Status:** Aceito
- **Data:** 2026-09-10
- **Relacionado:** [0004](0004-busca-hibrida-fundida-por-rrf.md),
  [0005](0005-permissao-resolvida-no-servidor.md), requisitos ING-10 e FUN-12

## Contexto

Busca híbrida precisa de duas capacidades: similaridade vetorial e busca
lexical. O desenho mais comum na indústria separa as duas em bancos diferentes,
um vetorial dedicado (Qdrant, Pinecone, Weaviate) e um de texto (Postgres,
Elasticsearch).

Com dois bancos, cada gravação de trecho passa a ser duas gravações, em sistemas
que não compartilham transação. Não existe estado intermediário correto: ou o
vetor existe sem o texto, ou o texto existe sem o vetor, e nos dois casos a busca
mente por omissão sem erro nenhum aparecer.

O escopo de permissão agrava. O filtro por Espaço (ADR-0005) tem que valer nos
dois braços, então a informação de permissão precisaria ser replicada e mantida
em sincronia nos dois bancos.

## Decisão

Um banco só: **PostgreSQL com a extensão `pgvector`**.

- `chunk` guarda o texto, a página e o `space_slug`;
- `chunk_embedding` guarda o vetor, em tabela separada;
- as duas gravações acontecem na **mesma transação**;
- a busca lexical usa `tsvector` nativo com `unaccent`, e a vetorial usa o
  operador de distância cosseno (`<=>`) do pgvector.

O embedding fica em tabela própria de propósito: trocar de modelo reconstrói
`chunk_embedding` sem tocar no canônico nem nos chunks.

## Consequências

Ganhos:

- **não existe índice meio gravado.** É a razão principal;
- **o filtro de escopo é um `WHERE`**, aplicado igual nos dois braços, com uma
  fonte de verdade só;
- **menos peça para operar.** Uma instância a menos para provisionar, monitorar,
  backupar e explicar.

Custos:

- **o pgvector não é um banco vetorial dedicado.** Em escala de dezenas de
  milhões de vetores, um índice HNSW especializado ganha. Nesta base (663
  vetores hoje, ordem de milhões no horizonte previsível) a diferença não
  aparece;
- **a extensão precisa existir no servidor.** `vector` não é contrib do Postgres,
  e num banco gerenciado quem decide a lista é o provedor. Isso já virou um
  bloqueio real no ambiente de dev, tratado no ADR-0014;
- **a dimensão entra no DDL.** `vector(3072)` é fixo na coluna, então trocar para
  um modelo de outra dimensão exige migração e reindexação. O sistema recusa
  ativamente essa troca (ADR-0009).

## Alternativas consideradas

**Qdrant, que já existe no cluster.** Descartada: resolveria o braço vetorial e
deixaria o problema das duas gravações de pé, agora com o agravante de o filtro
de permissão viver em dois lugares.

**Só busca lexical.** Descartada. Medido nesta base: pergunta que não repete as
palavras do documento (o caso normal) não encontra nada sem vetor.

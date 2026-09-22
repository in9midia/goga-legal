# ADR-0024 — O conceito diz desde quando e até quando vale, e a busca pergunta pela data do fato

- **Status:** Aceito
- **Data:** 2026-09-21
- **Relacionado:** [0003](0003-chunking-pai-filho-com-motor-por-espaco.md),
  [0015](0015-okf-como-formato-de-entrada.md),
  [0017](0017-representacoes-por-espaco-e-busca-que-funde-metodos.md),
  [0025](0025-nivel-de-confianca-como-filtro-da-busca.md), migração 0016,
  requisitos BUS-01, BUS-04

## Contexto

A base não sabia dizer se o que ela recuperou ainda valia.

O modo de falha é o pior tipo que existe neste projeto: **silencioso e com cara
de acerto**. Conteúdo revogado responde à pergunta tão bem quanto o vigente. As
palavras são as mesmas, o vetor é vizinho, o `ts_rank_cd` é alto. Ele sobe no
ranking exatamente como qualquer outro trecho, a busca reporta sucesso, a
telemetria mostra cinco passagens com score bom, e a resposta montada em cima
delas está ancorada na regra que deixou de valer. Nada falha, nada avisa.

A pergunta certa quase nunca é "o que vale hoje". É **"o que valia naquela
data"** — e isso não é de um domínio só:

- política interna substituída, e alguém pergunta sobre um caso do ano passado;
- versão de manual que saiu de circulação, e o equipamento em campo é o antigo;
- tabela de preço, de alíquota, de limite, de SLA — todas datadas;
- norma revogada, que é o caso que motivou a entrega.

O OKF não tem campo para isso, e não tinha como ter: a especificação é mínima e
não registra esquema. Mas ela também não proíbe — chave extra no frontmatter é
explicitamente tolerada, e é assim que um consumidor acrescenta o que o seu
domínio exige sem deixar de ser OKF.

## Decisão

**O conceito ganha `vigencia: {de, ate}`, e a busca ganha `as_of`.**

```yaml
vigencia:
  de: 1990-09-11
  ate: null        # null, ausente ou vazio = ainda vigente
```

Três regras fixam o comportamento, e as três existem por causa de um modo de
falha concreto:

**1. Ausência é "sempre válido", nunca "inválido".** A imensa maioria dos
documentos de qualquer base não declara vigência. Se ausência significasse
"fora de vigência", ligar `as_of` esvaziaria a busca inteira — e esvaziaria sem
erro, que é o jeito mais caro de errar aqui. Data ilegível cai na mesma regra,
pela tolerância que a especificação obriga: `ate: "ano que vem"` não pode fazer
a ingestão recusar o bundle, e tratar isso como "revogado" seria pior do que
ignorar.

**2. A comparação é textual, sobre ISO-8601.** O natural seria
`(okf->'vigencia'->>'ate')::date`, e ele não entra em índice: o cast de texto
para data é `stable`, não `immutable`, porque depende do `DateStyle` da sessão.
Postgres recusa em índice de expressão e em coluna gerada — e sem índice o
filtro só existiria varrendo. Texto ISO-8601 com zero à esquerda ordena igual ao
calendário, então `>=` e `<=` sobre a string dão a mesma resposta. A garantia de
formato fica na **entrada** (`okf.data_iso`), que normaliza o `datetime.date` que
o YAML produz sozinho, aceita a string com aspas, e recusa `1990-9-11` antes de
gravar. Normalizar na leitura seria normalizar a cada busca, para sempre.

**3. Não há coluna nova.** O conceito inteiro já vive em `document.okf`. Uma
coluna `vigencia_de` ao lado passaria a divergir do JSONB no primeiro caminho de
escrita que esquecesse dela, e a divergência seria invisível: o filtro usaria a
coluna e a tela mostraria o JSONB. A migração 0016 acrescenta apenas um **índice
parcial**, sobre os documentos que declaram a chave.

**O filtro entra na consulta, não depois dela.** É o ponto que parece detalhe de
implementação e não é. Cada método de acesso pede `pool_size` candidatos ao
banco; o que fosse descartado em Python sairia do pool sem ser reposto. Uma base
com muito conteúdo revogado devolveria quarenta candidatos, o filtro deixaria
três, e a busca voltaria com três resultados — parecendo que o assunto quase não
existe na base. Filtrar no `WHERE` faz o banco repor.

**A derivação não inventa vigência.** `okf.derive()` pede ao modelo tipo, título,
descrição e tags, e não pede datas. Vigência é fato jurídico ou administrativo
verificável, e um modelo que "deduz" a data de revogação de um documento produz
exatamente o dado que este filtro existe para evitar.

## Consequências

Ganhos:

- **a pergunta datada tem resposta.** `as_of=2019-03-04` não devolve o que já
  estava revogado naquele dia, nem o que só passou a valer depois;
- **vale para qualquer base.** Manual antigo, política substituída e tabela do
  ano passado usam o mesmo campo e o mesmo parâmetro;
- **o custo de quem não usa é zero.** Sem `as_of` não há cláusula nenhuma a mais
  na consulta, e sem `vigencia` no frontmatter não há chave a mais no JSONB.

Custos e limites, registrados para não serem redescobertos:

- **vigência é do DOCUMENTO, não do dispositivo.** Um documento que reúne vários
  artigos com vigências diferentes tem uma vigência só. Cortar por dispositivo
  exigiria vigência por chunk, e o chunk não é uma unidade que alguém edita;
- **o filtro não sabe o que substituiu o quê.** Ele remove o revogado; não
  aponta o sucessor. A ligação entre a norma velha e a nova é relação, e relação
  é assunto do grafo (ADR-0012);
- **conteúdo já ingerido continua sem vigência** até ser reprocessado com o
  frontmatter preenchido. Isso é aditivo por construção: eles seguem aparecendo;
- **a wiki é filtrada pelo mesmo campo**, lido do `frontmatter` da página. Na
  prática nenhuma página declara vigência hoje, então todas passam — o que está
  correto: uma síntese sem data declarada não é uma síntese revogada.

## Alternativas consideradas

**Colunas `vigencia_de` / `vigencia_ate` em `document`.** Indexariam melhor e
são o caminho óbvio. Descartadas pela segunda fonte de verdade: o dado nasce no
frontmatter, é gravado no JSONB pela ingestão, e uma cópia em coluna divergiria
em silêncio. O ganho de índice é recuperado com índice parcial de expressão.

**Coluna gerada (`GENERATED ALWAYS AS ... STORED`).** Resolveria a divergência,
e o Postgres a recusa: a expressão precisaria do cast `text::date`, que não é
`immutable`.

**Filtrar em Python, depois da consulta.** Serviria aos cinco métodos de uma vez
e não tocaria SQL nenhum. Descartada pelo `LIMIT`: o pool é preenchido pelo
banco, e o que se descarta depois não é reposto.

**Marcar o documento revogado como inativo (`document.active = false`).** Já
existe e parece de graça. Está errado: revogado não é inexistente. A pergunta
sobre um fato de 2019 precisa **encontrar** a regra de 2019.

**Pedir a vigência ao modelo na derivação.** Descartada sem hesitação: seria
gerar o dado que o filtro existe para tornar confiável.

# ADR-0010 — Contador por dia, não histórico de chamadas

- **Status:** Aceito
- **Data:** 2026-09-10
- **Relacionado:** [0009](0009-provedores-de-ia-no-banco-cifrados.md), requisito WEB-05

## Contexto

Com o provedor de IA cadastrável (ADR-0009), a pergunta imediata passa a ser
quanto se está gastando. O requisito é um painel de tokens por dia, e a exigência
explícita foi que fosse performático.

O desenho instintivo é gravar um evento por chamada e agregar na leitura. Ele
começa mais simples e fica caro **exatamente quando o número passa a importar**:
com a base cheia, somar os tokens do mês vira uma varredura de milhões de linhas
a cada abertura da tela.

## Decisão

Uma tabela de **rollup**, `ai_usage_daily`, com chave
`(day, provider_id, model, operation)`. Cada chamada de IA faz **um** UPSERT que
soma no contador do dia:

```sql
ON CONFLICT (day, provider_id, model, operation) DO UPDATE
   SET calls = calls + 1, tokens = tokens + EXCLUDED.tokens, ...
```

A tela lê algumas dezenas de linhas por mês, então custa o mesmo com a base vazia
e com ela cheia. Verificado: cinco chamadas viraram duas linhas.

Três detalhes deliberados:

- **as falhas contam.** Uma sequência de 429 é justamente o que se quer ver no
  painel, não só no log;
- **`operation` diz de onde veio** (`index`, `search`, `chunking`, `test`), o que
  separa o custo da ingestão do custo das perguntas;
- **sem FK para `ai_provider`**, e o nome fica desnormalizado ao lado. Apagar o
  cadastro de um provedor não pode apagar o gasto que já aconteceu.

O registro **nunca levanta exceção**. Telemetria que derruba a busca é pior que
telemetria ausente, então a falha vai para o log e a vida segue.

## Consequências

Ganhos:

- **a tela é barata por construção**, e continua barata;
- **o gasto fica atribuível** por provedor, modelo e origem da chamada.

Custos:

- **granularidade de dia.** Não dá para perguntar "quais foram as chamadas das
  14h05". É o que a tela promete, e é o que cabe num contador;
- **um round trip de banco por chamada de IA.** É um UPSERT em tabela pequena,
  microssegundos, e acontece uma vez por lote de embedding e não por texto.

## Alternativas consideradas

**Tabela de eventos com agregação na leitura.** Descartada pelo motivo do
Contexto. Daria a granularidade de hora, que ninguém pediu, ao custo de a tela
piorar com o uso.

**Ler o spend log do LiteLLM.** Funciona só para o que passa pelo gateway, e o
gateway é opcional aqui (ADR-0009). Ficaria com metade do gasto.

**Contador em memória com flush periódico.** Descartada por complexidade sem
ganho: o UPSERT já é barato, e um flush pendente se perde no restart do pod.

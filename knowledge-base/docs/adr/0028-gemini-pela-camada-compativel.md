# ADR-0028 — Gemini entra pela camada compatível, e o uso não reportado entra como estimativa

- **Status:** Aceito
- **Data:** 2026-09-21
- **Relacionado:** [0003](0003-provedor-de-ia-configuravel.md),
  [0004](0004-busca-hibrida-com-rrf.md),
  [0008](0008-indice-vetorial-hnsw.md)

## Contexto

O operador pediu suporte a Gemini, com `gemini-embedding-001`.

A API nativa do Gemini fala outro formato. O embedding é
`POST .../models/<modelo>:embedContent`, com o texto em
`content.parts[].text`, e a resposta vem em `embedding.values`. Os quatro
provedores existentes falam o formato da OpenAI: `{"input": [...]}` no pedido e
`data[].embedding` na resposta.

Suportar o formato nativo significaria um ramo condicional dentro de
`embedding.py` para montar o corpo e outro para ler a resposta — exatamente o
que a tabela `providers.DIALETOS` existe para evitar. O comentário dela diz a
intenção: acrescentar um provedor deve ser **uma linha, não uma caça a
condicionais**.

Há um segundo fato. O `gemini-embedding-001` devolve **3072 dimensões por
padrão**, que é o que a coluna `chunk_embedding.embedding` fixa no DDL — mas ele
**aceita truncar** para 1536 ou 768 (Matryoshka), e truncado continua
respondendo `200`, com um vetor menor.

**O que acontece então não é degradação silenciosa.** A coluna é `vector(3072)`,
e o pgvector recusa: `expected 3072 dimensions, not 1536`. Conferido neste
cluster. A armadilha 2 de [`arquitetura.md`](../arquitetura.md) é outra e mais
sutil — **mesma dimensão, modelo diferente**, que produz espaço vetorial
incomparável e "devolve lixo ordenado sem reclamar". Contra ela existe
`_espacos_por_modelo()`, e não é desta decisão que ela trata.

O que a dimensão errada custa é **onde e quando** a falha aparece: no `INSERT`,
no meio de uma ingestão que já pagou OCR e chunking, com uma mensagem do
Postgres que não diz qual provedor está mal cadastrado nem onde corrigir.

## Decisão

**Gemini entra pela camada compatível com OpenAI do Google**
(`https://generativelanguage.googleapis.com/v1beta/openai`), como mais uma
linha em `DIALETOS`. O pedido, a resposta e a listagem de modelos passam a ser
os mesmos do dialeto `openai`.

**E o uso que o provedor não reporta entra como estimativa, nunca como zero.**
A camada compatível do Google **não devolve o bloco `usage`** (conferido contra
a API). Sem tratamento, toda chamada gravaria `tokens = 0` como se fosse
medição, e o painel de custo por caso — o risco 8 do plano — mostraria gasto
zero para uma base inteira. Zero é pior que ausente, porque parece medido.

A coluna `tokens_estimados` já existia para exatamente isso, e a regra da casa
já estava escrita: estimativa não soma com apurado. Agora o caminho do
embedding a usa.

A estimativa é quatro caracteres por token, que é **regra de bolso e não
medição nossa** — erra para mais em léxico jurídico, denso em palavra longa. É
por isso que ela vai para a coluna separada, e não para `tokens`.

**O que este ADR NÃO acrescentou:** a conferência da dimensão do vetor. Ela
**já existia** em `embed()`, comparando o retorno com `settings.embedding_dim`.
Uma segunda conferência contra o `dimensions` do cadastro foi escrita e depois
**removida**: além de redundante, ela reprovaria uma instalação que funciona
quando o campo do cadastro estivesse errado e o modelo devolvesse o que o
índice espera.

## Custo

- **Dependemos de uma camada de compatibilidade que o Google pode mudar.** O
  sinal de que mudou é `400` ou vetor de tamanho inesperado, e os dois falham
  alto. É o custo que torna a alternativa (um cliente nativo) desnecessária
  hoje.
- **O custo do embedding pelo Gemini é estimado, não medido.** A tela precisa
  mostrar as duas colunas separadas, senão o operador soma estimativa com
  apurado sem saber. E a estimativa erra para mais em texto jurídico.
- A camada compatível não expõe recursos nativos do Gemini (por exemplo,
  `task_type` no embedding, que ajusta o vetor para consulta ou para documento).
  Perder isso custa alguma qualidade de recuperação, e é reversível: no dia em
  que importar, entra um dialeto nativo com o corpo próprio.

## Descartado

**Cliente nativo do Gemini**, com `:embedContent` e o corpo próprio. Daria
acesso a `task_type` e não dependeria de camada de compatibilidade, mas
introduziria o primeiro `if kind == ...` dentro de `embedding.py` — e o segundo
viria fácil. Fica para quando houver motivo medido, não antes.

**Passar `dimensions` para todos os provedores.** Mandar o campo para uma
`api-version` antiga do Azure é `400`, e o ganho seria zero: o
`text-embedding-3-large` já devolve 3072. O campo é por dialeto.

**Confiar só no `dimensions` do pedido.** Seria uma trava que depende de o outro
lado obedecer, e o modo de falha que ela deixaria aberto é justamente o
silencioso.

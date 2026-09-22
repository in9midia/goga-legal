# ADR-0026 — A conferência do conceito fica registrada: contra o quê, quando e por quem

- **Status:** Aceito
- **Data:** 2026-09-21
- **Relacionado:** [0001](0001-documento-canonico-como-fonte-de-verdade.md),
  [0015](0015-okf-como-formato-de-entrada.md),
  [0025](0025-nivel-de-confianca-como-filtro-da-busca.md), migração 0018

## Contexto

`verified` é campo da própria especificação OKF e é uma lista de assinaturas:
quem validou (`human:<id>` ou um ator não humano) e quando. Dele sai o nível de
confiança (ADR-0015), e é ele que o ADR-0025 transformou em filtro.

Ele responde uma pergunta e não responde a seguinte. Responde **que** alguém
validou. Não responde **contra o quê**.

A diferença aparece no dia em que o conteúdo é contestado. "Isto foi conferido"
não sustenta nada sozinho; "isto foi conferido em 17/09/2026, contra o texto
publicado em tal endereço, pela curadoria" sustenta. E há um estado intermediário
que `verified` não sabe expressar: **conferência reaberta**. Uma assinatura
antiga continua lá, válida na forma, enquanto alguém já descobriu que ela pode
estar errada e voltou a conferir. Durante essa janela o conteúdo não deveria
contar como conferido — e contava.

## Decisão

**O conceito ganha `auditoria: {status, fonte, conferido_em, conferido_por}`.**

```yaml
auditoria:
  status: verificada-mantida      # verificada-corrigida | em-verificacao | ...
  fonte: "endereço ou identificação do que serviu de referência"
  conferido_em: 2026-09-17
  conferido_por: "curadoria"
```

**Os dois campos convivem, e não competem.** `verified` continua sendo o campo
da especificação, exportável e legível por qualquer outro consumidor de OKF;
`auditoria` é o detalhe operacional de quem mantém a base. Fundir os dois
obrigaria a inventar subcampo dentro de um campo da especificação, e o bundle
deixaria de ser legível fora daqui — que é a propriedade pela qual o OKF foi
escolhido.

**O vocabulário de `status` é livre, com uma exceção que tem comportamento.**
`em-verificacao` **rebaixa** o nível de confiança a `unverified`, mesmo havendo
um `verified` assinado. O motivo é direto: a conferência foi reaberta porque há
dúvida sobre aquela assinatura, e continuar contando com ela é confiar
exatamente no que se pôs em dúvida.

**O rebaixamento só anda para baixo.** Nenhum status faz subir de nível. Se
subisse, bastaria escrever `status: verificada` no frontmatter para um documento
virar revisado, e a escala inteira passaria a ser declaração de quem edita o
arquivo — o oposto do que o ADR-0015 fixou ao dizer que o nível é derivado,
nunca declarado.

**Qualquer outro status é texto livre, e não tem efeito.** A especificação proíbe
recusar um bundle por valor desconhecido, e um vocabulário fechado aqui recusaria
bundles válidos de quem organiza a curadoria de outro jeito.

**O índice da migração 0018 é para a fila de curadoria, não para a busca.** A
busca filtra por `trust`, nunca por status. Quem consulta por status é o outro
lado do balcão: "o que está em verificação agora", "o que foi conferido antes de
tal data e merece reconferência". É uma fila de trabalho, e ela varre a tabela
inteira sem o índice.

## Consequências

Ganhos:

- **a conferência passa a ser auditável.** A pergunta "contra o quê isto foi
  conferido?" tem resposta no próprio documento, e não na memória de quem
  conferiu;
- **conferência reaberta deixa de valer como conferida**, sem ninguém precisar
  apagar a assinatura antiga — o que seria perder o histórico para expressar um
  estado temporário;
- **a fila de curadoria tem consulta.** Status e data de conferência são
  indexados, então "o que está pendente" e "o que envelheceu" são consultas, não
  planilhas paralelas.

Custos e limites:

- **é um campo, não um fluxo.** Nada nesta entrega faz a conferência acontecer,
  nem cobra a reconferência. Quem escreve o frontmatter escreve a auditoria;
- **`fonte` é texto livre.** Não há verificação de que o endereço existe, nem de
  que ele diz o que o conceito afirma. Verificação de citação contra fonte
  primária é outro assunto, e ele não mora nesta base;
- **a auditoria é do DOCUMENTO**, com o mesmo limite do nível de confiança: um
  documento conferido em parte não tem como dizer isso;
- **mais um índice parcial em `document`** (migração 0018).

## Alternativas consideradas

**Usar só `verified`, com convenção no `by`.** Algo como
`by: "human:curadoria@planalto.gov.br/l8078"`. Descartada: empilha três
informações num campo que a especificação define como identificação de ator, e a
primeira ferramenta OKF que lesse o bundle mostraria a string inteira como nome
de pessoa.

**Tabela própria de auditoria, fora do JSONB.** Daria histórico de conferências,
que o campo não dá. Descartada por agora: o dado nasce no frontmatter, junto do
conceito, e uma tabela criaria uma segunda fonte de verdade que a ingestão teria
de manter em sincronia a cada reprocessamento. Quando houver **histórico** de
conferências (e não apenas a última), esta decisão precisa ser revista.

**Vocabulário fechado de status, validado na ingestão.** Descartada pela regra de
tolerância da especificação: recusar valor desconhecido quebraria bundles
válidos. O único valor com significado é o que rebaixa, e ele rebaixa para o
lado seguro.

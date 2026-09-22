# ADR-0016 — Cada base escolhe o seu modelo, de embedding e de chat

- **Status:** Aceito
- **Data:** 2026-09-11
- **Relacionado:** [0002](0002-indice-unico-em-postgres-com-pgvector.md),
  [0003](0003-chunking-pai-filho-com-motor-por-espaco.md),
  [0009](0009-provedores-de-ia-no-banco-cifrados.md),
  [0015](0015-okf-como-formato-de-entrada.md), requisitos ING-09, FUN-04

## Contexto

O [ADR-0009](0009-provedores-de-ia-no-banco-cifrados.md) tirou o provedor da
variável de ambiente e o pôs no banco, editável por tela. Isso resolveu o
problema de trocar de modelo sem abrir PR de infraestrutura, mas manteve uma
limitação que só apareceu depois: **o provedor é um só para a instalação
inteira**, a linha marcada com `is_default`.

É exatamente o defeito que o [ADR-0003](0003-chunking-pai-filho-com-motor-por-espaco.md)
já tinha corrigido para o motor de corte, e pelo mesmo motivo: este projeto
existe para **comparar técnicas** (FUN-04), e com uma escolha global não há como
rodar dois modelos lado a lado. Trocar o modelo para experimentar significava
trocar para todas as bases ao mesmo tempo.

O [ADR-0015](0015-okf-como-formato-de-entrada.md) agravou o problema ao
introduzir um segundo propósito: agora são **dois** modelos por instalação, e
uma base que quisesse um gerador mais barato para classificar documentos
arrastaria todas as outras junto.

## Decisão

**`space.embedding_provider_id` e `space.chat_provider_id`** (migração 0004),
ambos anuláveis, com `REFERENCES ai_provider(id) ON DELETE SET NULL`.

`NULL` é o valor de todo Espaço já gravado e significa **"use o padrão da
instalação"**. Não é ausência de informação: é a escolha de não escolher, e
continua sendo o caso da maioria. Nenhuma base muda de comportamento por causa
desta migração.

**A resolução tem duas camadas**, em `providers.padrao(purpose, space)`: a
escolha do Espaço, quando há uma e o provedor dela continua ativo; senão o
`is_default`. Cair para o padrão é a degradação desejada, não um bug — ver
Consequências.

**O Espaço viaja por todo caminho que fala com um modelo.** `embed(texts,
operation, space)`, `llm.complete_json(..., space)`, `okf.derive(..., space)`, e
o adaptador do corte semântico. Não existe "Espaço corrente" implícito: passar o
errado não daria erro nenhum, só vetorizaria com o modelo de outra base.

**A busca agrupa por modelo.** `search._espacos_por_modelo()` devolve `None`
quando todos os Espaços alcançáveis usam o mesmo modelo — o caso de qualquer
instalação que não usou este recurso — e aí a busca segue idêntica ao que era:
uma vetorização, uma consulta. Quando divergem, a pergunta é vetorizada **uma
vez por modelo** e o braço vetorial roda por grupo.

**A dimensão continua travada.** A API recusa, por Espaço, provedor de embedding
cuja dimensão não case com a do índice — a mesma guarda que o `is_default` já
tinha, porque `chunk_embedding.embedding` é `vector(N)` fixo no DDL.

## Consequências

Ganhos:

- **dá para comparar dois modelos na mesma instalação**, que era impossível. É
  a mesma capacidade que o ADR-0003 deu ao corte;
- **o custo fica onde a decisão é.** Uma base pode usar um gerador barato para
  classificar documentos sem impor isso às outras;
- **a tela diz o que está EM VIGOR, não o que foi escolhido.** `resolvido()`
  devolve `from_space`, distinguindo "escolhido nesta base" de "padrão da
  instalação" — inclusive quando a escolha caiu porque o provedor sumiu.

Custos e armadilhas:

- **a chave do cache passou a ser `(propósito, Espaço)`.** Com a chave só no
  propósito, a primeira base a consultar gravaria o provedor dela e as outras
  usariam o modelo errado por até 60 s — vetorizando com um modelo contra um
  índice de outro, **sem erro nenhum**. É o teste mais importante de
  `test_provedor_por_espaco.py`;
- **trocar o embedding não reindexa**, pela mesma razão de trocar o motor: o que
  já está indexado guarda os vetores do modelo anterior. A tela diz isso;
- **comparar similaridade entre modelos diferentes é aproximação.** Quando uma
  busca abrange bases com modelos distintos, cada grupo devolve seus candidatos
  e a ordenação final os mistura por similaridade — números que vêm de espaços
  vetoriais diferentes. É a melhor aproximação disponível, e a recomendação
  continua sendo **um modelo por instalação**, salvo quando o objetivo é
  justamente comparar;
- **`ON DELETE SET NULL`, e não `RESTRICT`.** Apagar um provedor em uso não pode
  quebrar a base que o escolheu: ela volta ao padrão. Com `RESTRICT`, o operador
  descobriria o vínculo só ao tentar apagar, e teria de caçar quais Espaços
  apontavam para lá sem nenhuma tela que dissesse. A mitigação é a tela: a lista
  de provedores mostra quais bases escolheram cada um.

## Alternativas consideradas

**Deixar como estava, um provedor por instalação.** Descartada: mantém
impossível o que o projeto existe para fazer.

**Recusar busca que abranja bases com modelos diferentes.** Seria o mais
correto tecnicamente, e foi descartado por ser inutilizável: o escopo de uma
busca vem das permissões de quem pergunta, não de uma escolha dele. Um
administrador, que alcança tudo, nunca mais conseguiria buscar.

**Uma vetorização só, ignorando a divergência.** Descartada, e é o bug que este
ADR existe para evitar: o `<=>` compara vetores de modelos diferentes sem
reclamar, devolve um número que não quer dizer nada, e a base inteira pareceria
funcionar devolvendo lixo ordenado.

**Índice separado por modelo (uma tabela de embedding por dimensão/modelo).**
Descartada para esta v0 por custo: resolve de verdade o problema da comparação
entre modelos, mas multiplica DDL, migração e consulta. Fica registrado como o
caminho certo se a comparação entre modelos virar uso corrente em vez de
experimento.

## O que ficou de fora

- **reindexação automática ao trocar o modelo.** Segue manual, pelo reprocesso
  do Espaço, como na troca de motor;
- **a tela não marca documento "desalinhado" por modelo**, como faz por motor de
  corte. `chunk_embedding.model` guarda o modelo de cada vetor e o dado está
  lá — falta a comparação na tela;
- **nada impede duas bases com o mesmo modelo e endpoints diferentes** de serem
  tratadas como modelos distintos no agrupamento da busca: o agrupamento é por
  id de provedor, não por nome de modelo. É conservador de propósito.

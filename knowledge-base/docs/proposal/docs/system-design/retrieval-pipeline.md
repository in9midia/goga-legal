# Pipeline de Busca (Retrieval)

## 1. Visão geral

O pipeline de busca expõe **duas superfícies em camadas**:

- **`search`** (onda 1) — o primitivo: tool de busca stateless que roda o fluxo uma única vez por chamada e devolve passagens candidatas rankeadas, acompanhada pela tool `fetch`, que devolve por id um documento canônico ou uma página da wiki inteiros, com suas referências. É a superfície recomendada para chamadores que são agentes: eles têm o contexto da conversa com o usuário e conduzem o próprio loop de tentativas.
- **`consult`** (onda 2) — o produto agêntico, construído sobre o primitivo: um agente de retrieval interno conduz ciclos de busca, avalia suficiência e devolve evidência consolidada em uma única chamada. É a superfície para consumidores não-agênticos ou que preferem delegar o loop.

Três princípios estruturais definem o desenho:

1. **Uma tool de busca unificada** devolve passagens candidatas de qualquer representação, complementada pela **tool `fetch`**, que devolve por id o item inteiro (documento canônico ou página da wiki) com suas referências. O contrato comum de passagem candidata é o que permite unificar.
2. O **reranking é etapa comum**: reordena o pool mesclado de passagens, venha do índice ou da busca de páginas da wiki.
3. A **melhoria de query tem divisão de papéis explícita**: decomposição e reformulação informada são do agente que conduz o loop (o interno no `consult`, o do chamador no `search`); reescrita single-shot é slot ligável dentro da tool; HyDE é variante de embedding de query dentro do método semântico.

```text
CONSUMIDOR agêntico / Simulador             CONSUMIDOR não-agêntico
    │ (conduz o próprio loop)                   │ (delega o loop)
    │                                           ▼
    │                        ┌─ CONSULT (onda 2) ─────────────────────┐
    │                        │ agente de retrieval interno:           │
    │                        │ planeja → busca → avalia → repete      │
    │                        │ devolve evidência + flag suficiência   │
    │                        └──────────────────┬─────────────────────┘
    │ query + parâmetros                        │ usa os mesmos
    │ (escopo, representações,                  │ primitivos
    │  enhance, top_k)                          │
    ▼                                           ▼
┌─ SEARCH (stateless, 1 passada) ────────────────────────────────────┐
│ F0 Hard filter de segurança (Espaços permitidos)                   │
│ F1 Melhoria de query        [slot, default off]                    │
│ F2 Filtro de escopo         (Espaço, tags, facetas)                │
│ F3 Métodos de acesso em paralelo                                   │
│     ├ índice: semântica (embedding de query: crua | HyDE)          │
│     ├ índice: full-text BM25                                       │
│     ├ índice: travessia de grafo               (onda 2)            │
│     └ wiki:   busca de páginas (multi-vetor + BM25)                │
│ F4 Normalização → passagens candidatas                             │
│     ├ expansão de contexto (filho → pai, só índice)                │
│     ├ threshold de similaridade                                    │
│     └ fusão (RRF) + dedup                                          │
│ F5 Reranking (pool mesclado)                                       │
│ F6 Retorno: passagens rankeadas + trace                            │
└────────────────────────────────────────────────────────────────────┘
         + FETCH (documento canônico ou página da wiki, por id, com referências)
```

## 2. Superfícies e consumidores

| Superfície | Onda | Consumidor típico | Contrato |
|---|---|---|---|
| **`search`** + **`fetch`** | 1 | Agentes externos (via MCP) e Simulador | Uma passada por chamada; passagens rankeadas + trace. `fetch` devolve o item inteiro por id. O loop de tentativas é do chamador. |
| **`consult`** | 2 | Sistemas não-agênticos e integrações que delegam o loop | Uma chamada; loop interno completo; evidência consolidada + flag de suficiência + trace. |

O par `search` + `fetch` segue o padrão de mercado levantado em 2026-09-03: o contrato de conectores de conhecimento do ChatGPT exige exatamente uma tool `search` (query → lista de ids, títulos e URLs) e uma tool `fetch` (id → texto completo), e os servidores MCP para OKF, o plugin MCP do Obsidian e o padrão LLM Wiki seguem o mesmo desenho de "buscar, depois ler, o agente navega". O `consult` corresponde ao padrão `ask_question` (uma chamada, loop de recuperação interno), com a diferença deliberada de devolver evidência e flag de suficiência em vez de resposta gerada.

O contrato do `consult` tem três regras pensadas para domar a agência aninhada quando o chamador também for um agente:

- **Orçamento explícito por chamada**: máximo de ciclos, teto de tokens e timeout são parâmetros da chamada, não configuração oculta.
- **Retorno estruturado, não prosa**: contexto consolidado, passagens com origem, flag de suficiência e trace de custo, preservando a capacidade de raciocínio do chamador.
- **Evidência, não resposta final**: a geração da resposta ao usuário fica com o chamador, que tem o contexto da conversa. O agente interno é um agente de retrieval, de escopo fechado e terminável.

A tool `search` precisa ser completa sozinha (por isso o slot de melhoria de query existe dentro dela): na onda 1 ela é a única superfície de busca (acompanhada do `fetch` para leitura), e na onda 2 segue sendo o primitivo sobre o qual o `consult` é construído.

## 3. A tool de busca por dentro

Stateless, executa uma vez por chamada, sem retry interno. Parâmetros: query, escopo (Espaço(s), tags, facetas), representações a consultar, melhoria de query on/off, top_k.

**F0 — Hard filter de segurança.** Interseção entre o escopo pedido e os Espaços permitidos do chamador. Aplicado antes de tudo, não contornável por parâmetro.

**F1 — Melhoria de query** (slot, default off). Reescrita single-shot: variantes `rewrite` e `step-back`. O agente normalmente chama com off, porque reformular é papel dele; o simulador liga e desliga para medir; consumidores diretos ligam se quiserem. Decomposição em sub-queries **não** vive aqui: gera múltiplas chamadas de tool, logo é orquestração (papel do agente).

**F2 — Filtro de escopo.** Algorítmico sobre metadados (Espaço, tags, facetas como data e autor). A dedução de tags a partir da query via LLM (metadata tagging) é variante ligável deste slot.

**F3 — Métodos de acesso em paralelo.** Cada representação consultada aciona seus métodos ativos. No método semântico do índice, a estratégia de embedding da query é um slot interno (crua na onda 1; HyDE como variante A/B na onda 2). A busca de páginas da wiki devolve páginas inteiras como passagens (qualquer vetor de seção que casar devolve a página toda).

**F4 — Normalização e pós-processamento.** Todos os resultados convergem para o contrato de passagem candidata:

```yaml
passagem_candidata:
  texto: string            # chunk pai (índice) ou página inteira (wiki)
  origem:
    representacao: indice | wiki
    documento_canonico: id   # e página OKF, quando wiki
    espaco: id
  scores: { semantica: float?, bm25: float?, rerank: float? }
  metadados: { tags: [], variantes_usadas: {} }
```

Sub-etapas, todas algorítmicas: expansão de contexto (filho → pai, só para resultados do índice), corte por threshold aplicado **por método de acesso** (cada método tem valor próprio, porque as escalas de score não são comparáveis entre si; a mesma razão pela qual a fusão usa posições de ranking), fusão dos rankings (RRF como default) e dedup. Filtragem por diversidade (Dartboard) fica registrada como variante de onda 2, para quando o corpus ficar denso. A expansão de contexto tem uma variante alternativa registrada: **RSE (Relevant Segment Extraction)**, que em vez de subir para um chunk pai fixo reconstrói dinamicamente segmentos contínuos a partir de chunks adjacentes relevantes. O filho → pai é o default por ser mais simples e determinístico; RSE só entra em avaliação se casos concretos mostrarem que o pai fixo corta contexto relevante.

**F5 — Reranking** (slot; modelo de rerank é variante). Reordena o pool mesclado. Como tudo já está em formato de passagem, o reranker pontua pares (query, passagem) sem saber a origem: o rerank se aplica a **tudo que for passagem**, independentemente da representação de onde veio. O que não passa por rerank é saída sintetizada por LLM (caso do navegador sub-LLM da wiki), porque não é passagem comparável.

**F6 — Retorno.** Top-k de passagens rankeadas mais o trace da execução (variantes usadas em cada slot, tempos, tokens, custo, scores). O trace é devolvido no retorno da chamada e fica também recuperável por identificador de execução; alimenta o simulador, os logs e a avaliação offline.

## 4. Tool `fetch` (leitura e navegação)

`fetch(id)` devolve um item inteiro a partir do identificador que veio numa passagem candidata: a versão atual de um **documento canônico** ou uma **página da wiki**. Junto com o conteúdo vêm as referências do item: numa página, os links cruzados para outras páginas; num documento canônico, as páginas da wiki derivadas dele, quando a wiki estiver ativa no Espaço. É a tool que completa o `search`: a busca encontra o ponto de entrada, o `fetch` entrega o inteiro e abre a navegação.

A busca de páginas (dentro da tool de busca) resolve o problema do **ponto de entrada** na wiki. A partir de uma página encontrada, a navegação segue as referências cruzadas. O slot de navegação tem duas variantes:

| Variante | Como funciona | Trade-off |
|---|---|---|
| **Leitura direta** (default onda 1) | O próprio agente navega com `fetch`, página por página, seguindo as referências devolvidas. | Simples, sem segunda LLM, cada passo visível no trace. Consome contexto do orquestrador. |
| **Navegador sub-LLM** (variante ligável) | Uma sub-LLM encapsulada recebe a página de entrada, navega e devolve contexto sintetizado. | Protege o contexto do orquestrador em navegações longas. Custo extra e saída que pula o rerank. |

O `fetch` obedece à mesma regra transversal de segurança do modelo conceitual (§7): ler um item ou listar suas referências valida o Espaço do item contra os Espaços permitidos do chamador, e item fora de escopo não é lido nem aparece como referência navegável.

A leitura direta é o default porque as páginas são atômicas (garantia do contrato de destilação) e a busca de páginas entrega o ponto de entrada; nessa condição, o agente navegar por conta própria é o caminho mais simples e rastreável. O navegador sub-LLM fica registrado como variante para quando a economia de contexto do agente que conduz o loop justificar o custo extra. As duas variantes são mensuráveis pelo mesmo trace.

## 5. O loop agêntico e o serviço `consult` (onda 2)

O loop pertence sempre a quem chama o `search`: ao agente do chamador na onda 1, e ao agente de retrieval interno do `consult` na onda 2. As tools são funções puras; o agente é o while loop. O ciclo abaixo descreve o agente interno do `consult` e vale igualmente como guia para um chamador agêntico bem construído:

1. **Planejar**: decidir escopo, representações e parâmetros da chamada. Decompor a pergunta em sub-queries quando composta (uma chamada de tool por sub-query).
2. **Avaliar** o retorno com critérios explícitos (inspirados em Self-RAG e CRAG): relevância das passagens para a pergunta, grau de suporte (grounding) que elas dão à resposta pretendida, e cobertura (sobrou parte da pergunta sem evidência?).
3. **Decidir a próxima ação**: parar (suficiente); reformular a query informado pelo que falhou; mudar escopo ou representação; navegar a wiki a partir de uma página promissora; ou declarar insuficiência.
4. **Consolidar**: montar a evidência final (contexto consolidado + passagens com origem) e devolvê-la ao chamador com a flag de suficiência.

Esgotado o orçamento da chamada sem suficiência, o `consult` retorna o melhor contexto acumulado **sinalizado como insuficiente**, nunca uma resposta com confiança fabricada. Fallback corretivo (ex.: busca web) fica registrado como slot de onda futura, desligado.

Não há mecanismo formal de política de retry ao lado do agente: a decisão de próximo ciclo é raciocínio do próprio agente sobre o histórico presente no seu contexto. Pelo mesmo motivo, não há classificação prévia da query em categorias fixas com estratégia especializada por categoria (estilo Adaptive-RAG): adaptar a estratégia à query é parte do raciocínio de quem conduz o loop, e formalizar uma taxonomia de queries só se justificaria se a avaliação offline mostrar que o agente não adapta bem sozinho.

## 6. Resumo das peças trocáveis deste pipeline

| Slot | Default (onda 1) | Variantes registradas |
|---|---|---|
| Melhoria de query (F1) | off | rewrite, step-back |
| Embedding de query (F3) | query crua | HyDE (onda 2) |
| Dedução de tags da query (F2) | off | metadata tagging via LLM |
| Expansão de contexto (F4) | filho → pai | RSE (condicional) |
| Fusão (F4) | RRF | — |
| Threshold (F4) | ativo, valor configurável por método de acesso | — |
| Diversidade (F4) | off | Dartboard (onda 2) |
| Reranker (F5) | modelo único configurável | troca de modelo |
| Navegação da wiki | leitura direta | navegador sub-LLM |
| Travessia de grafo (F3) | off (onda 2) | grafo em memória, entidades via LLM |
| Superfície `consult` | off (onda 2) | agente de retrieval interno sobre o `search` |
| Compressão contextual | off | onda 2, quando volume justificar custo |
| Fallback corretivo (agente) | off | busca web (futuro) |

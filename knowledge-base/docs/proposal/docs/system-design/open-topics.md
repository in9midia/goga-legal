# Pontos Abertos de Discussão

Documento de trabalho para discussões de arquitetura que atravessam sessões. Cada ponto registra o contexto, o estado da discussão e os desdobramentos possíveis. Quando um ponto é fechado, a decisão migra para o documento normativo correspondente em `docs/` e o ponto é marcado como fechado aqui, com a referência de destino.

Formato de cada ponto: **status** (aberto | em discussão | fechado), **contexto**, **estado da discussão**, **desdobramentos possíveis**, **próximos passos**.

---

## 1. Parent-child e multi-vetor: duas técnicas ou um mecanismo único?

**Status:** em discussão (aberto em 2026-07-11)

**Contexto**

O índice usa chunking hierárquico parent-child (busca no filho, retorno do pai). A wiki usa embedding multi-vetor por página (vetores de seção, retorno da página inteira). A observação que originou o ponto: as duas técnicas parecem equivalentes, e o multi-vetor parece dispensar o chunking, o que seria uma economia. Por que usar uma técnica em cada representação?

**Estado da discussão**

Consenso alcançado até aqui:

- A equivalência é real. Ambas seguem o padrão "casar no pequeno, entregar o inteiro", e na implementação ambas se reduzem a N vetores apontando para 1 unidade de entrega.
- A diferença não está no mecanismo de busca, está em quem fabrica a unidade de entrega. Na wiki, a página já nasce atômica (o contrato de destilação garante), então o custo de criar unidades do tamanho certo foi pago na destilação e o fatiamento para matching pode ser mecânico. No documento canônico não existe unidade de entrega natural (um PDF de 100 páginas não é entregável), então o chunk pai precisa ser fabricado, e é isso que o chunking faz.
- Princípio geral identificado: quanto mais limpo e estruturado o conteúdo, menos maquinário de preparação o retrieval precisa.
- Não há competição entre parent-child e multi-vetor: um modelo unificado seria a visão multi-vetor generalizada (a mais geral das duas, pois a unidade de matching não precisa de identidade própria), com o parent-child como instanciação dela no índice. A competição real e mensurável é entre **variantes de fabricação** das unidades no índice: chunking semântico via LLM vs. mecânico (janela fixa + parágrafos, custo zero de LLM) vs. proposition chunking, a decidir por telemetria e avaliação offline.
- Os termos genéricos **unidade de entrega** e **unidade de matching** foram aceitos e já registrados na taxonomia, que descreve o padrão comum ("casar no pequeno, entregar o inteiro") com as duas instanciações.
- Registro relacionado: a variante RSE (Relevant Segment Extraction), registrada no pipeline de busca como alternativa condicional à expansão de contexto, representa uma terceira resposta para "quem fabrica a unidade de entrega": em vez de fabricá-la na ingestão (chunking) ou ganhá-la pronta da destilação (wiki), fabrica-a dinamicamente em tempo de consulta, remontando segmentos contínuos a partir das unidades de matching relevantes.

**Encaminhamento provisório (2026-07-11):** o híbrido é mantido como está (parent-child no índice, multi-vetor na wiki, como técnicas nomeadas). A inclinação é unificar futuramente, mas a decisão de levar a unificação de mecanismo e vocabulário aos demais documentos normativos fica em aberto.

**Desdobramentos possíveis**

1. **Unificar no modelo conceitual**: adotar unidade de entrega e unidade de matching como vocabulário oficial. O mecanismo de storage e de expansão de contexto passa a ser único; cada representação define apenas como fabrica suas unidades (índice: chunking; wiki: ganha da destilação). Mudaria `conceptual-model.md`, `ingestion-pipeline.md` e `retrieval-pipeline.md`, sem mudar fluxo. Detalhe já mapeado: a granularidade do BM25 segue como botão por representação (unidades de matching no índice, página inteira na wiki).
2. **Manter como está**: duas técnicas com nomes próprios, aceitando a redundância conceitual em troca de vocabulário já estabelecido nos documentos.

**Próximos passos**

- Amadurecer se a unificação de mecanismo e vocabulário compensa o retrabalho nos documentos normativos.
- ~~Registrar a variante mecânica de chunking no slot correspondente~~ — feito: registrada no slot de chunking do pipeline de ingestão e na taxonomia.
- Planejar a comparação entre chunking mecânico e semântico quando a avaliação offline estiver rodando.

---

## 2. Onde vive o loop agêntico: na base ou no chamador?

**Status:** fechado (2026-09-03). Decisão registrada em `retrieval-pipeline.md` §2 e §4 e em `requirements.md` (BUS-01, BUS-07, BUS-08).

**Contexto**

Existe um atrito quando o consumidor da base é ele próprio um agente. Duas visões em tensão: (a) a base é uma tool pura, o fluxo roda uma única vez por chamada e o loop de tentativas fica inteiramente com o agente chamador; (b) a base é em si um tipo de agente, e quem chamar recebe uma resposta boa em uma única chamada porque a parte agêntica que tenta N vezes fica dentro da solução.

**Estado da discussão**

Custos mapeados de cada extremo:

- **Base como agente (loop interno)** cria agência aninhada quando o chamador também é agente: latência opaca (chamada longa sem visibilidade nem interrupção), custo invisível (tokens do loop interno não aparecem para o chamador), perda de contexto (o agente interno só vê a string da query, enquanto o chamador tem a conversa inteira e reformularia melhor) e loop duplo (chamador insatisfeito re-chama, e o loop interno roda tudo de novo, multiplicando tentativas sem coordenação). Há ainda um terceiro nível potencial: agente externo → agente da base → sub-LLM navegador da wiki.
- **Base como tool pura (loop no chamador)** transfere a qualidade para a competência de cada consumidor: cada integração reimplementa o loop, os critérios de suficiência e o orçamento; consumidores não-agênticos ficam com a qualidade de passada única; a promessa de produto "a base responde bem" deixa de ser garantível pela própria base.

Direção que emergiu na discussão: **não escolher, expor as duas superfícies como camadas.**

1. **`search`** — a tool de busca stateless (uma passada, passagens rankeadas). É o primitivo. Recomendada para chamadores agênticos.
2. **`consult`** — o serviço agêntico da base, construído sobre o primitivo: uma chamada, loop interno completo. É o produto para consumidores simples ou que preferem delegar.

Amarras propostas para domar o aninhamento quando um agente usar `consult`:

- Orçamento explícito como parâmetro da chamada (máximo de ciclos, teto de tokens, timeout), para o chamador controlar latência e custo.
- Retorno estruturado, não prosa: contexto consolidado + passagens com origem + flag de suficiência + trace de custo, preservando a capacidade de raciocínio do chamador.
- A base devolve evidência, não resposta final: a geração fica com o chamador, que tem o contexto da conversa. O agente interno é um agente de retrieval (escopo fechado e terminável), não um conversacional.

Observação de coerência: o Simulador da interface web precisa das duas superfícies (simular busca crua e simular consulta agêntica completa), e a telemetria deve distinguir as duas para os comparativos fazerem sentido.

**Encaminhamento provisório (2026-07-11):** os documentos normativos (`retrieval-pipeline.md`, `conceptual-model.md`, `web-management-ui.md`) foram estruturados no modelo de duas superfícies, com `search` na onda 1 e `consult` na onda 2. O ponto segue aberto até pesquisa adicional confirmar o modelo.

**Pesquisa de 2026-09-03.** Levantamento de como soluções de conhecimento expõem tools a agentes:

- O contrato de conectores de conhecimento do ChatGPT (OpenAI) exige exatamente duas tools: `search` (query → lista de ids, títulos e URLs) e `fetch` (id → texto completo). O ChatGPT chama `search` e depois `fetch` nos itens que julgar relevantes; o chamador conduz a navegação.
- Servidores MCP para OKF (hdean-ssp/okf-mcp, mfdaves/okf-mcp, okfbundle.com) seguem "buscar, depois ler": busca híbrida devolve conceitos, leitura devolve o conceito inteiro, com navegação de grafo em alguns.
- O plugin MCP oficial do Obsidian (`search_notes`, `search_content`, `read_note`, `get_backlinks`) e o padrão LLM Wiki de Karpathy (ler índice, buscar, ler páginas, sintetizar) seguem o mesmo desenho, com o agente navegando.
- O DeepWiki é o caso híbrido: `read_wiki_structure` e `read_wiki_contents` para o agente navegar, e `ask_question` como endpoint único com recuperação interna que devolve resposta sintetizada. É o precedente do `consult`, com a diferença de que o `consult` devolve evidência e flag de suficiência, não resposta.
- A especificação OKF não prescreve acesso: lista "infraestrutura de armazenamento, serviço ou consulta" como não objetivo.

**Encaminhamento final (2026-09-03):** modelo de duas superfícies confirmado. A tool de leitura foi generalizada como `fetch` por id, cobrindo documento canônico e página da wiki (antes só `ler_pagina` da wiki), o que alinha a superfície MCP ao contrato do ChatGPT. O `consult` permanece previsto como dispensável, até haver demanda de consumidores não-agênticos. O navegador sub-LLM continua como variante ligável do slot de navegação, não como caminho único.

**Desdobramentos possíveis**

1. ~~Confirmar o modelo de duas superfícies como decisão definitiva (já refletido nos documentos normativos).~~ Feito em 2026-09-03: `search`, `fetch`, `consult`.
2. Reduzir ou ampliar o escopo do `consult` conforme a pesquisa (por exemplo, mantê-lo indefinidamente fora do roadmap se não houver demanda real de consumidores não-agênticos).
3. ~~Definir os nomes definitivos das duas superfícies (search/consult é vocabulário de trabalho).~~ Feito em 2026-09-03: `search`, `fetch`, `consult`.

**Próximos passos**

- ~~Pesquisa adicional do operador sobre o padrão (precedentes de mercado de retrieval agêntico como serviço, comportamento de tools agênticas via MCP)~~ — feito em 2026-09-03, ver acima.
- ~~Validar o contrato de retorno do `consult` (evidência + suficiência, sem resposta final)~~ — confirmado; registrado em `requirements.md` BUS-08.
- Definir como o custo do loop interno aparece para o chamador (campo de custo no retorno, quota, ou ambos). Fica para quando o `consult` sair de dispensável.

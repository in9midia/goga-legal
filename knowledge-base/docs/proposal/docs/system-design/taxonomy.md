# Taxonomia de Técnicas

Nomenclatura adotada para as técnicas envolvidas na arquitetura da base de conhecimento. Precisão terminológica é essencial para comunicação entre times e para a documentação técnica. Cada entrada indica se a técnica envolve IA (✦ IA) ou é puramente algorítmica, e em que parte do sistema ela vive.

**RAG — Retrieval-Augmented Generation**

Padrão arquitetural que conecta LLMs a bases de conhecimento externas. Em vez de depender apenas do conhecimento treinado no modelo, o sistema primeiro **recupera** (retrieval) conteúdo relevante para a query e o fornece como contexto para o LLM gerar a resposta. É no "R" que reside a maior variação de técnicas, cada uma com trade-offs distintos de precisão, custo, velocidade e adequação ao tipo de conteúdo.

## 1. Preparação de conteúdo (ingestão)

**Document Parsing / Canonicalização**

Normalização executada antes de qualquer indexação. Converte documentos em múltiplos formatos (PDF, Word, Excel, Markdown) num documento canônico em Markdown limpo: extração de essência **sem reescrever**, removendo capas, cabeçalhos, rodapés, índices e sumários. Majoritariamente algorítmica; pode envolver ✦ IA para conteúdo visual (OCR e captioning de imagens). Ferramentas de referência: Docling, Unstructured.io, LlamaParse.

**Captioning de imagens** ✦ IA

Gera descrição textual de imagens e a indexa no lugar delas dentro do documento canônico. Alternativa futura registrada: ColPali (retrieval multimodal direto sobre imagens de páginas), só a considerar se houver evidência de perda relevante no captioning.

**Destilação** ✦ IA

Reescrita de conhecimento pela LLM: lê documentos canônicos e mantém uma wiki de páginas atômicas em formato OKF (frontmatter YAML e referências cruzadas como links Markdown). É o contraste deliberado com a canonicalização: a destilação **reescreve e sintetiza**; a canonicalização preserva. O custo de IA é pago na ingestão, tornando a consulta barata. É também a resposta do sistema à necessidade que técnicas de sumarização hierárquica como RAPTOR perseguem (síntese abstrativa para perguntas de alto nível); RAPTOR permanece registrado apenas como candidato alternativo de representação derivada, não adotado.

**Semantic Chunking** ✦ IA

Recorte do documento em pedaços logicamente autocontidos, respeitando fronteiras semânticas em vez de corte cego por tamanho fixo.

**Chunking mecânico**

Recorte por janela de tamanho fixo respeitando fronteiras de parágrafo, sem LLM (custo zero de IA na preparação). Variante registrada do slot de chunking, para comparação com o chunking semântico via telemetria e avaliação offline.

**Proposition Chunking** ✦ IA

Decomposição do texto em proposições atômicas via LLM (afirmações mínimas, autocontidas e factuais), usadas como unidades de matching. Variante condicional do slot de chunking; referência teórica: Dense X Retrieval.

**Padrão "casar no pequeno, entregar o inteiro"**

Padrão comum a mais de uma técnica do sistema: N vetores de matching apontam para 1 bloco de conteúdo devolvido inteiro. A **unidade de matching** é o texto pequeno que casa com a query; a **unidade de entrega** é o bloco completo retornado ao consumidor. Duas instanciações existem no sistema: o chunking hierárquico parent-child no índice (filho → pai) e o embedding multi-vetor por página na wiki (seção → página). A diferença entre elas não está no mecanismo de busca, e sim em quem fabrica a unidade de entrega: no índice ela precisa ser fabricada pelo chunking; na wiki ela nasce pronta do contrato de destilação.

**Hierarchical Chunking (Parent-Child)**

Divisão em dois níveis: **chunks filhos** (unidades de matching, indexadas para casamento fino) e **chunks pais** (unidades de entrega, blocos maiores de contexto). A regra é: **busca no filho, retorno do pai**.

**Contextual Chunk Headers** ✦ IA

Cabeçalho de contexto (documento/seção) gerado via LLM e prependado a cada chunk antes do embedding, tornando cada chunk mais autocontido para o matching.

**Document Augmentation (perguntas hipotéticas)** ✦ IA

Geração de perguntas associadas a cada chunk na indexação, aumentando a superfície de matching. Variante alternativa registrada: HyPE (embeddings das perguntas substituem o do chunk em vez de complementá-lo).

**Embedding multi-vetor por página**

Aplicado às páginas da wiki: um vetor por seção (unidades de matching), todos resolvendo para a página inteira (unidade de entrega). Não é chunking, não há hierarquia nem entrega de fragmento; é apenas múltiplos pontos de matching para a mesma unidade de entrega.

## 2. Filtros de escopo (pré-retrieval)

Reduzem o espaço de busca antes dos métodos de acesso. Os atributos de filtro são metadados independentes dos vetores: atualizáveis a qualquer momento sem re-embedding.

**Filtro por Espaço**

Restringe o retrieval a um subconjunto do corpus a partir do catálogo flat de Espaços. É o filtro de escopo primário e também a fronteira de segurança (o filtro por Espaços permitidos do chamador é inegociável e precede tudo).

**Faceted Search**

Filtragem por dimensões ortogonais: data, autor, tipo de documento, área de negócio.

**Metadata Tagging** ✦ IA

A LLM deduz tags relevantes a partir da query e filtra o corpus para documentos que as possuam.

## 3. Melhoria de query

**Query Rewriting / Step-back** ✦ IA

Reescrita single-shot da query (versão mais clara, ou mais ampla/abstrata no caso do step-back) antes do retrieval. Vive como slot ligável dentro da tool de busca.

**Decomposição em sub-queries** ✦ IA

Quebra de uma pergunta composta em sub-perguntas, cada uma gerando uma chamada de retrieval. É orquestração, não pré-processamento: papel do agente.

**HyDE — Hypothetical Document Embeddings** ✦ IA

Gera uma resposta hipotética via LLM e usa o embedding dela na busca, no lugar do embedding da query crua. Classificada como **estratégia de embedding de query** dentro do método de acesso semântico, não como etapa de fluxo.

## 4. Métodos de acesso (retrieval)

**Semantic Search** ✦ IA (embedding da query)

Busca vetorial por similaridade sobre os chunks filhos do índice. Captura significado e contexto, não apenas termos exatos.

**Full-Text Search (BM25)**

Busca lexical sobre frequência e raridade de termos. Precisa para keywords exatas e complementar à semântica.

**Busca Híbrida (Hybrid Search)**

Combinação de busca densa (semântica) com busca esparsa (lexical/BM25), com fusão dos rankings. É uma propriedade da etapa de busca, não o nome de uma representação ou caminho: no sistema ela ocorre tanto sobre o índice (chunks filhos) quanto sobre a wiki (páginas inteiras), já que ambos combinam vetores e BM25. Por extensão, "RAG Híbrido" designa um RAG cujo retrieval é híbrido nesse sentido; o sistema como um todo é um Agentic RAG com retrieval híbrido dentro.

**Busca de páginas**

Busca híbrida (multi-vetor + BM25) sobre as páginas inteiras da wiki. Serve para encontrar pontos de entrada; a unidade de retorno é sempre a página completa.

**Navegação por referências**

Leitura de páginas da wiki seguindo as referências cruzadas a partir de um ponto de entrada. A leitura é feita pela tool `fetch`, que devolve o item inteiro por id com suas referências. Na variante default o próprio agente navega (leitura direta); na variante alternativa uma sub-LLM ✦ IA encapsulada navega e devolve contexto sintetizado.

**Graph Traversal (Graph RAG)**

Navegação por um grafo de entidades e relações extraídas (✦ IA na construção) dos chunks pais do índice. Estrutura auxiliar que abre um caminho relacional até conteúdo existente; a travessia é algorítmica, limitada por saltos ou suficiência.

## 5. Pós-retrieval

**Context Expansion (filho → pai)**

Após o matching num chunk filho, o pipeline sobe para o chunk pai correspondente. Algorítmica. Variante alternativa registrada: RSE (Relevant Segment Extraction), que reconstrói segmentos contínuos a partir de chunks adjacentes relevantes em vez de subir para um pai fixo.

**Threshold de similaridade**

Descarte de resultados abaixo de um score mínimo antes de etapas caras, aplicado por método de acesso: cada método tem escala e valor de corte próprios, já que os scores não são comparáveis entre métodos. Algorítmica.

**Fusão de rankings (RRF — Reciprocal Rank Fusion)**

Combinação dos rankings dos diferentes métodos de acesso num pool único, seguida de deduplicação. Algorítmica.

**Reranking** ✦ IA

Modelo especializado reordena o pool mesclado de passagens candidatas por relevância à query, independentemente da representação de origem.

**Contextual Compression** ✦ IA

Compressão dos resultados via LLM antes da geração, mantendo só o relevante à query. Otimização de custo de tokens, para quando o volume de uso justificar.

**Filtragem por diversidade (Dartboard)**

Score que combina relevância e diversidade para remover quase-duplicatas do resultado. Relevante quando o corpus fica denso.

## 6. Orquestração

**Agentic RAG** ✦ IA

Um agente LLM orquestra múltiplos ciclos de retrieval, avalia resultados parciais e decide quando o contexto acumulado é suficiente. As tools são stateless e executam uma vez por chamada; loop, retry e reformulação são responsabilidade exclusiva do agente. **Analogia: as tools são funções puras; o agente é o while loop.**

**Padrão search + fetch**

Forma dominante de expor uma base de conhecimento a agentes: uma tool de busca devolve candidatos (id, título, trecho ou passagem) e uma tool de leitura devolve o item inteiro por id; o agente conduz a navegação em várias chamadas. É o contrato exigido pela OpenAI para conectores de conhecimento do ChatGPT (exatamente `search` e `fetch`) e o desenho seguido por servidores MCP para OKF e Obsidian e pelo padrão LLM Wiki. O sistema adota esse padrão na superfície `search` + `fetch`; o `consult` é a camada equivalente ao `ask_question` (uma chamada, loop interno), devolvendo evidência em vez de resposta.

**Critérios de avaliação por ciclo (Self-RAG / CRAG)** ✦ IA

Vocabulário para a decisão de suficiência do agente: relevância das passagens, grau de suporte (grounding) e cobertura da pergunta. O fallback corretivo (buscar fonte alternativa quando a confiança é baixa) vem da mesma linhagem.

## 7. Avaliação

**Ragas**

Framework primário de avaliação offline. Métricas adotadas: `faithfulness`, `answer_relevancy`, `context_precision`, `context_recall` e `answer_correctness`, separando diagnóstico do retriever (precision/recall de contexto) do diagnóstico do gerador (as demais). Agregação por média harmônica, penalizando qualquer métrica individual baixa. Alternativas registradas (DeepEval, GroUSE, Open-RAG-Eval), a considerar apenas se o Ragas não cobrir bem um caso específico.

**Dataset golden**

Conjunto curado de perguntas com respostas de referência, extraído de documentos reais da base, geração assistida por LLM e seleção humana. Pré-requisito da avaliação offline.

**Grid-search de hiperparâmetros com LLM-judge** ✦ IA

Varredura offline de combinações (chunk size, overlap, top-k, variantes de slot) avaliada por juiz LLM sobre o dataset golden. Ferramenta de tuning, não mecanismo de produção.

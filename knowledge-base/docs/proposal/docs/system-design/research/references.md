# Referências

Bookmarks de conceitos, frameworks e artigos usados recorrentemente na ideação e implementação da base de conhecimento. Arquivo deliberadamente enxuto — poucas entradas, bem descritas. Ferramentas e artigos apontam sempre para a fonte oficial; conceitos apontam para uma referência bem embasada (estudo ou publicação de empresa de peso na área).

## Ferramentas e frameworks

**LlamaIndex**
Framework central candidato para orquestração de RAG, ingestão e agentes no backend (`apps/api`).
https://www.llamaindex.ai/

---

**RAGFlow**
Motor de RAG open source (Apache-2.0) da InfiniFlow, com parsing profundo (DeepDoc), Ingestion Pipeline, Knowledge Compilation (Wiki, Graph, Tree, PageIndex), busca híbrida com rerank, API REST e servidor MCP. Avaliado como ferramenta candidata; comparativo de aderência em `docs/candidate-tools/ragflow/`.
https://ragflow.io/

---

**Unstructured.io**
Biblioteca de parsing e limpeza de documentos, candidata para o slot de canonicalização do pipeline de ingestão.
https://unstructured.io/

---

**Docling**
Toolkit de parsing de documentos da IBM Research, alternativa a Unstructured.io e LlamaParse.
https://docling-project.github.io/docling/

---

**LlamaParse**
Serviço de parsing do próprio ecossistema LlamaIndex, terceira opção considerada para o Document Parsing.
https://www.llamaindex.ai/llamaparse

---

**pgvector**
Extensão do PostgreSQL para busca por similaridade vetorial, escolhida para os índices de retrieval (vetores na mesma instância relacional).
https://github.com/pgvector/pgvector

---

**Keycloak**
Solução de identidade e acesso (OAuth/SSO) escolhida para autenticação da interface web.
https://www.keycloak.org/

---

**Obsidian — Graph view**
Referência de UX para a visualização de grafo interativa da wiki na interface web.
https://obsidian.md/help/plugins/graph

---

**OKF — Open Knowledge Format (v0.2)**
Formato adotado para a wiki (representação destilada por IA), com frontmatter YAML e referências cruzadas entre arquivos. Especificação canônica no repositório próprio do padrão; v0.2 é retrocompatível com v0.1 (o anúncio original do Google Cloud Blog descrevia a v0.1).
https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md

---

**OpenAI — conectores MCP para o ChatGPT**
Documentação do contrato de conectores de conhecimento do ChatGPT, que exige exatamente as tools `search` (query → ids, títulos, URLs) e `fetch` (id → texto completo). Serviu como precedente de mercado para fixar a superfície `search` + `fetch` e generalizar a tool de leitura para documento canônico e página da wiki (2026-09-03).
https://developers.openai.com/api/docs/mcp

---

**hdean-ssp/okf-mcp**
Servidor MCP e CLI para bundles OKF, com busca híbrida (BM25 + vetor) e leitura de conceitos por id (`fetch_concepts`, `show_concept`, `list_concepts`). Exemplo de solução OKF que expõe "buscar, depois ler", com o agente navegando.
https://github.com/hdean-ssp/okf-mcp

---

**mfdaves/okf-mcp**
Servidor MCP para OKF com busca estruturada (`search_concepts`, `get_concept`) e navegação de grafo (`get_neighbors`, `find_paths`). Segundo exemplo do padrão buscar + ler + navegar sobre OKF, usado na decisão sobre a tool `fetch`.
https://github.com/mfdaves/okf-mcp

---

**DeepWiki MCP (Cognition)**
Servidor MCP com `read_wiki_structure`, `read_wiki_contents` (o agente navega) e `ask_question` (endpoint único com recuperação interna e resposta sintetizada). Precedente do padrão `ask_question`, ao qual o `consult` corresponde, com a diferença de devolver evidência em vez de resposta.
https://cognition.com/blog/deepwiki-mcp-server

---

**NirDiamant/RAG_Techniques**
Coleção de 42+ notebooks demonstrando técnicas de RAG (HyDE, RAPTOR, Self-RAG, CRAG, GraphRAG, avaliação etc.), majoritariamente em LangChain + OpenAI + FAISS. Primeira fonte da pesquisa de técnicas de RAG que alimentou o desenho do sistema.
https://github.com/NirDiamant/RAG_Techniques

---

**mbergo/all-rag-techniques**
Segunda coleção de técnicas de RAG estudada, implementada com bibliotecas fundamentais (NumPy, API OpenAI-compatible) em vez de frameworks pesados. É cópia de um repositório original de Fareed Khan (`FareedKhan-dev/all-rag-techniques`), hoje removido do GitHub (confirmado HTTP 404).
https://github.com/mbergo/all-rag-techniques

---

**stepkurniawan/RAG-comparation**
Código experimental de uma dissertação de mestrado, com harness de benchmark real (chunk size, embedding, vector store, distância, top-k, LLM) avaliado via Ragas. Inativo desde abril/2024.
https://github.com/stepkurniawan/RAG-comparation

---

**Ragas**
Framework de avaliação de RAG adotado como referência principal na pesquisa (faithfulness, answer relevancy, context precision/recall, answer correctness).
https://github.com/explodinggradients/ragas

---

**DeepEval**
Framework de avaliação de LLM/RAG estilo Pytest; alternativa ao Ragas considerada na pesquisa.
https://github.com/confident-ai/deepeval

---

**Open RAG Eval**
Framework de avaliação de RAG da Vectara que dispensa "golden answers", usando as técnicas UMBRELA e AutoNuggetizer.
https://github.com/vectara/open-rag-eval

---

**dsRAG**
Projeto de referência para a técnica "Contextual Chunk Headers" (lá chamada de AutoContext): cabeçalhos de contexto de documento/seção prependados a cada chunk antes do embedding.
https://github.com/D-Star-AI/dsRAG

## Conceitos

**Agentic RAG**
Padrão arquitetural central do pipeline de recuperação: um agente orquestra múltiplos ciclos de retrieval e decide quando o contexto acumulado é suficiente.
https://developer.nvidia.com/blog/traditional-rag-vs-agentic-rag-why-ai-agents-need-dynamic-knowledge-to-get-smarter/

---

**GraphRAG**
Técnica de retrieval baseada em grafo de conhecimento; prevista na arquitetura mas ainda não ativada na fase inicial.
https://www.microsoft.com/en-us/research/project/graphrag/

---

**BM25**
Algoritmo de ranking lexical por trás do Full-Text Search do RAG Híbrido.
https://www.elastic.co/docs/solutions/search/ranking

---

**Reranking**
Etapa de pós-retrieval que reordena os resultados por relevância antes de entregá-los ao LLM.
https://www.pinecone.io/learn/series/rag/rerankers/

---

**HyDE — Hypothetical Document Embeddings**
Paper original da técnica de gerar um documento hipotético via LLM e usar o embedding dele para a busca, em vez do embedding da query crua.
https://arxiv.org/abs/2212.10496

---

**HyPE — Hypothetical Prompt Embeddings**
Preprint (ainda sem peer review) que propõe pré-computar perguntas hipotéticas por chunk no momento da indexação, eliminando a chamada de LLM em tempo de query.
https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5139335

---

**RAPTOR**
Sumarização abstrativa recursiva que organiza o corpus numa árvore de múltiplos níveis para recuperação hierárquica (Stanford, ICLR 2024).
https://arxiv.org/abs/2401.18059

---

**Self-RAG**
Paper que introduz a técnica de decidir dinamicamente se/quando recuperar, avaliar a relevância dos documentos recuperados e o grau de suporte/utilidade da resposta gerada.
https://arxiv.org/abs/2310.11511

---

**CRAG — Corrective Retrieval Augmented Generation**
Paper que introduz o avaliador leve de qualidade da recuperação e o fallback para busca web quando o contexto recuperado é insuficiente.
https://arxiv.org/abs/2401.15884

---

**Adaptive-RAG**
Paper que introduz a classificação da complexidade da query para adaptar a estratégia de recuperação (sem recuperação, single-step ou multi-step) — base teórica da técnica de roteamento por categoria de query (NAACL 2024).
https://arxiv.org/abs/2403.14403

---

**ColPali**
Paper que introduz retrieval multimodal via embeddings de imagens de páginas de documento, evitando a etapa de descrição textual de imagens.
https://arxiv.org/abs/2407.01449

---

**Dense X Retrieval (base do Proposition Chunking)**
Paper que introduz "proposição" como unidade atômica de retrieval — referência teórica mais citada para a técnica de Proposition Chunking.
https://arxiv.org/abs/2312.06648

---

**MemoRAG**
Paper sobre sistema de RAG com camada de memória entre consultas (pares chave-valor, queries substitutas). O título mudou entre versões do arXiv: divulgado inicialmente como "Moving towards Next-Gen RAG via Memory-Inspired Knowledge Discovery", republicado como "MemoRAG: Boosting Long Context Processing with Global Memory-Enhanced Retrieval Augmentation" (WWW/TheWebConf 2025).
https://arxiv.org/abs/2409.05591

---

**GroUSE**
Benchmark que avalia avaliadores (juízes LLM) em Grounded Question Answering, com 6 métricas cobrindo 7 modos de falha do gerador — uma das alternativas ao Ragas consideradas na pesquisa.
https://arxiv.org/abs/2409.06595

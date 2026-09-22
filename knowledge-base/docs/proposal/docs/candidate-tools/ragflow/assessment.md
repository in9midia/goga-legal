# Avaliação de aderência: RAGFlow v0.27.1

Avaliação requisito a requisito do RAGFlow (edição open source, v0.27.1 de 28/08/2026; documentação no commit `4168b3f9` de 02/09/2026) contra os requisitos de [`docs/system-design/requirements.md`](../../system-design/requirements.md), na revisão de 2026-09-03 (40 requisitos em quatro grupos: FUN, ING, BUS, WEB). A página `index.html` desta pasta é a representação visual desta avaliação; os dois são mantidos em paralelo a partir da mesma avaliação.

**Método:** avaliação documental (pastas `docs/`, `docker/`, `conf/`, `mcp/` e READMEs do repositório `infiniflow/ragflow`). Nada foi instalado ou testado. Onde a documentação e o código divergem (tools do servidor MCP), prevaleceu o código. Comportamentos marcados como não documentados exigem prova de conceito antes de qualquer decisão.

**Escala:** `atende` (entrega como está), `atende parcialmente` (entrega parte, ou exige convenção/customização pequena), `divergente` (resolve o problema por outro caminho conceitual; adotar implica mudar o desenho), `não atende` (ausente).

**Critério de julgamento:** técnicas citadas pelo nome nos requisitos (RRF, pai/filho, OKF, Ragas, Docling) são referência, não obrigação; o que se julga é se a ferramenta entrega o resultado exigido, por qualquer técnica. `divergente` fica reservado para quando o RAGFlow resolve o problema por um caminho que implicaria mudar decisões estruturais do desenho.

## Resumo

| Veredito | Total | Só essenciais |
|---|---|---|
| atende | 14 | 7 |
| atende parcialmente | 19 | 11 |
| divergente | 2 | 1 |
| não atende | 5 | 3 |
| **total** | **40** | **22** |

Por grupo:

| Grupo | atende | parcial | divergente | não atende |
|---|---|---|---|---|
| FUN. Fundamentos e plataforma | 2 | 9 | 1 | 2 |
| ING. Pipeline de ingestão | 9 | 3 | 0 | 1 |
| BUS. Pipeline de busca | 3 | 3 | 1 | 1 |
| WEB. Interface web | 0 | 4 | 0 | 1 |

**Leitura geral.** O RAGFlow atende bem à essência do projeto: várias técnicas coexistindo e escolhidas por dataset (parser, chunking, enriquecimento, embedding, compilação, método de busca), motor de parsing profundo, mais de um método de acesso com rerank configurável, wiki e grafo gerados por LLM, API REST, servidor MCP e conectores (FUN-03, ING-07, ING-08, ING-10, ING-11, BUS-03, BUS-04, BUS-06). Não entrega o que o desenho trata como estrutura: o documento canônico como fonte de verdade (ING-03), a separação entre quem lê e quem edita por Espaço (FUN-09) e a avaliação offline (FUN-07); a telemetria acessível a partir da chamada entrega só em parte (FUN-06). A superfície para agentes fica incompleta: o MCP só busca, sem `fetch` (FUN-11, BUS-07). Dois pontos são conceitualmente divergentes: conteúdo mutável por curadoria (FUN-02) e agência acoplada à geração de resposta (BUS-08).

## Matriz por requisito

| ID | Requisito | Criticidade | Veredito | O que o RAGFlow oferece |
|---|---|---|---|---|
| FUN-01 | Espaço como agrupamento único, fronteira de segurança e unidade de configuração | essencial | atende parcialmente | O **Dataset** (knowledge base) é flat, é unidade de configuração (embedding, parser, tag sets, fontes) e é o escopo da busca. Segurança só `me` / `team`. |
| FUN-02 | Conteúdo imutável com cascata pelas representações | essencial | divergente | O oposto por padrão: chunks editáveis, adicionáveis, excluíveis e desabilitáveis; reparse in place. Excluir documento cascateia chunks; artefatos de compilação não cascateiam (Update manual). Metadados em lote sem reparse. |
| FUN-03 | Múltiplas técnicas coexistentes, escolhidas por Espaço | essencial | atende | Por dataset: parser (DeepDoc, Docling, MinerU, VLM…), método de chunking (12 built-in) ou Ingestion Pipeline próprio, enriquecimentos, embedding, PageIndex, templates de compilação e método de busca do Indexer (Full-text, Embedding, Hybrid). Método de chunking também por documento. |
| FUN-04 | Etapas com contrato estável e comparação A/B sobre o mesmo conteúdo | opcional | atende parcialmente | Componentes com contrato claro no Ingestion Pipeline (Parser, Chunker, Transformer, Indexer); pipelines versionados e exportáveis; método por documento. Um pipeline por dataset e um índice por dataset. |
| FUN-05 | Configuração de técnicas por Espaço, com padrão global e override, exposta na interface | essencial | atende parcialmente | Configuração rica **por dataset** na UI (parser, chunking, enriquecimentos, PageIndex, compilação, embedding). Parâmetros de busca vivem em cada aplicação consumidora (Chat, Search, Retrieval do Agent). Defaults globais só para modelos; sistema via Admin UI e CLI (`SET VAR`). |
| FUN-06 | Telemetria por execução, gravada e acessível a partir da chamada | essencial | atende parcialmente | **Langfuse** por tenant (trace por request com spans de retrieval, ranking, generation, prompts e documentos); seção `otel` e perfil Jaeger no compose sem docs; logs de ingestão com status, `process_duration` e `token_count` por documento. A resposta de `/retrieval` traz só `similarity`, `vector_similarity` e `term_similarity` por chunk. |
| FUN-07 | Avaliação offline reproduzível, capaz de comparar técnicas | essencial | não atende | Nada de dataset golden, métricas ou comparação reproduzível. Só **Retrieval Testing** manual, **Multi-model comparison** no Chat e tracing Langfuse. |
| FUN-08 | Acesso a conteúdo sempre filtrado pelos Espaços permitidos do chamador | essencial | atende parcialmente | API key por usuário/tenant; datasets `me`/`team` com checagem server-side em API e UI. O escopo é o que o chamador passa em `dataset_ids`; em MCP self-host uma única chave serve todos os clientes. |
| FUN-09 | Permissionamento: leitura separada de edição por Espaço, mais administrador global | essencial | não atende | Edição open source: escopo `Only me` / `Team`; papéis de time `owner`, `normal`, `invite`; `Superuser` global. Membros do time enviam e parseiam arquivos em datasets compartilhados. Read/Write/Manage e permissão por documento descritos, mas sem tela na OSS; RBAC administrativo só por CLI; controles finos posicionados como Enterprise. |
| FUN-10 | Autenticação corporativa via OAuth/OIDC, Espaços permitidos por grupos | essencial | atende parcialmente | Canais `oauth2`, `oidc` (descoberta por `issuer`), `github`; `disable_password_login`; `REGISTER_ENABLED`. O callback devolve só `email`, `username`, `nickname`, `avatar_url`. Keycloak não é citado. |
| FUN-11 | API REST e endpoints MCP (search, fetch) | essencial | atende parcialmente | REST completa (datasets, upload, parse, chunks, metadados, retrieval, chat, agent, search, OpenAI-compatible). Servidor MCP oficial com `ragflow_retrieval`, `ragflow_list_datasets`, `ragflow_list_chats`; SSE e streamable HTTP (host mode ainda sem streamable HTTP). |
| FUN-12 | Persistência em serviços do ambiente corporativo, com backends substituíveis | opcional | atende parcialmente | Object store: MinIO, S3-compatível, OSS, Azure, GCS, OpenDAL. Metadados: MySQL (default), **PostgreSQL**, GaussDB, OceanBase. Doc engine: Elasticsearch, Infinity, OpenSearch, OceanBase, SeekDB, SereneDB, GaussDB. Redis obrigatório. pgvector não é opção de doc engine. |
| FUN-13 | Deploy em Kubernetes com containers separados e CI/CD | opcional | atende parcialmente | **Helm chart** oficial (desde v0.15.0; K8s ≥ 1.24) cobrindo web/api e dependências opcionais; separação de processos por flags do entrypoint (`--disable-webserver`, `--disable-taskexecutor`, `--enable-mcpserver` etc.). Imagens só x86_64; ~2 GB; 4 CPU / 16 GB / 50 GB. |
| FUN-14 | Conteúdo em pt-BR: modelos multilíngues e interface localizável | opcional | atende | UI em português desde v0.16.0 e `README_pt_br.md`; `cross_languages` em toda a pilha; bge-m3, bge-reranker-v2-m3, Jina v3/v4, Cohere multilingual, Voyage; Azure OpenAI (chat e embedding, sem rerank); Anthropic só chat. |
| ING-01 | Formatos de entrada: PDF, Word, Excel, Markdown | essencial | atende | PDF, DOC/DOCX, XLS/XLSX/CSV, MD/MDX, TXT, PPT/PPTX, imagens, HTML, e-mail, áudio, vídeo ("23+ formatos"). |
| ING-02 | Documento bruto preservado intacto | essencial | atende | Todo upload vai ao **MinIO** em `<kb_id>/filename`; download por UI e API; backends S3-compatível, OSS, Azure, GCS, OpenDAL. |
| ING-03 | Documento canônico como fonte de verdade | essencial | não atende | Não existe. O Parser vai do arquivo direto a chunks; a saída intermediária (HTML para planilhas, JSON para Word/PPT, texto) é variável efêmera do pipeline. |
| ING-04 | Canonicalização com mais de uma técnica disponível | opcional | atende parcialmente | PDF parser selecionável por dataset: **DeepDoc** (OCR + TSR + layout), Naive, **Docling** (local ou Docling Serve), TCADP, **MinerU** (remoto), Mistral OCR, PaddleOCR e VLMs. Tabelas saem em HTML; imagens podem ser lidas por VLM. A saída do Parser é efêmera e vai direto a chunks. |
| ING-05 | Escopo por humano com fallback IA | opcional | atende parcialmente | Dataset é sempre escolhido pelo humano. Tags/metadados: `meta_fields` manuais ou **Auto metadata** gerado por LLM com domínio de valores, sem intervenção. |
| ING-06 | Pipeline assíncrono com estado por documento e por representação | essencial | atende parcialmente | Task executor assíncrono; estados por documento `UNSTART / SCHEDULE / RUNNING / DONE / FAIL / CANCEL`, progresso, cancelar e reexecutar; logs por documento e por dataset. |
| ING-07 | Chunking com mais de uma estratégia disponível, escolhida por Espaço | essencial | atende | Doze métodos built-in (General, Q&A, Manual, Table, Paper, Book, Laws, Presentation, One, Tag, Picture, Email) por dataset e por documento; `parser_config.parent_child` (`use_parent_child`, `children_delimiter`) no método General desde v0.23.0, com a semântica exata de busca no filho e entrega do pai; Chunker do pipeline: Token e Title (hierárquico por seções). |
| ING-08 | Enriquecimento de chunk opcional e combinável | opcional | atende | Componente **Transformer**: Summary, Keywords, Questions, Metadata, encadeáveis, prompt editável, por documento ou por chunk. Indexer pode indexar as perguntas (≈ HyPE) ou o sumário (Enhanced context). Built-in: `auto_keywords`, `auto_questions`. |
| ING-09 | Embedding com modelo configurável por Espaço | essencial | atende | `embedding_model` por dataset (`model@factory`), dezenas de provedores, inclusive locais (Ollama, Xinference, TEI). Troca exige "Parse again". |
| ING-10 | Índice como representação de base, vetorial e lexical, com metadados por chunk | essencial | atende | Híbrido nativo (BM25 + vetor) em Elasticsearch, Infinity ou OpenSearch; `dataset_id`, `tag_kwd`, `important_keywords` por chunk; `metadata_condition` empurrado ao motor. |
| ING-11 | Wiki destilada por LLM como representação opcional | opcional | atende | **Knowledge Compilation · Wiki** (v0.27.0): artefato de nível de dataset, opcional, com Plan, Blueprints (Brand, Engineering, General, Market, Product, Userinterview, Custom), especificações de Entity/Relation/Claim/Concept e atualização manual (botão Update). Na busca, entra como chunks de compilação no mesmo pool. |
| ING-12 | Grafo de entidades como representação auxiliar | dispensável | atende | **Knowledge Compilation · Graph** (entidades, relações, regras) por documento; recuperação com `use_kg` (entidades da query, top-N por PageRank, N-hop, community reports). |
| ING-13 | Ingestão por monitoramento de fontes externas | dispensável | atende | **Data sources** com polling (refresh interval, cleanup interval, sync deleted): SharePoint, OneDrive, S3, Azure Blob, Oracle Storage, Confluence, Notion, Google Drive, Azure DevOps e outros; SharePoint e OneDrive nativos desde v0.26.0. |
| BUS-01 | Tool `search` unificada e stateless, que devolve evidência | essencial | atende parcialmente | `POST /api/v1/retrieval` e a tool MCP `ragflow_retrieval`: stateless, vários `dataset_ids`, contrato único por chunk (texto, `document_id`, `dataset_id`, três scores, `positions`), sem gerar resposta. Flags `use_kg`, `toc_enhance`, `include_knowledge_compilation` trazem grafo, PageIndex e wiki para o mesmo pool. Chat, Agent e Search geram resposta, mas são camadas opcionais. |
| BUS-02 | Melhoria de query como etapa opcional, desligada por padrão | opcional | não atende | Só na camada de Chat: Multi-turn conversation optimization, Keyword analysis e Thinking modes (o Medium "clarifies or rewrites the question"). `/retrieval` tem apenas `keyword` e `cross_languages`. |
| BUS-03 | Filtro de escopo por Espaço, tags e facetas | opcional | atende | `dataset_ids`, `document_ids`, `metadata_condition` (11 operadores, and/or); facetas via `GET /datasets/{id}/metadata/summary`. **Tag sets** associam tags à query por similaridade, como reforço de ranking. |
| BUS-04 | Mais de um método de acesso, combináveis e selecionáveis por Espaço | essencial | atende | Search method por dataset no Indexer: Full-text, Embedding ou Hybrid (exige ES, Infinity ou OpenSearch); por chamada, `use_kg` (grafo), `toc_enhance` (PageIndex) e `include_knowledge_compilation` (artefatos de compilação, inclusive a wiki) acrescentam chunks ao mesmo pool. |
| BUS-05 | Pós-processamento: expansão de contexto, threshold, fusão e dedup | opcional | atende parcialmente | Fusão por **soma ponderada** `x·vetor + (1−x)·termo` (default x = 0,3) mais PageRank do dataset; `similarity_threshold` único sobre o score composto; expansão pai via `parent_child`. Dedup não documentado. |
| BUS-06 | Reranking sobre o pool mesclado, cego à origem, com modelo configurável | opcional | atende | `rerank_id` (qualquer provedor de rerank cadastrado), `rerank_candidates_count` (default 64). Modelos internos removidos na v0.18.0; o score do rerank é combinado ao composto. |
| BUS-07 | Tool `fetch` por id: documento canônico ou página da wiki, com referências | essencial | atende parcialmente | REST: download do arquivo bruto e listagem paginada dos chunks de um documento (`GET /datasets/{id}/documents/{id}/chunks`), o que permite ler um documento por id. Não há documento canônico, nenhum endpoint REST nem tool MCP para ler uma página da Wiki ou listar suas referências; o único contato com a Wiki é `include_knowledge_compilation` na busca. |
| BUS-08 | Superfície `consult`: uma chamada com loop interno, devolvendo evidência | dispensável | divergente | Chat com **Thinking modes** (None, Low, Medium, High, Ultra) e Agentic Retrieval (decomposição, recuperação, checagem de evidência); componente Agent com `Max reflection rounds`, tools e saída estruturada por JSON Schema. |
| WEB-01 | Gestão de Espaços e de seus documentos pela interface | essencial | atende parcialmente | Criar dataset (nome, embedding, parse type), editar em Configuration, excluir (só o criador). Upload de arquivos e pastas com "Parse on creation", exclusão de documentos com cascata de chunks. Lista mostra datasets próprios e compartilhados; cada dataset pertence ao workspace de um usuário. |
| WEB-02 | Navegação de conteúdo somente leitura por Espaço | opcional | atende parcialmente | Lista de documentos com status e filtros; chunks com preview do PDF/DOCX na posição de origem; Artifacts com Wiki hierárquica, Graph, Mind Map, Tree, Timeline. |
| WEB-03 | Simulador de Recuperação | essencial | atende parcialmente | **Retrieval Testing** por dataset: threshold, peso vetorial, rerank, cross-language, metadados, Top; resultado com chunk, scores, documento de origem e filtro por arquivo. Parâmetros não são salvos. |
| WEB-04 | Logs de consultas simuladas e de produção | opcional | atende parcialmente | Logs de ingestão na UI; conversas de Chat e Agent persistidas por sessão. Sem log de chamadas de `/retrieval` nem do Retrieval Testing; sem trilha de auditoria administrativa. |
| WEB-05 | Analytics por representação, método de acesso e técnica | opcional | não atende | Nenhuma tela de analytics de uso, tokens ou custo. Admin UI mostra só status de serviços. Perfil ClickHouse no compose sem documentação de finalidade. |

## Detalhe por requisito

### Grupo FUN. Fundamentos e plataforma

#### FUN-01. Espaço como agrupamento único, fronteira de segurança e unidade de configuração

- **Requisito:** Catálogo flat gerido por humanos; cada documento em exatamente um Espaço; unidade de configuração e de segurança.
- **Criticidade:** essencial
- **Veredito:** atende parcialmente
- **O que o RAGFlow oferece:** O **Dataset** (knowledge base) é flat, é unidade de configuração (embedding, parser, tag sets, fontes) e é o escopo da busca. Segurança só `me` / `team`.
- **Justificativa:** O Dataset mapeia bem para Espaço como catálogo e unidade de configuração. A fronteira de segurança é binária (só eu ou o time inteiro), sem perfis por Espaço nem grupos, e um arquivo do File Management pode ser vinculado a vários datasets.
- **Lacuna e customização:** Impor "um documento = um dataset" por convenção (só upload direto em dataset) e resolver autorização granular fora do RAGFlow ou por customização do backend.
- **Evidência:**
  - "A Dataset is the basic unit used in RAGFlow to organize and manage knowledge." (`docs/references/glossary.mdx`)
  - "a dataset is more than a "folder". It converts raw documents into retrievable chunks, stores the enabled status of documents and chunks, maintains metadata" (`docs/guides/dataset/dataset_overview.md`)
  - "the Permissions field can be set to Only me or Team" (`docs/guides/team/team_management/resource_sharing_from_the_team_perspective.md`)

#### FUN-02. Conteúdo imutável com cascata pelas representações

- **Requisito:** Toda mudança é inclusão ou remoção de documento, com cascata pelas representações derivadas; reclassificar tags é só metadados.
- **Criticidade:** essencial
- **Veredito:** divergente
- **O que o RAGFlow oferece:** O oposto por padrão: chunks editáveis, adicionáveis, excluíveis e desabilitáveis; reparse in place. Excluir documento cascateia chunks; artefatos de compilação não cascateiam (Update manual). Metadados em lote sem reparse.
- **Justificativa:** RAGFlow é orientado a curadoria manual de chunks. Imutabilidade teria de ser imposta por política (não usar edição de chunk) e a cascata para Wiki e Graph exige acionar Update. A reclassificação de metadados, essa sim, atende.
- **Lacuna e customização:** Política de perfis sem edição de chunk; automação do Update de artefatos por API após inclusão/remoção.
- **Evidência:**
  - "Double-click a chunk to open the edit parsing block window. You can view and modify: Content, Keywords, Questions, Tags" (`docs/guides/dataset/chunk_parsing_results_and_knowledge_fragment_management.md`)
  - "The corresponding chunks, metadata, and parsing results are also removed" (`docs/guides/dataset/files_dataset_document_management.md`)
  - "Uploading or deleting knowledge base documents alone does not immediately update existing knowledge artifacts." (`docs/guides/knowledge_compilation/apply_knowledge_compilation_template.md`)

#### FUN-03. Múltiplas técnicas coexistentes, escolhidas por Espaço

- **Requisito:** Cada etapa de ingestão e busca admite mais de uma técnica, e Espaços diferentes (tipo de conteúdo, volume) podem usar técnicas diferentes sem alterar o restante do sistema.
- **Criticidade:** essencial
- **Veredito:** atende
- **O que o RAGFlow oferece:** Por dataset: parser (DeepDoc, Docling, MinerU, VLM…), método de chunking (12 built-in) ou Ingestion Pipeline próprio, enriquecimentos, embedding, PageIndex, templates de compilação e método de busca do Indexer (Full-text, Embedding, Hybrid). Método de chunking também por documento.
- **Justificativa:** É o ponto forte do RAGFlow para este projeto: datasets diferentes rodam técnicas diferentes de ingestão e de busca (método do Indexer) sem tocar no restante, e o pipeline é versionado e exportável. Nuance, não lacuna deste requisito: os parâmetros de busca (threshold, peso, rerank) vivem na aplicação consumidora, e a herança de um padrão global é assunto de FUN-05.
- **Evidência:**
  - "Different built-in methods display different configuration items. Use the current interface as the source of truth." (`docs/guides/dataset/configuration.md`)
  - "Search method = Full-text | Embedding | Hybrid" (`docs/guides/agent/ingestion_pipeline/configure_indexer_component.md`)
  - "Ingestion pipeline: The parsing method or pipeline used" (`docs/guides/dataset/logs.md`)

#### FUN-04. Etapas com contrato estável e comparação A/B sobre o mesmo conteúdo

- **Requisito:** Etapas com contrato estável, permitindo comparar técnicas lado a lado (A/B) sobre o mesmo conteúdo sem reprocessar o restante do sistema.
- **Criticidade:** opcional
- **Veredito:** atende parcialmente
- **O que o RAGFlow oferece:** Componentes com contrato claro no Ingestion Pipeline (Parser, Chunker, Transformer, Indexer); pipelines versionados e exportáveis; método por documento. Um pipeline por dataset e um índice por dataset.
- **Justificativa:** Os contratos existem e são estáveis, mas duas técnicas não coexistem sobre o mesmo conjunto de documentos dentro de um dataset: comparar chunking A com B exige datasets paralelos, com reprocessamento completo.
- **Lacuna e customização:** Datasets paralelos por técnica e comparação externa via Retrieval Testing ou `/retrieval`.
- **Evidência:**
  - "Ingestion pipeline: The parsing method or pipeline used" (`docs/guides/dataset/logs.md`)
  - "Agent version control: all updates are continuously logged and can be rolled back" (`docs/release_notes.md (v0.18.0)`)

#### FUN-05. Configuração de técnicas por Espaço, com padrão global e override, exposta na interface

- **Requisito:** Padrão global com override por Espaço, definindo quais representações e técnicas se aplicam a cada um; exposta na interface web.
- **Criticidade:** essencial
- **Veredito:** atende parcialmente
- **O que o RAGFlow oferece:** Configuração rica **por dataset** na UI (parser, chunking, enriquecimentos, PageIndex, compilação, embedding). Parâmetros de busca vivem em cada aplicação consumidora (Chat, Search, Retrieval do Agent). Defaults globais só para modelos; sistema via Admin UI e CLI (`SET VAR`).
- **Justificativa:** O override por Espaço existe e é exposto na interface, mas não há um padrão global de técnicas do qual os datasets herdem, e os parâmetros de busca (threshold, peso, rerank) não são por dataset: vivem em cada aplicação consumidora. Só o método do Indexer (Full-text, Embedding, Hybrid) é por dataset.
- **Lacuna e customização:** Modelar o plano global externamente e traduzi-lo em `parser_config` e templates via API para cada dataset.
- **Evidência:**
  - "Parameter changes in Retrieval Testing are only used for the current test and are not automatically synchronized to Chat Assistant or Agent." (`docs/guides/dataset/retrieval_testing.md`)
  - "Different built-in methods display different configuration items. Use the current interface as the source of truth." (`docs/guides/dataset/configuration.md`)
  - "Search Settings allow you to configure the knowledge sources, retrieval strategy, and presentation of search results." (`docs/guides/search/search_settings.md`)

#### FUN-06. Telemetria por execução, gravada e acessível a partir da chamada

- **Requisito:** Técnica aplicada em cada etapa, latência, tokens, custo e scores, gravados em ingestão e busca e acessíveis no retorno ou por identificador de execução.
- **Criticidade:** essencial
- **Veredito:** atende parcialmente
- **O que o RAGFlow oferece:** **Langfuse** por tenant (trace por request com spans de retrieval, ranking, generation, prompts e documentos); seção `otel` e perfil Jaeger no compose sem docs; logs de ingestão com status, `process_duration` e `token_count` por documento. A resposta de `/retrieval` traz só `similarity`, `vector_similarity` e `term_similarity` por chunk.
- **Justificativa:** A telemetria existe, mas fora do produto (Langfuse) e sem custo monetário nem identificação da técnica aplicada; o retorno da busca não traz tempo, tokens ou custo, e a ligação entre uma chamada de `/retrieval` e seu trace no Langfuse não é documentada. Ingestão tem duração e tokens por documento, o que cobre o mínimo daquele lado.
- **Lacuna e customização:** Langfuse como backend de trace mais um envelope próprio em torno das chamadas medindo tempo e calculando custo por token.
- **Evidência:**
  - "For every user request you will see: a trace representing the overall request; spans for retrieval, ranking and generation steps; the complete prompts, retrieved documents and LLM responses as metadata" (`docs/administrator/tracing.mdx`)
  - "otel: ... port: ${OTEL_PORT:-4318} ... enable: false" (`docker/service_conf.yaml.template`)
  - ""process_duration": 0.0, ... "token_count": 0, ... "chunk_count": 0" (`docs/references/http_api_reference.md (List documents)`)

#### FUN-07. Avaliação offline reproduzível, capaz de comparar técnicas

- **Requisito:** Dataset golden e métricas de retrieval, capazes de comparar técnicas entre si; Ragas como referência.
- **Criticidade:** essencial
- **Veredito:** não atende
- **O que o RAGFlow oferece:** Nada de dataset golden, métricas ou comparação reproduzível. Só **Retrieval Testing** manual, **Multi-model comparison** no Chat e tracing Langfuse.
- **Justificativa:** A avaliação offline, que no projeto é o instrumento que decide qual técnica fica ligada, ficaria inteiramente fora da ferramenta, consumindo `/retrieval`.
- **Lacuna e customização:** Harness externo (Ragas ou equivalente) chamando `/retrieval`; Langfuse datasets/scores como apoio.
- **Evidência:**
  - "tests several models simultaneously with the same Chat configuration and the same question" (`docs/guides/chat/testing_and_evaluation.md`)

#### FUN-08. Acesso a conteúdo sempre filtrado pelos Espaços permitidos do chamador

- **Requisito:** Em toda superfície (search, fetch, consult, interface web, API), aplicado no servidor antes de qualquer método de acesso e não contornável por parâmetro.
- **Criticidade:** essencial
- **Veredito:** atende parcialmente
- **O que o RAGFlow oferece:** API key por usuário/tenant; datasets `me`/`team` com checagem server-side em API e UI. O escopo é o que o chamador passa em `dataset_ids`; em MCP self-host uma única chave serve todos os clientes.
- **Justificativa:** Existe fronteira por tenant/time com checagem no servidor, mas o modelo é dono + time, não Espaços permitidos derivados de grupos. A validação de `dataset_ids` em `/retrieval` não é documentada, e no MCP self-host o conjunto acessível é o do servidor, não do chamador.
- **Lacuna e customização:** Proxy que mapeie grupos do chamador para `dataset_ids` antes de repassar, ou customização da validação no backend.
- **Evidência:**
  - "User '<tenant_id>' lacks permission for datasets: '<dataset_ids>'" (`docs/references/http_api_reference.md`)
  - "Self-host mode: ... In this mode, the MCP server can access only the datasets of a specified tenant" (`docs/develop/mcp/launch_mcp_server.md`)
  - "RAGFlow currently uses API key to validate identity ... this makeshift solution could expose your MCP server to potential network attacks." (`docs/develop/mcp/launch_mcp_server.md`)

#### FUN-09. Permissionamento: leitura separada de edição por Espaço, mais administrador global

- **Requisito:** Administrador global e, por Espaço, separação mínima entre quem só lê e quem edita; quatro perfis e grupos como modelo de referência.
- **Criticidade:** essencial
- **Veredito:** não atende
- **O que o RAGFlow oferece:** Edição open source: escopo `Only me` / `Team`; papéis de time `owner`, `normal`, `invite`; `Superuser` global. Membros do time enviam e parseiam arquivos em datasets compartilhados. Read/Write/Manage e permissão por documento descritos, mas sem tela na OSS; RBAC administrativo só por CLI; controles finos posicionados como Enterprise.
- **Justificativa:** Mesmo com a exigência reduzida ao mínimo, a OSS não separa quem só lê de quem edita dentro de um dataset: compartilhar com o time dá upload e parse a todos. O administrador global existe. As permissões finas são vendidas na edição Enterprise.
- **Lacuna e customização:** Modelo de leitura/edição por Espaço e grupos implementado no backend ou num gateway próprio.
- **Evidência:**
  - "Team members can upload and parse files in shared knowledge bases." (`docs/guides/team/sharing_scope_configuration/share_knowledge_bases.md`)
  - "In the open-source edition, the sharing scope is configured through the Permissions field on the resource configuration page." (`docs/guides/team/sharing_scope_configuration/open_source_edition_sharing_scope_configuration.md`)
  - "cloud.ragflow.io demonstrates the capabilities of RAGFlow Enterprise. ... it offers much more sophisticated team permission controls." (`docs/faq.mdx`)

#### FUN-10. Autenticação corporativa via OAuth/OIDC, Espaços permitidos por grupos

- **Requisito:** OAuth/OIDC com Keycloak como provedor; Espaços permitidos derivados de grupos.
- **Criticidade:** essencial
- **Veredito:** atende parcialmente
- **O que o RAGFlow oferece:** Canais `oauth2`, `oidc` (descoberta por `issuer`), `github`; `disable_password_login`; `REGISTER_ENABLED`. O callback devolve só `email`, `username`, `nickname`, `avatar_url`. Keycloak não é citado.
- **Justificativa:** Como OIDC genérico, Keycloak funciona para identidade. Não há mapeamento de grupos ou roles a partir de claims, logo os Espaços permitidos não derivam do provedor.
- **Lacuna e customização:** Estender o callback OIDC para ler a claim de grupos e sincronizar user_tenant e compartilhamentos.
- **Evidência:**
  - "type: Authentication type, options include oauth2, oidc, github. Default is oauth2, when issuer parameter is provided, defaults to oidc." (`docs/administrator/configurations/configurations.md`)
  - "Supports both OAuth2 and OIDC authentication protocols; Automatic OIDC configuration discovery" (`api/apps/auth/README.md`)

#### FUN-11. API REST e endpoints MCP (search, fetch)

- **Requisito:** API REST de ingestão e consulta; endpoints MCP `search` e `fetch` (`consult` quando existir) para agentes externos.
- **Criticidade:** essencial
- **Veredito:** atende parcialmente
- **O que o RAGFlow oferece:** REST completa (datasets, upload, parse, chunks, metadados, retrieval, chat, agent, search, OpenAI-compatible). Servidor MCP oficial com `ragflow_retrieval`, `ragflow_list_datasets`, `ragflow_list_chats`; SSE e streamable HTTP (host mode ainda sem streamable HTTP).
- **Justificativa:** REST atende. O MCP cobre só a busca, com subconjunto de parâmetros (sem `cross_languages`, `metadata_condition`, `use_kg`), e não tem tool de leitura por id: um agente não consegue completar o padrão buscar e depois ler.
- **Lacuna e customização:** Servidor MCP próprio na frente da REST, com `search` completo e `fetch` sobre download de documento e listagem de chunks.
- **Evidência:**
  - "If you set mcp-mode to host, you must add the --no-transport-streamable-http-enabled flag, because the streamable-HTTP transport is not yet supported in host mode." (`docs/develop/mcp/launch_mcp_server.md`)
  - "name="ragflow_retrieval" ... name="ragflow_list_datasets" ... name="ragflow_list_chats"" (`mcp/server/server.py`)

#### FUN-12. Persistência em serviços do ambiente corporativo, com backends substituíveis

- **Requisito:** Sem storage local no servidor e com backends substituíveis; Oracle Object Storage, PostgreSQL + pgvector e grafo como referência.
- **Criticidade:** opcional
- **Veredito:** atende parcialmente
- **O que o RAGFlow oferece:** Object store: MinIO, S3-compatível, OSS, Azure, GCS, OpenDAL. Metadados: MySQL (default), **PostgreSQL**, GaussDB, OceanBase. Doc engine: Elasticsearch, Infinity, OpenSearch, OceanBase, SeekDB, SereneDB, GaussDB. Redis obrigatório. pgvector não é opção de doc engine.
- **Justificativa:** Tudo é externalizável e substituível por configuração, sem storage local, o que cobre a substituibilidade. Não cobre o "serviços do ambiente corporativo": os índices exigem um doc engine à parte (Elasticsearch ou Infinity para híbrido completo), mais Redis e MySQL ou PostgreSQL, serviços que hoje não existem no ambiente e teriam de ser provisionados; Oracle Object Storage não é backend nomeado, só o modo S3-compatível, a validar.
- **Lacuna e customização:** Validar Oracle Object Storage via `STORAGE_IMPL=AWS_S3` com `endpoint_url` próprio; provisionar Elasticsearch ou Infinity e Redis.
- **Evidência:**
  - "The business metadata database type. Defaults to mysql. Supported values include mysql, postgres, gaussdb, and oceanbase." (`docker/README.md`)
  - "Currently, only Elasticsearch and Infinity meet the hybrid search requirements of RAGFlow." (`docs/faq.mdx`)
  - "When using an external storage backend, you can remove the minio service from docker-compose-base.yml." (`docs/administrator/configurations/configurations.md`)

#### FUN-13. Deploy em Kubernetes com containers separados e CI/CD

- **Requisito:** Oracle OKE, containers separados, CI/CD em Azure DevOps.
- **Criticidade:** opcional
- **Veredito:** atende parcialmente
- **O que o RAGFlow oferece:** **Helm chart** oficial (desde v0.15.0; K8s ≥ 1.24) cobrindo web/api e dependências opcionais; separação de processos por flags do entrypoint (`--disable-webserver`, `--disable-taskexecutor`, `--enable-mcpserver` etc.). Imagens só x86_64; ~2 GB; 4 CPU / 16 GB / 50 GB.
- **Justificativa:** Chart oficial básico e flags de separação existem; não há guia de produção em K8s, o chart não cobre sandbox, NATS, Jaeger nem task executor separado, e só há imagem x86.
- **Lacuna e customização:** Chart próprio ou manifests derivados para OKE; pipeline Azure DevOps é agnóstico.
- **Evidência:**
  - "All Docker images are built for x86 platforms. We don't currently offer Docker images for ARM64." (`README.md`)
  - "Components: RAGFlow (web/api) and optional dependencies (Infinity/Elasticsearch/OpenSearch, MySQL, MinIO, Redis)" (`helm/README.md`)

#### FUN-14. Conteúdo em pt-BR: modelos multilíngues e interface localizável

- **Requisito:** Modelos de embedding e rerank multilíngues; interface localizável.
- **Criticidade:** opcional
- **Veredito:** atende
- **O que o RAGFlow oferece:** UI em português desde v0.16.0 e `README_pt_br.md`; `cross_languages` em toda a pilha; bge-m3, bge-reranker-v2-m3, Jina v3/v4, Cohere multilingual, Voyage; Azure OpenAI (chat e embedding, sem rerank); Anthropic só chat.
- **Justificativa:** Embedding e rerank multilíngues por vários provedores, busca cross-language nativa e interface em português. Verificar se a tradução é pt-BR e a cobertura do stemmer.
- **Evidência:**
  - "New UI language: Portuguese" (`docs/release_notes.md (v0.16.0)`)
  - "Cross-language search: Select one or more target languages so a query can match related content in other languages in the dataset." (`docs/guides/dataset/retrieval_testing.md`)

### Grupo ING. Pipeline de ingestão

#### ING-01. Formatos de entrada: PDF, Word, Excel, Markdown

- **Requisito:** Formato novo não exige mudar o restante do pipeline.
- **Criticidade:** essencial
- **Veredito:** atende
- **O que o RAGFlow oferece:** PDF, DOC/DOCX, XLS/XLSX/CSV, MD/MDX, TXT, PPT/PPTX, imagens, HTML, e-mail, áudio, vídeo ("23+ formatos").
- **Justificativa:** Cobertura supera o requisito. Adicionar um formato novo exige código no RAGFlow; não há mecanismo de parser registrável, mas o restante do pipeline não muda.
- **Evidência:**
  - "File formats that RAGFlow supports include documents (PDF, DOC, DOCX, TXT, MD, MDX), tables (CSV, XLSX, XLS), pictures (JPEG, JPG, PNG, TIF, GIF), and slides (PPT, PPTX)." (`docs/quickstart.mdx`)
  - "It supports 8 file categories and more than 23 formats, including PDF, images, audio, video, email, spreadsheets (Excel), Word, PPT, HTML and Markdown." (`docs/guides/agent/ingestion_pipeline/configure_parser_component.md`)

#### ING-02. Documento bruto preservado intacto

- **Requisito:** Arquivo como chegou, em object store, para auditoria e reprocessamento com outras técnicas.
- **Criticidade:** essencial
- **Veredito:** atende
- **O que o RAGFlow oferece:** Todo upload vai ao **MinIO** em `<kb_id>/filename`; download por UI e API; backends S3-compatível, OSS, Azure, GCS, OpenDAL.
- **Justificativa:** O bruto é preservado e é a base do "Parse again", inclusive com outro parser ou método de chunking. Oracle Object Storage não aparece como backend de armazenamento (só como conector de leitura); o caminho seria o modo S3-compatível, a validar.
- **Lacuna e customização:** Validar Oracle Object Storage via `STORAGE_IMPL=AWS_S3` com `endpoint_url` próprio.
- **Evidência:**
  - "All uploaded files are stored in Minio, RAGFlow's object storage solution. For instance, if you upload your file directly to a dataset, it is located at <knowledgebase_id>/filename." (`docs/faq.mdx`)
  - "When using an external storage backend, you can remove the minio service from docker-compose-base.yml." (`docs/administrator/configurations/configurations.md`)

#### ING-03. Documento canônico como fonte de verdade

- **Requisito:** Texto limpo e legível (Markdown como referência), extração sem reescrever, versionado; todas as representações derivam dele.
- **Criticidade:** essencial
- **Veredito:** não atende
- **O que o RAGFlow oferece:** Não existe. O Parser vai do arquivo direto a chunks; a saída intermediária (HTML para planilhas, JSON para Word/PPT, texto) é variável efêmera do pipeline.
- **Justificativa:** Nenhum artefato canônico é persistido ou versionado, em formato algum; o que persiste são chunks com posições no original. É o desvio mais estrutural em relação ao desenho, porque o canônico é o pivô de todas as representações do projeto.
- **Lacuna e customização:** Canonicalizar fora do RAGFlow e subir o texto limpo como documento (perde o vínculo com o bruto dentro da ferramenta), ou customizar o pipeline para persistir a saída do Parser no object store.
- **Evidência:**
  - "Output in HTML format, preserving row and column structure." (`docs/guides/agent/ingestion_pipeline/configure_parser_component.md`)
  - "Output in JSON format, preserving document hierarchy, such as headings, paragraphs and slides." (`docs/guides/agent/ingestion_pipeline/configure_parser_component.md`)
  - "After clicking chunk text, the document preview area jumps to the corresponding source location" (`docs/guides/dataset/chunk_parsing_results_and_knowledge_fragment_management.md`)

#### ING-04. Canonicalização com mais de uma técnica disponível

- **Requisito:** Técnicas de canonicalização comparáveis entre si, gerando o documento canônico (ING-03); remoção de ruído, tabelas em Markdown e captioning como operações esperadas; Docling, Unstructured.io e LlamaParse como referência.
- **Criticidade:** opcional
- **Veredito:** atende parcialmente
- **O que o RAGFlow oferece:** PDF parser selecionável por dataset: **DeepDoc** (OCR + TSR + layout), Naive, **Docling** (local ou Docling Serve), TCADP, **MinerU** (remoto), Mistral OCR, PaddleOCR e VLMs. Tabelas saem em HTML; imagens podem ser lidas por VLM. A saída do Parser é efêmera e vai direto a chunks.
- **Justificativa:** Pluralidade real de técnicas de canonicalização (DeepDoc, Docling, MinerU, VLMs), com escolha por dataset e comparação possível via Retrieval Testing; a lista fixa (sem Unstructured nem LlamaParse) e as tabelas em HTML não pesam, porque ferramentas e formato são referência. O que falta é o resultado exigido: nenhuma dessas técnicas gera um documento canônico persistido (ING-03). Por isso parcial, e não atende.
- **Lacuna e customização:** Parser novo implica alterar código (exemplos em `rag/app`). Tabelas em Markdown exigiriam pós-processamento.
- **Evidência:**
  - "DeepDoc: The default PDF parser in RAGFlow. It can perform OCR, table structure recognition (TSR), document layout understanding (DLR), and other tasks." (`docs/guides/dataset/configuration.md`)
  - "you can also use a vision-language model (VLM) that supports PDF parsing" (`docs/guides/dataset/configuration.md`)
  - "RAGFlow is only a remote client for MinerU" (`docs/faq.mdx`)

#### ING-05. Escopo por humano com fallback IA

- **Requisito:** Espaço e tags informados na entrada; se ausentes, IA classifica e o pipeline segue sem espera humana.
- **Criticidade:** opcional
- **Veredito:** atende parcialmente
- **O que o RAGFlow oferece:** Dataset é sempre escolhido pelo humano. Tags/metadados: `meta_fields` manuais ou **Auto metadata** gerado por LLM com domínio de valores, sem intervenção.
- **Justificativa:** O fallback por IA existe para tags e metadados, com valores restritos e sem espera. Não existe para o Espaço: a IA não escolhe dataset.
- **Lacuna e customização:** Passo externo de classificação de Espaço antes de chamar a API de upload.
- **Evidência:**
  - "Auto metadata: Controls whether metadata is generated automatically." (`docs/guides/dataset/configuration.md`)
  - "Values: The allowed values for the field, used to restrict the generated result's value range." (`docs/guides/dataset/configuration.md`)

#### ING-06. Pipeline assíncrono com estado por documento e por representação

- **Requisito:** Estado visível por documento e por representação, falhas reprocessáveis e disponibilidade para busca só quando as representações configuradas estiverem prontas.
- **Criticidade:** essencial
- **Veredito:** atende parcialmente
- **O que o RAGFlow oferece:** Task executor assíncrono; estados por documento `UNSTART / SCHEDULE / RUNNING / DONE / FAIL / CANCEL`, progresso, cancelar e reexecutar; logs por documento e por dataset.
- **Justificativa:** O nível de documento está bem coberto. Não há estado por representação: artefatos de compilação (Wiki, Graph) têm só log de dataset e um botão Update manual, e um documento fica DONE independentemente da wiki estar atualizada.
- **Lacuna e customização:** Orquestração externa consultando `run` do documento e os dataset-level logs para reconstruir o estado por representação e a disponibilidade conjunta.
- **Evidência:**
  - "troubleshoot in the order of document status -> configuration -> Logs" (`docs/guides/dataset/notes_and_faqs.md`)
  - "Whether to delete existing tasks and chunks before rerunning" (`docs/references/http_api_reference.md`)
  - "They are not parent-child logs or summary logs." (`docs/guides/dataset/logs.md`)

#### ING-07. Chunking com mais de uma estratégia disponível, escolhida por Espaço

- **Requisito:** Pai/filho (busca no filho, entrega do pai), semântico via LLM, mecânico e proposition como técnicas de referência.
- **Criticidade:** essencial
- **Veredito:** atende
- **O que o RAGFlow oferece:** Doze métodos built-in (General, Q&A, Manual, Table, Paper, Book, Laws, Presentation, One, Tag, Picture, Email) por dataset e por documento; `parser_config.parent_child` (`use_parent_child`, `children_delimiter`) no método General desde v0.23.0, com a semântica exata de busca no filho e entrega do pai; Chunker do pipeline: Token e Title (hierárquico por seções).
- **Justificativa:** Mais de uma estratégia, escolhida por dataset e até por documento, com a técnica de referência pai/filho disponível. O que falta é técnica, não capacidade: sem chunking semântico via LLM nem proposition, e a opção pai/filho não aparece no Chunker do Ingestion Pipeline.
- **Lacuna e customização:** Técnicas semântica e proposition ficariam fora (pré-chunking externo) ou por código.
- **Evidência:**
  - "At retrieval time, matched child chunks are replaced by their parent's full text before being passed to the LLM, giving precise vector matching with broader context." (`docs/references/http_api_reference.md`)
  - "Child chunk are used for retrieval: Controls whether finer-grained child chunks participate in retrieval." (`docs/guides/dataset/configuration.md`)
  - "The system splits documents by chapter and section structure. Each chunk represents a complete structural unit." (`docs/guides/agent/ingestion_pipeline/configure_chunker_component.md`)

#### ING-08. Enriquecimento de chunk opcional e combinável

- **Requisito:** Contextual headers e perguntas hipotéticas / HyPE como técnicas de referência.
- **Criticidade:** opcional
- **Veredito:** atende
- **O que o RAGFlow oferece:** Componente **Transformer**: Summary, Keywords, Questions, Metadata, encadeáveis, prompt editável, por documento ou por chunk. Indexer pode indexar as perguntas (≈ HyPE) ou o sumário (Enhanced context). Built-in: `auto_keywords`, `auto_questions`.
- **Justificativa:** Enriquecimento opcional e combinável está pronto, com perguntas hipotéticas nativas. Contextual headers não é opção nomeada; aproxima-se via Transformer com prompt próprio, e a doc não detalha como a saída é concatenada ao chunk.
- **Lacuna e customização:** Transformer customizado com prompt de cabeçalho contextual; validar no código como o texto enriquecido entra no embedding.
- **Evidência:**
  - "the second Transformer component processes the output of the first one, for example, generating keywords from a summary" (`docs/guides/agent/ingestion_pipeline/configure_transformer_component.md`)
  - "Retrieval strategy: Processed text (default) | Questions | Enhanced context" (`docs/guides/agent/ingestion_pipeline/configure_indexer_component.md`)

#### ING-09. Embedding com modelo configurável por Espaço

- **Requisito:** Troca de modelo implica reconstruir a representação.
- **Criticidade:** essencial
- **Veredito:** atende
- **O que o RAGFlow oferece:** `embedding_model` por dataset (`model@factory`), dezenas de provedores, inclusive locais (Ollama, Xinference, TEI). Troca exige "Parse again".
- **Justificativa:** Modelo configurável por dataset; a troca exige reprocessamento manual, compatível com o requisito.
- **Evidência:**
  - "Changing the embedding model after content has already been parsed usually affects the index and should be handled carefully." (`docs/guides/dataset/configuration.md`)
  - "To search across multiple knowledge bases at the same time, all selected knowledge bases must use the same embedding model." (`docs/guides/agent/ingestion_pipeline/configure_indexer_component.md`)

#### ING-10. Índice como representação de base, vetorial e lexical, com metadados por chunk

- **Requisito:** Busca vetorial e lexical (BM25 como referência); metadados de Espaço e tags gravados por chunk, independentes dos vetores.
- **Criticidade:** essencial
- **Veredito:** atende
- **O que o RAGFlow oferece:** Híbrido nativo (BM25 + vetor) em Elasticsearch, Infinity ou OpenSearch; `dataset_id`, `tag_kwd`, `important_keywords` por chunk; `metadata_condition` empurrado ao motor.
- **Justificativa:** Metadados são campos próprios do índice, independentes do vetor, e usados como filtro. Metadados de negócio são de nível documento (propagados), exceto tags e keywords, editáveis por chunk.
- **Evidência:**
  - "BM25 is used for relevance scoring in full-text search and can be combined with vector similarity" (`docs/references/glossary.mdx`)
  - "Metadata filters pushed down to the metadata index for faster retrieval" (`docs/release_notes.md (v0.27.1)`)

#### ING-11. Wiki destilada por LLM como representação opcional

- **Requisito:** OKF, páginas atômicas (~200–800 palavras), rastreabilidade das fontes, índice próprio e lint periódico como contrato da técnica de referência.
- **Criticidade:** opcional
- **Veredito:** atende
- **O que o RAGFlow oferece:** **Knowledge Compilation · Wiki** (v0.27.0): artefato de nível de dataset, opcional, com Plan, Blueprints (Brand, Engineering, General, Market, Product, Userinterview, Custom), especificações de Entity/Relation/Claim/Concept e atualização manual (botão Update). Na busca, entra como chunks de compilação no mesmo pool.
- **Justificativa:** Existe uma wiki gerada por LLM, opcional e configurável por dataset, com blueprint customizável: é o que o requisito pede como representação. OKF, granularidade de página, rastreabilidade formal, índice próprio e lint são contrato da técnica de referência e não pesam. As ressalvas que restam pertencem a outros requisitos: a atualização manual dos artefatos é a divergência de FUN-02, e a ausência de leitura programática de páginas é a lacuna de BUS-07.
- **Lacuna e customização:** Blueprint Custom + Instruction para aproximar o contrato de destilação do projeto, se desejado; verificar no código como as páginas são indexadas e citadas na busca.
- **Evidência:**
  - "Wiki compiles document content into structured and associated knowledge pages. The system identifies entities, relationships, facts, and concepts in documents, then generates content similar to encyclopedia knowledge pages" (`docs/guides/knowledge_compilation/built_in_templates_and_dedicated_configuration.md`)
  - "Wiki is generated as a knowledge-base-level artifact. After knowledge compilation for related documents is complete, you need to go to the Artifacts page of the knowledge base and click generate." (`docs/guides/knowledge_compilation/apply_knowledge_compilation_template.md`)
  - "When documents are added to or removed from the knowledge base, the corresponding knowledge artifacts are not automatically regenerated." (`docs/guides/knowledge_compilation/apply_knowledge_compilation_template.md`)

#### ING-12. Grafo de entidades como representação auxiliar

- **Requisito:** Travessia como método de acesso.
- **Criticidade:** dispensável
- **Veredito:** atende
- **O que o RAGFlow oferece:** **Knowledge Compilation · Graph** (entidades, relações, regras) por documento; recuperação com `use_kg` (entidades da query, top-N por PageRank, N-hop, community reports).
- **Justificativa:** Grafo como representação auxiliar existe e há um caminho de acesso por grafo. A doc de recuperação ainda descreve o fluxo do GraphRAG legado (descontinuado na v0.27.0); a integração do novo artefato Graph com `use_kg` não está explicitamente confirmada.
- **Evidência:**
  - "The previous GraphRAG and RAPTOR features have been deprecated and are no longer available in the UI. Their replacements, Graph and Tree, are now integrated into Knowledge Compilation." (`docs/release_notes.md (v0.27.0)`)
  - "Whether to search chunks related to the generated knowledge graph for multi-hop queries." (`docs/references/http_api_reference.md`)

#### ING-13. Ingestão por monitoramento de fontes externas

- **Requisito:** SharePoint e similares.
- **Criticidade:** dispensável
- **Veredito:** atende
- **O que o RAGFlow oferece:** **Data sources** com polling (refresh interval, cleanup interval, sync deleted): SharePoint, OneDrive, S3, Azure Blob, Oracle Storage, Confluence, Notion, Google Drive, Azure DevOps e outros; SharePoint e OneDrive nativos desde v0.26.0.
- **Justificativa:** Conectores prontos, com sincronização periódica e remoção espelhada. Cobre o requisito com folga.
- **Evidência:**
  - "A Microsoft 365 or SharePoint organization site and Entra ID application authorization are required." (`docs/guides/data_source/data_source_configuration.md`)
  - "Content newly added or modified in the external system is usually synchronized to the knowledge base when the next refresh interval arrives." (`docs/guides/data_source/add_to_knowledge_base_and_sync.md`)

### Grupo BUS. Pipeline de busca

#### BUS-01. Tool `search` unificada e stateless, que devolve evidência

- **Requisito:** Uma passada por chamada; passagens candidatas de qualquer representação num contrato comum (texto, origem, scores, metadados), devolvidas como evidência, nunca resposta gerada.
- **Criticidade:** essencial
- **Veredito:** atende parcialmente
- **O que o RAGFlow oferece:** `POST /api/v1/retrieval` e a tool MCP `ragflow_retrieval`: stateless, vários `dataset_ids`, contrato único por chunk (texto, `document_id`, `dataset_id`, três scores, `positions`), sem gerar resposta. Flags `use_kg`, `toc_enhance`, `include_knowledge_compilation` trazem grafo, PageIndex e wiki para o mesmo pool. Chat, Agent e Search geram resposta, mas são camadas opcionais.
- **Justificativa:** O primitivo de evidência existe, é stateless e unifica várias representações num só retorno. Falta na origem o rótulo da representação de onde o chunk veio (bruto, grafo, wiki), o que impede o chamador de saber o que está lendo, e o contrato não é extensível sem mudar código.
- **Lacuna e customização:** Rotular origem por representação exigiria alterar a resposta do endpoint ou um proxy que enriqueça o retorno.
- **Evidência:**
  - "Whether to include knowledge-compilation chunks in the results." (`docs/references/http_api_reference.md`)
  - "similarity ... A composite similarity score of the chunk ranging from 0 to 1 ... It is the weighted sum of vector_similarity and term_similarity." (`docs/references/python_api_reference.md`)
  - "Retrieve relevant chunks from the RAGFlow retrieve interface based on the question." (`mcp/server/server.py`)

#### BUS-02. Melhoria de query como etapa opcional, desligada por padrão

- **Requisito:** Rewrite e step-back; HyDE como técnica de embedding de query.
- **Criticidade:** opcional
- **Veredito:** não atende
- **O que o RAGFlow oferece:** Só na camada de Chat: Multi-turn conversation optimization, Keyword analysis e Thinking modes (o Medium "clarifies or rewrites the question"). `/retrieval` tem apenas `keyword` e `cross_languages`.
- **Justificativa:** A reescrita fica acoplada ao chat, não é etapa da tool de recuperação. Step-back e HyDE não são documentados.
- **Lacuna e customização:** Implementar rewrite, step-back e HyDE fora, antes de chamar `/retrieval`.
- **Evidência:**
  - "Multi-turn conversation optimization: Uses the conversation history to optimize the current retrieval query" (`docs/guides/chat/chat_configuration.md`)
  - "Medium (recommended starting point): ... It first clarifies or rewrites the question, then retrieves and integrates evidence." (`docs/guides/chat/chat_configuration.md`)

#### BUS-03. Filtro de escopo por Espaço, tags e facetas

- **Requisito:** Filtro sobre metadados; dedução de tags da query via LLM como técnica opcional.
- **Criticidade:** opcional
- **Veredito:** atende
- **O que o RAGFlow oferece:** `dataset_ids`, `document_ids`, `metadata_condition` (11 operadores, and/or); facetas via `GET /datasets/{id}/metadata/summary`. **Tag sets** associam tags à query por similaridade, como reforço de ranking.
- **Justificativa:** Filtro por Espaço, documento e facetas atendido, com pushdown ao motor. A dedução de tags da query existe por similaridade com o tag set, como boost e não como filtro via LLM; sendo técnica de referência, não pesa no veredito.
- **Lacuna e customização:** Metadata tagging via LLM como filtro ficaria fora, antes de chamar o endpoint; tag sets indisponíveis no motor Infinity.
- **Evidência:**
  - "Metadata can also be used to restrict the retrieval range. After metadata conditions are configured, retrieval only searches content that meets the metadata conditions." (`docs/guides/dataset/metadata_management.md`)
  - "During retrieval, queries are also automatically associated with corresponding tags, improving retrieval accuracy with tag information." (`docs/guides/dataset/configuration.md`)

#### BUS-04. Mais de um método de acesso, combináveis e selecionáveis por Espaço

- **Requisito:** Combináveis e selecionáveis por Espaço; semântico e BM25 sobre o índice, busca de páginas na wiki e travessia de grafo como técnicas de referência.
- **Criticidade:** essencial
- **Veredito:** atende
- **O que o RAGFlow oferece:** Search method por dataset no Indexer: Full-text, Embedding ou Hybrid (exige ES, Infinity ou OpenSearch); por chamada, `use_kg` (grafo), `toc_enhance` (PageIndex) e `include_knowledge_compilation` (artefatos de compilação, inclusive a wiki) acrescentam chunks ao mesmo pool.
- **Justificativa:** Mais de um método, selecionável por dataset no Indexer e combinável por chamada (híbrido, grafo, PageIndex, artefatos de compilação), o que é o que o requisito pede. Busca de páginas da wiki e travessia de grafo são referência: a wiki entra como chunks de compilação no pool e o grafo tem caminho próprio via `use_kg`. Ressalva informativa: a ponderação entre métodos vive na aplicação consumidora, não no dataset (ver FUN-05).
- **Lacuna e customização:** Ponderação entre métodos por dataset (hoje na aplicação consumidora) só com alteração no backend.
- **Evidência:**
  - "only Elasticsearch and Infinity meet the hybrid search requirements of RAGFlow. Most open-source vector databases have limited support for full-text search" (`docs/faq.mdx`)
  - "Search method = Full-text | Embedding | Hybrid" (`docs/guides/agent/ingestion_pipeline/configure_indexer_component.md`)

#### BUS-05. Pós-processamento: expansão de contexto, threshold, fusão e dedup

- **Requisito:** Quando há mais de um método: expansão de contexto (filho → pai como referência), threshold por método, fusão e dedup; RRF como referência da fusão.
- **Criticidade:** opcional
- **Veredito:** atende parcialmente
- **O que o RAGFlow oferece:** Fusão por **soma ponderada** `x·vetor + (1−x)·termo` (default x = 0,3) mais PageRank do dataset; `similarity_threshold` único sobre o score composto; expansão pai via `parent_child`. Dedup não documentado.
- **Justificativa:** Expansão de contexto e fusão existem; a fusão por soma ponderada é uma técnica válida, ainda que a referência do projeto seja RRF. Ficam de fora o threshold por método (o RAGFlow aplica um só corte sobre o score composto) e o dedup, não documentado.
- **Lacuna e customização:** Threshold por método e dedup só com alteração no backend ou fusão externa a partir de chamadas separadas.
- **Evidência:**
  - "If x represents the weight of vector cosine similarity, then (1 - x) is the term similarity weight." (`docs/references/http_api_reference.md`)
  - "this score is added to the hybrid similarity score of matched chunks in the dataset, increasing their ranking weight" (`docs/guides/dataset/configuration.md`)
  - "Similarity threshold: Candidate chunks below this threshold are filtered out. ... The default value is 0.2." (`docs/guides/dataset/retrieval_testing.md`)

#### BUS-06. Reranking sobre o pool mesclado, cego à origem, com modelo configurável

- **Requisito:** Reordena o pool mesclado sem saber a origem; modelo configurável.
- **Criticidade:** opcional
- **Veredito:** atende
- **O que o RAGFlow oferece:** `rerank_id` (qualquer provedor de rerank cadastrado), `rerank_candidates_count` (default 64). Modelos internos removidos na v0.18.0; o score do rerank é combinado ao composto.
- **Justificativa:** Modelo de rerank configurável (qualquer provedor cadastrado), aplicado ao pool mesclado sem distinguir dataset ou origem, com `rerank_candidates_count` controlando o tamanho do pool. Ressalva informativa: o score final é composto com a similaridade de termos em vez de substituir o ranking; o requisito não exige substituição.
- **Evidência:**
  - "If selected, reranking results participate in the comprehensive score. Using a rerank model may increase retrieval latency." (`docs/guides/dataset/retrieval_testing.md`)
  - "built-in rerank models have been removed because they have minimal impact on retrieval rates but significantly increase retrieval time" (`docs/release_notes.md (v0.18.0)`)

#### BUS-07. Tool `fetch` por id: documento canônico ou página da wiki, com referências

- **Requisito:** Devolve inteiro um documento canônico ou uma página da wiki, com suas referências; navegação direta pelo agente como default.
- **Criticidade:** essencial
- **Veredito:** atende parcialmente
- **O que o RAGFlow oferece:** REST: download do arquivo bruto e listagem paginada dos chunks de um documento (`GET /datasets/{id}/documents/{id}/chunks`), o que permite ler um documento por id. Não há documento canônico, nenhum endpoint REST nem tool MCP para ler uma página da Wiki ou listar suas referências; o único contato com a Wiki é `include_knowledge_compilation` na busca.
- **Justificativa:** A metade "documento por id" é alcançável pela REST (bruto ou chunks concatenados), embora sem canônico e fora do MCP. A metade "página da wiki com referências" não existe: a Wiki é artefato navegável só na UI. O padrão buscar e depois ler, que é o que um agente precisa, fica incompleto.
- **Lacuna e customização:** Expor `fetch` próprio: sobre download/chunks para documentos e sobre o armazenamento dos artefatos para páginas da Wiki (código a estudar); publicar no MCP.
- **Evidência:**
  - "Generated knowledge artifacts can be used as auxiliary information for subsequent retrieval and Q&A" (`docs/guides/knowledge_compilation/overview.md`)
  - "The MCP server currently offers a specialized tool ... retrieve" (`docs/develop/mcp/mcp_tools.md`)
  - "Lists chunks in a specified document." (`docs/references/http_api_reference.md (GET /api/v1/datasets/{dataset_id}/documents/{document_id}/chunks)`)
  - "Downloads a document from a specified dataset." (`docs/references/http_api_reference.md (GET /api/v1/datasets/{dataset_id}/documents/{document_id})`)

#### BUS-08. Superfície `consult`: uma chamada com loop interno, devolvendo evidência

- **Requisito:** Padrão `ask_question`: loop de recuperação interno, orçamento explícito, evidência consolidada e flag de suficiência, não resposta.
- **Criticidade:** dispensável
- **Veredito:** divergente
- **O que o RAGFlow oferece:** Chat com **Thinking modes** (None, Low, Medium, High, Ultra) e Agentic Retrieval (decomposição, recuperação, checagem de evidência); componente Agent com `Max reflection rounds`, tools e saída estruturada por JSON Schema.
- **Justificativa:** Existe agência sobre a recuperação, no padrão `ask_question`, mas acoplada à geração da resposta e sem contrato de orçamento (ciclos, tokens, timeout) nem flag de suficiência; a noção mais próxima é `empty_response`.
- **Lacuna e customização:** Um `consult` teria que ser construído como agente RAGFlow com saída estruturada (evidência + suficiência), ou fora, sobre `/retrieval`.
- **Evidência:**
  - "High: ... It splits the problem more actively and checks whether the evidence is sufficient, so it may take longer and invoke the model more often." (`docs/guides/chat/chat_configuration.md`)
  - "Brand new Agentic RAG with four thinking modes when answering - Low, Medium, High, and Ultra" (`docs/release_notes.md (v0.27.0)`)

### Grupo WEB. Interface web

#### WEB-01. Gestão de Espaços e de seus documentos pela interface

- **Requisito:** Criar, editar e desativar Espaço; enviar e remover documentos.
- **Criticidade:** essencial
- **Veredito:** atende parcialmente
- **O que o RAGFlow oferece:** Criar dataset (nome, embedding, parse type), editar em Configuration, excluir (só o criador). Upload de arquivos e pastas com "Parse on creation", exclusão de documentos com cascata de chunks. Lista mostra datasets próprios e compartilhados; cada dataset pertence ao workspace de um usuário.
- **Justificativa:** Envio e remoção de documentos e criação/edição de dataset estão cobertos. Sem estado "desativado" de dataset (só documentos e chunks) e sem catálogo flat corporativo central: o catálogo é por tenant.
- **Lacuna e customização:** Convenção de tenant único corporativo; desativação simulada por desabilitar documentos.
- **Evidência:**
  - "Deleting a shared knowledge base generally requires the current user to be the creator" (`docs/guides/team/team_management/faq.md`)
  - "The corresponding chunks, metadata, and parsing results are also removed" (`docs/guides/dataset/files_dataset_document_management.md`)

#### WEB-02. Navegação de conteúdo somente leitura por Espaço

- **Requisito:** Documentos (bruto, canônico, estado por representação) e representações; modo apresentação e grafo interativo como exemplos.
- **Criticidade:** opcional
- **Veredito:** atende parcialmente
- **O que o RAGFlow oferece:** Lista de documentos com status e filtros; chunks com preview do PDF/DOCX na posição de origem; Artifacts com Wiki hierárquica, Graph, Mind Map, Tree, Timeline.
- **Justificativa:** Documentos e representações são navegáveis, com preview do trecho de origem e artefatos de compilação. Sem documento canônico navegável (ING-03); modo apresentação e interatividade do grafo não descritos, mas são exemplos, não obrigação.
- **Evidência:**
  - "Fixed hierarchical Wiki topic navigation" (`docs/release_notes.md (v0.27.1)`)
  - "After clicking chunk text, the document preview area jumps to the corresponding source location" (`docs/guides/dataset/chunk_parsing_results_and_knowledge_fragment_management.md`)

#### WEB-03. Simulador de Recuperação

- **Requisito:** Pergunta + escopo + parâmetros da tool; resultado bruto com scores, origem, técnicas aplicadas e custo.
- **Criticidade:** essencial
- **Veredito:** atende parcialmente
- **O que o RAGFlow oferece:** **Retrieval Testing** por dataset: threshold, peso vetorial, rerank, cross-language, metadados, Top; resultado com chunk, scores, documento de origem e filtro por arquivo. Parâmetros não são salvos.
- **Justificativa:** Cobre pergunta, escopo, parâmetros, scores e origem. Falta custo, tokens, latência, técnicas aplicadas e histórico; escopo multi-dataset só via API, Search ou Chat.
- **Evidência:**
  - "Each result mainly displays the recalled chunk content, relevance information, and source document, and is sorted according to the current retrieval configuration." (`docs/guides/dataset/retrieval_testing.md`)

#### WEB-04. Logs de consultas simuladas e de produção

- **Requisito:** Histórico para auditoria.
- **Criticidade:** opcional
- **Veredito:** atende parcialmente
- **O que o RAGFlow oferece:** Logs de ingestão na UI; conversas de Chat e Agent persistidas por sessão. Sem log de chamadas de `/retrieval` nem do Retrieval Testing; sem trilha de auditoria administrativa.
- **Justificativa:** Consultas via chat ficam registradas; consultas via tool de busca não. Auditoria delegada ao Langfuse.
- **Evidência:**
  - "Logs: Used to view document parsing and dataset-level task records, including document logs and dataset-level logs." (`docs/guides/dataset/dataset_overview.md`)

#### WEB-05. Analytics por representação, método de acesso e técnica

- **Requisito:** Tempo e custo médios por representação, método de acesso e técnica.
- **Criticidade:** opcional
- **Veredito:** não atende
- **O que o RAGFlow oferece:** Nenhuma tela de analytics de uso, tokens ou custo. Admin UI mostra só status de serviços. Perfil ClickHouse no compose sem documentação de finalidade.
- **Justificativa:** A base de dados para a decisão de desligar técnicas não existe na ferramenta.
- **Lacuna e customização:** Analytics construído fora sobre Langfuse ou sobre instrumentação própria.
- **Evidência:**
  - "The Admin UI provides ... check system status" (`docs/administrator/admin/admin_ui/check_system_status.md`)

## Lacunas críticas

1. **Não existe documento canônico** (ING-03): o RAGFlow vai do arquivo aos chunks; índice e wiki não derivam de uma fonte comum reconstruível, e trocar de parser não gera nova versão de nada.
2. **Segurança por Espaço sem separar leitura de edição** (FUN-09 não atende; FUN-08 e FUN-10 parciais): só Only me/Team, quem vê envia e parseia, sem grupos, OIDC só de identidade; controles finos são Enterprise.
3. **Conteúdo mutável por design** (FUN-02): chunks editáveis, reparse in place, artefatos atualizados por botão; a cascata do projeto não existe.
4. **Medição fora do produto** (FUN-06 parcial; FUN-07 e WEB-05 não atendem): o retorno da busca traz três scores; tempo, tokens e custo só via Langfuse e, na ingestão, por documento; nenhuma avaliação offline nem analytics. O ciclo "comparar técnicas com evidência" fica sem instrumento na ferramenta.
5. **Superfície para agentes incompleta** (FUN-11, BUS-07, ambos parciais): o MCP tem só `ragflow_retrieval`; a REST lê um documento por id (download e chunks), mas não há canônico nem endpoint para ler uma página da wiki ou suas referências, logo o padrão buscar e depois ler não fecha.
6. **Configuração sem padrão global e sem A/B no mesmo conteúdo** (FUN-05, FUN-04, ambos parciais): tudo é por dataset, sem herança de um plano global, e comparar duas técnicas exige datasets paralelos.

## Cenários de adoção

1. **Adotar o RAGFlow como plataforma** e rever o desenho onde ele diverge (sem canônico, conteúdo mutável, permissões me/team, medição fora). Ganha o motor completo, a configuração por dataset, a UI e os conectores em semanas; paga com a perda do canônico e da imutabilidade, segurança por Espaço num gateway próprio, telemetria, avaliação e analytics fora do produto e uma stack maior (ES ou Infinity, MySQL, Redis, MinIO). A descoberto: ING-03, FUN-09, FUN-07 (não atende); FUN-02, BUS-08 (divergentes). Parciais a completar fora: FUN-06, BUS-07.
2. **Compor: RAGFlow como motor atrás da API própria.** Mantém REST + MCP com `search` e `fetch`, hard filter, telemetria e avaliação na camada própria; usa o RAGFlow para parsing, chunking, índice híbrido, rerank, wiki e conectores. Preserva a estrutura do desenho e a superfície para agentes; paga com duas fontes de verdade para o mesmo documento (ING-03), leitura de páginas da wiki e contrato OKF próprios (BUS-07), A/B ainda por datasets paralelos (FUN-04), UI duplicada e acoplamento a uma API que muda rápido. A descoberto: ING-03. Parciais a completar fora: FUN-04, BUS-07.
3. **Construir conforme o desenho, com o RAGFlow como referência e benchmark.** Todos os requisitos sob controle e stack alinhada ao ambiente (OKE, Oracle Object Storage, Keycloak, PostgreSQL + pgvector); paga com parsing profundo a montar (Docling/Unstructured), UI do zero e tempo maior até o primeiro retrieval útil.

A pergunta que decide entre os cenários: o documento canônico, a imutabilidade com cascata e a separação leitura/edição por Espaço são estrutura no desenho, não técnica. Se forem negociáveis, o cenário 1 entrega mais rápido e ainda cumpre a essência (técnicas por Espaço); se não forem, o RAGFlow só cabe como motor ou como referência.

## Mudanças em relação à avaliação de 2026-09-02

A avaliação anterior usava a numeração `R01`–`R44`. Em 2026-09-03 os requisitos foram reagrupados, reescritos com o resultado no sujeito (técnicas nomeadas viraram referência) e renumerados; o mapa completo está na seção "Transição da numeração anterior" de `requirements.md`. Os vereditos abaixo mudaram porque o **requisito** mudou, não o RAGFlow (mesma versão, mesma documentação); a única exceção é BUS-07, em que uma evidência já disponível na documentação passou a ser citada.

Mudaram também as criticidades, o que altera a coluna "Só essenciais" (30 essenciais antes, 22 agora): FUN-07 (avaliação offline) subiu de opcional para essencial; FUN-04, ING-04, ING-11, BUS-03, BUS-05 e BUS-06 desceram de essencial para opcional; FUN-09 continua essencial, com a exigência reduzida ao mínimo de separar leitura de edição por Espaço.

| Novo ID | Veredito anterior | Veredito atual | Por quê |
|---|---|---|---|
| FUN-03 | R30 atende parcialmente | atende | o requisito passou a pedir técnicas coexistentes por Espaço, não slots com contrato; a configuração por dataset do RAGFlow cobre isso. |
| FUN-06 | R28 atende parcialmente, R23 não atende | atende parcialmente | R23 (trace no retorno) foi fundido em R28; o requisito aceita telemetria acessível por identificador de execução, o que o Langfuse cobre em parte. |
| ING-07 | R08 atende parcialmente | atende | o requisito passou a pedir mais de uma estratégia de chunking por Espaço, com pai/filho como referência; doze métodos por dataset atendem. |
| ING-08 | R09 atende parcialmente | atende | contextual headers virou referência; o enriquecimento opcional e combinável do Transformer atende. |
| ING-11 | R12 divergente | atende | a wiki virou representação opcional, com OKF, lint e rastreabilidade como contrato de referência; a Knowledge Compilation Wiki atende à representação, e as ressalvas restantes pertencem a FUN-02 e BUS-07. |
| BUS-01 | R16 atende parcialmente, R26 atende | atende parcialmente | R26 (evidência, não resposta), que atendia, foi fundido em R16, que atende parcialmente por falta de rótulo de representação na origem. |
| BUS-03 | R18 atende parcialmente | atende | dedução de tags via LLM virou técnica opcional; o filtro por Espaço, documento e facetas atende sozinho. |
| BUS-04 | R20 atende parcialmente | atende | o requisito passou a pedir métodos combináveis e selecionáveis por Espaço, com wiki e grafo como referência; o método do Indexer por dataset e as flags por chamada atendem. |
| BUS-05 | R21 divergente | atende parcialmente | RRF virou referência; soma ponderada deixa de ser divergência, mas threshold global e dedup não documentado mantêm o parcial. |
| BUS-06 | R22 atende parcialmente | atende | o requisito não exige rerank puro que substitua o ranking; modelo configurável sobre o pool mesclado e cego à origem atende. |
| BUS-07 | R24 não atende | atende parcialmente | as tools de leitura da wiki viraram `fetch` por id de documento canônico ou página; a metade "documento por id" é coberta por download e listagem de chunks por documento, **evidência acrescentada nesta revisão** (não constava em 02/09). |
| WEB-01 | R31 atende parcialmente, R15 atende | atende parcialmente |  |

Saíram da lista: R42 (stack Python + React, decisão de projeto) e R43 (open source e comunidade, agora critério de seleção em `docs/candidate-tools/README.md`; o RAGFlow o cumpre: Apache-2.0, 22 releases em 12 meses, comunidade ativa). R15 (canais de entrada) foi dividido em FUN-11, WEB-01 e ING-13. Todos os demais vereditos foram remapeados sem alteração.

## Ficha técnica (v0.27.1)

- Licença Apache-2.0; edição Enterprise com DeepDoc proprietário e permissões avançadas.
- 22 releases nos últimos 12 meses (v0.20.5 → v0.27.1); GraphRAG e RAPTOR descontinuados na v0.27.0 em favor de Graph e Tree do Knowledge Compilation.
- Stack: Python ≥ 3.13 (api server, task executor, admin server, MCP server; ORM Peewee), frontend React; componentes em Go (engine, syncer, harness).
- Serviços: MySQL (ou PostgreSQL, GaussDB, OceanBase) para metadados; Redis; MinIO (ou S3-compatível, OSS, Azure, GCS); doc engine Elasticsearch ou Infinity para híbrido completo (OpenSearch, OceanBase, SeekDB, SereneDB, GaussDB como alternativas). PostgreSQL + pgvector não é opção de doc engine.
- Requisitos mínimos: 4 CPU, 16 GB RAM, 50 GB disco; imagens só x86_64 (~2 GB).
- Deploy: Docker Compose e Helm chart oficial (K8s ≥ 1.24); separação de processos por flags do entrypoint.
- Autenticação: OAuth2, OIDC (descoberta por issuer), GitHub; só identidade, sem grupos/roles por claim.
- Observabilidade: Langfuse por tenant; OpenTelemetry e Jaeger presentes no compose sem documentação.
- MCP: `ragflow_retrieval`, `ragflow_list_datasets`, `ragflow_list_chats`; SSE e streamable HTTP (host mode ainda sem streamable HTTP). Sem tool de leitura por id.
- UI em 17 idiomas, incluindo português (desde v0.16.0).

## Defasagens conhecidas da documentação do RAGFlow

- `docs/develop/mcp/mcp_tools.md` cita uma única tool (`retrieve`); o código `mcp/server/server.py` expõe três.
- A referência HTTP ainda documenta `parser_config.raptor` e `parser_config.graphrag`, descontinuados na v0.27.0.
- O limite de upload aparece como 128 MB em `docker/README.md` e como 1 GB em `docs/faq.mdx`.
- `docs/guides/dataset/advanced/`, referenciada no release notes, não existe no repositório.

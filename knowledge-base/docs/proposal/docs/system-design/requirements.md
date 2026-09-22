# Requisitos do projeto

Lista consolidada do que a base de conhecimento corporativa precisa entregar. É a régua para avaliar aderência de ferramentas candidatas: cada ferramenta avaliada tem sua própria subpasta em `docs/candidate-tools/`, com o veredito requisito a requisito. Este arquivo nunca contém informação específica de uma ferramenta candidata, apenas o que o projeto exige, independente de com o que será comparado.

## O que o projeto precisa, em uma frase

Conteúdos de áreas diferentes da empresa, com tipos e volumes diferentes, respondem melhor a técnicas diferentes de ingestão e busca. A base precisa permitir que **várias técnicas coexistam**, que cada Espaço use as que lhe servem e que as técnicas sejam **comparadas com evidência**. Slots, variantes e planos de ativação, que aparecem nos documentos de desenho, são o caminho escolhido para chegar a isso, não o fim em si.

## Relação com os documentos de system design

Os demais documentos deste diretório (`conceptual-model.md`, `ingestion-pipeline.md`, `retrieval-pipeline.md`, `taxonomy.md`, `web-management-ui.md`) descrevem a **implementação de referência**: como o projeto construiria a base por conta própria. Esta lista descreve o **mínimo que qualquer solução precisa atender**, por outro caminho que seja. Por isso os dois usam vocabulário diferente de propósito:

| Nos requisitos | No system design | Sentido |
|---|---|---|
| etapa | slot | ponto do pipeline em que uma técnica se aplica |
| técnica | variante | uma implementação concreta em uma etapa |
| configuração de técnicas por Espaço | plano de ativação | quais representações e técnicas se aplicam a cada Espaço |

A coluna **Fonte** aponta para onde a implementação de referência trata cada requisito. Se uma decisão de desenho mudar o que o projeto exige, atualize esta lista; se mudar só o como, atualize apenas o documento de desenho. As fases de entrega (ondas) pertencem ao system design e não aparecem aqui: na lista, o único marcador de prioridade é a criticidade.

## Como ler

Cada requisito tem um identificador estável com prefixo do grupo (`FUN-01`, `ING-01`, `BUS-01`, `WEB-01`). Inclusões futuras recebem o próximo número do grupo; identificadores não são reaproveitados.

Criticidade:

- **essencial**: sem isso a solução não serve como base do projeto.
- **opcional**: esperado na primeira versão, mas contornável ou substituível.
- **dispensável**: só entra com evidência medida; hoje não faz falta.

Técnicas citadas pelo nome (Docling, RRF, Ragas, pai/filho, OKF etc.) são **referências**, não obrigação: indicam a técnica que a implementação de referência adotaria, para dar concretude ao requisito.

## FUN. Fundamentos e plataforma

Requisitos que não pertencem a um pipeline nem a uma tela e valem para o sistema inteiro: modelo conceitual, segurança, configuração, medição, integração e plataforma.

| ID | Requisito | Criticidade | Fonte |
|---|---|---|---|
| FUN-01 | **Espaço** como agrupamento único de cada documento: catálogo flat gerido por humanos, fronteira de segurança e unidade de configuração | essencial | conceptual-model §2, §7 |
| FUN-02 | **Conteúdo imutável**: toda mudança é inclusão ou remoção de documento, com cascata pelas representações derivadas; reclassificar tags é só metadados | essencial | conceptual-model §3; ingestion §6 |
| FUN-03 | **Múltiplas técnicas coexistentes**: cada etapa de ingestão e busca admite mais de uma técnica, e Espaços diferentes (tipo de conteúdo, volume) podem usar técnicas diferentes sem alterar o restante do sistema | essencial | conceptual-model §1, §4 |
| FUN-04 | **Etapas com contrato estável**, permitindo comparar técnicas lado a lado (A/B) sobre o mesmo conteúdo sem reprocessar o restante do sistema | opcional | conceptual-model §4 |
| FUN-05 | **Configuração de técnicas por Espaço**: padrão global com override por Espaço, definindo quais representações e técnicas se aplicam a cada um; exposta na interface web | essencial | conceptual-model §4, §5; web-management-ui (Configuração) |
| FUN-06 | **Telemetria por execução** (técnica aplicada em cada etapa, latência, tokens, custo, scores), gravada em ingestão e busca e acessível a partir da chamada, no retorno ou por identificador de execução | essencial | conceptual-model §5; ingestion §7; retrieval §3 |
| FUN-07 | **Avaliação offline reproduzível**, com dataset golden e métricas de retrieval, capaz de comparar técnicas entre si; Ragas como referência | essencial | conceptual-model §5; taxonomy §7 |
| FUN-08 | **Todo acesso a conteúdo filtrado pelos Espaços permitidos do chamador**, em toda superfície (`search`, `fetch`, `consult`, interface web, API), aplicado no servidor antes de qualquer método de acesso e não contornável por parâmetro | essencial | conceptual-model §7; retrieval §3, §4 |
| FUN-09 | **Permissionamento**: administrador global e, por Espaço, separação mínima entre quem só lê e quem edita; quatro perfis (Administrador, Dono, Editor, Consulta) e associação por grupos como modelo de referência | essencial | web-management-ui (Permissionamento); conceptual-model §7 |
| FUN-10 | **Autenticação corporativa via OAuth/OIDC** (Keycloak como provedor); Espaços permitidos derivados de grupos | essencial | web-management-ui (Stack, Permissionamento); conceptual-model §7 |
| FUN-11 | **API REST** de ingestão e consulta e **endpoints MCP** (`search`, `fetch`; `consult` quando existir, ver BUS-08) para agentes externos | essencial | architecture; web-management-ui (APIs); retrieval §1, §2 |
| FUN-12 | **Persistência em serviços do ambiente corporativo**, sem storage local no servidor e com backends substituíveis; Oracle Object Storage, PostgreSQL + pgvector e grafo como referência | opcional | conceptual-model §6 |
| FUN-13 | **Deploy em Kubernetes** (Oracle OKE) com containers separados; CI/CD em Azure DevOps | opcional | web-management-ui (Stack) |
| FUN-14 | **Conteúdo em pt-BR**: modelos de embedding e rerank multilíngues; interface localizável | opcional | ingestion §5 E4a; web-management-ui (Stack) |

## ING. Pipeline de ingestão

Do documento bruto às representações prontas para busca.

| ID | Requisito | Criticidade | Fonte |
|---|---|---|---|
| ING-01 | **Formatos de entrada**: PDF, Word (.docx), Excel (.xlsx), Markdown; formato novo não exige mudar o restante do pipeline | essencial | ingestion §2 |
| ING-02 | **Documento bruto preservado intacto** em object store, para auditoria e reprocessamento com outras técnicas | essencial | conceptual-model §2; ingestion §2 |
| ING-03 | **Documento canônico** em texto limpo e legível (Markdown como referência) como fonte de verdade: extração sem reescrever, versionado; todas as representações derivam dele | essencial | conceptual-model §2, §3; ingestion §4 |
| ING-04 | **Canonicalização com mais de uma técnica disponível**, comparáveis entre si, gerando o documento canônico (ING-03); remoção de ruído, tabelas em Markdown e captioning de imagens como operações esperadas; Docling, Unstructured.io e LlamaParse como referência | opcional | ingestion §4; taxonomy §1 |
| ING-05 | **Escopo por humano com fallback IA**: Espaço e tags informados na entrada; se ausentes, IA classifica e o pipeline segue sem espera humana | opcional | ingestion §3 |
| ING-06 | **Pipeline assíncrono** com estado visível por documento e por representação, falhas reprocessáveis e disponibilidade para busca só quando as representações configuradas estiverem prontas | essencial | ingestion §1, §6 |
| ING-07 | **Chunking com mais de uma estratégia disponível**, escolhida por Espaço; pai/filho (busca no filho, entrega do pai), semântico via LLM, mecânico e proposition como técnicas de referência | essencial | ingestion §5 E4a; taxonomy §1 |
| ING-08 | **Enriquecimento de chunk** opcional e combinável: contextual headers, perguntas hipotéticas / HyPE como técnicas de referência | opcional | ingestion §5 E4a; taxonomy §1 |
| ING-09 | **Embedding com modelo configurável** por Espaço; troca de modelo implica reconstruir a representação | essencial | ingestion §5 E4a |
| ING-10 | **Índice** como representação de base, com busca vetorial e lexical (BM25 como referência); metadados de Espaço e tags gravados por chunk, independentes dos vetores | essencial | ingestion §5 E4a; taxonomy §2, §4 |
| ING-11 | **Wiki destilada por LLM** como representação opcional; OKF, páginas atômicas (~200–800 palavras), rastreabilidade das fontes, índice próprio e lint periódico como contrato da técnica de referência | opcional | conceptual-model §3; ingestion §5 E4b, §7 |
| ING-12 | **Grafo de entidades** como representação auxiliar, com travessia como método de acesso | dispensável | ingestion §5 E4c; taxonomy §4 |
| ING-13 | **Ingestão por monitoramento de fontes externas** (SharePoint e similares) | dispensável | ingestion §2 |

## BUS. Pipeline de busca

Da pergunta do consumidor às passagens devolvidas.

| ID | Requisito | Criticidade | Fonte |
|---|---|---|---|
| BUS-01 | **Tool `search` unificada e stateless**: uma passada por chamada, passagens candidatas de qualquer representação num contrato comum (texto, origem, scores, metadados), devolvidas como evidência, nunca resposta gerada | essencial | retrieval §1, §2, §3 |
| BUS-02 | **Melhoria de query** como etapa opcional, desligada por padrão: rewrite e step-back; HyDE como técnica de embedding de query | opcional | retrieval §3 F1, §6; taxonomy §3 |
| BUS-03 | **Filtro de escopo** por Espaço, tags e facetas sobre metadados; dedução de tags da query via LLM como técnica opcional | opcional | retrieval §3 F2; taxonomy §2 |
| BUS-04 | **Mais de um método de acesso**, combináveis e selecionáveis por Espaço; semântico e BM25 sobre o índice, busca de páginas na wiki e travessia de grafo como técnicas de referência | essencial | retrieval §3 F3; taxonomy §4 |
| BUS-05 | **Pós-processamento** quando há mais de um método: expansão de contexto (filho → pai como referência), threshold por método, fusão e dedup; RRF como referência da fusão | opcional | retrieval §3 F4; taxonomy §5 |
| BUS-06 | **Reranking** sobre o pool mesclado, cego à origem, com modelo configurável | opcional | retrieval §3 F5; taxonomy §5 |
| BUS-07 | **Tool `fetch` por id**: documento canônico ou página da wiki inteiros, com suas referências; navegação direta pelo agente como default | essencial | retrieval §4 |
| BUS-08 | **Superfície `consult`**: uma chamada com loop de recuperação interno (padrão `ask_question`), orçamento explícito, devolvendo evidência consolidada e flag de suficiência, não resposta | dispensável | retrieval §2, §5 |

## WEB. Interface web

Painel de administração e operação da base.

| ID | Requisito | Criticidade | Fonte |
|---|---|---|---|
| WEB-01 | **Gestão de Espaços e de seus documentos** pela interface: criar, editar e desativar Espaço; enviar e remover documentos | essencial | web-management-ui (Espaços e documentos); ingestion §2 |
| WEB-02 | **Navegação de conteúdo somente leitura** por Espaço: documentos (bruto, canônico, estado por representação) e representações; modo apresentação e grafo interativo como exemplos | opcional | web-management-ui (Navegação de conteúdo) |
| WEB-03 | **Simulador de Recuperação**: pergunta + escopo + parâmetros da tool; resultado bruto com scores, origem, técnicas aplicadas e custo | essencial | web-management-ui (Simulador) |
| WEB-04 | **Logs** de consultas simuladas e de produção, para auditoria | opcional | web-management-ui (Logs) |
| WEB-05 | **Analytics** por representação, método de acesso e técnica: tempo e custo médios | opcional | web-management-ui (Analytics) |

## Resumo

| Grupo | essencial | opcional | dispensável | total |
|---|---|---|---|---|
| FUN | 10 | 4 | 0 | 14 |
| ING | 7 | 4 | 2 | 13 |
| BUS | 3 | 4 | 1 | 8 |
| WEB | 2 | 3 | 0 | 5 |
| **total** | **22** | **15** | **3** | **40** |

## Transição da numeração anterior

A primeira versão desta lista (setembro de 2026) usava identificadores corridos `R01` a `R44`, em cinco grupos, e foi revisada em 2026-09-03 para a estrutura atual. O mapa abaixo existe para leitura de documentos e avaliações produzidos com a numeração antiga.

| Antigo | Novo | Antigo | Novo | Antigo | Novo | Antigo | Novo |
|---|---|---|---|---|---|---|---|
| R01 | FUN-01 | R12 | ING-11 | R23 | FUN-06 (fundido) | R34 | WEB-04 |
| R02 | ING-02 | R13 | ING-12 | R24 | BUS-07 | R35 | WEB-05 |
| R03 | ING-03 | R14 | FUN-02 | R25 | BUS-08 | R36 | FUN-05 (fundido) |
| R04 | ING-01 | R15 | dividido (FUN-11, WEB-01, ING-13) | R26 | BUS-01 (fundido) | R37 | FUN-09 |
| R05 | ING-04 | R16 | BUS-01 | R27 | FUN-05 | R38 | FUN-11 |
| R06 | ING-05 | R17 | FUN-08 | R28 | FUN-06 | R39 | FUN-10 |
| R07 | ING-06 | R18 | BUS-03 | R29 | FUN-07 | R40 | FUN-12 |
| R08 | ING-07 | R19 | BUS-02 | R30 | FUN-03 e FUN-04 (dividido) | R41 | FUN-13 |
| R09 | ING-08 | R20 | BUS-04 | R31 | WEB-01 | R42 | descartado |
| R10 | ING-09 | R21 | BUS-05 | R32 | WEB-02 | R43 | descartado (critério em candidate-tools) |
| R11 | ING-10 | R22 | BUS-06 | R33 | WEB-03 | R44 | FUN-14 |

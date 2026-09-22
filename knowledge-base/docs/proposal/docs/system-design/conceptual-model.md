# Modelo Conceitual — Esqueleto da Base de Conhecimento

## 1. Objetivo do esqueleto

Conteúdos de áreas diferentes da empresa, com tipos e volumes diferentes, respondem melhor a técnicas diferentes de ingestão e busca. A essência do projeto é permitir que **várias técnicas coexistam**, que cada Espaço use as que lhe servem e que as técnicas sejam **comparadas com evidência**. O esqueleto descrito aqui é o caminho escolhido para isso: definir a estrutura fixa do sistema (as etapas e seus contratos) separada das técnicas que preenchem cada etapa (as peças trocáveis). A filosofia central permanece: **ligar tudo, medir tudo, e desligar o que não performa**. O esqueleto muda raramente; as peças mudam o tempo todo.

Este documento e os demais do system design descrevem a implementação de referência e usam o vocabulário de slot e variante. O mínimo que qualquer solução precisa atender está em `requirements.md`, que usa etapa e técnica para os mesmos conceitos.

## 2. Vocabulário

| Termo | Definição |
|---|---|
| **Documento bruto** | Arquivo como chegou (PDF, Word, Excel, Markdown). Preservado intacto para auditoria e reprocessamento. |
| **Documento canônico** | Versão em Markdown limpo do documento bruto. Extração de essência **sem reescrever**: remove ruído (capas, cabeçalhos, índices), converte tabelas, descreve imagens. É a **fonte de verdade** de todo o resto. |
| **Espaço** | Agrupamento de domínio (RH, Produto X, Projeto Y). Catálogo flat gerenciado por humanos. Cada documento pertence a exatamente um Espaço. É também a fronteira de segurança. |
| **Representação** | Estrutura derivada do documento canônico, construída na ingestão para facilitar retrieval. Na v1 existem duas: o **índice** (chunks + vetores + BM25), que é a representação de base, presente em todo Espaço, e a **wiki** (páginas destiladas OKF), representação prevista e ligável por Espaço. Um grafo estilo GraphRAG com sumários de comunidade, ou uma árvore de sumarização recursiva estilo RAPTOR, seriam candidatas a uma terceira, por criarem conteúdo derivado próprio. |
| **Estrutura auxiliar** | Dado adicional dentro de uma representação que abre um novo caminho até o mesmo conteúdo, sem criar conteúdo novo. Exemplo: grafo de entidades sobre os chunks pais do índice (onda 2). |
| **Método de acesso** | Motor de consulta que opera sobre uma representação em tempo de busca: busca semântica, full-text (BM25), busca de páginas, navegação por referências, travessia de grafo. |
| **Slot** | Ponto do pipeline com contrato definido (entrada/saída) que aceita implementações alternativas. |
| **Variante** | Uma implementação concreta de um slot. Variantes podem coexistir, ser ligadas/desligadas e comparadas. |
| **Passagem candidata** | Contrato comum de resultado de retrieval: trecho de texto + origem + scores + metadados. Detalhado em `retrieval-pipeline.md`. |
| **Consumidor** | Quem consulta a base: sistemas externos e assistentes via API/MCP (agênticos ou não) e o Simulador de Recuperação da interface web. A consulta tem duas superfícies: `search` + `fetch` (uma passada por chamada e leitura por id; o loop é do chamador) e `consult` (agêntica, o loop é interno). |

**Por que o nome "Espaço":** o agrupamento de domínio atravessa todas as técnicas do sistema (filtro de escopo do índice, roteamento da destilação, escopo do grafo, fronteira de segurança, unidade de configuração), então seu nome precisa ser agnóstico a técnica. Termos ligados a uma representação ou tecnologia específica não servem: "bundle" nomeia o diretório físico de arquivos OKF (a wiki de um Espaço *é* um bundle na prática, mas o índice, o grafo e as permissões não são), "coleção" colide com as collections dos vector stores, e "domínio" é sobrecarregado em ambiente técnico (DNS, DDD). "Espaço" é neutro, cobre os três tipos de agrupamento (corporativo, produto e projeto), tem precedente consolidado em bases de conhecimento corporativas (os spaces do Confluence) e segue a política de idioma do projeto.

## 3. O modelo em uma figura

```text
Documento bruto ──▶ Canonicalização ──▶ DOCUMENTO CANÔNICO (fonte de verdade)
                                          │  (pertence a um Espaço)
                     ┌────────────────────┴────────────────────┐
                     ▼                                         ▼
          Representação ÍNDICE                      Representação WIKI
          ├ estrutura: chunks pai/filho             ├ estrutura: páginas OKF
          │   + vetores + BM25                      │   atômicas (~200-800 palavras)
          ├ auxiliar (onda 2): grafo                │   + índice de páginas
          │   de entidades                          │   (multi-vetor + BM25)
          └ métodos de acesso:                      └ métodos de acesso:
             ├ busca semântica                         ├ busca de páginas
             ├ full-text (BM25)                        │   (ponto de entrada)
             └ travessia de grafo (onda 2)             └ navegação por referências
                                                          (entrega: página inteira)
```

Pontos estruturais que a figura fixa:

- O canônico é único; representações são deriváveis dele a qualquer momento. O índice é **reconstruível** de forma determinística. A wiki é **regenerável, não idêntica**: redestilar os canônicos de um Espaço produz uma wiki válida equivalente, mas não uma cópia da anterior, porque a destilação é incremental e autônoma.
- Conteúdo não é editável, por ninguém: nem documentos brutos, nem canônicos, nem páginas da wiki aceitam edição direta. Toda mudança de conteúdo entra como **inclusão ou remoção de documento bruto**, e o efeito cascateia: novo canônico, rebuild do índice, reprocessamento da destilação. Atualizar um documento é remover a versão antiga e incluir a nova. A única escrita sobre as representações é a das próprias LLMs do pipeline (destilação e lint). Reclassificar tags é operação de metadados, não de conteúdo; trocar um documento de Espaço não é reclassificação, é remoção no Espaço de origem seguida de nova inclusão no destino.
- Representações são plugáveis: adicionar uma nova (ou desligar uma existente) não afeta as demais.
- As "N técnicas de preparação" (chunking, enriquecimento, embedding) não competem com a destilação: são **internas à representação-índice**, assim como o contrato de destilação é interno à representação-wiki.
- A wiki não passa por chunking. O controle de tamanho vem do contrato de destilação (páginas atômicas); a rede de segurança para páginas grandes é embedding multi-vetor por seção, onde **qualquer vetor que casar devolve a página inteira**. Os arquivos permanecem OKF puros; o índice de páginas é estrutura externa a eles.

## 4. Slots e variantes

Cada etapa dos pipelines é um slot com contrato estável. Regras:

1. **Contrato primeiro.** O que entra e o que sai de cada slot é fixo; a implementação é livre. É isso que permite trocar Docling por Unstructured, ou testar duas estratégias de chunking, sem tocar no resto.
2. **Variantes coexistem.** Um slot pode ter Y variantes registradas; a configuração define qual está ativa (ou quais, quando o slot aceita composição, como os enriquecimentos de chunk).
3. **Ativação por Espaço.** A resolução de configuração é `padrão global → override por Espaço`. O override por Espaço, ao menos para representações e para as variantes principais de cada slot, entra na v1 e é exposto na interface web: é o mecanismo pelo qual conteúdos diferentes recebem técnicas diferentes, e por isso não pode ficar para depois.
4. **Toda variante é identificada no trace.** Cada execução registra qual variante rodou em cada slot (ver plano de telemetria abaixo). Sem isso, não há como comparar e desligar depois.

## 5. Planos transversais

Quatro planos independentes atravessam os dois pipelines. A separação de nomes resolve a ambiguidade entre "escolher o melhor caminho em runtime" e "medir para desligar caminhos depois":

| Plano | Pergunta que responde | Quando atua |
|---|---|---|
| **Configuração de ativação** | O que existe e está ligado? | Design time (admin liga/desliga variantes e representações) |
| **Roteamento em runtime** | Qual caminho esta consulta usou? | Por consulta (o agente e os parâmetros da chamada escolhem entre o que está ligado) |
| **Telemetria** | Quanto custou e demorou? | Por execução (latência, tokens, custo por slot/variante, gravados no trace e acessíveis a partir da chamada, no retorno ou por identificador de execução) |
| **Avaliação offline** | Quão boa é a resposta? | Periódico (harness com dataset golden + métricas Ragas, capaz de comparar técnicas entre si; alimenta a decisão de desligar) |

O ciclo de convergência que o projeto busca é: ativação define o cardápio, roteamento usa o cardápio, telemetria e avaliação medem, e o administrador enxuga o cardápio com base nas medições. As comparações de alto nível vêm primeiro (índice vs. wiki), antes de qualquer tuning fino de variante: a escolha de representação tende a dominar o resultado, e otimizar detalhes internos antes dessa decisão é esforço mal alocado.

**Avaliação offline:** dataset de perguntas golden curado a partir de documentos reais; Ragas como framework primário; métricas `faithfulness`, `answer_relevancy`, `context_precision`, `context_recall`, `answer_correctness`; agregação por média harmônica; fases de geração e avaliação desacopladas.

## 6. Persistência plugável

Quatro stores lógicos, cada um atrás de uma interface própria, com backend concreto substituível:

| Store lógico | Conteúdo | Backend inicial |
|---|---|---|
| **Object store** | Documentos brutos, documentos canônicos, arquivos OKF da wiki | Oracle Object Storage |
| **Metadados e estado** | Catálogo de Espaços, registro de documentos, estados do pipeline, configuração, traces | PostgreSQL |
| **Índices de retrieval** | Vetores (índice e páginas da wiki) e índice lexical BM25 | PostgreSQL + pgvector |
| **Grafo** (onda 2) | Entidades e relações sobre chunks pais | grafo em memória (candidato registrado), a confirmar quando ativado |

A organização física dos arquivos no object store é independente dos atributos de escopo: a classificação vive nos metadados, o que permite reclassificar sem mover arquivos.

## 7. Segurança e permissionamento

O Espaço é a fronteira de segurança. O modelo de perfis (Administrador, Dono, Editor, Consulta) e a associação por grupos estão detalhados na documentação da interface web de gestão. O mínimo exigido pelo projeto é menor que esse modelo: um administrador global e, por Espaço, a separação entre quem só lê e quem edita; os quatro perfis são o modelo completo adotado pela implementação de referência. O que o esqueleto fixa:

- Todo consumidor carrega um conjunto de **Espaços permitidos** (derivado dos grupos no Keycloak).
- O filtro por Espaços permitidos é um **hard filter aplicado antes de qualquer método de acesso**, em toda superfície de acesso a conteúdo (`search`, `fetch`, `consult`, interface web e API), sem exceção. É aplicado no servidor, não é rankeável nem contornável por parâmetro.
- Toda passagem candidata carrega o Espaço de origem nos metadados, o que permite auditar que nenhum resultado vazou de escopo.

## 8. Ondas de implementação

| | Onda 1 | Onda 2+ |
|---|---|---|
| Representações | índice, wiki | — |
| Superfícies de consulta | `search` + `fetch` | `consult` (agêntica) |
| Métodos de acesso | semântica, BM25, busca de páginas, navegação | travessia de grafo; HyDE como variante de embedding de query no método semântico |
| Enriquecimento de chunks | contextual headers | doc augmentation (perguntas hipotéticas) |
| Melhoria de query | reformulação pelo agente; slot de reescrita na tool (default off) | — |
| Pós-retrieval | expansão de contexto, threshold, fusão, rerank | compressão contextual, filtragem por diversidade |
| Avaliação | telemetria completa + logs; harness golden + Ragas | grid-search de hiperparâmetros com LLM-judge |

O critério para promover algo de onda 2 é sempre uma evidência medida na onda 1, nunca antecipação.

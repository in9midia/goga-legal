# Pipeline de Ingestão

## 1. Visão geral

O pipeline de ingestão transforma um documento bruto qualquer em conteúdo pronto para retrieval. É **assíncrono em todos os estágios**, com estado rastreável por documento e por representação. O esqueleto tem quatro estágios fixos; dentro de cada um, as técnicas são variantes de slots.

```text
E1 RECEPÇÃO ──▶ E2 ESCOPO ──▶ E3 CANONICALIZAÇÃO ──▶ E4 CONSTRUÇÃO DE REPRESENTAÇÕES
   (bruto           (Espaço        (bruto → canônico)        │
    armazenado)      + tags)                                 ├─▶ E4a Índice
                                                             ├─▶ E4b Wiki
                                                             └─▶ E4c Grafo (onda 2)
```

Um ponto estrutural importante: **não existe roteamento por LLM no meio do pipeline**. A única decisão de destino é o Espaço, tomada em E2 (humano primeiro, IA como fallback). Dali em diante tudo é determinístico: o Espaço determina quais representações construir (via configuração de ativação) e para qual wiki destilar.

## 2. Estágio E1 — Recepção

Canais de entrada:

| Canal | Status |
|---|---|
| Upload via interface web | Confirmado |
| REST API (sistemas externos) | Confirmado |
| Monitoramento de pastas (SharePoint etc.) | Opcional, não descartado |

O documento bruto é gravado no object store exatamente como chegou e um registro do documento é criado no store de metadados, iniciando a máquina de estados. Formatos aceitos: PDF, Markdown, Word (.docx), Excel (.xlsx). Formato novo = variante nova no slot de canonicalização, sem mudança no esqueleto.

## 3. Estágio E2 — Escopo

Coleta dos dois atributos de escopo, com prioridade absoluta para o humano:

| Atributo | Quem define | Fallback |
|---|---|---|
| **Espaço** | Humano na entrada | IA decide (slot: variante de classificação) |
| **Tags de tipo** | Humano na entrada | IA decide (slot: variante de extração) |

O valor informado pelo humano na entrada é definitivo. Na ausência dele, a IA decide sozinha e o pipeline segue automaticamente: não existe estado de espera por confirmação humana. Correções posteriores de tags acontecem por reclassificação; Espaço incorreto se corrige removendo o documento e incluindo-o de novo com o Espaço certo.

Os atributos vivem nos metadados, nunca nos embeddings nem na estrutura de diretórios. **Reclassificar** um documento é trocar suas tags: operação de metadados que se propaga aos chunks indexados sem reprocessamento de conteúdo. Trocar de Espaço não é reclassificação: como o Espaço roteia a destilação e é a fronteira de segurança, a troca é uma **remoção no Espaço de origem seguida de nova inclusão no destino**, cada uma com sua cascata normal (a remoção reprocessa a destilação das páginas derivadas; a inclusão destila na wiki do novo Espaço).

## 4. Estágio E3 — Canonicalização

Converte o bruto em documento canônico: Markdown limpo, essência extraída **sem reescrever**. Este é o contraste fundamental com a destilação (E4b): a canonicalização preserva o texto original e só remove ruído; a destilação reescreve.

Operações internas (todas parte do mesmo estágio, não estágios separados):

- Extração de estrutura (headings, listas, tabelas → Markdown).
- Remoção de ruído: capas, cabeçalhos, rodapés, índices, sumários.
- Imagens → descrição textual (captioning) no lugar da imagem.
- Tabelas → Markdown; planilhas → uma seção por aba.

**Slot de canonicalização** (variantes candidatas: Docling, Unstructured.io, LlamaParse). A escolha do parser é por variante, comparável via telemetria; o contrato de saída (documento canônico + metadados de parsing) é o mesmo para todas. O canônico é gravado no object store ao lado do bruto e versionado: reprocessar com um parser melhor gera nova versão do canônico e dispara reconstrução das representações.

## 5. Estágio E4 — Construção de representações

Fan-out assíncrono: para cada representação **ativa no Espaço do documento**, dispara o build correspondente. A escolha de representações e de variantes por Espaço, resolvida pela configuração de ativação, é o mecanismo pelo qual conteúdos de tipos e volumes diferentes recebem técnicas diferentes sem mudar o pipeline. Os builds são independentes entre si na execução: a falha de um não impede o andamento dos outros. A disponibilidade para busca, porém, é um portão conjunto, definido na seção de estados. Cada build tem estado próprio por (documento, representação).

### E4a — Build do índice

Sequência interna, cada passo um slot:

| # | Slot | Variante default (onda 1) | Outras variantes registradas |
|---|---|---|---|
| 1 | Chunking | Hierárquico semântico (pai/filho, fronteiras semânticas) | Chunking mecânico (janela fixa + parágrafos, sem LLM); proposition chunking (condicional) |
| 2 | Enriquecimento de chunk | Contextual headers (cabeçalho de contexto prependado antes do embedding) | Doc augmentation / perguntas hipotéticas (onda 2); HyPE (experimento A/B futuro) |
| 3 | Embedding | Modelo configurável (padrão global, override por Espaço); modelos multilíngues, pois o conteúdo é em pt-BR | Troca de modelo = re-embedding da representação |
| 4 | Indexação | pgvector (filhos) + BM25 (filhos) | — |

Regra estrutural preservada: **busca no filho, retorno do pai**. Os metadados de Espaço e tags são gravados em cada chunk como campos independentes dos vetores.

O slot de enriquecimento aceita composição (mais de uma variante ativa ao mesmo tempo), porque enriquecimentos são aditivos, não excludentes.

### E4b — Build da wiki

A LLM de destilação recebe o documento canônico e opera com autonomia sobre a wiki do Espaço (criar, editar, mesclar, reorganizar páginas). O roteamento é determinístico a partir do Espaço.

**Contrato de destilação** (as regras fixas do prompt, independentes do modelo usado):

- Páginas atômicas: um conceito por página, alvo de ~200 a 800 palavras.
- Formato OKF puro, alinhado à especificação v0.2 (retrocompatível com v0.1): frontmatter YAML (`type` obrigatório; `title`, `description`, `tags` por convenção; `generated: { by, at }` registrando a LLM de destilação e o momento da geração, na convenção de ator do padrão) e referências cruzadas como links Markdown.
- Toda página nova ou alterada registra de quais documentos canônicos deriva: nos metadados (rastreabilidade operacional, fora do arquivo OKF, usada para reprocessamento e remoção por consulta direta) e também no próprio frontmatter, no campo `sources` do padrão v0.2 (`resource` apontando para o id do documento canônico de origem, nunca o bruto nem fonte externa) — o que mantém a página autodescritiva mesmo fora do sistema, sem alterar onde a cascata operacional é resolvida.

Após a escrita das páginas, o build atualiza o **índice de páginas**: embedding multi-vetor (um vetor por seção, todos resolvendo para a página inteira) + BM25 por página. Sem chunking, sem hierarquia pai/filho.

### E4c — Build do grafo (onda 2)

Extração de entidades e relações via LLM sobre os **chunks pais** do índice. O grafo é estrutura auxiliar da representação-índice: seus nós apontam para chunks pais existentes, não criam conteúdo novo. Só é construído quando o método de acesso de travessia estiver ativado.

## 6. Estados e reprocessamento

Máquina de estados em dois níveis:

```text
Documento:  RECEBIDO → ESCOPADO → CANONIZADO → CONCLUÍDO
                │           │          │           (todas as representações ativas OK)
                └───────────┴──────────┴──▶ FALHA
                                            (reprocessável a partir do estágio que falhou)
Por (documento, representação):  PENDENTE → CONSTRUINDO → OK | FALHA
```

Qualquer estágio pode falhar: recepção, escopo e canonicalização levam o documento ao estado FALHA, visível na interface e reprocessável a partir do estágio que falhou, sem repetir os anteriores. Falhas de build vivem no nível (documento, representação) e são reprocessáveis por representação.

Um documento só entra na busca quando atinge CONCLUÍDO. Na **primeira ingestão**, falha em qualquer build retém o documento em CANONIZADO, fora da busca em todas as representações (inclusive as que construíram com sucesso), até que o reprocessamento da representação falha conclua: a consistência entre representações prevalece sobre a disponibilidade parcial. Em **rebuild de documento já disponível** (nova variante, novo parser), a versão anterior da representação continua servindo a busca até o novo build concluir com sucesso; a troca é atômica por (documento, representação), e um rebuild que falha mantém a versão antiga no ar.

Semântica de reprocessamento:

| Gatilho | O que reprocessa |
|---|---|
| Falha em um build | Só aquele (documento, representação) |
| Nova variante de chunking/enriquecimento/embedding | Rebuild da representação-índice a partir do canônico |
| Novo parser de canonicalização | Nova versão do canônico + rebuild de todas as representações |
| Reclassificação de tags | Só metadados (sem rebuild) |
| Troca de Espaço | Não é reclassificação: remoção no Espaço de origem + nova inclusão no destino, cada uma com sua cascata normal |
| Documento removido | Remove chunks do índice; reprocessa destilação das páginas que derivavam dele |

Não existe edição de conteúdo no sistema: atualizar um documento é remover o antigo e incluir o novo, encadeando a semântica de remoção da tabela com uma ingestão normal.

## 7. Manutenção contínua

- **Lint da wiki** (por Espaço, periódico): LLM varre em busca de contradições, páginas órfãs, páginas fora do contrato de tamanho e degradações. Não é rollback; perda por edição é risco assumido do modelo.
- **Telemetria de ingestão**: cada estágio grava no trace a variante usada, duração, tokens e custo, alimentando o comparativo entre variantes do plano de telemetria. O trace de ingestão é recuperável por identificador do documento (ou da execução) e fica visível no estado por documento na interface web.

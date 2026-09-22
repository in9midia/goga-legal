# Interface Web de Gestão

A interface web é o painel de administração e operação da base de conhecimento. É, por si só, um serviço com design próprio a ser elaborado no planejamento do projeto. Este documento registra as decisões e direcionamentos já definidos.

## Stack técnica

| Camada | Tecnologia | Justificativa |
|---|---|---|
| Frontend | React | — |
| Backend | Python | Ecossistema de bibliotecas RAG e manipulação de documentos mais maduro |
| Banco de dados | PostgreSQL + pgvector | Suporte nativo a vetores na mesma instância relacional |
| Autenticação | OAuth/OIDC com Keycloak | Keycloak disponível no ambiente corporativo |
| Storage de arquivos | Oracle Object Storage | Sem storage local no servidor |
| Containers | Backend e frontend separados | — |
| CI/CD | Azure DevOps | Pipelines de build e publicação já existentes |
| Kubernetes | Oracle OKE | Registro de imagens Oracle |
| Idioma | pt-BR | Interface localizável; modelos de embedding e rerank multilíngues |

> **Framework de backend:** candidato principal é o LlamaIndex, para centralizar orquestração de RAG, ingestão e agentes num framework único em vez de compor várias bibliotecas soltas. Decisão a validar no planejamento do projeto.

## APIs

O backend expõe APIs que servem as telas da interface. Duas famílias de endpoints são adicionalmente expostas para integrações externas e servidores MCP:

- **Endpoint de ingestão** (REST) — recebe documentos de sistemas externos.
- **Endpoints de consulta** — expõem as superfícies do pipeline de busca: `search` (busca de uma passada, para chamadores que conduzem o próprio loop), `fetch` (leitura por id de documento canônico ou página da wiki, com referências, que completa o `search`) e `consult` (consulta agêntica de chamada única, onda 2).

## Áreas da interface

### Espaços e documentos

Criação e gestão do catálogo de Espaços: criar com nome e descrição, editar e desativar existentes.

Dentro de cada Espaço, envio e remoção de documentos pela interface, com Espaço e tags informados na entrada e o estado do pipeline de ingestão visível por documento e por representação (incluindo falhas e a ação de reprocessar). Não há edição de conteúdo: atualizar um documento é remover o antigo e enviar o novo.

### Navegação de conteúdo

Browsing do conteúdo da base organizado por Espaço. A navegação parte sempre do Espaço; dentro dele o usuário escolhe entre os **documentos** (bruto e canônico, com o estado de cada representação) e, quando ativa no Espaço, a **wiki**.

Toda visualização de conteúdo é somente leitura: a interface não oferece edição de documentos, canônicos ou páginas da wiki. Mudanças de conteúdo acontecem exclusivamente por inclusão e remoção de documentos, cujo efeito cascateia pelas representações.

Ambas as visões são apresentadas com árvore de navegação e campo de busca simples para evitar listas planas. A exibição de conteúdo Markdown suporta **modo apresentação**, onde o conteúdo ocupa a maior parte da tela com menus retraídos.

Na wiki, a navegação inclui uma **visualização de grafo** interativa, ao estilo Obsidian, que exibe as conexões entre páginas e permite navegar por elas. Implementada com biblioteca JavaScript de grafos. Prevista para o final da primeira implementação da interface, dentro do escopo da v1.

### Simulador de Recuperação

Ambiente de debug e validação do pipeline de busca. O usuário digita uma pergunta, define o escopo (aberto ou filtrado por Espaço, tags e facetas), controla os parâmetros da tool de busca (representações consultadas, melhoria de query on/off, top-k) e observa o resultado bruto: passagens recuperadas com scores, origem de cada uma (representação, documento canônico, Espaço), variantes usadas em cada slot e custo de tokens. O Simulador cobre as duas superfícies de consulta: a busca de uma passada (`search`) e, na onda 2, a consulta agêntica (`consult`), que acrescenta ao resultado os ciclos executados e a flag de suficiência. O trace de execução é a matéria-prima da tela.

Não é um assistente conversacional; é uma ferramenta para quem administra e valida a base. Um assistente embutido é funcionalidade prevista para versão futura: um cliente da API de consulta que permite conversar diretamente com a base.

> **Evolução prevista:** explicabilidade do retrieval (por que cada passagem foi recuperada e qual trecho foi efetivamente usado na resposta), em fase posterior à v1.

### Logs

Histórico de consultas realizadas, simuladas e de produção. Base para auditoria e análise de uso.

### Analytics

Métricas de performance por método de acesso e por variante de slot: tempo médio de resposta, custo médio de tokens, comparativo entre representações (índice vs. wiki). Dados fundamentais para a decisão de desligar caminhos que não performam. Alimentada pela telemetria dos pipelines.

> **Evolução prevista:** captura de feedback de relevância declarado pelo usuário como sinal adicional para a decisão de desligar caminhos (e, mais adiante, para recalibrar ranking). Condicionada a volume de uso real e à avaliação offline já em operação, pelo risco de feedback ruidoso degradar o sistema.

### Configuração

Habilitar e desabilitar representações, métodos de acesso e variantes de slot (o plano de configuração de ativação), com resolução `padrão global → override por Espaço`. O override por Espaço entra na v1, começando por representações e pelas variantes principais de cada slot: é assim que conteúdos de tipos e volumes diferentes recebem técnicas diferentes.

> **Decisão postergada:** granularidade fina do override por Espaço (parâmetros internos de cada variante) em versão futura, conforme a demanda medida.

### Permissionamento

O mínimo exigido pelo projeto é um administrador global e, por Espaço, a separação entre quem só lê e quem edita. A implementação de referência adota o modelo completo abaixo, com quatro perfis, um global e três com escopo por Espaço:

| Perfil | Escopo | Capacidades |
|---|---|---|
| **Administrador** | Global | Gerencia usuários, grupos e permissões; acessa Logs e Analytics; acesso irrestrito a todos os Espaços |
| **Dono** | Por Espaço | Controle total sobre um Espaço específico, incluindo gestão de quem tem acesso a ele |
| **Editor** | Por Espaço | Inclui e remove documentos no(s) Espaço(s) associado(s) e reclassifica tags dentro deles |
| **Consulta** | Por Espaço | Acessa conteúdo em modo somente leitura no(s) Espaço(s) associado(s) |

Mover um documento entre Espaços não é capacidade direta de nenhum perfil: a troca é uma remoção no Espaço de origem seguida de nova inclusão no destino, e cada uma dessas ações exige permissão de Editor no Espaço correspondente.

Espaços são associados a **grupos**, não diretamente a usuários. Usuários herdam as associações do grupo ao qual pertencem. O conjunto de Espaços permitidos derivado dos grupos é o que alimenta o hard filter de segurança do pipeline de busca, da navegação de conteúdo e da API.

> **Decisão postergada:** definir se o perfil (dono, editor ou consulta) é atributo do grupo ou da associação usuário-grupo, e como o perfil de Dono se relaciona com a criação de novos Espaços. Detalhamento completo do modelo de permissionamento no planejamento do projeto.

# Base de Conhecimento Corporativa

Serviço para organizar e centralizar o conhecimento da empresa, com uma API que expõe REST (para a interface web de operação e para a ingestão por sistemas externos) e MCP (para agentes de IA consultarem a base via `search` e `fetch`).

## O que é

Base de conhecimento corporativa que centraliza documentos e conteúdos da empresa em repositórios de conteúdo (Espaços), com múltiplas estratégias de retrieval, interface web de gestão e endpoints MCP para consumo por agentes de IA.

## Estrutura do repositório

- `apps/web` — interface web de operação e gestão da base de conhecimento.
- `apps/api` — backend REST + MCP unificado, responsável pelo pipeline de ingestão e pelas estratégias de retrieval.

Cada módulo mantém sua própria documentação técnica em `apps/<módulo>/docs/`.

Para arquitetura, convenções e procedimentos transversais, veja [docs/](docs/).

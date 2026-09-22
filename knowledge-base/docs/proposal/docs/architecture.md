# Arquitetura

## Visão geral

Serviço de base de conhecimento corporativa, composto por uma API (REST + MCP unificada) que serve uma interface web de operação, recebe documentos de sistemas externos via REST e expõe endpoints MCP (`search`, `fetch`) para agentes de IA consultarem a base.

## Módulos

- `apps/web` — interface web de gestão e operação da base de conhecimento.
- `apps/api` — backend REST + MCP, responsável pelo pipeline de ingestão e pelas estratégias de retrieval sobre os repositórios de conteúdo.

## Fluxo de dados

A interface web e agentes de IA (via MCP) consomem a mesma API. A API orquestra o pipeline de ingestão (recebimento, canonicalização e construção de representações) e o pipeline de busca sobre as representações configuradas. O modelo conceitual e os fluxos detalhados estão em `docs/system-design/`.


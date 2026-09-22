# Product

## Register

brand

## Users

Engenheiros, arquitetos e stakeholders técnicos do Goga Legal que precisam decidir se vale adotar o RAGFlow (inteiro ou em partes) no lugar de construir a base de conhecimento conforme o desenho próprio. Contexto de uso: leitura no monitor durante a discussão de arquitetura, projeção em reunião de decisão e consulta de referência quando alguém perguntar "mas o RAGFlow já não faz isso?". O leitor conhece o desenho do projeto (ou a página visual dele em `docs/system-design/diagram/`) e não conhece o RAGFlow a fundo.

## Product Purpose

Uma página HTML autocontida (`index.html`) que mostra, requisito a requisito, o que o RAGFlow v0.27.1 já entrega, o que entrega parcialmente, o que entrega de um jeito conceitualmente diferente e o que não entrega. Complementa a matriz com o mapa de conceitos entre os dois sistemas, os dois pipelines lado a lado, as lacunas críticas e três cenários de adoção. Sucesso: uma reunião de decisão consegue fechar "adotar, compor ou construir" em trinta minutos usando só esta página, com a evidência de cada veredito a um clique.

## Brand Personality

A mesma da página de system design: precisa, engenheirada, viva, com a metáfora da **prancheta de revisão de engenharia**. Aqui a prancheta tem duas folhas sobrepostas: o desenho do projeto e o esquema do RAGFlow, e a redline marca onde os dois casam e onde não casam. Comparativo com opinião, não folheto de vendedor nem lista neutra de features.

## Anti-references

- Tabela comparativa de landing page de SaaS: colunas de "check verde" e "X vermelho" sem evidência nem nuance.
- Dashboard genérico com score percentual em destaque como se aderência fosse uma métrica única.
- Slide de consultoria com quadrantes e setas sem hierarquia.
- Página que só repete a documentação do fornecedor sem confrontar com os requisitos.

## Design Principles

1. **Veredito com evidência.** Todo veredito abre um inspector com o trecho da documentação oficial que o sustenta e a fonte. Sem evidência, o veredito é "não avaliado".
2. **Mesma prancheta, mesmas tintas.** Ingestão é rosa, busca é índigo, como na página de system design; o leitor não reaprende a legenda. Os vereditos ganham uma camada semântica própria, discreta.
3. **Divergente não é ruim.** "Divergente" (o RAGFlow resolve o problema por outro caminho) é uma categoria de primeira classe, distinta de "não atende", porque muda a decisão de arquitetura, não só o esforço.
4. **Fiel às duas fontes.** Requisitos derivam de `docs/system-design/requirements.md` (revisão de 2026-09-03: técnicas nomeadas são referência, o veredito julga o resultado); o que o RAGFlow faz deriva da documentação oficial na versão avaliada, com data e commit registrados.
5. **Interação revela, não esconde.** Filtros por grupo, criticidade e veredito reduzem a matriz; a matriz inteira é legível sem clique.

## Accessibility & Inclusion

Contraste WCAG AA no mínimo; vereditos nunca dependem só de cor (sempre há rótulo textual e ícone tipográfico). Toda interação acessível por teclado (linhas e nós são botões reais, inspector fecha com Esc). `prefers-reduced-motion` desliga o fluxo animado. Conteúdo íntegro sem JavaScript: a matriz e os diagramas são HTML renderizado; JS só adiciona filtros, inspector e motion.

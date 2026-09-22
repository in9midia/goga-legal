# Product

## Register

brand

## Users

Engenheiros, arquitetos e stakeholders técnicos do Goga Legal que precisam entender (ou apresentar) o desenho da base de conhecimento. Contexto de uso: leitura no monitor durante discussões de arquitetura, projeção em reuniões de alinhamento e consulta de referência durante o desenvolvimento. O leitor já é técnico; o trabalho da página é tornar o sistema inteiro apreensível de uma vez, coisa que os documentos Markdown normativos (fonte de verdade) não conseguem fazer sozinhos.

## Product Purpose

Uma página HTML autocontida (`index.html`) que representa visualmente o system design descrito em `docs/system-design/*.md`: modelo conceitual, pipeline de ingestão, pipeline de busca, slots e variantes, taxonomia de técnicas, planos transversais, persistência e segurança. Os diagramas de ingestão e busca são separados e interativos. Sucesso: alguém que nunca leu os documentos entende a arquitetura em dez minutos, e quem já leu usa a página como mapa de referência.

## Brand Personality

Precisa, engenheirada, viva. A metáfora é a **prancheta de revisão de engenharia**: papel branco puro, traços exatos, e a tinta rosa de redline marcando o que importa. Confiança técnica sem frieza; a página tem opinião visual, não é um wiki genérico.

## Anti-references

- Dashboard SaaS genérico: cards idênticos com ícone + título + texto, hero-metric, gradientes decorativos.
- "Dark blueprint" reflexo: fundo escuro com linhas neon cianas, o clichê de página de arquitetura.
- Slide de consultoria: caixas cinzas com setas sem hierarquia, texto em todas as caixas do mesmo tamanho.
- Documentação-café-com-leite: beges e cinzas tímidos que não assumem identidade.

## Design Principles

1. **O diagrama é o texto.** A informação primária vive nos diagramas e tabelas interativas; prosa só onde diagrama não alcança.
2. **Duas tintas, dois pipelines.** Ingestão e busca têm cada uma sua cor de identificação, consistente na página inteira.
3. **Onda é dimensão, não rodapé.** O que é onda 2+ aparece no lugar certo do fluxo, visualmente distinto e alternável, nunca escondido num anexo.
4. **Fiel à fonte.** Todo conteúdo deriva dos documentos normativos em `docs/system-design/`; a página não inventa decisões.
5. **Interação revela, não esconde.** Clicar aprofunda (inspector com detalhes); o fluxo geral é legível sem nenhum clique.

## Accessibility & Inclusion

Contraste WCAG AA no mínimo (corpo ≥4.5:1). Toda interação acessível por teclado (nós de diagrama são botões reais, inspector fecha com Esc). `prefers-reduced-motion` desliga animações de fluxo. Conteúdo íntegro sem JavaScript: os diagramas e tabelas são HTML renderizado, JS só adiciona filtro, inspector e motion.

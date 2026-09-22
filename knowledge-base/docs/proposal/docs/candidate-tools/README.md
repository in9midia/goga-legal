# Ferramentas candidatas

Comparativos de aderência entre os requisitos da base de conhecimento e ferramentas prontas (open source ou comerciais) que poderiam substituir ou compor partes do desenho. Os requisitos do projeto (`FUN-01`, `ING-01`, `BUS-01`, `WEB-01`…, com criticidade e fonte no system design) ficam em `docs/system-design/requirements.md`, comum a todas as comparações; esse arquivo também traz o mapa de transição da numeração antiga (`R01`…`R44`), usada na primeira avaliação. Cada ferramenta candidata tem sua própria subpasta com:

- `assessment.md`: a avaliação requisito a requisito, com evidências (trechos da documentação oficial) e veredito.
- `index.html`: página autocontida, visualmente rica e clicável, para explorar a comparação. Segue o mesmo esquema e design de `docs/system-design/diagram/`.
- `PRODUCT.md` e `DESIGN.md`: registro de produto e sistema visual da página.

A fonte de verdade dos requisitos é `docs/system-design/requirements.md`. Se um requisito mudar, atualize esse arquivo e o veredito correspondente em cada `assessment.md` afetado. Nenhuma informação específica de uma ferramenta candidata deve entrar em `requirements.md` — isso pertence à subpasta da ferramenta.

## Critérios gerais de seleção

Além da aderência requisito a requisito, toda ferramenta candidata é avaliada por critérios que dizem respeito à ferramenta em si, não ao sistema, e por isso não constam da lista de requisitos:

- **Open source com licença permissiva**, comunidade ativa e código extensível para as customizações do projeto. Edições comerciais ou recursos exclusivos de edição paga são registrados como ressalva.

## Ferramentas avaliadas

- [RAGFlow](ragflow/) (avaliação em 2026-09-02 sobre a documentação da v0.27.1; reavaliada em 2026-09-03 contra a lista de requisitos revisada)

# Design

Sistema visual da página `index.html` (aderência RAGFlow × requisitos). Herda integralmente o sistema de `docs/system-design/diagram/DESIGN.md` (prancheta de revisão de engenharia) e acrescenta uma camada semântica de veredito. Só as diferenças estão registradas aqui.

## Color

Tokens herdados sem alteração: `--bg`, `--surface`, `--ink`, `--muted`, `--line`, `--ingest` (rosa, ingestão), `--retrieval` (índigo, busca), com as variantes `-deep` e `-tint`.

Camada de veredito (nova), usada apenas em badges, células de veredito e no gráfico de distribuição:

| Token | Valor | Papel |
|---|---|---|
| `--ok` | `oklch(0.55 0.13 150)` | **Atende**: o RAGFlow entrega o requisito como está. |
| `--partial` | `oklch(0.7 0.14 80)` | **Atende parcialmente**: entrega parte, ou exige configuração/customização pequena. |
| `--diverge` | `oklch(0.5 0.12 300)` | **Divergente**: resolve o problema por outro caminho conceitual; adotar implica mudar o desenho. |
| `--gap` | `var(--ink)` | **Não atende**: ausente; exige construir fora ou por cima da ferramenta. |

Regras:

- Veredito nunca depende só da cor: badge sempre traz rótulo textual e um glifo tipográfico (`●` atende, `◐` parcial, `◇` divergente, `○` não atende).
- Rosa e índigo continuam reservados a ingestão e busca (títulos de seção, nós, conectores, filtro de grupo). Os vereditos usam a camada própria, em preenchimento claro (tint) nas células e preenchimento cheio só no gráfico e nos chips ativos.
- Criticidade ("essencial", "opcional", "dispensável") é dimensão de filtro, expressa por badge mono (`crit-essencial`, `crit-opcional`, `crit-dispensavel`); o modo "Só essenciais" no topo esmaece (`opacity`) as linhas `data-crit != essencial`, no mesmo mecanismo da alternância de onda da página de system design.
- Grupo de requisito é badge de contorno (`grp-FUN`, `grp-ING`, `grp-BUS`, `grp-WEB`): ING herda a tinta de ingestão, BUS a de busca, FUN e WEB ficam neutros, para que a cor continue significando pipeline e não categoria.

## Typography

Idêntica: **Archivo** (variável, `wdth` ~112–125 em títulos) para display e corpo; **Spline Sans Mono** para IDs de requisito (`FUN-01`, `ING-01`, `BUS-01`, `WEB-01`), nomes de parâmetros de API, badges e legendas.

## Components

Herdados: nó de diagrama, conector SVG com pulso, inspector lateral, badge, chip de filtro, tabela, callout, board com grade pontilhada, planes.

Novos:

- **Linha de requisito**: `<tr>` clicável (com `<button>` no ID) da matriz de aderência; célula de veredito com badge da camada de veredito; célula "o que o RAGFlow oferece" resumida em uma linha; hover em `--surface`.
- **Barra de distribuição**: barra horizontal segmentada com os quatro vereditos, proporcional à contagem, com rótulo numérico por segmento e legenda abaixo. Não é score único; é distribuição.
- **Par de nós (mapeamento)**: dois nós lado a lado ligados por conector curto, o da esquerda com a tinta do pipeline do projeto e o da direita em contorno neutro com o nome do conceito do RAGFlow; badge de veredito entre os dois.
- **Cartão de lacuna**: plane com borda 1.5px `--ink`, kicker mono com o(s) requisito(s) afetado(s), título e um parágrafo de impacto.
- **Cartão de cenário**: plane maior com título, resumo e duas listas curtas (ganha / paga); sem recomendação embutida na cor.

## Layout

Igual: página única com nav lateral fixa (desktop), conteúdo máx. 1100px, diagramas sangram até 1280px e rolam dentro do próprio container. A matriz de aderência rola horizontalmente em telas estreitas.

## Motion

Igual à página de system design: pulso nos conectores dos pipelines lado a lado, inspector com slide + fade 240ms, hovers 120ms; tudo desligado em `prefers-reduced-motion`.

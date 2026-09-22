# Design

Sistema visual da página `index.html` (representação visual do system design). Mood: **prancheta de revisão de engenharia** — papel branco puro, traços precisos, tinta rosa de redline como marca.

## Color

Estratégia: **full palette** — papel branco, tinta escura e duas cores de identificação usadas com papel semântico fixo.

| Token | Valor | Papel |
|---|---|---|
| `--bg` | `oklch(1 0 0)` | Papel. Branco puro, sem tinte. |
| `--surface` | `oklch(0.962 0.004 300)` | Painéis, faixas de seção, células de tabela. |
| `--ink` | `oklch(0.2 0.015 300)` | Texto de corpo e traços de diagrama. |
| `--muted` | `oklch(0.45 0.015 300)` | Texto secundário, legendas. |
| `--ingest` | `oklch(0.56 0.21 355)` | **Tinta do pipeline de ingestão** e cor primária da marca (redline rosa). |
| `--retrieval` | `oklch(0.46 0.16 275)` | **Tinta do pipeline de busca** (índigo). |
| `--line` | `oklch(0.85 0.008 300)` | Réguas, bordas de 1px. |

Regras:

- Ingestão é sempre rosa, busca é sempre índigo, na página inteira (nós, conectores, badges, títulos de seção).
- Texto sobre preenchimento saturado (rosa/índigo) é sempre branco.
- Onda 2+ se expressa por **traço tracejado + badge**, nunca por cor própria; a alternância Onda 1 / Onda 1+2 esmaece (`opacity`) os elementos `data-wave="2"`.
- Marcador ✦ IA usa a tinta do pipeline onde aparece; técnicas algorítmicas usam contorno de tinta neutra.

## Typography

| Papel | Fonte | Uso |
|---|---|---|
| Display / headings | **Archivo** (variável, eixo `wdth`) | Títulos expandidos (wdth ~125) em peso 600–700; voz de spec sheet. |
| Corpo | **Archivo** normal | 16px/1.6, máx. 70ch. |
| Labels técnicos / código | **Spline Sans Mono** | IDs de estágio (E1, F0), estados, contratos YAML, badges. |

Carregadas do Google Fonts com fallback de sistema (`system-ui`, `ui-monospace`). Escala modular ≥1.25; h1 com `clamp()` teto 4.5rem; `text-wrap: balance` em headings.

## Components

- **Nó de diagrama**: `<button>` com borda 1px `--ink`, fundo branco, ID mono no canto, título Archivo semibold. Hover: fundo levemente tingido da tinta do pipeline. Nó ativo: anel de 2px na tinta do pipeline.
- **Conector**: SVG stroke 1.5px na tinta do pipeline; fluxo animado por `stroke-dashoffset` (desligado em `prefers-reduced-motion`).
- **Inspector**: painel lateral fixo (slide-over) com detalhe do nó clicado; título, badges de onda/slot, corpo em prosa e tabelas. Fecha com Esc, botão e clique fora.
- **Badge de onda**: pílula mono pequena `onda 2` com borda tracejada.
- **Chips de filtro**: pílulas clicáveis (taxonomia e slots); ativa = preenchida com tinta e texto branco.
- **Tabelas**: cabeçalho mono uppercase pequeno, linhas com régua 1px `--line`, hover de linha em `--surface`.

## Layout

- Página única com scroll, nav lateral fixa à esquerda em desktop (lista de seções, item ativo marcado na tinta da seção), colapsa para topo em <1024px.
- Conteúdo máx. 1100px; diagramas podem sangrar até 1280px. Diagramas largos rolam horizontalmente dentro do próprio container (`overflow-x: auto`).
- Espaçamento fluido com `clamp()`; seções separadas por régua fina + número de estágio quando o conteúdo é sequencial de fato.

## Motion

- Pontos de fluxo percorrendo os conectores dos pipelines (dash animado, loop lento) — é a única animação contínua.
- Inspector: slide + fade 240ms `cubic-bezier(0.16, 1, 0.3, 1)`.
- Hovers: 120ms ease-out.
- `prefers-reduced-motion: reduce`: conectores estáticos, inspector aparece sem deslocamento.

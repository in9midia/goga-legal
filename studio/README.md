# Goga Studio

Ferramenta **interna** para simular perguntas e respostas jurídicas com um fluxo de
agentes configurável, com rastreabilidade de ponta a ponta. Plano:
[planning/00-MVP-PLANO.md](../planning/00-MVP-PLANO.md).

```
studio/
├── api/   Node 22 + Fastify + Drizzle (Postgres) + Vercel AI SDK — motor do fluxo em processo
└── ui/    React 19 + Vite + Tailwind v4 + shadcn/ui + React Flow (@xyflow/react)
```

## Rodar em desenvolvimento

```bash
docker compose -f studio/docker-compose.dev.yml up -d   # Postgres do Studio na porta 5442
cp studio/api/.env.example studio/api/.env              # preencha STUDIO_SECRET_KEY e STUDIO_ADMIN_PASSWORD
npm --prefix studio/api run dev                         # API em :8787 (migra e semeia no boot)
npm --prefix studio/ui run dev                          # UI em :5173 (proxy /api -> :8787)
```

O primeiro boot cria o admin (`STUDIO_ADMIN_EMAIL`/`STUDIO_ADMIN_PASSWORD`), os provedores
(DeepSeek, Gemini e **Simulado**), os catálogos (38 especialidades, 10 skills, MCP) e os dois
fluxos seed, com "Goga — Atendimento padrão" publicado em produção.

**Sem chave de provedor** o Studio funciona com o provedor **Simulado**: um modelo offline e
determinístico, de custo zero, que existe para testes e demonstração. Para usar: duplique um
fluxo e troque o "Modelo padrão" nas configurações do fluxo (clique no canvas vazio). A resposta
dele não tem valor jurídico e diz isso.

## Rodar no k3d (junto com a KB)

```bash
cp .env.example .env        # na raiz do repo: chaves DeepSeek/Gemini e senha do admin
./start-k8s-local.sh        # sobe a KB (auth desligada) e o namespace stack-studio
./start-k8s-local.sh populate   # popula a KB (exige as duas chaves)
```

Studio em `http://studio.localtest.me:8890`, KB em `http://localhost:8890`.

## Testes

```bash
npm --prefix studio/api test        # unitários (skills, compliance, JSON) + integração do motor
npm --prefix studio/ui run build    # typecheck + build
```

O teste de integração (`src/engine/engine.test.ts`) roda o fluxo seed inteiro contra o
Postgres de dev com o modelo Simulado e confere roteamento, encadeamento (15 → 23),
compliance, spans e registro de uso. Sem o Postgres de dev ele é pulado.

## Onde mexer

| | |
|---|---|
| `api/src/shared/graph.ts` | contrato do grafo (schemas zod + validação), importado também pela UI |
| `api/src/engine/executor.ts` | a semântica do fluxo (plano §4.2) |
| `api/src/engine/prompts.ts` | schemas de saída de cada tipo de nó e instruções de formato |
| `api/src/skills/` | as 10 skills determinísticas (prazo, correção, juizado, citação, compliance, documento) |
| `api/src/llm/` | chamada ao modelo com span + custo, JSON com reparo, modelo Simulado |
| `api/seed/*.json` | conteúdo derivado da pesquisa: especialidades, presets, regras globais, checklists, citações, modelos de documento |
| `ui/src/components/flow/` | canvas e inspector do editor |
| `ui/src/components/trace/` | trace (usado no Simulador e no Histórico) |

## Decisões que não estão óbvias no código

- **Modelos DeepSeek**: o plano citava `deepseek-chat`/`deepseek-reasoner`; a documentação
  atual da DeepSeek lista `deepseek-flash` (V4.1) e `deepseek-v4-pro`, e são esses os semeados.
  Preço de pico (o teto) em 2026-09-22.
- **JSON pelo prompt, não pelo modo estruturado do provedor**: o DeepSeek não aceita schema, e
  modo JSON com tools não combina em todos os provedores. `generateJson` valida com zod e faz
  uma rodada de reparo.
- **O disclaimer é anexado pelo motor**, não confiado ao modelo; o Compliance ainda confere.
- **Índices econômicos (IPCA, Selic, salário mínimo) vêm do BCB/SGS** e ficam em cache em
  disco; nada disso é digitado no código.
- **Busca da KB antes do modelo**: o especialista recebe as evidências já recuperadas (e a
  busca vira span `kb` no trace); o modelo ainda pode chamar `buscar_kb` para refinar.

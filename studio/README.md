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

Passo a passo completo, com a KB, e como parar e reiniciar: [README da raiz](../README.md#rodar-em-desenvolvimento).

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

## Agentes externos (Claude Code, Codex, Gemini CLI)

A skill `goga-studio` ([fonte](api/agent-skill/goga-studio/SKILL.md)) deixa esses agentes
operarem o Studio com **as mesmas ferramentas do Assistente** (`/api/v1/agent/*` reaproveita
`assistant/tools.ts`). Instalar em qualquer máquina com Node 18+:

```bash
curl -fsSL https://<studio>/skills/goga.mjs | node - instalar
```

O Studio serve o script com o próprio endereço embutido; `instalar` grava a skill em
`~/.claude/skills` (Claude Code) e `~/.agents/skills` (Codex e Gemini CLI) e faz o login: abre
`/agents/autorizar` no navegador, a pessoa entra com usuário e senha, confere o código e autoriza,
e o CLI recebe um token pessoal (fluxo tipo *device code*; o token nunca passa por URL). Tokens
se veem e revogam em **Agentes externos**. Atrás de um proxy TLS, defina `STUDIO_PUBLIC_URL`
(ex.: `https://goga.inine.com.br`) para os links saírem com `https`.

Dentro do repo a skill já é descoberta (`.agents/skills/` → Codex e Gemini, `.claude/skills/` →
Claude Code, ambos links para `api/agent-skill/`). Ações sensíveis (publicar, excluir, restaurar,
lote, escrita genérica) voltam 428 sem `confirm: true`, e a skill manda o agente pedir aprovação.

## Agente de conversa (na frente do fluxo)

Capacidades › Agente de conversa (tabela `chat_agent`, prompt no texto do motor `conversa.agente`;
src/engine/frontdesk.ts). No Simulador e no WhatsApp, toda mensagem passa por ele e ganha resposta
na hora. Ele decide `responder` (saudação, "e aí?", agradecimento) ou `fluxo`: sem turno rodando, inicia
o fluxo; com turno rodando, o fato novo é acrescentado ao turno (`addContext`, run.ts) e entra em toda
chamada a modelo seguinte (`withAddenda`, llm/call.ts; menos Guarda). Complemento que chegou depois da
última chamada que escreve a resposta vira o turno seguinte. Falha do agente ou agente desligado =
comportamento antigo (fluxo direto, um turno por vez). Modelo padrão: o DeepSeek "flash", sem thinking.

## WhatsApp (não oficial, Evolution API)

Tela **Administração › WhatsApp** (só administradores): cadastra um ou mais números, cada um
ligado a **um fluxo** (o de produção, que segue a publicação, ou um fluxo específico, que roda a
última versão publicada dele). Ao criar, o Studio cria a instância no Evolution, configura o webhook
autenticado e mostra o QR code; no celular: *Aparelhos conectados › Conectar um aparelho*.

O que a pessoa faz pelo WhatsApp: conversa com o fluxo, manda fotos e documentos (PDF, DOCX, imagem,
texto; o arquivo vira anexo do turno, como no Simulador) e recebe os documentos gerados. Pergunta de
esclarecimento com opções (`opcoes` do desfecho; o Classificador devolve `opcoes_esclarecimento`)
chega como lista numerada, e responder "2" vale a opção 2. Comandos (com `/`, `#` ou `!`):
`/nova` (conversa nova, a anterior fica guardada), `/limpar` (pede confirmação e apaga conversas,
execuções e arquivos do contato), `/cancelar` (interrompe a resposta em preparo) e `/ajuda`.

Nada se perde (src/whatsapp/worker.ts): o webhook só responde 200 depois de gravar a mensagem
(`whatsapp_inbound`; o Evolution reenvia por ~3 h o que não foi aceito); um turno por contato, com
as mensagens seguidas agrupadas; o turno interrompido por reinício do Studio roda de novo; a resposta
vai para `whatsapp_outbound` e é reenviada com espera crescente se o Evolution cair ou o número
desconectar (até 24 h). Sessão travada (Evolution diz `open`, envio diz *Connection Closed*): o número
fica *desconectado* com motivo 428 e o Studio reinicia o Evolution (no máximo a cada 15 min), que volta
sem QR porque a sessão fica só em armazenamento durável (Postgres + volume; sem Redis). Desenho e
lições vêm do In9 CRM (`services/evolution-api` e `channels/adapters/whatsapp_evolution`).
Infra: `charts/goga/templates/evolution.yaml`. Variáveis: `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`,
`EVOLUTION_WEBHOOK_BASE_URL`, `EVOLUTION_RESTART_TARGET`, `WHATSAPP_WORKER`.

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

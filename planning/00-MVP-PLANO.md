# Goga Legal — Plano do MVP (KB + Studio)

> **Objetivo único do MVP:** simular perguntas e respostas jurídicas com um fluxo de agentes configurável no Studio, com base de conhecimento populada e rastreabilidade de ponta a ponta. O MVP é uma ferramenta **interna** (curadoria, produto, jurídico). Não tem usuário final.

---

## 1. Escopo

### 1.1 Entra no MVP

| Módulo | O que entrega |
|---|---|
| **KB** (`knowledge-base/`, já existe) | Espaços (bases) populados com o repertório da pesquisa, embeddings Gemini, busca híbrida, consumida pelo Studio via API/MCP |
| **Studio — Fluxos** | Vários fluxos salvos, duplicar, **um único fluxo em produção**. Editor visual (React Flow): Entrada → Classificador → N Especialistas → Consolidador → Compliance → Saída |
| **Studio — Propriedades do agente** | Nome, modelo, especialidade, prompt, skills, MCP, bases de conhecimento, guardrails, regras de roteamento/escalonamento, limites |
| **Studio — Provedores & Modelos** | Cadastro de provedores (chave cifrada, endpoint) e modelos (preço entrada/saída/cache, contexto, finalidade) |
| **Studio — Simulador** | Chat multi-turno contra **qualquer** fluxo (não só o de produção), com anexos de entrada e documentos gerados na saída, trace completo |
| **Studio — Histórico** | Todas as execuções (simulações) com filtro e acesso ao trace |
| **Studio — Custos** | Custo por provedor, modelo, usuário, fluxo, agente e período |
| **Studio — Auditoria** | Quem mudou o quê (fluxos, publicação, provedores, chaves, catálogos), com diff antes/depois |
| **Autenticação** | Simples: usuários locais do Studio (e-mail + senha), sessão por cookie. Sem Keycloak/realm no MVP |

### 1.2 Fica fora do MVP (explicitamente)

App/chat do usuário final, voz/transcrição, áudio podcast, consulta por vídeo e rede de advogados (Ag. 11), KYC/assinatura (Ag. 49), monitor processual e integrações DataJud/pJe/DJEN (Ag. 33), protocolo real em consumidor.gov/Procon (Ag. 52 só **gera** a reclamação), memória longitudinal do cliente (Ag. 12), QC retroativo e autocrítica prognóstico×desfecho (13/35), tickets de atendimento humano, pagamentos, multi-tenant, app mobile. Família e penal seguem só como **detecção e encaminhamento**.

### 1.3 Premissas e decisões já tomadas

- **Modelo de chat auto-populado:** DeepSeek (`deepseek-chat` como padrão; `deepseek-reasoner` cadastrado como opção para consolidador/compliance).
- **Embeddings:** Gemini `gemini-embedding-001` (3072 dimensões) — encaixa sem migração na coluna `vector(3072)` da KB, que já suporta o dialeto `gemini` (`knowledge-base/services/kb-api/src/kb_api/providers.py`).
- **UI:** React + shadcn/ui. **Backend do Studio:** Node.
- **A KB continua como está (Python/FastAPI).** Ela já tem ingestão, busca, MCP, auth e UI prontos; reescrever em Node não compra nada para o MVP. O Studio a consome por HTTP.
- **Arquitetura enxuta:** um backend Node monolítico, execução do fluxo **em processo** (sem fila, sem Redis, sem worker), Postgres, streaming por SSE.

### 1.4 Pontos de atenção descobertos na análise

1. **O `agentic-sdlc` não usa shadcn** (usa um kit próprio em `services/ui/src/components/ui.tsx` + Tailwind v4 `@theme`) e usa `reactflow` v11, não `@xyflow/react`. Interpretação adotada: **copiar o padrão visual e de layout** (tokens `ink-*`, Inter/JetBrains Mono, lucide, sidebar de 240px, `SectionHeader`, cards, KPI, inspector à direita do canvas) **implementado com componentes shadcn** tematizados com esses tokens, e React Flow via `@xyflow/react` v12.
2. **A UI da KB (`kb-ui`) não é shadcn**, mas já segue o mesmo padrão visual do agentic-sdlc. Recomendação: no MVP o módulo KB **reutiliza a `kb-ui` existente** (link direto na sidebar do Studio) e o Studio consome a API da KB para listar bases e buscar. Migrar a `kb-ui` para shadcn fica para depois. *(Ver decisão D1 na seção 12.)*
3. **Sem Keycloak no MVP.** A KB já tem modo sem autenticação: com `KB_KEYCLOAK_ISSUER` vazio ela sobe em `auth-desligada` (todo chamador vê tudo). No MVP a KB roda assim, **só na rede local** (ngrok desligado). O Studio tem login próprio simples.
4. **Nenhum conteúdo foi ingerido na KB** (bloqueio: sem provedor de embedding). Os 67 conceitos OKF de `content/auditoria-citacoes/` e os 17 espaços de `content/spaces.yaml` estão prontos para ir.
5. **Os agentes 36–43 não existem na pesquisa** (a numeração salta de 35 para 44). O catálogo reflete isso.

---

## 2. Arquitetura

```
                   ┌────────────── cluster k3d "knowledge-base" (já existe) ───────────────┐
                   │  namespace stack-knowledge-base                                       │
 navegador ───────►│    kb-ui ── kb-api (Python, auth desligada) ── Postgres+pgvector,     │
    │              │                   ▲  /v1/search, /v1/spaces      MinIO, Memgraph      │
    │              │  namespace stack-studio                                               │
    └─ login ─────►│    studio-ui (nginx) ──/api──► studio-api (Node) ── Postgres "studio" │
       e-mail/senha│                                   │  volume de arquivos (anexos/docs) │
                   └───────────────────────────────────┼───────────────────────────────────┘
                                                       │ HTTPS
                                                 DeepSeek · Gemini
```

- **Um único cluster k3d**: o Studio entra como um namespace novo (`stack-studio`) no cluster que a KB já cria, com manifests próprios. Sem o Keycloak, não há motivo para um segundo cluster.
- **studio-api** chama a KB pela rede interna do cluster (sem token, já que a KB está com auth desligada) e filtra as bases pelo que está configurado no nó. Chama DeepSeek/Gemini direto (sem LiteLLM).
- Desenvolvimento diário: `npm run dev` no `studio-ui` (Vite) e no `studio-api` (tsx watch), apontando para o Postgres do Studio e a KB do cluster via port-forward.

### 2.1 Estrutura do repositório

```
goga-legal/
├── knowledge-base/            # existente (Python) — recebe ajustes de conteúdo e config
├── studio/
│   ├── api/                   # Node 22 + TypeScript
│   └── ui/                    # React + Vite + shadcn
├── infra/
│   └── k8s/local/studio/      # manifests do namespace stack-studio (aplicados no cluster da KB)
├── planning/                  # este plano e os seguintes
├── research/                  # pesquisa (fonte)
└── start-k8s-local.sh         # sobe o cluster da KB + o namespace do Studio
```

### 2.2 Stack do Studio

| Camada | Escolha | Por quê |
|---|---|---|
| API | **Fastify** + TypeScript, zod (validação e tipos compartilhados) | leve, schema-first, SSE simples |
| ORM / DB | **Drizzle** + Postgres 16 (migrations SQL versionadas) | SQL explícito, sem mágica |
| LLM | **Vercel AI SDK** (`ai`, `@ai-sdk/deepseek`, `@ai-sdk/google`, `@ai-sdk/openai-compatible`) | `generateObject` (classificador estruturado), tool calling, `usage` para custo, troca de provedor por config |
| MCP | `@modelcontextprotocol/sdk` (cliente Streamable HTTP) | conectar ao `/mcp` da KB e futuros servidores |
| Auth | `@fastify/cookie` + `@fastify/session` (sessão em Postgres), senha com `argon2` | o mais simples que é seguro; troca por OIDC depois sem mexer no resto |
| Documentos | `pdf-parse`, `mammoth` (entrada), `docx` (saída DOCX), Gemini multimodal para imagem/PDF escaneado | sem OCR próprio |
| Cripto | AES-256-GCM com `STUDIO_SECRET_KEY` para chaves de API | igual ao ADR-0009 da KB |
| UI | React 19, Vite, Tailwind v4, **shadcn/ui**, `@xyflow/react` v12, TanStack Query + Table, react-hook-form + zod, **shadcn Charts** (recharts), lucide | exigência + padrão agentic-sdlc |

---

## 3. Modelo de dados (Studio)

```
app_user        id, name, email, password_hash, role(admin|operador), active, created_at
provider        id, name, kind(deepseek|gemini|openai_compat), base_url, api_key_enc, active
model           id, provider_id, model_id, label, purpose(chat|embedding|vision),
                price_in_per_1m, price_out_per_1m, price_cache_per_1m, context_window,
                supports_tools, supports_json, active, is_default
specialty       id, number, name, area, cluster, scope, default_prompt, default_spaces[],
                default_skills[], routing_hints (palavras/exemplos), escalation_rules, phase
skill           id(slug), name, description, input_schema, kind(builtin)          -- lista fixa, seed
mcp_server      id(slug), name, url, auth_mode, tools_cache, enabled              -- lista fixa, seed
flow            id, name, description, graph(jsonb), revision, created_by, updated_at
flow_release    id, flow_id, revision, graph(jsonb) — snapshot imutável, published_by, published_at
production      singleton: flow_release_id                                         -- "o" fluxo de produção
run             id, flow_id, flow_revision, is_production, session_id, user_id, status,
                started_at, ended_at, cost_usd, tokens_in, tokens_out
session         id, title, user_id, flow_id, created_at                          -- conversa do simulador
message         id, session_id, role, content, attachments[], run_id
span            id, run_id, parent_id, node_id, kind(agent|llm|tool|mcp|kb|guardrail|route),
                name, input(jsonb), output(jsonb), status, error, started_at, ms,
                model_id, tokens_in, tokens_out, cost_usd
file            id, session_id, direction(in|out), name, mime, size, sha256, path, extracted_text
usage           id, run_id, span_id, user_id, flow_id, node_id, provider_id, model_id,
                tokens_in, tokens_out, tokens_cache, cost_usd, created_at          -- base do painel de custos
audit_log       id, actor_sub, action, entity, entity_id, before(jsonb), after(jsonb), at
```

**Fluxos e produção (o que você pediu):**
- Pode haver quantos fluxos quiser. **Duplicar** = copiar `graph` para um novo `flow` (auditado).
- Editar um fluxo nunca afeta produção. **Publicar** cria um `flow_release` imutável e aponta `production` para ele. Só existe **um** em produção (singleton); publicar outro substitui, com confirmação e registro em auditoria.
- A lista de fluxos mostra um badge **Produção** no fluxo cuja release está publicada, e alerta "alterações não publicadas" quando o rascunho divergir da release.
- O **Simulador** escolhe qualquer fluxo (rascunho atual) ou a release de produção. O `run` guarda a revisão exata usada, então o trace sempre corresponde ao grafo que rodou.

---

## 4. O fluxo de agentes

### 4.1 Tipos de nó

| Nó | Papel | Origem na pesquisa |
|---|---|---|
| **Entrada** | Recebe mensagem + anexos, extrai texto dos anexos, aplica **regras globais** do fluxo | Ag. 1, 3 (parcial) |
| **Classificador** | Saída estruturada: ranking de especialidades com score e justificativa, polo, urgência, foro, complexidade, flags `fora_de_escopo`, `conflito_interesse`, `precisa_esclarecimento` | Ag. 2, 4, 5 (detecção) |
| **Especialista** (N) | Parecer no formato padronizado, usando KB + skills + MCP | Ag. 14–31, 45–48, 50, 52–54 |
| **Consolidador** | Junta pareceres, resolve conflitos, produz resposta técnica e simples, controla narrativa, gera documentos pedidos | Ag. 6, 9, 10, 44 |
| **Compliance** (guarda) | Veto: disclaimer, sem promessa de resultado, citações verificadas, zona verde/amarela/vermelha, LGPD. Se reprovar, devolve ao consolidador (máx. N ciclos) | Ag. 8, 34 (simplificado) |
| **Saída** | Entrega resposta + documentos ao simulador | — |

Arestas: `Classificador → Especialista` (roteamento), `Especialista → Consolidador`, `Consolidador ↔ Compliance`. Um especialista pode ter arestas para outro especialista (consulta encadeada, ex.: 53 → 52; 54 → 29), executado depois do primeiro.

### 4.2 Semântica de execução (motor em Node, ~400 linhas)

1. **Entrada** normaliza a mensagem, extrai texto dos anexos e carrega o histórico da sessão.
2. **Classificador** roda com `generateObject` (schema zod). Então:
   - `fora_de_escopo` → vai para o especialista de encaminhamento (Ag. 5), que é um nó especialista comum.
   - `conflito_interesse` → resposta de bloqueio (Regra Absoluta nº 2).
   - `score máximo < limiar_esclarecimento` → devolve **pergunta de esclarecimento** ao usuário (uma lacuna por vez; regra-mãe) e encerra o turno.
   - senão → seleciona especialistas com `score ≥ limiar_roteamento`, até `max_especialistas`.
3. **Especialistas** rodam **em paralelo** (`Promise.allSettled`), cada um com timeout e limite de custo. Encadeamentos rodam em sequência depois.
4. **Consolidador** recebe os pareceres (JSON) e produz a resposta e, se pedido, chama a skill `gerar_documento`.
5. **Compliance** valida (checagens determinísticas + LLM). Reprovou → volta ao consolidador com os motivos (até `max_ciclos`). Continuou reprovando → resposta segura padrão + flag no trace.
6. Tudo emite **spans** por SSE para o simulador em tempo real.

### 4.3 Propriedades do agente (painel à direita do canvas)

Abas no inspector (padrão `AgentFlowEditor` do agentic-sdlc: canvas à esquerda, inspector em card à direita):

| Aba | Campos |
|---|---|
| **Geral** | Nome, tipo de nó, **Especialidade** (select do catálogo; ao escolher, pré-preenche prompt/KB/skills), descrição |
| **Modelo** | Modelo (select de `model` ativos de chat), temperatura, max tokens, timeout, custo máximo por chamada, fallback de modelo |
| **Prompt** | Prompt de sistema (editor com variáveis `{{mensagem}}`, `{{ficha}}`, `{{pareceres}}`, `{{regras_globais}}`), formato de saída (schema de parecer padrão ou livre), exemplos |
| **Conhecimento** | **Bases de conhecimento** (multi-select da lista vinda de `GET /v1/spaces` da KB), top_k, confiança mínima (`min_trust`), data de vigência (`as_of`), "citar só VERIFICADAS" |
| **Ferramentas** | **Skills** (multi-select da lista fixa), **MCP** (multi-select da lista fixa, com as ferramentas de cada servidor) |
| **Regras** | Guardrails do agente (lista de regras em texto + checagens determinísticas marcáveis), gatilhos de **escalonamento para humano** (ex.: vara comum, recurso, > 20 SM, saúde), zona permitida (verde/amarela) |
| **Roteamento** *(só classificador)* | Limiar de roteamento, limiar de esclarecimento, máx. especialistas, gatilhos de exclusão (família/penal), regra de polo réu → fast-path |
| **Ciclo** *(só compliance)* | Máx. ciclos de revisão, checagens obrigatórias, resposta segura padrão |

**Configurações do fluxo** (clicando no canvas vazio): nome, descrição, **regras globais** (Regras Absolutas 1 e 2, regra-mãe, neutralidade, sem promessa de resultado), **disclaimer final obrigatório** (texto da pesquisa), idioma e tom.

### 4.4 Skills (lista fixa, implementadas em Node)

| Skill | O que faz | Determinística? |
|---|---|---|
| `buscar_kb` | Busca híbrida na KB restrita às bases do nó | sim (retrieval) |
| `buscar_documento_kb` | Abre documento/trecho completo da KB | sim |
| `verificar_citacao` | Extrai citações (lei/artigo, súmula, tema, REsp…) do texto e confere na KB se existem e estão `VERIFICADA`; bloqueia `EM VERIFICAÇÃO` (auditoria_citacoes) | sim |
| `calcular_prazo` | Prescrição/decadência (CC 205/206, CDC 26/27, Dec. 20.910/32) a partir da data do fato | sim |
| `calcular_correcao` | Correção + juros (Lei 14.905/2024: IPCA + Selic−IPCA) com tabela de índices local | sim |
| `elegibilidade_juizado` | JEC (20/40 SM), JEF, Juizado da Fazenda (60 SM) pelo valor da causa e réu | sim |
| `ler_anexo` | Texto extraído de um anexo da sessão | sim |
| `checklist_documental` | Lista de documentos necessários por tipo de caso (catálogo em JSON) | sim |
| `gerar_documento` | Gera DOCX (e PDF) a partir de template + campos: reclamação extrajudicial, notificação, resumo do caso, parecer | sim |
| `checar_compliance` | Disclaimer presente, termos proibidos ("garantido", "com certeza vai ganhar"), percentuais de êxito, zona | sim |

Cálculo, prazo e citação **nunca** ficam com o LLM (Guardrail 6 da pesquisa).

### 4.5 MCP (lista fixa)

- `goga-kb`: o `/mcp` da KB (`search`, `fetch`, `list_spaces`). **Ativo.**
- `lexml` / `stj-jurisprudencia`: registrados como **desabilitados** (placeholder visível na UI) para mostrar o caminho. Ficam fora do MVP.

O cadastro de MCP é seed, não editável na UI do MVP (conforme pedido: "listas fixas").

---

## 5. Conteúdo seed

### 5.1 Catálogo de especialidades (tabela `specialty`)

Semeado a partir de `research/mapeamento_agentes_juridicos(1).md` + `habilidades_juridicas_agentes(1).md` + `Agentes_53_54_…md`. Cada item tem: número, nome, área, escopo, prompt padrão (derivado das seções de habilidades), bases padrão (de `knowledge-base/content/spaces.yaml`), skills padrão, gatilhos de escalonamento, fase.

| Grupo | Especialidades |
|---|---|
| Recepção/controle | 1 Recepcionista, 2 Intake, 4 Classificador, 5 Exclusão e Encaminhamento, 6 Orquestrador, 7 Prazos, 8 Compliance, 9 Redator do Resumo, 10 Orientação e Via, 34 Adversidade, 44 Controlador de Narrativa, 51 Processual Civil |
| Núcleo consumerista | 14 Consumidor Geral, 15 Bancário, 16 Telecom/Essenciais, 17 Aéreo, 18 Planos de Saúde, 19 E-commerce, 20 Imobiliário do Consumidor, 21 Veículos, 22 Educação, 23 Dano Moral (serviço) |
| Contratual | 45 Contratos Imobiliários, 46 Prestação de Serviços, 47 Confissão de Dívida/Acordos, 48 Contratos Cíveis e Digitais |
| Cível e conexas | 24 Civil Geral, 25 Locações e Condomínio, 26 Trabalhista, 27 Previdenciário, 28 Tributário do Cidadão, 29 Seguros, 30 Responsabilidade Civil (escopo reduzido), 31 LGPD/Digital, 50 Condominial, 52 Reclamação Extrajudicial, 53 Danos em Via Pública, 54 Colisão de Veículos |

Os agentes de controle (4, 6, 8, 9, 10, 44, 34) viram **presets** de Classificador/Consolidador/Compliance, não especialistas roteáveis.

### 5.2 Fluxo seed "Goga — Atendimento padrão" (publicado em produção)

`Entrada → Classificador → [26 especialistas de mérito + 5 Encaminhamento] → Consolidador → Compliance → Saída`, com encadeamentos 53→52, 54→29→52, 15→23, 14→23. Todos com `deepseek-chat`; Consolidador e Compliance com `deepseek-reasoner` opcional. Layout automático (ELK/dagre) na primeira abertura.

Um segundo fluxo seed **"Goga — Fase 1 (zona verde)"**: só 14, 15, 16, 17, 19, 23, 52 em modo orientação, conforme o roadmap da pesquisa (MAP §6). Serve para comparar fluxos no simulador.

### 5.3 Provedores e modelos (seed)

- **DeepSeek:** `deepseek-chat` (padrão chat), `deepseek-reasoner`. Chave de `DEEPSEEK_API_KEY` no primeiro boot.
- **Google Gemini:** `gemini-embedding-001` (embedding, 3072) e `gemini-2.5-flash` (visão, para extrair texto de anexos escaneados/imagens). Chave de `GEMINI_API_KEY`.
- Preços preenchidos no seed a partir das páginas oficiais **na data da implementação**, editáveis na UI.

### 5.4 População da KB

1. **Provedores na KB:** registrar Gemini (embedding) e DeepSeek (chat, dialeto `openai` com endpoint `https://api.deepseek.com`, usado pela KB para derivar conceitos OKF e wiki) via `POST /v1/ai/providers` (script, não manual).
2. **Espaços:** aplicar `content/spaces.yaml` (17 espaços) com `scripts/apply-spaces.py`. **Adicionar** os que faltam para especialidades sem base própria: `telecom-essenciais` (16), `transito-veiculos` (21, 54), `educacao` (22), `extrajudicial` (52: canais, modelos de reclamação), `encaminhamento` (5: Defensoria, OAB, MP, Procon, delegacias).
3. **Conceitos auditados:** ingerir os 67 OKF de `content/auditoria-citacoes/` (`scripts/ingest.sh`).
4. **Legislação primária (novo script `scripts/fetch-legislacao.py`):** baixa do Planalto, converte para Markdown com frontmatter (`vigencia`, `fonte`, `verified: true`), um arquivo por diploma, e ingere no espaço certo. Lista mínima, tirada da seção 6 do resumo da pesquisa:
   - Transversal: CF (arts. selecionados), CDC, CC/2002, CPC/2015, Lei 9.099/95, Lei 10.259/01, Lei 12.153/09, Lei 8.906/94, LGPD, Marco Civil, Lei 14.905/24.
   - Por área: Lei 14.181/21 (bancário), Lei 9.472/97 + Decreto 6.523/08 (telecom), Res. ANAC 400/16 (aéreo), Lei 9.656/98 + Lei 14.454/22 (saúde), Decreto 7.962/13 (e-commerce), Lei 4.591/64 + Lei 13.786/18 (imobiliário), CTB (trânsito), Lei 8.245/91 (locação), CLT (trabalhista), Lei 8.213/91 + Lei 8.742/93 (previdenciário), CTN (tributário), Dec. 20.910/32 (fazenda), Lei 14.063/20.
5. **Súmulas e temas:** só os que estão como `VERIFICADA` na auditoria entram com `verified: true`; os 9 "em verificação" entram com `verified: false` e `armadilha`, para a skill `verificar_citacao` bloqueá-los.
6. **Modelos de documento** (espaço `estilo-peca` e `extrajudicial`): reclamação por canal (consumidor.gov, Procon, ouvidoria, Anatel/ANS/Bacen/ANAC/ANEEL), notificação extrajudicial, notificação ao causador (54), requerimento ao ente público (53), checklists 53/54. São também os templates da skill `gerar_documento`.
7. **Corrigir resíduos** apontados na auditoria (Tema 898, JEF art. 3º, art. 37 da Lei 8.245, etc.) antes de ingerir qualquer texto derivado da pesquisa.

> Jurisprudência em massa (inteiro teor) fica fora do MVP. Entram súmulas, temas e precedentes-âncora citados na pesquisa.

---

## 6. Autenticação (simples)

- **Studio:** tabela `app_user` (e-mail + senha com `argon2`), login em `/login`, sessão em cookie `httpOnly`/`SameSite=Lax` guardada no Postgres. Sem cadastro público.
- **Dois papéis:** `admin` (edita fluxos, provedores, catálogos, publica em produção, gerencia usuários) e `operador` (simulador, histórico, custos). Auditoria e custos usam o `user_id` da sessão.
- **Seed:** um admin criado no primeiro boot a partir de `STUDIO_ADMIN_EMAIL` / `STUDIO_ADMIN_PASSWORD`. Tela mínima de usuários em Administração (criar, desativar, trocar senha).
- **KB:** roda com `KB_KEYCLOAK_ISSUER` vazio (modo `auth-desligada`, já suportado). Aceitável porque é local e interna; **não expor** (ngrok desligado). A `kb-ui` abre sem login.
- **Caminho futuro:** quando entrar o Keycloak, o Studio troca o plugin de sessão por OIDC e a KB volta a validar tokens — nenhuma outra parte muda.

---

## 7. UI do Studio

Shell copiado do `agentic-sdlc` (`services/ui/src/Layout.tsx`): sidebar fixa 240px, grupos de navegação, rodapé com saúde da API e usuário, conteúdo em `max-w` centralizado (exceto editor e simulador, que usam largura total). Tema escuro com os tokens `ink-*` aplicados às variáveis CSS do shadcn.

```
Goga
├─ Studio
│  ├─ Fluxos            lista (badge Produção, rascunho divergente) · novo · duplicar · excluir
│  │   └─ Editor        canvas React Flow + inspector · salvar · publicar · simular
│  ├─ Simulador         escolher fluxo/release · chat · anexos · docs gerados · trace ao vivo
│  ├─ Histórico         execuções (filtro: fluxo, usuário, status, período, produção/rascunho)
│  ├─ Custos            KPIs + gráficos + tabela por provedor/modelo/usuário/fluxo/agente
│  └─ Auditoria         log de mudanças com diff
├─ Conhecimento
│  └─ Bases (KB) ↗      abre a kb-ui
└─ Administração
   ├─ Provedores e modelos
   ├─ Usuários
   └─ Catálogos         especialidades · skills · MCP (só leitura, exceto especialidades)
```

### 7.1 Simulador (tela principal do MVP)

Layout em três colunas redimensionáveis (shadcn `Resizable`):
- **Esquerda:** sessões anteriores + seletor de fluxo (qualquer rascunho ou a produção).
- **Centro:** chat. Upload por arrastar (PDF, DOCX, imagens, TXT); as mensagens do assistente mostram resposta simples e técnica em abas, citações com badge VERIFICADA, e **documentos gerados** como cartões de download.
- **Direita:** **Trace** do turno selecionado:
  - **Mini-canvas** do fluxo com o caminho percorrido destacado (nós executados coloridos por status, arestas usadas animadas).
  - **Árvore de spans** (Entrada → Classificador → Especialistas em paralelo → Consolidador ↔ Compliance): para cada span, prompt renderizado, resposta bruta, JSON estruturado, trechos da KB recuperados (com score, base, página), chamadas de skill/MCP com entrada e saída, guardrails aprovados/reprovados, tokens, custo, latência.
  - KPIs do turno: custo total, tokens, tempo, nº de agentes.
- Ações de diagnóstico: **"Reexecutar com outro fluxo"** (mesma pergunta e anexos, compara lado a lado) e **"Abrir nó no editor"** a partir de um span.

### 7.2 Custos

KPIs (custo no período, nº de execuções, custo médio por execução, tokens) + gráfico de área por dia (empilhado por provedor) + barras por modelo + tabela agrupável por **provedor, modelo, usuário, fluxo, agente/especialidade**, com filtros de período. Inclui o custo de **embedding** lido de `GET /v1/ai/usage` da KB, com badge de origem (padrão `costSource` do agentic-sdlc).

### 7.3 Provedores e modelos

Mesmo padrão de tela da KB (Administração › Modelos de IA) e de `pages/Providers/List.tsx` do agentic-sdlc: cartões por provedor, chave mascarada (nunca retorna em claro), botão **Testar**, modelos com preço/contexto/finalidade, modelo padrão por finalidade.

### 7.4 Histórico e Auditoria

- **Histórico** = execuções (o *que foi perguntado*); clique abre o trace completo (a mesma visão do simulador, só leitura).
- **Auditoria** = mudanças de configuração (o *que foi alterado*): criar/editar/duplicar/excluir/publicar fluxo, provedor, chave (só "alterada"), modelo, preço, especialidade. Diff JSON lado a lado.

---

## 8. API do Studio (resumo)

```
POST            /api/v1/auth/login · POST /api/v1/auth/logout · GET /api/v1/auth/me
GET/POST/PUT    /api/v1/users[/:id]           (admin)
GET/POST        /api/v1/flows                 · GET/PUT/DELETE /api/v1/flows/:id (PUT com expectedRevision)
POST            /api/v1/flows/:id/duplicate   · POST /api/v1/flows/:id/publish
GET             /api/v1/production
GET/POST/PUT    /api/v1/providers[/:id]       · POST /api/v1/providers/:id/test
GET/POST/PUT    /api/v1/models[/:id]
GET             /api/v1/catalog/{specialties,skills,mcp}   · PUT /api/v1/catalog/specialties/:id
GET             /api/v1/kb/spaces             (proxy de GET /v1/spaces da KB)
POST            /api/v1/sessions              · GET /api/v1/sessions[/:id]
POST            /api/v1/sessions/:id/files    (upload) · GET /api/v1/files/:id (download)
POST            /api/v1/sessions/:id/messages → { runId }
GET             /api/v1/runs/:id/stream       (SSE: span.start, span.end, token, done)
GET             /api/v1/runs[?filters]        · GET /api/v1/runs/:id (trace completo)
GET             /api/v1/costs?groupBy=&from=&to=
GET             /api/v1/audit?entity=&actor=&from=&to=
```

Validação do grafo no salvar/publicar (erros por nó, padrão `{errors:[{code,nodeId,message}]}` do agentic-sdlc): exatamente 1 Entrada, 1 Classificador, 1 Consolidador, 1 Saída; todo especialista alcançável; sem ciclos (exceto Consolidador↔Compliance); modelo ativo; bases existentes na KB.

---

## 9. Fases de entrega

Estimativa para 1 dev full-time com apoio de IA. Cada fase termina com algo demonstrável.

| Fase | Entrega | Critério de pronto | Est. |
|---|---|---|---|
| **F0 Fundação** | Monorepo, namespace `stack-studio` no cluster da KB com Postgres, `studio/api` e `studio/ui` esqueleto, shell shadcn com tema agentic-sdlc, login simples + usuários, KB em modo sem auth | Logar no Studio e listar as bases da KB pela API | 2 d |
| **F1 KB populada** | Provedores Gemini/DeepSeek na KB por script, 17 + 5 espaços, 67 OKF, legislação primária, modelos de documento, service token do Studio | `POST /v1/search` retorna trechos com página para perguntas das 5 bases de `content/evaluation/` | 4 d |
| **F2 Provedores e custos-base** | CRUD provedor/modelo, cifra de chaves, teste de conexão, camada `llm.ts` (AI SDK) que registra `usage` com custo, auditoria genérica (hook em todas as mutações) | Teste de conexão DeepSeek ok; toda chamada grava `usage`; toda mutação grava `audit_log` | 3 d |
| **F3 Fluxos e editor** | Catálogos seed, CRUD de fluxos, duplicar, publicar/produção, editor React Flow com os 6 tipos de nó, inspector com todas as abas, validação, layout automático, fluxos seed | Montar, salvar, duplicar e publicar um fluxo; seed aparece com 30+ nós legíveis | 6 d |
| **F4 Motor + skills** | Executor do grafo, classificador estruturado, especialistas paralelos, consolidador, ciclo de compliance, 10 skills, cliente MCP `goga-kb`, spans | Pergunta de teste percorre o fluxo seed e gera spans coerentes (via teste de integração) | 6 d |
| **F5 Simulador** | Sessões, chat multi-turno, upload e extração de anexos, documentos gerados (DOCX/PDF), SSE, painel de trace com caminho destacado, reexecutar com outro fluxo | Anexar um contrato, perguntar, receber parecer + reclamação DOCX, inspecionar cada passo | 5 d |
| **F6 Histórico, Custos, Auditoria** | Três telas com filtros, gráficos e drill-down | Custos batem com a soma dos spans; auditoria mostra diff da publicação | 3 d |
| **F7 Avaliação e ajuste** | Rodar as 250 perguntas de `content/evaluation/` em lote contra um fluxo, ajustar prompts/limiares, README e roteiro de demo | Relatório de lote com taxa de roteamento correto, custo médio e reprovações de compliance | 3 d |

**Total:** ~32 dias úteis (~6–7 semanas). Caminho crítico: F0 → F3 → F4 → F5. F1 roda em paralelo a F2/F3.

---

## 10. Propostas adicionais (baratas, alto valor)

1. **Execução em lote no simulador** (F7): roda um conjunto de perguntas (os YAML de `content/evaluation/`) contra um ou dois fluxos e compara roteamento, custo e aprovações de compliance. É o que transforma o simulador em ferramenta de diagnóstico de verdade.
2. **Reexecutar com outro fluxo** lado a lado (já na F5).
3. **Caminho destacado no canvas** a partir do trace (já na F5).
4. **Avaliação manual por resposta** (👍/👎 + comentário do curador no histórico), gravada no `run`, para priorizar ajustes.
5. **Rótulo de expectativa em perguntas de teste** (especialidade esperada) para medir acerto do classificador automaticamente no lote.

---

## 11. Riscos

| Risco | Mitigação |
|---|---|
| Classificador com 26+ especialidades erra roteamento | `routing_hints` e exemplos por especialidade no prompt; saída estruturada com justificativa; lote de avaliação com especialidade esperada |
| DeepSeek com tool calling/JSON instável | `generateObject` com retry e reparo de JSON; skills determinísticas executadas pelo motor quando possível, não pelo modelo |
| Ingestão síncrona da KB estoura timeout em diplomas grandes (CC, CPC) | Dividir por livro/título no script de legislação |
| Citações alucinadas | `verificar_citacao` determinística + compliance bloqueando; só `VERIFICADA` no repertório |
| Latência (N especialistas + ciclos) | Paralelismo, `max_especialistas` (padrão 3), timeout por nó, streaming do progresso |
| Custo descontrolado em lote | Limite de custo por run e por nó; KPI de custo por execução visível |
| KB sem autenticação | Só rede local; ngrok desligado; Keycloak volta antes de qualquer exposição |

---

## 12. Decisões em aberto

| # | Decisão | Recomendação |
|---|---|---|
| D1 | Módulo KB no MVP: reusar `kb-ui` (padrão visual já igual, sem shadcn) ou reescrever telas da KB em shadcn dentro do Studio | **Reusar** a `kb-ui` agora (economiza ~2 semanas); migrar depois |
| D2 | Deploy local | **Resolvido:** um cluster só (o da KB) com namespace `stack-studio` |
| D3 | Especialistas no fluxo seed: todos os 26 ou só a Fase 1 da pesquisa | **Os dois fluxos seed** (completo em produção, Fase 1 como alternativa) |
| D4 | Armazenamento de anexos: volume local ou MinIO | **Volume local** no MVP |
| D5 | Especialidades editáveis na UI? | **Sim** (prompt/KB/skills padrão); skills e MCP ficam fixos |

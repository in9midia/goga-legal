# Contexto e Diretrizes para Agentes IA

## Contexto e referências

Antes de decidir sobre convenções, fluxos ou regras, verifique `docs/`. O que está documentado lá é normativo: prevalece sobre suposições e deve ser seguido. Se uma decisão alterar algo já documentado, atualize o documento correspondente.

Para orientação geral:
- `README.md` — visão de alto nível para humanos; aponta para `docs/` quando precisa detalhar algo.
- `docs/` — decisões arquiteturais, técnicas e procedimentos do projeto.

## Estratégia de IA agnóstica

Este projeto adota uma estratégia agnóstica de ferramenta para suportar múltiplas IAs sem duplicar instruções.

**Fontes de verdade editáveis:**

- `AGENTS.md` — regras operacionais comuns a qualquer agente.
- `.agents/skills/` — implementações padronizadas dos fluxos operacionais.

Arquivos de compatibilidade como `CLAUDE.md` e diretórios de ferramenta são apenas apontamentos para essas fontes de verdade. Nunca edite os apontamentos diretamente quando a intenção for mudar regras ou skills.

**Como cada ferramenta carrega as instruções e as skills:**

- **Claude Code** — carrega as regras por meio de `CLAUDE.md`, que inclui `@AGENTS.md` e não deve ser editado; skills via `.claude/skills`, que aponta para `.agents/skills`.
- **Cursor** — lê `AGENTS.md` como arquivo nativo de instruções; skills via `.cursor/skills`, que aponta para `.agents/skills`.
- **Codex CLI / outras ferramentas** — leem `AGENTS.md` diretamente; skills de `.agents/skills`.

## Skills do Projeto

Skills do projeto seguem convenções específicas de frontmatter, estrutura de arquivos e autoria. Sempre que criar ou editar uma skill, consulte `docs/skill-conventions.md` antes de finalizar.

## Idioma

Este projeto adota uma política de idioma híbrida:

- **Estrutura e código do projeto** (nomes de pastas, arquivos de código, configs, nomes de documentos técnicos, variáveis, comentários dentro de arquivos de código e comentários operacionais dentro de arquivos de configuração): **inglês**.
- **Conteúdo escrito para humanos** (nomes dos produtos, documentação narrativa, commits, mensagens ao usuário, comunicação no chat, exemplos explicativos e comentários em blocos de documentação): **português do Brasil (`pt-BR`)**.

A única exceção admissível são jargões tecnológicos globais enraizados que soem puramente artificiais em português, como `build`, `entrypoint`, `workflow`, `tag`, `push`, `pipeline` ou trechos de código exatos. Referências externas podem ser capturadas no idioma original; metadados, títulos criados pela IA e textos autorais do sistema continuam em `pt-BR`.

Em textos para humanos, evite abusar do travessão (em dash, "—") como recurso para intercalar comentários no meio da frase — esse é um tique típico de texto gerado por IA. Nessa situação, prefira vírgulas ou parênteses, como um redator em pt-BR normalmente faria. Isso não é uma proibição: travessão continua correto em diálogo, títulos e usos pontuais de ênfase; o problema é o uso repetitivo e fora do corriqueiro. Em listas, marcadores e itens de Markdown, use hífen ("-").

## Monorepo

Este repositório é um monorepo — cada módulo (`apps/*`) é uma unidade autônoma. Antes de agir, identifique o módulo certo e trabalhe dentro dele; use a raiz só para o que é genuinamente transversal. Convenções completas de estrutura, documentação por módulo e escopo de trabalho estão em `docs/monorepo.md` — é normativo, consulte antes de decidir onde algo deve morar.

## Testes

A IA escreve, mantém e executa todos os testes. Ao implementar ou alterar funcionalidades, criar ou atualizar os scripts correspondentes. Ao verificar funcionalidades ou conduzir UAT, executar os scripts e reportar os resultados. Ver `docs/testing.md`.

**Toda verificação de funcionalidade é E2E** — scripts em `e2e/` contra o sistema em execução. Testes unitários não são UAT.

## Commits

- Mensagens sempre em **pt-BR**.
- Formato **Conventional Commits**: `tipo: assunto conciso` (assunto até ~72 caracteres).
- Tipos válidos: `feat`, `fix`, `docs`, `refactor`, `chore`.
- A mensagem inteira deve usar **presente do indicativo na terceira pessoa do singular**, descrevendo o que o commit faz: `adiciona`, `corrige`, `atualiza`, `remove`, `refatora`, `documenta`.
- Não use imperativo na mensagem: evite `adicione`, `corrija`, `atualize`, `remova`, `refatore`, `documente`.
- Corpo obrigatório, com um parágrafo curto resumindo o objetivo da mudança e uma lista de bullets descrevendo as mudanças realizadas.
- Antes de executar `git push`, apresente a proposta e aguarde aprovação explícita do operador.
- Use arquivos explícitos no `git add`; não use staging amplo como `git add .`.
- Se houver arquivos não relacionados à tarefa fora do staging, pergunte ao operador o que fazer. Nunca mencione arquivos pendentes na mensagem de commit.
- **NUNCA** adicione trailers de autoria ou atribuição de IA (ex.: `Co-Authored-By`, como o Claude Code costuma inserir por padrão), independentemente da ferramenta usada.
- `git push` pode ser bloqueado pelo sandbox da ferramenta em uso. Se isso ocorrer, execute o push fora do sandbox - não delegue ao operador por falha de rede.

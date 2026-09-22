# Contexto e diretrizes para agentes de IA

Este é o repositório da **base de conhecimento do Goga Legal**. Guarda os
documentos como eles são, extrai deles um texto limpo que a busca indexa, e
devolve o trecho e a página de onde a resposta saiu, para uma pessoa na interface
web ou para o agente de IA de um editor, pelo MCP.

## Antes de decidir, leia

O que está documentado é **normativo**: prevalece sobre suposição e deve ser
seguido. Se uma decisão sua alterar algo já documentado, atualize o documento no
mesmo trabalho.

| Onde | O que responde |
|---|---|
| [`docs/adr/`](docs/adr/) | **por que** o sistema é assim. Leia o ADR antes de mudar a área dele |
| [`docs/arquitetura.md`](docs/arquitetura.md) | como as peças se ligam, e 23 armadilhas que já custaram caro |
| [`docs/glossario.md`](docs/glossario.md) | o vocabulário do domínio. Espaço, canônico, pai/filho |
| [`docs/operacao.md`](docs/operacao.md) | as telas e o comportamento de cada uma |
| [`docs/desenvolvimento.md`](docs/desenvolvimento.md) | como rodar, testar e onde mexer |
| [`docs/testes.md`](docs/testes.md) | o que é testado, o que não é, e por quê |
| [`docs/ia.md`](docs/ia.md) | onde agentes erram neste código, e a ordem de leitura que funciona |
| [`docs/proposal/`](docs/proposal/) | a especificação original (requisitos e system design) |

Os requisitos têm código (`ING-03`, `BUS-01`, `FUN-08`) e aparecem citados no
código e nos ADRs. Estão em
[`docs/proposal/docs/system-design/requirements.md`](docs/proposal/docs/system-design/requirements.md).

## Estratégia de IA agnóstica

Este projeto suporta múltiplos agentes sem duplicar instrução.

**Fontes de verdade editáveis:**

- `AGENTS.md`, este arquivo, com as regras operacionais comuns a qualquer agente;
- `.agents/skills/`, com os fluxos operacionais padronizados.

Arquivos de compatibilidade como `CLAUDE.md` e diretórios de ferramenta são
apenas apontamentos para essas fontes. **Nunca edite os apontamentos** quando a
intenção for mudar regra ou skill.

Como cada ferramenta carrega:

- **Claude Code** lê `CLAUDE.md`, que inclui `@AGENTS.md`; skills por
  `.claude/skills`, que aponta para `.agents/skills`;
- **Cursor** lê `AGENTS.md` nativamente; skills por `.cursor/skills`;
- **Codex CLI e outras** leem `AGENTS.md` direto.

Skills seguem convenções próprias de frontmatter, estrutura e autocontenção.
Consulte [`docs/proposal/docs/skill-conventions.md`](docs/proposal/docs/skill-conventions.md)
antes de criar ou editar uma.

## Idioma

Política híbrida:

- **estrutura e código** (nomes de pasta e arquivo, identificadores, configs):
  **inglês**;
- **conteúdo escrito para humanos** (documentação, commits, mensagens de erro
  visíveis, comunicação no chat): **português do Brasil**.

Exceção: jargão tecnológico enraizado que soa artificial traduzido (`build`,
`pipeline`, `push`, `tag`, `entrypoint`, `workflow`).

Comentários dentro do código Python deste projeto estão **sem acento**, por
consistência com o que já existe. Não é uma regra de estilo pela estética: o
arquivo inteiro é ASCII e misturar aumenta o diff sem ganho.

Em texto para humanos, evite abusar do travessão como recurso para intercalar
comentário no meio da frase. Isso é tique de texto gerado por IA. Prefira vírgula
ou parênteses. Em listas e marcadores use hífen.

## Como escrever comentário neste projeto

Esta é a convenção mais visível do repositório, e a que mais importa preservar.
Comentário aqui **não descreve o que o código faz**. Ele registra:

- por que a escolha óbvia foi recusada;
- o que aconteceu quando se tentou o contrário;
- o modo de falha que o código está evitando, e como ele se manifesta.

Bom:

```python
# `escape_html=True` (o padrao do docling) gravava "GH &amp; VOCE" dentro do
# canonico, e o texto ia assim para o indice.
```

Ruim:

```python
# Desliga o escape de HTML.
```

Quando um número aparece no código (um teto de memória, um timeout, um tamanho de
lote), o comentário diz **de onde veio**. `memory: 8Gi` sem explicação é um número
mágico; com "OOMKilled com 4Gi durante OCR de PDF de 121 páginas" é uma decisão.

## Testes

O que existe hoje, sem enfeite:

- **testes unitários** em `services/kb-api/tests/` e `services/kb-ui/src/**/*.test.ts`,
  cobrindo o que é lógica pura: migrações, backend de storage em disco, cifra de
  credencial, dialetos de provedor, geração de configuração de MCP;
- **verificação de ponta a ponta é manual**, contra a stack de pé. Extração, busca
  e permissão dependem de Postgres, object store e Identity, e um teste unitário
  honesto delas não existe.

Ao mudar comportamento, atualize ou crie o teste correspondente. Ao verificar,
rode o que existe **e diga o que ficou sem cobertura**. Não relate como verde o
que não foi exercitado. Detalhes em [`docs/testes.md`](docs/testes.md).

Os dois gates de qualidade:

```bash
cd services/kb-api && uv run -- python -m scripts.check && uv run -- python -m scripts.test
cd services/kb-ui  && npm run quality
```

## Commits

- mensagens em **pt-BR**, formato **Conventional Commits**: `tipo: assunto`
  (assunto até ~72 caracteres);
- tipos válidos: `feat`, `fix`, `docs`, `refactor`, `chore`;
- **presente do indicativo, terceira pessoa**, descrevendo o que o commit faz:
  `adiciona`, `corrige`, `atualiza`, `remove`, `refatora`, `documenta`. Não use
  imperativo (`adicione`, `corrija`);
- corpo obrigatório: um parágrafo curto com o objetivo e uma lista de bullets com
  as mudanças;
- `git add` com arquivos explícitos. Não use `git add .`;
- se houver arquivo não relacionado à tarefa fora do staging, pergunte ao operador
  o que fazer. Nunca mencione arquivo pendente na mensagem;
- antes de `git push`, apresente a proposta e aguarde aprovação explícita.

## Segurança, com o que já foi decidido

Três regras que vieram de erro real neste projeto:

1. **credencial não entra na conversa nem em prompt.** A tentativa de "cole este
   prompt e o agente se configura" punha token no histórico, e foi revertida
   (ADR-0007);
2. **a permissão é do servidor.** Nenhum parâmetro de requisição amplia escopo. Ao
   criar rota nova que leia conteúdo, o escopo vem do `Principal`, nunca do
   payload (ADR-0005);
3. **credencial de provedor de IA fica cifrada**, e a API devolve apenas os quatro
   últimos caracteres. Nunca faça uma rota devolver o valor (ADR-0009).

Ao escrever segredo em arquivo versionado, pare e pergunte. No GitOps da
organização anterior havia credencial em texto puro por convenção daquela casa;
aquilo saiu junto com o resto da infra dela (ADR-0022) e não é padrão a repetir.

## Onde mexer

```
services/kb-api/     FastAPI: REST de gestão + servidor MCP + pipeline de ingestão
  src/kb_api/
    main.py          rotas (é grande; procure pelo path da rota)
    ingest.py        do bruto ao índice
    extract.py       docling, fallbacks e OCR
    representations.py  as representações e os métodos de acesso
    retrieval.py     um recuperador por método de acesso
    wiki.py          destilação em páginas OKF (representação wiki)
    chunking.py      os quatro motores de corte
    okf.py           o formato de entrada OKF, ortogonal ao motor
    llm.py           chat que devolve JSON; só deriva conceito, não responde
    catalog.py       lista os modelos que uma conta de IA expõe
    search.py        os dois braços e a fusão
    providers.py     provedores de IA e contador de uso
    oauth.py         o Authorization Server do MCP
    auth.py          resolução de identidade e escopo
    migrate.py       runner de migração
    migrations/      uma por mudança de esquema
services/kb-ui/      React + Vite + Tailwind, servida por nginx que também faz proxy
scripts/e2e.py       ponta a ponta contra a stack, com login real no Identity
infra/k8s/local/     k3d, no formato do agentic-sdlc
scripts/             carga em massa, reconstrução do grafo, e os dois
                     aplicadores de `content/` (Espaços e avaliação)
content/             o repertório do Goga como arquivo versionado: os 17 + 5
                     Espaços com grants, o seed da auditoria de citações em
                     OKF, a legislação, os modelos de documento e os
                     conjuntos de avaliação. Ver content/README.md
```

`content/` é **configuração e conteúdo, não código**, e é a única pasta cujo
diff um advogado precisa conseguir ler. A permissão de leitura de repertório
mora ali de propósito: criada na tela, ela não tem revisão nem histórico, e a
pergunta "qual agente alcança qual Espaço" só se responderia consultando o banco
de produção.

Não há CI nem GitOps neste serviço. O pipeline e o overlay que existiam eram
da organização anterior e saíram no WP-39; o que havia está registrado em
[ADR-0022](docs/adr/0022-marca-goga-e-saida-da-infra-da-outra-organizacao.md),
para quem for montar o CI do Goga não recomeçar do zero.

## Quatro coisas que quebram sem avisar

Registradas porque cada uma custou uma investigação:

1. **o `iss` do token tem de ser o mesmo string dos dois lados.** O navegador e
   os pods precisam alcançar o Keycloak pelo **mesmo** nome
   (`kc.localtest.me`, nunca `localhost`), e esse nome precisa resolver dentro
   do cluster. Quando não resolve, o login começa, o token é emitido e a
   validação falha sem erro de configuração nenhum — a interface só diz
   "sessão expirada". Ver [ADR-0023](docs/adr/0023-repontamento-para-o-keycloak-do-goga.md);
2. **dimensão de vetor.** `chunk_embedding.embedding` é `vector(3072)` fixo no
   DDL. Misturar dimensões no mesmo índice degrada a busca **sem erro nenhum**. A
   API recusa a troca de propósito;
3. **`unaccent` na busca lexical.** Sem ele o braço lexical devolve zero em quase
   toda pergunta, e a busca fica só vetorial sem nada falhar;
4. **o prefixo do ingress.** `rewrite-target`, `<base href>` e `API_BASE_URL`
   precisam concordar. O `sub_filter` só funciona com
   `proxy_set_header Accept-Encoding ""`, e sem isso a substituição falha em
   silêncio.

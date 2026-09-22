# Glossário

O vocabulário deste domínio. Vale para pessoas e para agentes de IA: metade dos
mal-entendidos neste projeto veio de usar uma palavra com o sentido de outro
sistema.

## Domínio

**Espaço** — a unidade de conteúdo e a **fronteira de permissão**. "Base RH" é um
Espaço, com slug `rh`. Quem alcança um Espaço não necessariamente alcança outro,
e essa fronteira é aplicada no servidor em toda leitura. Na interface aparece
como "base". Em código é sempre `space`.

**Documento canônico** — o Markdown limpo extraído do arquivo original. **É ele
que a busca indexa.** Não é cache: é conteúdo de primeira classe, visível na
tela, e tudo no pipeline deriva dele. Coluna `document.canonical_md`.

**Bruto** — o arquivo original, exatamente como entrou, guardado no object store
e nunca reescrito. É o que permite auditar o canônico contra a fonte e
reprocessar sem pedir o arquivo de novo.

**Pai e filho** — os dois níveis de corte. A busca casa no **filho** (pequeno,
vetor preciso) e entrega o **pai** (grande, com contexto). Mesma tabela `chunk`,
com `parent_id` nulo marcando o pai.

**Motor de corte** — a estratégia que fatia o canônico. Quatro (`markdown`,
`sentence`, `semantic`, `fixed`), escolhidos **por Espaço**. Em código,
`space.chunking.engine`.

**Representação** — estrutura derivada do canônico, construída na ingestão.
Duas na v1: o **índice** (chunks + vetores + BM25), presente em todo Espaço, e a
**wiki** (páginas OKF destiladas), ligável. É um **conjunto** por Espaço, não um
enum: as duas convivem. Em código, `space.representations`.

**Estrutura auxiliar** — dado a mais **dentro** de uma representação, que abre
outro caminho até o **mesmo** conteúdo sem criar conteúdo novo. O grafo de
entidades é isto: os nós apontam para chunks pais que já existem.

**Método de acesso** — motor de consulta sobre uma representação, em tempo de
busca: semântica e textual no índice, busca de páginas na wiki, travessia no
grafo. A busca agrupa os Espaços pelo método que oferecem e funde tudo por RRF.

**Enriquecimento de chunk** — slot **dentro** do índice: o que é prependado a
cada trecho antes do embedding. `nenhum` ou `conceito` (a identidade do conceito
do documento). Em código, `space.chunking.enrichment`. Confundir com
representação é a armadilha 23 de [`arquitetura.md`](arquitetura.md).

**Destilação** — a LLM lê os canônicos e **reescreve** conhecimento em páginas
atômicas. É o oposto da canonicalização, que preserva. Produz a wiki.

**Unidade de matching / unidade de entrega** — o par que o padrão "casar no
pequeno, entregar o inteiro" define. No índice: filho casa, pai entrega. Na wiki:
seção casa, página entrega.

**OKF** (*Open Knowledge Format*) — especificação aberta do Google Cloud para
empacotar conhecimento: um diretório de Markdown, um **conceito** por arquivo,
com frontmatter YAML no topo e links Markdown entre eles. `type` é o único campo
sempre obrigatório. Ver [ADR-0015](adr/0015-okf-como-formato-de-entrada.md).

**Conceito** — no vocabulário do OKF, o que diz *de que* um documento fala: tipo,
título, descrição, tags. Aqui ele fica em `document.okf`. Não confundir com
**trecho**: um conceito é cortado em vários.

**Conceito escrito / derivado** — as duas procedências. **Escrito** veio no
frontmatter do arquivo, redigido por alguém. **Derivado** foi gerado pelo modelo
na ingestão, para um documento que não traz frontmatter — o caso de quase tudo
numa base corporativa. O derivado carrega `generated: {by, at}` e nunca aparece
como revisado. Escrito ganha do derivado.

**Propósito** (de provedor de IA) — para que a base usa aquele modelo:
`embedding` (vetoriza o texto para a busca) ou `chat` (gera texto; hoje só para
derivar conceito na ingestão). Cada propósito tem o seu provedor "em uso".

**Padrão da instalação** — o provedor marcado como "em uso" para um propósito,
válido para toda base que não escolheu o seu. É o que `NULL` significa em
`space.embedding_provider_id` e `space.chat_provider_id`: a escolha de não
escolher, e não ausência de modelo.

**Nível de confiança** — `unverified`, `machine-confirmed` ou `human-reviewed`.
É **derivado** do campo `verified` do conceito, na escala da especificação, nunca
declarado: um conceito que escreva `trust: human-reviewed` continua aparecendo
como não verificado.

**Figura** — imagem extraída de um documento, guardada no object store, com o
texto que o OCR leu dentro dela. Tabela `document_figure`.

**Trecho** — o que a busca devolve: texto, documento, **página do original** e os
scores. Sinônimo de chunk no texto para humanos.

**Evidência** — o contrato da busca. O serviço devolve trechos, nunca resposta
gerada. Quem redige é o modelo de quem perguntou.

## Busca

**Braço vetorial** — similaridade por embedding, distância cosseno via pgvector.
Perde sigla e código de documento.

**Braço lexical** — busca de texto do Postgres (`tsvector` com `unaccent`).
Perde sinônimo e paráfrase.

**RRF** (Reciprocal Rank Fusion) — como os dois braços são fundidos. Usa apenas a
**posição** de cada resultado em cada lista, nunca o score absoluto, porque as
escalas dos dois não são comparáveis.

**Pool de candidatos** — quantos resultados cada braço traz antes da fusão (40 por
padrão). Não é o mesmo que `top_k`, que é quantos saem no fim.

**Recorte** — o que o chamador pede para a busca **não** trazer: `min_trust` e
`as_of`. Não é o mesmo que escopo. Escopo é permissão, resolvida no servidor a
partir do token; recorte é escolha de quem chama, e só restringe. Vira cláusula
dentro da consulta, nunca filtro sobre a lista devolvida (ADR-0024, ADR-0025).

**Nível de confiança** (`trust`) — `unverified`, `machine-confirmed` ou
`human-reviewed`, **derivado** do `verified` do conceito, nunca declarado.
Documento sem conceito OKF é `unverified`: não ter sido conferido não é o mesmo
que ter sido conferido.

**Vigência** — `de` e `ate` do conceito, em `AAAA-MM-DD`. Ausência significa
**sempre válido**, nunca o contrário — quase nenhum documento declara vigência, e
a inversão esvaziaria a busca sem nada falhar.

**Armadilha** — marca de conteúdo cujo sentido óbvio na leitura rápida é o
inverso do que ele diz. O aviso viaja **dentro da passagem**, porque a leitura
errada acontece na primeira leitura (ADR-0027).

## Identidade e permissão

**Principal** — quem está chamando, resolvido do token. Carrega grupos, roles,
e-mail e se é irrestrito (administrador).

**Grant** — o vínculo entre um Espaço e um princípio (grupo, role, object id do
EntraID, e-mail, ou `public`). Tabela `space_grant`.

**Grupo e role** — namespaces **separados** no realm corporativo. Um grant para o
grupo `/goga/curadoria` não é satisfeito por uma role de mesmo nome. Juntá-los
já foi um bug aqui.

**Token de serviço** — identidade de máquina, para carga em massa e verificação de
fora do cluster. Carrega escopo de administração e **não tem pessoa**, então não
serve para o MCP: a auditoria registraria "service-token" no lugar de quem
perguntou.

**Conector** — um editor conectado ao MCP por OAuth, com access e refresh emitidos
por este serviço. A pessoa vê os conectores dela e revoga um a um.

## Infraestrutura

**kb-api** — o serviço FastAPI. Duas superfícies na mesma aplicação: o REST de
gestão e o servidor MCP.

**kb-ui** — a interface React. O nginx dela serve a SPA **e** faz proxy de `/v1`,
`/oauth`, `/mcp` e `/.well-known`, então é a única entrada da stack.

**Espelho local** — o k3d, no mesmo formato do OKE. Não é `docker compose` de
propósito: parte do comportamento só existe em cluster.

**Harness** — neste workspace, o **editor de IA** (Claude Desktop, Claude Code,
Cursor, opencode, Codex). Cuidado ao ler código antigo: a palavra já foi usada
para o ambiente de teste também.

## Palavras que confundem

| Palavra | Aqui significa | Não confunda com |
|---|---|---|
| base | Espaço, na linguagem da interface | a base de dados |
| candidata | as ferramentas de mercado comparadas (Onyx, RAGFlow, Dify) | os candidatos da busca, que são trechos |
| candidato | trecho que entrou no pool antes da fusão | as ferramentas comparadas |
| provedor | provedor de modelo de IA (Azure, OpenAI, Foundry, LiteLLM) | provedor de nuvem |
| motor | motor de corte de texto | motor de busca |

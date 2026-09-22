# ADR-0022 — A marca é Goga Legal, e a infra da organização anterior sai do repositório

- **Status:** Aceito
- **Data:** 2026-09-21
- **Relacionado:** [0007](0007-kb-api-como-authorization-server-do-mcp.md),
  [0014](0014-ambiente-local-espelha-o-cluster.md)

## Contexto

Este serviço nasceu como base de conhecimento corporativa de outra organização e
foi reaproveitado como a base de repertório do **Goga Legal**. O nome antigo
aparecia em 38 arquivos e 96 ocorrências, e elas **não eram todas a mesma
coisa**.

Uma substituição em massa produziria `identity.dev.hub.goga.com.br` — um host
que não existe — e um CI estendendo templates de pipeline de uma organização à
qual não pertencemos mais. O resultado pareceria pronto e estaria quebrado, com
o modo de falha mais caro que existe: o login para de funcionar sem erro de
configuração nenhum, e o build falha na última linha do log.

## Decisão

As ocorrências foram classificadas em cinco naturezas, e cada uma recebeu um
tratamento diferente.

| # | Natureza | Tratamento |
|---|---|---|
| 1 | marca em prosa e UI | **renomeada** para Goga Legal |
| 2 | identidade funcional (issuer, realm, client, nomes de role) | **intocada**, e marcada como pendência do WP-37 |
| 3 | hostname de produto | **removido do código**; onde era configuração já era variável de ambiente, onde era comentário virou genérico |
| 4 | infra da organização anterior (CI, GitOps, registry) | **removida**, não renomeada |
| 5 | ativos e exemplos | **substituídos** pela marca Goga e por domínios de exemplo |

### O que foi renomeado (natureza 1)

`README.md`, `AGENTS.md`, `docs/`, `docs/proposal/`, o `SERVER_INFO` e as
descrições das tools do MCP (`mcp.py`), a `description` do `pyproject.toml`, o
`<title>` do `index.html`, `Home.tsx`, `Connect.tsx` e `mcpConfig.ts`.

O `title` e a `description` do MCP são o que a lista de conectores mostra ao
lado do ícone: são superfície de marca, não identificador. O `name` do servidor
continua `knowledge-base`, porque **aquele** é identificador e trocá-lo
quebraria a configuração já instalada nos editores.

### O que NÃO foi tocado (natureza 2) — é do WP-37

Issuer, realm, client público e os nomes de role do Identity continuam com o
nome antigo, de propósito:

| Onde | O quê |
|---|---|
| `.env.example` | `KB_KEYCLOAK_URL`, `KB_KEYCLOAK_REALM`, `KB_KEYCLOAK_CLIENT_ID` |
| `infra/identity/configure-client.sh` | `KC_URL`, `KC_REALM`, `KC_CLIENT` |
| `infra/k8s/local/20-deploy.sh` | os mesmos três defaults |
| `infra/k8s/local/kustomization.yaml`, `kb-ui.yaml` | o issuer, em comentário |
| `start-k8s-local.sh` | o issuer e o client, no texto de ajuda e no eco final |
| `services/kb-api/src/kb_api/config.py` | default de `oidc_client_id` |
| `services/kb-ui/vite.config.ts` | o client, em comentário |
| `scripts/e2e.py` | o client, em comentário |
| `docs/arquitetura.md`, `docs/operacao.md`, `docs/decisao-token-mcp.md`, ADR-0007 | os mesmos valores, documentados |
| `tests/test_oauth_estado.py`, `tests/test_oauth_endereco_do_identity.py` | o realm, em fixture de issuer |

Trocar o nome do realm sem trocar o issuer junto quebra o login, e o Keycloak do
Goga ainda não existe. Enquanto ele não existir, **nem a KB autentica** — não é
uma pendência cosmética. Os pontos operativos carregam um comentário marcando a
pendência, e a busca pelo nome antigo continuava achando todos, que é o que o
WP-37 precisava para repontar sem esquecer nenhum. **Essa pendência foi
fechada** em [ADR-0023](0023-repontamento-para-o-keycloak-do-goga.md): o
issuer, o realm, o client e o grupo de administração são os do Goga, e a busca
pelo nome antigo devolve zero.

A fixture de teste manteve o nome antigo pelo mesmo motivo: se ela fosse
renomeada, a busca deixaria de achá-la e a asserção passaria a descrever um
realm que não é o configurado.

### O que foi removido (natureza 4), e o que existia

Esta seção existe para quem for montar o CI do Goga **não recomeçar do zero**.
Nada disto sobe conosco, e nada disto é recuperável do histórico de outro
repositório.

**`services/kb-api/azure-pipelines.yml`** e **`services/kb-ui/azure-pipelines.yml`**.
Dois arquivos de Azure DevOps que não continham build nenhum: cada um estendia
um template de um repositório `tpl-pipelines` da outra organização
(`microservices-build-multicloud-pipeline-python.yml` e
`frontend-build-multicloud-pipeline.yml`), passando só o `serviceDir`. Sem
acesso àquele repositório os arquivos não rodam nem localmente — um CI que
aponta para template inacessível é pior que CI nenhum, porque parece existir.

O que aqueles arquivos documentavam, e que continua sendo verdade sobre este
serviço:

- **o registry não cria repositório no primeiro push.** A tenancy tinha
  `isRepositoryCreatedOnFirstPush` desligado, e o push falhava na última linha
  do log, depois de dezenas de "Retrying in N seconds". O repositório da imagem
  precisava existir antes. Vale conferir a mesma configuração no registry que o
  Goga adotar;
- **o `uv sync --extra dev` estoura o disco do agente.** O `torch` chega
  transitivo pelo `docling` na variante CUDA: 15 pacotes `nvidia-*`, alguns GB,
  que a imagem nem usa — o `Dockerfile` instala torch CPU-only de propósito. A
  primeira execução avisou "Free disk space on / is lower than 5%".
  **Tentado e não resolve:** `[tool.uv.sources]` com o índice CPU do PyTorch;
  naquela versão do `uv` a diretiva vale só para dependência direta. Os
  caminhos que sobram são agente self-hosted com disco maior, ou declarar
  `torch` como dependência direta — o que exige cuidado, porque o `pip install .`
  do `Dockerfile` passaria a poder reinstalar a variante CUDA por cima do par
  CPU;
- **o release derivava o alvo do GitOps pelo PREFIXO do nome do serviço.** Um
  script `release-pipeline.sh` daquela organização procurava
  `overlays/<env>/stack-*/apps/ms*.yaml` para `ms-`, `ui*.yaml` para `ui-`, e
  assim por diante. Era a razão de os artefatos se chamarem `ms-knowledge-base`
  e `ui-knowledge-base` enquanto os diretórios se chamam `kb-api` e `kb-ui`.
  Essa amarra **não existe mais**: o CI do Goga pode nomear o artefato como
  preferir;
- **o extra `dev` do `pyproject.toml` é contrato de CI.** Sem `uv sync --extra dev`
  o sync passa e o `python -m scripts.check` quebra por falta do `ruff`. Ficou
  anotado no próprio `pyproject.toml`;
- **o `.npmrc` do `kb-ui` era exigência do template** (`npmAuthenticate` apontava
  para ele em dois stages e falhava se o arquivo não existisse). O arquivo ficou
  porque hoje só declara o registry público, mas nada depende mais dele.

**O overlay de GitOps de dev** (um repositório de Argo CD da organização
anterior, chart `helm-basic-app`) nunca morou aqui: era citado no `AGENTS.md`, no
`docs/desenvolvimento.md` e no ADR-0014. As citações saíram. O que ele fazia e
que precisa existir de novo: reescrever o `<base href>` por `sub_filter` no
ingress, casar `rewrite-target` e `API_BASE_URL` com o prefixo
`/knowledge-base`, e sustentar `proxy-read-timeout: 1800` — a ingestão é
síncrona e o teto dela é o timeout da borda (armadilha 28 de
`docs/arquitetura.md`).

**O campo `imageRepository` do `package.json` do `kb-ui`** saiu junto: ele
apontava para o namespace de registry da outra organização e só era lido pelo
template de frontend removido.

### Ativos e exemplos (natureza 5)

O PNG do logotipo anterior saiu. Entraram, a partir de `brand/`:

| Arquivo | Origem | Uso |
|---|---|---|
| `kb-ui/public/images/goga.svg` | `brand/goga.svg` | cabeçalho e barra lateral |
| `kb-ui/public/images/goga-icon.svg` | `brand/goga-icon.svg` | área apertada |
| `kb-ui/public/images/goga-logo.png` | rasterizado de `brand/goga.svg` | textura da cena 3D |
| `kb-ui/public/favicon.ico` | rasterizado de `brand/goga-icon.svg` | favicon da interface |
| `kb-api/src/kb_api/assets/icon.png` | rasterizado de `brand/goga-icon.svg` | ícone do servidor MCP |
| `kb-api/src/kb_api/assets/favicon.ico` | rasterizado de `brand/goga-icon.svg` | favicon do `/mcp` |

Três decisões pequenas que custariam uma investigação se ficassem implícitas:

1. **os SVG são referenciados por `<img>`, não inlinados.** Os dois saíram do
   Illustrator com `id="Layer_1"` e classes `st0…stN`, e dois SVG inline na
   mesma página colidem nesses nomes — o segundo herda o preenchimento do
   primeiro. Os `id` foram renomeados (`goga-logotipo`, `goga-icone`) e as
   classes receberam prefixo por arquivo (`gl*`, `gi*`), mas a referência por
   `<img>` é o que torna a colisão impossível;
2. **a cena 3D usa PNG, e não o SVG.** O `TextureLoader` do three.js carrega por
   `HTMLImageElement`, e um SVG sem `width`/`height` intrínsecos (os nossos só
   têm `viewBox`) chega com dimensão zero em parte dos navegadores: a textura
   sai em branco, sem erro. O plano também mudou de aspecto, de 3,64 para 2,73,
   que é o do `viewBox` novo;
3. **o logotipo vai sobre uma placa clara.** Ele é de duas cores — escudo
   verde-escuro com o miolo quase branco — e não existe versão clara dele. A
   marca anterior era de uma cor só e era invertida por filtro CSS; o mesmo
   filtro aqui achata o escudo numa mancha branca sólida.

Também nesta natureza: os e-mails de exemplo nos testes viraram `exemplo.com`,
os hosts de exemplo viraram `exemplo.br`, e o provedor de IA citado em
`catalog.py` virou `openai-goga`.

### A paleta veio junto

Trocar o logotipo e deixar a cor anterior no CSS produz uma interface meio de
cada marca. Os valores foram extraídos dos próprios arquivos de marca e entraram
como **token de tema** no `@theme` do Tailwind (`src/styles.css`), não espalhados
em classe utilitária: `bg-ink-900` e `text-text-muted` continuam valendo em toda
a interface, e a marca muda num lugar só.

| Papel | Valor |
|---|---|
| Verde principal | `#124638` |
| Verdes secundários | `#1c493c`, `#1e5142`, `#154638` |
| Verde claro | `#54766c` |
| Neutro claro | `#d1e0db` |
| Quase brancos | `#f6f7f7` … `#fafbfb` |

Duas ressalvas registradas no próprio CSS:

- **as três superfícies mais escuras (`ink-800` a `ink-950`) não estão na
  marca.** Foram obtidas escurecendo o verde principal, porque a marca não traz
  cor de fundo e uma interface de leitura longa precisa de degraus abaixo dele;
- **cor de estado não virou cor de marca.** `emerald`, `amber`, `rose` e `blue`
  continuam nos tons semânticos do Tailwind. Um "ok" no verde da marca deixa de
  ser lido como estado.

## Consequências

- a busca pelo nome da organização anterior passou a devolver **só** identidade
  funcional, e cada ponto ficou marcado. Foi a lista de trabalho do WP-37, e o
  ADR-0023 a zerou;
- **não há CI.** O serviço é construído e publicado à mão até o CI do Goga
  existir. A alternativa era manter dois YAML que não rodam;
- **não há ambiente de dev publicado.** O `start-k8s-local.sh` continua
  subindo a stack em k3d, e ela continua sendo o ambiente que prova o desenho;
- a interface mudou de cor. O esquema continua escuro, mas em verde, e nenhuma
  tela precisou ser reescrita porque tudo já lia os tokens;
- os ativos de marca moram em `brand/`, fora deste serviço, e as cópias em
  `kb-ui/public/images/` e `kb-api/src/kb_api/assets/` são derivadas. Trocar a
  marca exige regerar as cópias — a tabela acima diz quais.

## Alternativas consideradas

**Substituição em massa do nome da organização anterior por `goga`.**
Descartada pelo motivo do
Contexto: produziria host inexistente e realm inexistente, e as duas falhas são
silenciosas.

**Renomear o CI em vez de removê-lo.** Descartada. Os arquivos não continham
build: estendiam template de um repositório ao qual não temos acesso. Renomear
entregaria um CI que falha na primeira execução, e a informação útil que eles
carregavam (o que está na seção acima) ficaria enterrada num YAML que ninguém
consegue rodar.

**Repontar o Identity neste mesmo trabalho.** Descartada por sequenciamento: o
Keycloak do Goga é WP-37, e sem ele o repontamento não tem para onde apontar.
Renomear agora e apontar depois deixaria o repositório num estado em que o nome
diz uma coisa e o servidor responde outra.

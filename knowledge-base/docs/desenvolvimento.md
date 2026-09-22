# Desenvolvimento

Como trabalhar neste repositório, com ou sem agente de IA. As regras que o agente
segue estão em [`../AGENTS.md`](../AGENTS.md); este documento é o operacional.

## O que roda onde

| Serviço | O quê | Porta local |
|---|---|---|
| `services/kb-api` | FastAPI: REST de gestão, servidor MCP, pipeline de ingestão | 8080 no pod |
| `services/kb-ui` | React + Vite, servida por nginx que também faz proxy de tudo | 8080 no pod, 8890 pelo ingress |

A interface é a **única entrada**. O nginx dela serve a SPA e encaminha `/v1`,
`/oauth`, `/mcp` e `/.well-known` para a API, então em desenvolvimento tudo passa
por `localhost:8890`.

## Primeira vez

```bash
cp .env.example .env          # preencha KB_SECRET_KEY: openssl rand -hex 32
./start-k8s-local.sh
```

O provedor de IA **não** vem do `.env`. Depois de subir, cadastre em
Administração > Modelos de IA e use o botão Testar. Sem provedor a busca
funciona, mas fica só lexical.

O primeiro build da imagem do kb-api leva minutos: ela carrega torch e os modelos
de layout do docling. As seguintes usam cache.

## Subir num ambiente novo, ou contra um banco zerado

O esquema inteiro sai das migrações: elas rodam no startup do kb-api, sob
advisory lock, e o pod só fica Ready quando o banco está garantido. **Não há
passo manual de SQL.** Verificado criando um banco vazio e comparando com o que
estava em uso: mesmas 20 tabelas, mesmos 57 índices, definições idênticas.

O que o ambiente precisa oferecer:

| requisito | por quê | se faltar |
|---|---|---|
| **pgvector ≥ 0.7** | o tipo `halfvec`, que é o que permite indexar 3072 dimensões (o `vector` para em 2000) | a migração 0008 é **acessória**: loga alto, é pulada, e o serviço sobe. A busca funciona, só volta a varrer |
| **pgvector ≥ 0.8** | `hnsw.iterative_scan`, para índice aproximado conviver com o filtro de Espaço | o ajuste é ignorado em silêncio (há `try` em volta), e a busca filtrada devolve menos resultados |
| `unaccent`, `pg_trgm` | busca lexical em português | a 0001 falha e o serviço **não sobe** — e é o comportamento certo |
| um provedor de IA cadastrado | vetorizar pergunta e documento | a busca fica só lexical |

A imagem do Postgres local está **fixada** em `pgvector/pgvector:0.8.6-pg16`. A
tag móvel `pg16` resolvia para o que estivesse publicado no dia, e desde a 0008 a
versão deixou de ser detalhe: dois clusters criados em semanas diferentes teriam
desempenho de busca diferente sem nada no repositório explicando a diferença.

### O Memgraph não tem migração, e isso é de propósito

Ele é **inteiramente derivado** do Postgres: não guarda nada que não possa ser
refeito do documento canônico. Num ambiente novo ele nasce certo com a primeira
ingestão. Num ambiente que **vinha de uma versão anterior**, duas correções só
valem para o que for ingerido depois delas, e alcançar o que já estava lá é uma
passada de `scripts/rebuild-graph.py`:

- **`Term.norm`** (nome sem acento): sem ele, focar `diario` não acha `diário`;
- **`:Chunk` repetido**, do MERGE de caminho antigo: o mesmo trecho virava um nó
  por entidade — medido, oito.

Nenhuma das duas falha visivelmente. O desenho fica errado e o foco fica cego a
acento, sem nada quebrar — por isso a passada não é opcional se o grafo estiver
ligado.

## Ciclo de desenvolvimento

```bash
./start-k8s-local.sh sync ui      # só o bundle da interface
./start-k8s-local.sh sync api     # só a API
./start-k8s-local.sh status       # o que está de pé, com CPU e memória
./start-k8s-local.sh logs api     # segue o log
```

Mexeu só na interface? `sync ui`. É o que evita esperar um build que não mudou.

Para a interface, o Vite também roda fora do cluster, com proxy para a API:

```bash
cd services/kb-ui && npm install && npm run dev   # localhost:3010
```

## Os gates

São os mesmos que o pipeline roda. Rode antes de entregar:

```bash
cd services/kb-api
uv run -- python -m scripts.check     # ruff
uv run -- python -m scripts.test      # pytest

cd services/kb-ui
npm run quality                        # prettier + tsc + vitest
```

O `ruff format` **não** está no gate, de propósito: a primeira passada reescreve
13 dos 21 arquivos, e esse diff engoliria qualquer entrega em que ele viesse de
carona. Para adotar, é uma entrega sozinha. O caminho está comentado em
`services/kb-api/scripts/check.py`.

## Quando o ambiente parece quebrado

Na ordem, porque cada uma destas já foi confundida com bug de aplicação:

1. **o cluster está de pé?** `k3d cluster list`. Ele é parado pelo sistema quando
   outro cluster k3d sobe, e o sintoma é a stack inteira sem responder;
2. **as migrações aplicaram?** `curl -s localhost:8890/v1/health | python3 -m json.tool`,
   campo `migrations`;
3. **há provedor de IA cadastrado?** Sem ele a busca responde, mas sem vetor;
4. **os "relacionados" estão vazios?** O grafo não sobreviveu a um stop do
   cluster. É esperado, ele é derivado. Rode `scripts/rebuild-graph.py`
   (a skill `subir-local` tem o comando pronto);
5. **a ingestão deu `RemoteDisconnected`?** Provavelmente é timeout no caminho, não
   falha do servidor. Um documento desta base levou 13,5 minutos, e cada
   componente do caminho (loadbalancer do k3d, ingress, cliente) já cortou uma
   vez por estar apertado.

## Onde as coisas moram

```
services/kb-api/src/kb_api/
  main.py        rotas. É grande: localize pelo path com grep, não leia inteiro
  ingest.py      orquestra do bruto ao índice
  extract.py     docling, fallbacks e OCR
  representations.py  representações (índice, wiki) e métodos de acesso
  retrieval.py   um recuperador por método; o registro que a busca consulta
  wiki.py        destilação em páginas OKF, multi-vetor por seção
  chunking.py    os quatro motores de corte
  okf.py         o modo de ingestão OKF: frontmatter, identidade e links
  llm.py         a única chamada de texto gerado: derivar conceito na ingestão
  providers.py   provedores de IA: padrão da instalação e escolha por Espaço
  catalog.py     lista os modelos/deployments de uma conta, para a tela escolher
  search.py      os dois braços e a fusão
  providers.py   provedores de IA, cifra e contador de uso
  oauth.py       o Authorization Server do MCP
  auth.py        resolução de identidade e escopo
  migrate.py     runner de migração
  migrations/    uma por mudança de esquema
services/kb-ui/src/
  pages/         uma por tela
  lib/api.ts     cliente HTTP; types.ts é escrito à mão a partir das rotas
  components/    Ui.tsx tem os primitivos compartilhados
infra/k8s/local/  k3d, no formato do agentic-sdlc
scripts/          carga em massa e reconstrução do grafo
```

Não há CI nem GitOps deste serviço. O pipeline e o overlay que existiam eram
da organização anterior e saíram no WP-39; o inventário do que havia está em
[ADR-0022](adr/0022-marca-goga-e-saida-da-infra-da-outra-organizacao.md).

## Convenção de comentário

É a convenção mais visível do repositório. Comentário aqui não descreve o que o
código faz, registra por que a alternativa óbvia foi recusada e qual falha o
código está evitando. Quando há número (teto de memória, timeout, tamanho de
lote), o comentário diz de onde ele veio.

Isso não é preciosismo. Metade das armadilhas listadas em
[`arquitetura.md`](arquitetura.md) foi descoberta duas vezes, e a segunda foi
porque o comentário não estava lá.

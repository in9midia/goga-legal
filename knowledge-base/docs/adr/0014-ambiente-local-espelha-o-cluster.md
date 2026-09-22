# ADR-0014 — k3d local no mesmo formato do OKE, e GitOps para dev

- **Status:** Aceito
- **Data:** 2026-09-10
- **Relacionado:** [0008](0008-bruto-imutavel-com-backend-configuravel.md),
  [0011](0011-migracoes-numeradas-aplicadas-no-boot.md),
  [0012](0012-grafo-como-representacao-auxiliar-derivada.md)

## Contexto

Parte do comportamento deste serviço só existe em Kubernetes: ingress único
servindo interface e API pela mesma porta, permissão resolvida por grupo do
Identity, MCP autenticado atrás de proxy, e timeouts que precisam caber numa
ingestão de 13,5 minutos.

Um ambiente local em `docker compose` não exercita nada disso. O que ele valida
não é o que quebra.

## Decisão

**Local em k3d, no mesmo formato do agentic-sdlc**, com um script idempotente
(`start-k8s-local.sh`) que cria cluster, registry e ingress, constrói e empurra
as imagens, aplica a stack e espera os rollouts.

**Dev em GitOps** (Argo CD, chart `helm-basic-app`), com o overlay num
repositório de GitOps próprio.

> **Nota (WP-39).** O overlay de GitOps e o pipeline citados aqui eram da
> organização anterior e saíram do repositório; o inventário está em
> [ADR-0022](0022-marca-goga-e-saida-da-infra-da-outra-organizacao.md). A
> decisão de espelhar o cluster no ambiente local continua valendo. O destino
> do deploy, não: ele será redecidido quando o CI do Goga existir.

A autenticação usa o **Identity corporativo** nos dois, e não um Keycloak local.
Isso muda o que o ambiente prova: com um realm de brinquedo, os grupos, os
usuários e o formato dos claims seriam os que nós mesmos escrevemos, e a
integração de verdade ficaria sem teste.

Em dev, **nada de datastore próprio**: o Postgres é a instância gerenciada
compartilhada, o Memgraph é o compartilhado da plataforma (ADR-0012) e o storage
do bruto é um PVC até haver credencial de object storage (ADR-0008).

Duas coisas foram puxadas para dentro do GitOps para não depender de outra
equipe:

- um **hook PreSync** cria o banco, o papel da aplicação e as extensões. Ele
  também é o **teste** da pergunta que travava a entrega: se o `pgvector` não
  estiver disponível, falha com a mensagem exata do que pedir, em 30 segundos, e
  o Argo para o sync antes de o serviço tentar subir;
- o bucket não precisa de ticket, porque a aplicação chama `ensure_bucket()` no
  boot e trata `409` como sucesso.

## Consequências

Ganhos:

- **o que se testa é o que se entrega.** Cada armadilha desta lista apareceu
  primeiro no local: `proxy_timeout` do loadbalancer matando ingestão longa, MIME
  de `.mjs` recusado pelo worker do pdf.js, `absolute_redirect` vazando porta,
  rota da SPA colidindo com o endpoint do MCP;
- **uma pergunta de infraestrutura virou um Job.** Em vez de abrir ticket e
  esperar, o log responde.

Custos:

- **k3d pesa.** Dois clusters não cabem na mesma máquina, e o do projeto foi
  parado pelo sistema mais de uma vez ao subir o outro;
- **dev divide banco.** Banco próprio (`knowledge_base`) na instância
  compartilhada, então uma carga daqui afeta o vizinho;
- **o prefixo `/knowledge-base` do ingress não é cosmético.** Três coisas precisam
  concordar (o `rewrite-target`, o `<base href>` reescrito por `sub_filter` e o
  `API_BASE_URL` com prefixo), e mudar o caminho exige mudar as três.

## Alternativas consideradas

**`docker compose` no local.** Mais leve e mais rápido. Descartada pelo motivo do
Contexto: não exercita ingress, permissão nem MCP autenticado.

**Keycloak local em dev.** Descartada. Tornaria o ambiente autossuficiente ao
preço de o teste de integração testar a nossa própria imaginação.

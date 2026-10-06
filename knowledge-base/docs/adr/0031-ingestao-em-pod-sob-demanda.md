# ADR-0031 — Ingestão em pod sob demanda, como opção à thread do kb-api

- **Status:** Aceito
- **Data:** 2026-09-28
- **Relacionado:** fila de ingestão (`fila.py`, migração 0020), requisito ING-03

## Contexto

A fila de ingestão roda numa thread do kb-api, **um arquivo por vez**. Isso não
é timidez: dois docling no mesmo processo carregam o modelo de layout duas
vezes e o pod morre por memória, o que já aconteceu. O custo é que uma carga de
centenas de PDFs anda na velocidade de um docling, mesmo com o cluster tendo nós
sobrando.

## Decisão

**`KB_INGEST_MODE` escolhe onde a fila processa.** `local` (padrão) é o que já
existia. `pod` faz o kb-api criar um **Job do Kubernetes por arquivo**, até
`KB_INGEST_POD_MAX` ao mesmo tempo. No chart: `kb.ingest.mode` e
`kb.ingest.maxParallel`.

- **A fila é a mesma.** O dispatcher (`fila_pod.py`, uma thread no kb-api) pega
  a linha com o mesmo `FOR UPDATE SKIP LOCKED` e cria o Job. O Job roda a mesma
  imagem com `python -m kb_api.fila_pod <run_id> <worker>` e passa pelo mesmo
  `fila.processar` da thread. Ele não devolve nada por rede: escreve no mesmo
  Postgres, object store e Memgraph, e fecha a linha.
- **`ingest_run.worker`** guarda o nome do Job (`kb-ingest-<id>-<tentativa>`).
  É o que deixa o restart do kb-api **não** mexer no que está num Job: a subida
  só trata como órfão o `running` sem worker. Um rollout do kb-api deixa de
  interromper ingestão.
- **O Job não se retenta** (`backoffLimit: 0`). OOMKilled, prazo estourado ou Job
  apagado são vistos pelo reconciliador, que devolve a linha para a fila até
  `MAX_TENTATIVAS` e depois fecha com o motivo do Kubernetes. A retentativa do
  próprio Job não passaria pelo contador, e o laço de OOM voltaria.
- **Sem o cliente `kubernetes`.** Quatro chamadas REST com o token montado da
  service account (`kube.py`). A Role dá só `jobs` (create/get/list/delete) e
  `pods` (get/list) no namespace; o Job roda sem token.
- **O limite é de quem dimensiona o cluster.** Cada pod é um docling inteiro;
  `maxParallel × requests.memory` precisa caber nos nós. Job que não agenda
  fica `Pending` até o prazo e gasta uma tentativa.

## O que fica de fora

- **Uma réplica.** O reconciliador trata como órfão o `running` cujo Job não
  aparece na listagem. Com duas réplicas do kb-api, uma veria o Job da outra
  antes de ele existir. Precisaria de eleição de líder.
- **A retentativa automática (`retry.py`) e o reprocessamento** continuam
  processando dentro do kb-api. Só o que passa pela fila vai para o pod.
- **O resultado completo do upload com `wait=true`** (representações, grafo)
  vem da memória da thread; em modo pod a resposta traz só a linha de
  `ingest_run`.
- **Trocar de `pod` para `local`** com Jobs no ar: a subida em modo local trata
  todo `running` como órfão e o retoma. O conteúdo repetido cai no "já estava
  indexado".

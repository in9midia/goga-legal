---
name: subir-local
description: Sobe o ambiente local em k3d e confere que ele está funcional de ponta a ponta. Use antes de verificar qualquer mudança de comportamento.
---

# Subir e verificar o ambiente local

O ambiente local é Kubernetes (k3d), e não `docker compose`, porque parte do
comportamento deste serviço só existe em cluster: ingress único, permissão por
grupo do Identity, MCP autenticado. O porquê está no
[ADR-0014](../../../docs/adr/0014-ambiente-local-espelha-o-cluster.md).

## Passos

1. **Confira o pré-requisito de configuração.** Sem `.env` na raiz, a stack sobe
   mas a busca fica só lexical:

   ```bash
   test -f .env || cp .env.example .env
   ```

   `KB_SECRET_KEY` precisa de valor (`openssl rand -hex 32`). O provedor de IA
   **não** vem daqui: é cadastrado na tela depois de subir.

2. **Suba.** É idempotente, pode rodar quantas vezes quiser:

   ```bash
   ./start-k8s-local.sh
   ```

   Se só mexeu na interface, use `./start-k8s-local.sh sync ui`. A imagem do
   kb-api leva minutos, porque carrega torch e os modelos do docling.

3. **Antes de investigar qualquer erro, confirme que o cluster está de pé.** Ele
   é parado pelo sistema quando outro cluster k3d sobe, e o sintoma parece falha
   da aplicação:

   ```bash
   k3d cluster list
   ./start-k8s-local.sh status
   ```

4. **Verifique a saúde e o estado do esquema:**

   ```bash
   curl -s localhost:8890/v1/health | python3 -m json.tool
   ```

   Olhe `postgres`, `object_store`, `graph` e `migrations`.

5. **Cadastre o provedor de IA** na interface, em Administração > Modelos de IA, e
   use o botão Testar. Sem provedor a busca funciona, mas só lexical.

6. **Se os "documentos relacionados" estiverem vazios**, o grafo não sobreviveu a
   um stop do cluster. É esperado, ele é derivado. Reconstrua:

   ```bash
   kubectl -n stack-knowledge-base cp scripts/rebuild-graph.py \
     "$(kubectl -n stack-knowledge-base get pod -l app=kb-api -o jsonpath='{.items[0].metadata.name}')":/tmp/r.py
   kubectl -n stack-knowledge-base exec deploy/kb-api -- python /tmp/r.py
   ```

7. **Para carga em massa** de uma pasta, em vez de subir arquivo por arquivo na
   tela:

   ```bash
   ./scripts/ingest.sh <slug> <pasta> --group /goga/responsavel-tecnico
   ```

## Ao reportar o resultado

Diga o que foi **exercitado de fato**. "A stack subiu" não é o mesmo que "a busca
devolveu trecho com página". Se não testou a busca, diga que não testou.

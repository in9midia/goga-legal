---
name: migracao
description: Cria e aplica uma migração de esquema do kb-api. Use quando a mudança pedir coluna, tabela, índice ou dado novo no Postgres.
---

# Migração de esquema

Recebe em `$ARGUMENTS` uma descrição curta do que a migração faz, em pt-BR. Se
vier vazio, pergunte antes de continuar.

O esquema deste projeto é versionado: cada mudança é um arquivo numerado,
aplicado uma vez por banco e registrado em `schema_migration`. O porquê está no
[ADR-0011](../../../docs/adr/0011-migracoes-numeradas-aplicadas-no-boot.md).

## Passos

1. **Nunca numere à mão.** Crie o arquivo pelo CLI, que escolhe o próximo número:

   ```bash
   cd services/kb-api && uv run -- python -m kb_api.migrate new "$ARGUMENTS"
   ```

2. **Não edite migração já aplicada.** Cada uma guarda checksum, e editar uma
   antiga é detectado. Se a mudança corrige algo de uma migração anterior, ela é
   uma migração **nova**.

3. **Escreva o SQL com o cabeçalho explicando a decisão**, não a mecânica. Diga o
   que a mudança permite, o que quebraria sem ela e o que ela custa. Siga o tom
   das migrações existentes em `services/kb-api/src/kb_api/migrations/`.

4. **Confira a idempotência do que der.** `CREATE TABLE IF NOT EXISTS`,
   `CREATE INDEX IF NOT EXISTS`. `CREATE DATABASE` e `ALTER TYPE` não têm forma
   idempotente, então guarde com um `SELECT` sobre o catálogo.

5. **Teste contra Postgres de verdade**, não só olhando o SQL. Um descartável com
   pgvector resolve:

   ```bash
   docker run -d --name kb-mig -e POSTGRES_PASSWORD=x -e POSTGRES_USER=kb \
     -e POSTGRES_DB=kb -p 55440:5432 pgvector/pgvector:pg16
   ```

   Aponte `POSTGRES_*` para ele, rode `python -m kb_api.migrate` e depois
   `python -m kb_api.migrate status`. **Rode duas vezes** para confirmar que a
   segunda é no-op. Remova o container no fim.

6. **Se a migração popula ou transforma dado**, diga no cabeçalho quanto tempo ela
   leva com a base cheia. Migração longa atrasa a readiness do pod, porque a API
   aplica as pendentes no boot, e nesse caso ela deve ir para init container.

7. Rode os gates: `uv run -- python -m scripts.check` e `scripts.test`.

## O que não fazer

- não acrescente `ALTER TABLE ... IF NOT EXISTS` na migração 0001. Ela está
  congelada, e o cabeçalho dela diz isso;
- não mude a dimensão de `chunk_embedding.embedding` sem tratar a reindexação. A
  coluna é `vector(N)` fixo, e o índice existente fica inválido.

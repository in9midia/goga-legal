# ADR-0011 — Uma migração por mudança, aplicada uma vez e registrada

- **Status:** Aceito
- **Data:** 2026-09-10
- **Relacionado:** [0002](0002-indice-unico-em-postgres-com-pgvector.md),
  [0014](0014-ambiente-local-espelha-o-cluster.md)

## Contexto

Até certo ponto o esquema era **um** arquivo (`schema.sql`) reaplicado inteiro a
cada subida do pod, com todo `CREATE` idempotente e uma cauda de
`ALTER TABLE ... IF NOT EXISTS`.

Funciona, e escala mal por três razões:

1. **mudança destrutiva não cabe.** Renomear coluna, mudar tipo ou popular dado
   novo não tem forma idempotente honesta;
2. **ninguém sabe em que estado um banco está.** Sem registro, "esta coluna já
   existe aqui?" só se responde olhando o banco;
3. **a cauda de ALTER só cresce**, e nunca é seguro remover linha nenhuma dela.

## Decisão

Cada mudança de esquema é um arquivo numerado em `migrations/`, aplicado **uma
vez** por banco e registrado em `schema_migration`.

- `NNNN_nome_em_snake_case.sql`, com o número criado pelo CLI
  (`python -m kb_api.migrate new "..."`). Numerar à mão é como duas branches
  acabam com a mesma versão;
- a **0001 é o antigo `schema.sql`, palavra por palavra**, e não reescrito. Como
  ele era inteiramente idempotente, reaplicá-lo numa base que já tinha o esquema
  é no-op, e isso faz todo ambiente já de pé entrar no controle de versão sozinho,
  sem passo de baseline;
- a API aplica as pendentes **no boot**. O CLI existe para migrar sem subir a API
  (init container, pipeline);
- cada migração guarda o **checksum**. Editar uma já aplicada é detectado, e com
  `KB_MIGRATIONS_STRICT` o pod recusa subir.

## Consequências

Ganhos:

- **o estado do banco é uma pergunta com resposta**, na tabela e no `/v1/health`;
- **mudança destrutiva passa a caber**;
- **a versão do esquema aparece por pod.** Durante um rollout as réplicas
  convivem, e sem isso "o comportamento muda a cada F5" não vira "metade dos pods
  está na imagem antiga".

Custos:

- **arquivo congelado.** A 0001 não pode ser editada, e isso precisa estar escrito
  onde alguém iria editar (está, no cabeçalho dela);
- **aplicar no boot é conveniente e tem limite.** Migração longa atrasa a
  readiness, e o `startupProbe` do overlay é o que segura. Migração pesada deve ir
  para init container;
- **duas réplicas subindo juntas correriam.** Há um lock com timeout
  (`KB_MIGRATIONS_LOCK_SECONDS`), e hoje o serviço roda com uma réplica de
  qualquer forma.

## Alternativas consideradas

**Alembic.** Descartada por peso: traz SQLAlchemy para um projeto que usa psycopg
direto, e a autogeração de migração a partir de modelo não se aplica, porque aqui
não há ORM.

**Manter o `schema.sql` idempotente.** É o ponto de partida, e os três problemas
do Contexto são o motivo de sair dele.

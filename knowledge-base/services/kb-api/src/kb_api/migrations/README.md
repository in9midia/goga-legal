# Migracoes de esquema

Cada arquivo `NNNN_nome.sql` deste diretorio e uma mudanca de esquema aplicada
**uma unica vez** por banco e registrada na tabela `schema_migration`. O runner
esta em [`../migrate.py`](../migrate.py).

## Criar uma migracao

```bash
python -m kb_api.migrate new "indice de figura por pagina"
# -> src/kb_api/migrations/0002_indice_de_figura_por_pagina.sql
```

O comando escolhe o proximo numero sozinho — numerar na mao e como duas
branches acabam com a mesma versao.

## Aplicar e conferir

```bash
python -m kb_api.migrate            # aplica as pendentes
python -m kb_api.migrate status     # o que ja rodou neste banco
```

Na pratica quase nunca e preciso rodar `up` na mao: a API aplica as pendentes no
startup. O CLI serve para migrar **sem** subir a API (init-container, pipeline de
deploy) e para responder "em que versao este banco esta?" sem abrir o psql.

O `/v1/health` tambem devolve o resumo, que e o caminho mais rapido durante um
rollout — enquanto as replicas convivem, e ele que separa "mudou o
comportamento" de "metade dos pods ainda esta na imagem antiga".

## Regras

**Migracao aplicada nao se edita.** O banco dos outros ja rodou o arquivo
antigo; mudar o conteudo depois nao muda nada onde ja rodou, e a diferenca so
aparece em ambiente novo — meses depois, longe da causa. Correcao entra como
migracao nova. O runner compara o sha256 e avisa; com
`KB_MIGRATIONS_STRICT=1` ele se recusa a subir.

**Prefira mudanca compativel com a versao anterior do codigo.** Durante o
rollout o pod novo (ja migrado) e o antigo atendem ao mesmo tempo. Remover ou
renomear coluna que o codigo antigo ainda le quebra o trafego que cai nele. O
caminho seguro e em duas entregas: primeiro adicionar e passar a escrever nos
dois lugares, depois — na entrega seguinte — remover o antigo.

**Cada migracao roda dentro de uma transacao.** DDL no Postgres e transacional,
entao falha no meio nao deixa meia tabela. Para o DDL que o Postgres recusa em
bloco de transacao (`CREATE INDEX CONCURRENTLY`, tipicamente para criar indice
de vetor sem travar a escrita), acrescente esta linha ao arquivo:

```sql
-- kb:no-transaction
```

Nesse modo, falha no meio deixa o banco parcialmente mudado **sem** registro no
ledger, e a proxima subida tenta tudo de novo — entao a migracao precisa ser
reexecutavel (`IF NOT EXISTS` em tudo).

**Backfill grande vale fatiar.** A migracao roda com o lock tomado e as outras
replicas esperando; um `UPDATE` de milhoes de linhas dentro dela vira uma janela
de indisponibilidade. Para esses casos, a migracao cria a coluna e o preenchimento
vai para um passo separado.

## Sobre o `vector(3072)`

O `KB_EMBEDDING_DIM` substitui o literal `vector(3072)` no SQL na hora de
aplicar, para nao existir um arquivo por dimensao de modelo. O checksum e
calculado sobre o arquivo **original**, entao trocar a dimensao nao vira falso
alarme de migracao editada.

## 0001

E o antigo `schema.sql` palavra por palavra, e esta congelado. Como ele e
inteiramente idempotente, reaplica-lo numa base que ja tinha o esquema e um
no-op — foi assim que os ambientes que ja estavam de pe entraram no controle de
versao sem passo de baseline.

# ADR-0008 — O arquivo original nunca é reescrito, e onde ele mora é configuração

- **Status:** Aceito
- **Data:** 2026-09-10
- **Relacionado:** [0001](0001-documento-canonico-como-fonte-de-verdade.md),
  [0014](0014-ambiente-local-espelha-o-cluster.md), requisitos ING-02 e FUN-12

## Contexto

O canônico (ADR-0001) é derivado. Se o original não for preservado, três coisas
ficam impossíveis: auditar o canônico contra a fonte, reprocessar com outra
técnica de extração, e mostrar o documento como ele é para quem quer conferir.

Havia um segundo problema, de infraestrutura. O destino natural em produção é o
OCI Object Storage, mas a credencial dele (uma Customer Secret Key de um usuário
de IAM) é pedido a outra equipe. Esperar por ela deixava o ambiente de
desenvolvimento inteiro parado.

## Decisão

**O bruto é imutável.** Ele entra no object store com a chave
`<espaço>/<sha256[:2]>/<sha256>/<nome>` e nunca é reescrito. Reingerir arquivo
idêntico (mesmo sha) é no-op, o que torna a carga em massa segura de repetir.

**Onde ele mora é configuração**, por `KB_STORAGE_BACKEND`:

| valor | grava em | quando |
|---|---|---|
| `s3` (padrão) | MinIO ou OCI Object Storage, por SigV4 assinado à mão | produção |
| `filesystem` | um diretório em disco, normalmente um PVC | dev, enquanto não houver credencial |

As cinco funções públicas (`put`, `get`, `delete`, `stats`, `ensure_bucket`) têm
contrato idêntico nos dois, então nenhuma linha de chamada muda.

O cliente S3 é escrito à mão (SigV4, ~60 linhas de stdlib) para não arrastar o
boto3 e as dependências dele para dentro da imagem.

## Consequências

Ganhos:

- **auditoria e reprocessamento sem reenvio.** É a razão de o bruto existir;
- **o ambiente de dev sobe sem esperar credencial de ninguém**, que era o
  bloqueio concreto;
- **a troca é de configuração.** Ir para o OCI é preencher duas chaves e mudar
  uma variável.

Custos:

- **dois caminhos de código.** O que roda em dev não é o que roda em produção, e
  o caminho S3 fica sem exercício até o dia da virada. Por isso `s3` é o
  **padrão do código**: quem quiser disco pede explicitamente;
- **trocar o backend não migra conteúdo.** A árvore em disco casa 1:1 com as
  chaves do S3, então a migração é um `mirror`, mas é um passo manual que
  precisa acontecer **antes** de virar a chave;
- **o `filesystem` amarra o serviço em uma réplica.** O PVC é RWO: com duas, ou a
  segunda fica pendente, ou cada pod vê um pedaço do acervo.

Uma proteção que vale registrar: a última parte da chave é o **nome do arquivo
enviado por quem faz upload**. O backend de disco resolve o caminho e recusa
qualquer coisa que escape da raiz, com teste dedicado. Sem isso, um nome com
`../` escreveria fora do volume.

## Alternativas consideradas

**MinIO num pod, em dev.** Manteria um caminho de código só, que é o argumento
mais forte a favor. Descartada por decisão explícita de reusar o que o cluster
já oferece em vez de subir datastore próprio.

**Guardar o bruto no Postgres.** Descartada: 180 MB de binário em `bytea` numa
base cujo conteúdo útil são 24 MB inverte o custo do backup.

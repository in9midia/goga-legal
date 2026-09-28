# ADR-0030 — AWS S3 ou OCI como alternativa ao MinIO, com migração que só copia

- **Status:** Aceito
- **Data:** 2026-09-28
- **Relacionado:** [0008](0008-bruto-imutavel-com-backend-configuravel.md), requisitos ING-02 e FUN-12

## Contexto

O ADR-0008 deixou o endereço do bruto como configuração e escreveu o cliente S3
à mão. Na prática ele só tinha sido exercitado contra o MinIO do cluster, que
aceita coisa que a AWS recusa:

- a região do escopo da assinatura. O MinIO ignora; a AWS responde 301 com a
  região certa num cabeçalho;
- o `PUT` do bucket na subida. No MinIO ele cria ou devolve 409; numa conta AWS
  a credencial da aplicação normalmente não tem `s3:CreateBucket` (e não deve
  ter), então a subida quebrava num bucket que existe e funciona;
- credencial temporária (STS) e criptografia pedida por objeto, que exigem
  cabeçalhos `x-amz-*` dentro da assinatura.

E trocar de backend não migrava nada: o ADR-0008 registrou isso como passo
manual, sem ferramenta.

## Decisão

**`S3_PROVIDER` escolhe entre `minio` (padrão), `aws` e `oci`.** Ele só muda
padrões; todo campo continua sobrescrevível:

| | `minio` | `aws` | `oci` |
|---|---|---|---|
| endpoint | `http://minio:9000` | `https://s3.<S3_REGION>.amazonaws.com` | `https://<S3_NAMESPACE>.compat.objectstorage.<S3_REGION>.oraclecloud.com` |
| endereçamento | path-style | virtual-hosted (path-style se o bucket tiver ponto) | path-style |
| cria o bucket na subida | sim | não: confere com `HEAD` e explica o que falta | não |
| credencial | `kbkey` de laboratório | `S3_*`, com `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN` de fallback | `S3_*` (Customer Secret Key) |

O `oci` entrou quando o acervo local foi migrado para o Object Storage da OCI.
Antes ele era "o MinIO com outro endpoint", o que trazia junto a credencial de
laboratório e a criação de bucket, as duas erradas numa conta real.

O cliente continua sem boto3. A assinatura foi conferida byte a byte contra a
do botocore (virtual-hosted, token de sessão, SSE-KMS, chave acentuada, query de
listagem).

**A migração é `python -m kb_api.migrar_storage`**, empacotada em
`infra/k8s/local/30-migrar-storage.sh` como Job no cluster. Origem é a loja que
o processo usa (`S3_*`); destino é `DEST_S3_*`, lido pela mesma função. Ela:

- pula o que já está no destino com o mesmo tamanho. Como a chave carrega o
  sha256 do conteúdo (ADR-0008), mesmo tamanho na mesma chave é o mesmo arquivo;
- confere o tamanho no destino depois de cada `PUT`;
- **nunca apaga**, nem na origem nem no destino. O `--verificar` compara as duas
  listagens e só relata o que sobra.

## Consequências

- **virar para a AWS ou a OCI é preencher o `.env` e rodar dois scripts**, na ordem
  descrita em `docs/operacao.md`;
- **a migração pode rodar com o sistema no ar e repetir quantas vezes for
  preciso.** A segunda passada, com a ingestão pausada, copia só a diferença;
- **o MinIO não sai sozinho.** O deploy mantém o pod de pé mesmo com
  `S3_PROVIDER=aws`, porque ele é a origem da migração. Derrubá-lo é decisão de
  quem conferiu a cópia;
- **sem IRSA / instance profile.** Credencial por web identity pediria o fluxo
  STS `AssumeRoleWithWebIdentity`; com cliente à mão, fica de fora até haver um
  cluster na AWS que precise. Hoje é chave de usuário IAM (ou token STS
  injetado por fora);
- **chave nova da OCI demora a valer.** A Customer Secret Key recém-criada
  responde `SignatureDoesNotMatch` ("secret key ... could not be found") por
  alguns minutos, inclusive para o boto3. Não é região nem assinatura: é
  esperar;
- **objeto inteiro na memória**, como já era no upload. Cabe porque o upload é
  limitado a `KB_MAX_UPLOAD_MB`; o Job da migração tem teto de 2 GiB para 8
  cópias simultâneas.

## Alternativas consideradas

**boto3.** Resolveria IRSA e multipart de graça. Recusado pelo mesmo motivo do
ADR-0008 (dependência pesada na imagem para cinco chamadas), e porque a lacuna
real, a assinatura, foi validada contra ele.

**`mc mirror` / `aws s3 sync`.** Funcionam, mas exigem outra imagem, outra
credencial no host e não conhecem o `KB_STORAGE_BACKEND=filesystem`. O migrador
usa as mesmas classes que o kb-api, então migra de disco também.

**Espelhar gravações nos dois durante a transição.** Evitaria a pausa da
ingestão, ao custo de um modo de escrita dupla que só existiria por algumas
horas. A segunda passada idempotente dá o mesmo resultado sem código novo no
caminho quente.

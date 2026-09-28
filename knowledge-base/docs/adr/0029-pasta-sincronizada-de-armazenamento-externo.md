# ADR-0029 — Uma pasta do Google Drive pode ser espelhada numa base

- **Status:** Aceito
- **Data:** 2026-09-24
- **Relacionado:** [0008](0008-bruto-imutavel-com-backend-configuravel.md),
  [0009](0009-provedores-de-ia-no-banco-cifrados.md), requisito FUN-02

## Contexto

Todo documento entrava por upload. O acervo de um escritório, porém, vive numa
pasta que as pessoas editam todo dia, e manter a base igual a ela era trabalho
manual: reenviar o que mudou e lembrar de apagar o que saiu. O que se pediu foi
cadastrar armazenamentos (quantos forem necessários, começando pelo Google
Drive), escolher uma pasta numa base e mantê-la sincronizada, **sem afetar o que
foi enviado à mão**.

## Decisão

**Cadastro de armazenamento** em `storage_connection`, na tela Administração >
Armazenamentos. A credencial segue o ADR-0009 sem mudança: cifrada com
`KB_SECRET_KEY`, e a API nunca a devolve. O tipo é uma lista fechada no banco
(`google_drive` por enquanto), e um tipo novo é um cliente novo ao lado de
`gdrive.py`.

**Conta de serviço, e não OAuth de usuário.** A pessoa compartilha a pasta com o
e-mail da conta, como faria com um colega. O OAuth de usuário exigiria um
redirect de volta para a API (inexistente no k3d local) e um refresh token que
morre com troca de senha ou app em modo de teste. Escopo `drive.readonly`.

**Pasta sincronizada** em `storage_sync`, escolhida na própria base
(Documentos > Gerenciar). Uma thread no processo (`sync.py`) roda cada pasta no
intervalo dela e:

- enfileira arquivo novo ou alterado **pela fila de ingestão**, como um upload;
- detecta mudança sem baixar, pelo md5 do Drive (ou `modifiedTime` nos nativos do
  Google, exportados como .docx/.xlsx/.pptx), guardado em `storage_sync_item`;
- renomeia sem reingerir quando só o nome mudou;
- remove da base o que saiu da pasta, foi para a lixeira ou foi apagado.

**Consulta periódica, não webhook.** O `changes.watch` do Drive exige URL pública
HTTPS com domínio verificado e expira em uma semana; nada disso existe no k3d.

**A fronteira com o upload manual é a coluna `document.sync_id`.** Nulo é
manual. A ingestão passou a versionar e deduplicar **só dentro da mesma origem**
(`ingest.escopo_da_origem`): antes, o versionamento era pelo nome, e um
`contrato.pdf` vindo do Drive desativaria o `contrato.pdf` enviado à mão; a
deduplicação era pelo sha, e a remoção de um arquivo do Drive levaria o upload
de mesmo conteúdo. O arquivo sincronizado versiona pelo id remoto, que
sobrevive a renomear e mover.

## Consequências

Ganhos:

- a base acompanha a pasta sem ninguém reenviar nada;
- o upload manual continua exatamente como era, inclusive quando tem o mesmo
  nome ou o mesmo conteúdo de um arquivo da pasta (testado contra Postgres);
- o custo por rodada é uma listagem por subpasta; só o que mudou é baixado.

Custos e travas:

- **a mudança aparece no intervalo**, não na hora (mínimo 5 minutos, para não
  gastar a cota da API do Drive). Há "Sincronizar agora";
- **pasta descompartilhada não apaga nada.** A listagem de uma pasta sem acesso
  volta vazia sem erro, o que significaria remover tudo. A rodada consulta a
  pasta antes e para com erro. Pelo mesmo motivo, a remoção só acontece depois
  da listagem **inteira** ter dado certo;
- **o bruto compartilhado não sai.** A chave do object store é por sha e nome, então
  o manual e o sincronizado de mesmo conteúdo dividem o objeto. `remover_documento`
  só apaga objeto que nenhum outro documento referencia;
- **remover na tela um documento sincronizado não o tira da pasta**, e ele volta na
  próxima rodada. A pasta manda; a tela avisa;
- **remover a sincronização** pergunta o que fazer com os documentos: mantidos, eles
  viram upload manual (`sync_id` vai a nulo pela FK);
- atalhos do Drive são ignorados (apontam para fora da pasta escolhida), e formato
  que o extrator não lê fica como "ignorado" na lista de arquivos da pasta.

## Alternativas consideradas

**SDK do Google** (`google-api-python-client`). Descartado pelo mesmo motivo do
cliente S3 escrito à mão no ADR-0008: três chamadas REST e um JWT não justificam a
árvore de dependências. O JWT é assinado com o `cryptography`, que já estava na
imagem.

**Webhook do Drive.** Ver acima; fica como otimização para quando houver URL
pública, sem mudar o modelo de dados.

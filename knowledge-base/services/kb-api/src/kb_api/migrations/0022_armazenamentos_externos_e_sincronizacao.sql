-- Armazenamentos externos (Google Drive, por enquanto) e pastas sincronizadas.
--
-- Ate aqui todo documento entrava por upload, e manter uma base igual a uma
-- pasta que o escritorio edita todo dia era trabalho manual: reenviar o que
-- mudou, lembrar de apagar o que saiu. Agora um administrador cadastra a
-- conexao (`storage_connection`), escolhe uma pasta e liga a sincronizacao
-- (`storage_sync`); um laco no processo compara a pasta com o que ja entrou
-- (`storage_sync_item`) e enfileira, versiona ou remove.
--
-- NOME: "storage" aqui e o armazenamento DE ONDE o arquivo vem. Nao confundir
-- com o object store do bruto (`storage.py`, ADR-0008), que e para ONDE ele vai.
--
-- A credencial segue a regra do ADR-0009: cifrada com `KB_SECRET_KEY`, e a API
-- nunca a devolve. `config` guarda so o que nao e segredo (o e-mail da conta de
-- servico, que a pessoa precisa ver para compartilhar a pasta com ela).
CREATE TABLE IF NOT EXISTS storage_connection (
    id           BIGSERIAL PRIMARY KEY,
    -- Lista fechada pelo mesmo motivo de `ai_provider.kind` (0019): tipo que
    -- nenhum cliente sabe falar falha no INSERT, e nao na primeira sincronizacao.
    kind         TEXT NOT NULL CHECK (kind IN ('google_drive')),
    label        TEXT NOT NULL,
    config       JSONB NOT NULL DEFAULT '{}'::jsonb,
    secret_enc   TEXT NOT NULL DEFAULT '',
    secret_hint  TEXT NOT NULL DEFAULT '',
    created_by   TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Uma pasta sincronizada com uma base. A conexao nao cai em cascata
-- (`RESTRICT`): apagar a credencial com sincronizacoes ligadas deixaria bases
-- apontando para uma pasta que ninguem mais consegue ler, e o erro so
-- apareceria na proxima rodada. A base cai (`CASCADE`), porque os documentos
-- dela ja caem junto.
CREATE TABLE IF NOT EXISTS storage_sync (
    id                BIGSERIAL PRIMARY KEY,
    connection_id     BIGINT NOT NULL REFERENCES storage_connection(id) ON DELETE RESTRICT,
    space_slug        TEXT NOT NULL REFERENCES space(slug) ON DELETE CASCADE,
    folder_id         TEXT NOT NULL,
    folder_name       TEXT NOT NULL DEFAULT '',
    recursive         BOOLEAN NOT NULL DEFAULT TRUE,
    interval_minutes  INT NOT NULL DEFAULT 10,
    enabled           BOOLEAN NOT NULL DEFAULT TRUE,
    -- idle | running | error
    status            TEXT NOT NULL DEFAULT 'idle',
    last_run_at       TIMESTAMPTZ,
    last_ok_at        TIMESTAMPTZ,
    next_run_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error        TEXT NOT NULL DEFAULT '',
    last_summary      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by        TEXT NOT NULL DEFAULT '',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (space_slug, connection_id, folder_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS storage_sync_due ON storage_sync (next_run_at) WHERE enabled;
--> statement-breakpoint

-- O que a pasta tinha na ultima rodada, arquivo a arquivo. E o que permite
-- saber que algo MUDOU sem baixar: `remote_version` e o md5 que o Drive
-- calcula (arquivo binario) ou o `modifiedTime` (Documento/Planilha Google,
-- que nao tem md5). Sem esta tabela cada rodada teria de baixar a pasta
-- inteira para comparar sha256.
CREATE TABLE IF NOT EXISTS storage_sync_item (
    sync_id         BIGINT NOT NULL REFERENCES storage_sync(id) ON DELETE CASCADE,
    ref             TEXT NOT NULL,
    path            TEXT NOT NULL DEFAULT '',
    name            TEXT NOT NULL DEFAULT '',
    mime            TEXT NOT NULL DEFAULT '',
    size_bytes      BIGINT NOT NULL DEFAULT 0,
    remote_version  TEXT NOT NULL DEFAULT '',
    -- synced (entregue a fila; o desfecho esta no `ingest_run`) | skipped | error
    status          TEXT NOT NULL DEFAULT 'synced',
    error           TEXT NOT NULL DEFAULT '',
    run_id          BIGINT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (sync_id, ref)
);
--> statement-breakpoint

-- De onde o documento veio. NULL = upload manual, e e isso que garante que a
-- sincronizacao nunca toca no que foi enviado a mao: a remocao, o versionamento
-- e a deduplicacao da ingestao passam a olhar SO documentos da mesma origem.
-- Sem isso, um `contrato.pdf` no Drive desativaria o `contrato.pdf` enviado a
-- mao (o versionamento era por nome), e um arquivo apagado do Drive levaria
-- junto o upload de mesmo conteudo (a deduplicacao era por sha).
--
-- `SET NULL`: remover a sincronizacao com "manter os documentos" os transforma
-- em upload manual, que e exatamente o que a pessoa pediu.
ALTER TABLE document ADD COLUMN IF NOT EXISTS sync_id BIGINT
    REFERENCES storage_sync(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE document ADD COLUMN IF NOT EXISTS source_ref TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_origem ON document (sync_id, source_ref)
    WHERE sync_id IS NOT NULL;
--> statement-breakpoint

-- A fila leva a origem junto: e o worker que chama a ingestao, e sem isto o
-- documento sairia da fila como se tivesse sido enviado a mao. Sem FK de
-- proposito: `ingest_run` e log, e log nao pode sumir porque a sincronizacao
-- foi removida.
ALTER TABLE ingest_run ADD COLUMN IF NOT EXISTS sync_id BIGINT;
--> statement-breakpoint
ALTER TABLE ingest_run ADD COLUMN IF NOT EXISTS source_ref TEXT NOT NULL DEFAULT '';

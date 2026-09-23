-- Fila de ingestao.
--
-- O upload deixa de processar dentro da requisicao: grava o bruto no object
-- store, abre a linha em `ingest_run` com status `queued` e responde. Um worker
-- no processo consome a fila UM ARQUIVO POR VEZ.
--
-- Sincrono, dez arquivos de 10 MB enviados juntos viravam dez conexoes de
-- minutos atravessando o ingress; qualquer engasgo do pod soltava a conexao, o
-- cliente passava para o proximo arquivo e o servidor ficava com dois docling
-- rodando ao mesmo tempo -- OOMKilled, e todos os que estavam no ar perdidos.
--
-- `raw_key` e o que permite retomar: o bruto ja esta guardado, entao um pod que
-- reinicia devolve o `running` para a fila em vez de pedir "envie de novo".
-- `attempts` conta quantas vezes o worker pegou a linha: um arquivo que derruba
-- o pod toda vez precisa parar de ser retomado, senao vira laco de OOM.
ALTER TABLE ingest_run ADD COLUMN IF NOT EXISTS raw_key TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE ingest_run ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE ingest_run ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ingest_run_fila ON ingest_run (id) WHERE status = 'queued';
--> statement-breakpoint

-- Etapa e percentual, para a tela da fila. `progress` sai do trabalho feito
-- (lotes de pagina, de embedding, trechos do grafo), ver `progresso.py`.
ALTER TABLE ingest_run ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE ingest_run ADD COLUMN IF NOT EXISTS progress REAL NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE ingest_run ADD COLUMN IF NOT EXISTS stage_detail TEXT NOT NULL DEFAULT '';
--> statement-breakpoint

-- O log por documento. Separado de `ingest_run` porque e uma lista: cada troca
-- de etapa e cada marco (lote do docling, 10% do embedding) e uma linha. Sai
-- junto com a execucao (`ON DELETE CASCADE`), entao limpar o log de ingestao
-- limpa isto tambem.
CREATE TABLE IF NOT EXISTS ingest_event (
    id        BIGSERIAL PRIMARY KEY,
    run_id    BIGINT NOT NULL REFERENCES ingest_run(id) ON DELETE CASCADE,
    at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    stage     TEXT NOT NULL DEFAULT '',
    progress  REAL,
    message   TEXT NOT NULL DEFAULT ''
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ingest_event_run ON ingest_event (run_id, id);

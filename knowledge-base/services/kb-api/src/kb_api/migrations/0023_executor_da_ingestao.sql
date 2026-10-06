-- Quem esta processando cada linha `running` da fila de ingestao.
--
-- Vazio = a thread dentro do proprio kb-api (o modo padrao). Com
-- `KB_INGEST_MODE=pod`, cada arquivo roda num Job do Kubernetes e aqui fica o
-- nome dele. Sem esta coluna, a subida do kb-api nao tinha como separar o
-- `running` que morreu junto com o pod anterior do `running` que continua vivo
-- num Job: `retomar_orfaos` devolveria para a fila um arquivo ainda em
-- processamento, e ele seria ingerido duas vezes em paralelo.
ALTER TABLE ingest_run ADD COLUMN IF NOT EXISTS worker TEXT NOT NULL DEFAULT '';

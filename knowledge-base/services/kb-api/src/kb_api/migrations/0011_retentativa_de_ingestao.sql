-- 0011 — retentativa automatica de ingestao que falhou por motivo passageiro.
--
-- O PROBLEMA
--
-- A ingestao e sincrona e depende de coisas que saem do ar sem aviso: o
-- provedor de embedding devolve 429, a rede pisca, o OCR estoura o tempo. Hoje
-- o documento fica `failed` e alguem precisa notar e reenviar. Numa carga de
-- trezentos arquivos, "alguem precisa notar" nao acontece -- o arquivo some no
-- meio do log e a base fica com um buraco que ninguem sabe que existe.
--
-- O QUE PERMITE RETENTAR SEM O ARQUIVO DE VOLTA
--
-- O bruto e gravado no object store ANTES da extracao, e a linha do documento
-- guarda o `raw_key`. Entao a retentativa nao depende de quem enviou estar por
-- perto: ela le do object store e roda o pipeline de novo.
--
-- NEM TODO ERRO MERECE RETENTATIVA
--
-- `error_kind` separa o que adianta tentar de novo do que nao adianta. PDF
-- protegido por senha vai falhar igual daqui a uma hora, e retentar seria
-- gastar CPU para produzir o mesmo erro; um 429 do provedor passa sozinho. A
-- classificacao mora no codigo (`ingest.classificar_erro`), e nao aqui: ela
-- muda quando um modo de falha novo aparece, e migracao nao e lugar de regra
-- que muda.
--
-- POR QUE `next_retry_at` E COLUNA, E NAO CALCULO
--
-- Com a espera gravada, a proxima tentativa e uma consulta simples e o operador
-- VE na tela quando ela vai acontecer. Calculando a partir de `retry_count` e
-- `updated_at`, a mesma informacao existiria mas estaria escondida, e a tela
-- teria de repetir a formula do backoff -- dois lugares para errar.

ALTER TABLE document
    ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0;

ALTER TABLE document
    ADD COLUMN IF NOT EXISTS error_kind TEXT NOT NULL DEFAULT '';

ALTER TABLE document
    ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

-- Indice parcial: a varredura do worker so olha o que esta esperando vez. Sem
-- o `WHERE`, o indice cobriria a tabela inteira para servir uma consulta que
-- roda de cinco em cinco minutos sobre um punhado de linhas.
CREATE INDEX IF NOT EXISTS document_retry_pendente
    ON document (next_retry_at)
 WHERE status = 'failed' AND error_kind = 'recuperavel';

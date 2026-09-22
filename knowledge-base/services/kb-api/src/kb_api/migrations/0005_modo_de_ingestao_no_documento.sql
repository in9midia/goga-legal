-- 0005 — o modo de ingestao usado em CADA documento.
--
-- POR QUE ISTO PRECISOU EXISTIR
--
-- `document.chunk_engine` ja existia pelo mesmo motivo: trocar o motor nao
-- reprocessa o que ja esta indexado, e sem gravar por documento nao daria para
-- saber quais ficaram para tras. Quando o modo de ingestao virou um eixo
-- proprio (ADR-0015), esse rastreio ficou pela metade -- o motor era comparado,
-- o modo nao.
--
-- E o modo muda o TEXTO INDEXADO, nao so a fronteira do corte: no modo `okf` a
-- identidade do conceito entra na frente de cada trecho, e o frontmatter sai da
-- prosa. Medido no mesmo trecho, com `ts_rank_cd` do Postgres: a pergunta
-- "qual a politica de alcadas de contratacao" pontua 0,0000 sem o cabecalho e
-- 0,4000 com ele. Ou seja, uma base com os dois modos convivendo tem metade dos
-- trechos respondendo uma pergunta e a outra metade nao, sem nada na tela
-- dizendo por que.
--
-- Vazio = indexado antes desta coluna existir. Conta como DESALINHADO, mesma
-- convencao do `chunk_engine`: modo desconhecido nao pode passar por alinhado.

ALTER TABLE document
    ADD COLUMN IF NOT EXISTS ingest_mode TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN document.ingest_mode IS
    'Modo de ingestao usado NESTE documento (`padrao`, `okf`, ...). Fica aqui, e '
    'nao so no Espaco, porque trocar o modo nao reprocessa o que ja esta '
    'indexado: sem isto nao daria para saber quais documentos ficaram para tras. '
    'Vazio = anterior a esta coluna, e conta como desalinhado.';

-- Preenche o que ja esta indexado, com a informacao que da para deduzir com
-- CERTEZA: documento com conceito OKF gravado so pode ter vindo do modo `okf`.
-- O resto fica vazio de proposito -- "provavelmente padrao" nao e certeza, e
-- marcar como alinhado um documento que nao se sabe esconderia justamente o que
-- o reprocessamento precisa achar.
UPDATE document SET ingest_mode = 'okf' WHERE okf ? 'type' AND ingest_mode = '';

CREATE INDEX IF NOT EXISTS document_ingest_mode_idx
    ON document (space_slug, ingest_mode) WHERE active;

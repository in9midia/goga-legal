-- 0006 — quais REPRESENTACOES cada Espaco constroi.
--
-- O QUE ISTO CORRIGE
--
-- A 0003 e a 0005 trataram a escolha de ingestao como um MODO unico por Espaco
-- (`padrao` ou `okf`). A especificacao do projeto
-- (docs/proposal/docs/system-design/conceptual-model.md §2 e §3) modela isso de
-- outro jeito, e ela e normativa:
--
--   * REPRESENTACAO e uma estrutura derivada do canonico, construida na
--     ingestao. Sao duas na v1 -- o INDICE (chunks + vetores + BM25), que e a
--     representacao de base e existe em TODO Espaco, e a WIKI (paginas OKF
--     destiladas), prevista e LIGAVEL por Espaco (ING-11);
--   * elas nao competem: um Espaco pode ter as duas ativas ao mesmo tempo, e o
--     fan-out da ingestao constroi cada uma em separado, com estado proprio;
--   * o GRAFO nao e representacao. E ESTRUTURA AUXILIAR do indice: os nos
--     apontam para chunks pais que ja existem, e nao criam conteudo novo
--     (ING-12, onda 2).
--
-- Um enum de modo nao expressa isso. `indice + wiki` nao e um terceiro valor de
-- um enum: e o conjunto com os dois. Por isso esta coluna guarda um CONJUNTO.
--
-- O QUE O `chunking.mode` VIRA
--
-- O que a 0003 chamou de modo `okf` -- prepender a identidade do conceito em
-- cada trecho antes do embedding -- tem nome na taxonomia do projeto:
-- **Contextual Chunk Headers**, variante do slot de ENRIQUECIMENTO DE CHUNK, que
-- e interno a representacao-indice (ingestion-pipeline.md §5 E4a, passo 2). Ele
-- continua existindo e funcionando; muda o nome e o lugar conceitual. A leitura
-- da chave antiga fica no codigo (`chunking._enriquecimento`), para Espaco
-- gravado antes disto nao mudar de comportamento num deploy.
--
-- A COLUNA DO DOCUMENTO TAMBEM MUDA DE NOME
--
-- A 0005 criou `document.ingest_mode` com o vocabulario errado, e ela JA FOI
-- APLICADA -- entao editar aquele arquivo faria o checksum do ledger divergir e
-- o servico se recusaria a subir, que e exatamente o que a deteccao de drift
-- existe para fazer. O rename vem aqui, numa migracao nova, que e o caminho
-- certo: a 0005 fica congelada como foi aplicada.
--
-- `indice` SEMPRE ligado e o default: e o estado de todo Espaco ja gravado, e a
-- especificacao diz que ele esta presente em todo Espaco. Nenhuma base muda de
-- comportamento por causa desta migracao.

ALTER TABLE space
    ADD COLUMN IF NOT EXISTS representations JSONB NOT NULL
        DEFAULT '{"indice": true}'::jsonb;

COMMENT ON COLUMN space.representations IS
    'Representacoes ATIVAS neste Espaco, como conjunto: {"indice": true, '
    '"wiki": false}. `indice` e a representacao de base e esta presente em todo '
    'Espaco (conceptual-model §2). A wiki e ligavel (ING-11). O grafo NAO entra '
    'aqui: e estrutura auxiliar do indice, nao representacao (ING-12).';

-- Espaco ja gravado: o indice sempre ligado, a wiki desligada. Explicito em vez
-- de depender so do DEFAULT, porque o DEFAULT nao alcanca linha que ja existe.
UPDATE space
   SET representations = '{"indice": true, "wiki": false}'::jsonb
 WHERE representations = '{}'::jsonb OR NOT (representations ? 'indice');

-- A pergunta que a busca faz a cada consulta e "quais Espacos tem a wiki
-- ligada?", para so acionar o metodo de busca de paginas onde ele existe.
-- Parcial porque a wiki e opcional: um indice cheio teria uma entrada por
-- Espaco para responder sobre os poucos que a ligaram.
CREATE INDEX IF NOT EXISTS space_wiki_ativa_idx
    ON space ((representations->>'wiki')) WHERE active;

-- Rename guardado, e nao `ALTER ... RENAME` solto: migracao precisa ser
-- reexecutavel (o lock pode cair no meio e a proxima subida tenta tudo de
-- novo), e `RENAME COLUMN` nao tem `IF EXISTS`.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'document' AND column_name = 'ingest_mode'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'document' AND column_name = 'chunk_enrichment'
    ) THEN
        ALTER TABLE document RENAME COLUMN ingest_mode TO chunk_enrichment;
    END IF;
END $$;

-- Instalacao que nunca passou pela 0005 nao tem a coluna: cria aqui.
ALTER TABLE document
    ADD COLUMN IF NOT EXISTS chunk_enrichment TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN document.chunk_enrichment IS
    'Variante do slot de enriquecimento usada NESTE documento (`nenhum`, '
    '`conceito`). Fica aqui, e nao so no Espaco, porque trocar a variante nao '
    'reprocessa o que ja esta indexado: sem isto nao daria para saber quais '
    'documentos ficaram para tras. Vazio = anterior a esta coluna, e conta como '
    'desalinhado.';

-- Os valores tambem mudam de nome, e a traducao e a mesma que o codigo faz ao
-- ler Espaco gravado no formato antigo (`chunking._enriquecimento`).
UPDATE document SET chunk_enrichment = 'conceito' WHERE chunk_enrichment = 'okf';
UPDATE document SET chunk_enrichment = 'nenhum'   WHERE chunk_enrichment = 'padrao';

DROP INDEX IF EXISTS document_ingest_mode_idx;
CREATE INDEX IF NOT EXISTS document_chunk_enrichment_idx
    ON document (space_slug, chunk_enrichment) WHERE active;

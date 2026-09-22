-- 0007 — a representacao WIKI: paginas OKF destiladas, com indice proprio.
--
-- O QUE ELA E (ingestion-pipeline.md §5 E4b, conceptual-model.md §3)
--
-- A segunda representacao da v1. A LLM de destilacao le os documentos canonicos
-- do Espaco e mantem uma wiki de paginas ATOMICAS (~200 a 800 palavras) em
-- formato OKF puro. E o contraste deliberado com a canonicalizacao: a
-- canonicalizacao PRESERVA o texto, a destilacao REESCREVE.
--
-- TRES DECISOES DE ESQUEMA QUE VALEM EXPLICAR
--
-- 1. **A pagina e a unidade de entrega, e nao ha chunking.** O controle de
--    tamanho vem do contrato de destilacao, nao de um cortador. Por isso nao ha
--    `parent_id` aqui: a rede de seguranca para pagina grande e o multi-vetor
--    por secao, onde QUALQUER vetor que casar devolve a pagina inteira.
--
-- 2. **`wiki_page_source` e tabela, e nao um campo.** A rastreabilidade e
--    N-para-N de verdade: uma pagina pode derivar de varios documentos, e um
--    documento alimenta varias paginas. E ela e OPERACIONAL -- e por ela que a
--    remocao de um documento sabe quais paginas redestilar. O mesmo dado vai
--    tambem no frontmatter (`sources`), que mantem a pagina autodescritiva fora
--    do sistema; os dois nao competem, tem publicos diferentes.
--
-- 3. **`ON DELETE CASCADE` do documento NAO apaga a pagina.** A FK de
--    `wiki_page_source` cascateia o VINCULO, nao a pagina: uma pagina destilada
--    de tres documentos nao deve sumir porque um deles saiu. O que a remocao
--    dispara e a redestilacao, e isso e decisao do pipeline, nao do banco.

CREATE TABLE IF NOT EXISTS wiki_page (
    id          BIGSERIAL PRIMARY KEY,
    space_slug  TEXT NOT NULL REFERENCES space(slug) ON DELETE CASCADE,
    -- Caminho dentro do bundle OKF do Espaco (`metricas/usuarios-ativos.md`).
    -- E a identidade da pagina: a destilacao reescreve pelo caminho, e e assim
    -- que ela edita em vez de duplicar.
    path        TEXT NOT NULL,
    -- Do frontmatter, copiados para fora para a tela e o filtro nao terem de
    -- abrir o JSONB a cada linha.
    type        TEXT NOT NULL DEFAULT '',
    title       TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    -- O arquivo OKF INTEIRO, como ele e: frontmatter mais corpo. E o que o
    -- `fetch` devolve, e o que faz a pagina continuar valida fora daqui.
    content     TEXT NOT NULL DEFAULT '',
    frontmatter JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Contrato de destilacao: 200 a 800 palavras. Guardado para o lint da wiki
    -- achar quem saiu da faixa sem reprocessar nada.
    words       INT NOT NULL DEFAULT 0,
    -- BM25 por PAGINA (e nao por secao): a busca de paginas entrega a pagina
    -- inteira, entao a granularidade do lexical acompanha.
    tsv         tsvector,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (space_slug, path)
);

CREATE INDEX IF NOT EXISTS wiki_page_space_idx ON wiki_page (space_slug);
CREATE INDEX IF NOT EXISTS wiki_page_tsv_idx ON wiki_page USING GIN (tsv);

CREATE TABLE IF NOT EXISTS wiki_page_source (
    page_id     BIGINT NOT NULL REFERENCES wiki_page(id) ON DELETE CASCADE,
    document_id BIGINT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
    PRIMARY KEY (page_id, document_id)
);

CREATE INDEX IF NOT EXISTS wiki_page_source_documento_idx
    ON wiki_page_source (document_id);

-- Multi-vetor por secao: N vetores de matching apontando para 1 unidade de
-- entrega. Mesmo padrao do pai/filho do indice ("casar no pequeno, entregar o
-- inteiro"), com a diferenca de que aqui a unidade de entrega ja nasceu pronta
-- da destilacao, em vez de precisar ser fabricada por um cortador.
CREATE TABLE IF NOT EXISTS wiki_page_vector (
    id         BIGSERIAL PRIMARY KEY,
    page_id    BIGINT NOT NULL REFERENCES wiki_page(id) ON DELETE CASCADE,
    -- Repetido aqui para o filtro de Espaco da busca nao precisar do JOIN.
    -- Mesma decisao de `chunk_embedding.space_slug`, e pelo mesmo motivo.
    space_slug TEXT NOT NULL,
    -- O cabecalho da secao que gerou este vetor, para o trace dizer o que casou.
    section    TEXT NOT NULL DEFAULT '',
    ord        INT NOT NULL DEFAULT 0,
    model      TEXT NOT NULL DEFAULT '',
    embedding  vector(3072) NOT NULL
);

CREATE INDEX IF NOT EXISTS wiki_page_vector_space_idx
    ON wiki_page_vector (space_slug);

-- SEM INDICE VETORIAL, e isso e uma limitacao do pgvector, nao uma escolha.
--
-- Medido nesta instalacao ao tentar criar o indice:
--
--   ERROR: column cannot have more than 2000 dimensions for ivfflat index
--
-- O modelo em uso (`text-embedding-3-large`) devolve 3072, e o teto do pgvector
-- e 2000 -- para ivfflat E para hnsw. E pela mesma razao que `chunk_embedding`,
-- a tabela de vetores do indice, tambem nao tem indice vetorial nenhum desde a
-- 0001: a busca varre e calcula distancia exata.
--
-- A consequencia e conhecida e aceitavel na escala atual: a wiki de um Espaco
-- tem dezenas ou centenas de paginas, nao milhoes de vetores. Quando deixar de
-- ser, o caminho e reduzir a dimensao do embedding (a API do modelo aceita
-- `dimensions`) e ai o indice passa a ser possivel -- e essa e uma decisao de
-- qualidade de busca, nao de indice, entao fica para quando houver medicao.

-- Estado do build por (documento, representacao), como a maquina de estados do
-- pipeline pede: falha de build vive no nivel da representacao e e
-- reprocessavel por representacao, sem repetir as outras.
CREATE TABLE IF NOT EXISTS document_representation (
    document_id    BIGINT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
    representation TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pendente',
    error          TEXT NOT NULL DEFAULT '',
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (document_id, representation)
);

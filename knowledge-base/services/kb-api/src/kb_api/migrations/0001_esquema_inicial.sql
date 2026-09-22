-- 0001 — esquema inicial.
--
-- Este arquivo E o antigo `schema.sql`, palavra por palavra. Foi renomeado para
-- virar a primeira migracao, e nao reescrito, por um motivo pratico: ele e
-- inteiramente idempotente, entao reaplica-lo numa base que ja tinha o esquema
-- e um no-op. Isso deixa todo ambiente que ja estava de pe entrar no controle
-- de versao sozinho, sem passo de baseline e sem migracao manual.
--
-- A cauda de `ALTER TABLE ... IF NOT EXISTS` no fim tambem foi preservada pelo
-- mesmo motivo: e ela que leva uma base antiga ao estado que os `CREATE TABLE`
-- daqui descrevem.
--
-- ARQUIVO CONGELADO: nao edite. Mudanca de esquema entra como migracao nova
-- (`python -m kb_api.migrate new <nome>`). Ver migrations/README.md.

-- Esquema da base de conhecimento.
--
-- Decisoes que valem explicar:
--
-- * `document.canonical_md` e a FONTE DE VERDADE (ING-03): o bruto fica no
--   object store, e tudo o que a busca ve deriva deste texto. Nenhuma das tres
--   ferramentas de mercado avaliadas tem esse artefato.
-- * Conteudo IMUTAVEL (FUN-02): nao ha UPDATE de texto. Reingerir o mesmo
--   arquivo cria uma versao nova e desativa a anterior; chunk e embedding
--   cascateiam por ON DELETE CASCADE.
-- * `chunk` guarda pai e filho na mesma tabela: `parent_id` nulo = pai. A busca
--   roda no filho e a entrega e do pai (ING-07).
-- * O escopo de permissao vive em `space_grant`, resolvido por grupo do
--   Keycloak, object id do EntraID ou e-mail (FUN-08/FUN-09).

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- unaccent: sem ele o full-text portugues indexa 'ferias' como 'feria' com
-- acento e a consulta SEM acento (como as pessoas escrevem) nao casa com
-- nada. O sintoma e a etapa lexical devolver zero candidatos e a busca
-- ficar so vetorial, sem erro nenhum aparecendo.
CREATE EXTENSION IF NOT EXISTS unaccent;

-- ── Espacos ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS space (
    slug        TEXT PRIMARY KEY,
    label       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    -- Motor de chunking DESTE Espaco: `{engine, child_chars, child_overlap,
    -- parent_chars, breakpoint_percentile}`. Vazio = o default do servico.
    --
    -- Fica no Espaco, e nao global, porque nao existe um corte bom para tudo:
    -- manual com heading e contrato em texto corrido pedem estrategias
    -- diferentes. E como este projeto existe para COMPARAR tecnicas, com a
    -- escolha global era impossivel rodar duas lado a lado.
    chunking    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Quem alcanca o Espaco. principal_type:
--   'group'     caminho do claim groups (ex.: /goga/curadoria)
--   'role'      role do realm, ou 'client:role' para role de client
--   'entra_oid' object id do EntraID (a ponte de conta do agentic-sdlc)
--   'email'     e-mail nominal
--   'public'    qualquer chamador autenticado
--
-- Grupo e role sao tipos SEPARADOS de proposito: num realm corporativo os dois
-- sao namespaces diferentes, e juntar os dois faria um grant para o grupo
-- `/goga/curadoria` ser satisfeito por uma role de mesmo nome.
CREATE TABLE IF NOT EXISTS space_grant (
    id             BIGSERIAL PRIMARY KEY,
    space_slug     TEXT NOT NULL REFERENCES space(slug) ON DELETE CASCADE,
    principal_type TEXT NOT NULL CHECK (principal_type IN ('group','role','entra_oid','email','public')),
    principal_id   TEXT NOT NULL DEFAULT '',
    role           TEXT NOT NULL DEFAULT 'reader' CHECK (role IN ('reader','editor','owner')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (space_slug, principal_type, principal_id)
);
CREATE INDEX IF NOT EXISTS space_grant_lookup
    ON space_grant (principal_type, principal_id);

-- ── Documentos ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS document (
    id            BIGSERIAL PRIMARY KEY,
    space_slug    TEXT NOT NULL REFERENCES space(slug) ON DELETE CASCADE,
    filename      TEXT NOT NULL,
    title         TEXT NOT NULL DEFAULT '',
    -- sha256 do arquivo bruto: identidade do conteudo, base da imutabilidade
    content_sha   TEXT NOT NULL,
    mime          TEXT NOT NULL DEFAULT '',
    size_bytes    BIGINT NOT NULL DEFAULT 0,
    -- chave no object store; o bruto nunca e reescrito
    raw_key       TEXT NOT NULL DEFAULT '',
    -- documento canonico: texto limpo em Markdown, a fonte de verdade
    canonical_md  TEXT NOT NULL DEFAULT '',
    extractor     TEXT NOT NULL DEFAULT '',
    -- Motor de corte usado NESTE documento. Fica aqui e nao so no Espaco porque
    -- trocar o motor nao reprocessa o que ja esta indexado: sem gravar por
    -- documento, nao daria para saber quais ficaram para tras.
    chunk_engine  TEXT NOT NULL DEFAULT '',
    version       INT NOT NULL DEFAULT 1,
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    status        TEXT NOT NULL DEFAULT 'pending',
    error         TEXT NOT NULL DEFAULT '',
    tags          JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Paginas do original, quando o formato tem paginacao. Zero = sem paginas
    -- (docx, txt) ou extrator que nao reporta.
    pages         INT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    indexed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS document_space ON document (space_slug, active);
CREATE INDEX IF NOT EXISTS document_sha ON document (space_slug, content_sha);

-- ── Chunks (pai e filho na mesma tabela) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS chunk (
    id          BIGSERIAL PRIMARY KEY,
    document_id BIGINT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
    space_slug  TEXT NOT NULL,
    -- nulo = pai; preenchido = filho, e aponta para o pai que sera entregue
    parent_id   BIGINT REFERENCES chunk(id) ON DELETE CASCADE,
    ord         INT NOT NULL DEFAULT 0,
    content     TEXT NOT NULL,
    -- Pagina do ORIGINAL onde o trecho comeca, quando da para saber. E o que
    -- permite levar quem pergunta ate o lugar exato no arquivo, em vez de
    -- entregar o PDF inteiro e dizer "esta aqui dentro".
    page        INT,
    -- Deslocamento no canonico: usado para calcular a pagina e para achar o
    -- trecho de novo se o canonico for reprocessado.
    char_start  INT,
    -- tsvector materializado: busca lexical (BM25-like) sem depender de extensao
    tsv         tsvector,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chunk_document ON chunk (document_id);
CREATE INDEX IF NOT EXISTS chunk_parent ON chunk (parent_id);
CREATE INDEX IF NOT EXISTS chunk_space ON chunk (space_slug);
CREATE INDEX IF NOT EXISTS chunk_tsv ON chunk USING GIN (tsv);

-- ── Figuras (imagens do documento, com o texto lido por OCR) ───────────────
-- Imagem em documento corporativo raramente e decoracao: e o print da tela, o
-- fluxograma, a tabela colada como figura. Guardar o PNG permite MOSTRAR a
-- evidencia; guardar o OCR permite ENCONTRA-LA.
CREATE TABLE IF NOT EXISTS document_figure (
    id          BIGSERIAL PRIMARY KEY,
    document_id BIGINT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
    space_slug  TEXT NOT NULL,
    -- ref estavel dentro do documento (fig-1, fig-2...), o mesmo que aparece
    -- como `<!-- figura fig-N -->` no canonico
    ref         TEXT NOT NULL,
    page        INT,
    caption     TEXT NOT NULL DEFAULT '',
    ocr_text    TEXT NOT NULL DEFAULT '',
    -- chave no object store; a imagem nao vive no Postgres
    image_key   TEXT NOT NULL DEFAULT '',
    bytes       INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (document_id, ref)
);
CREATE INDEX IF NOT EXISTS document_figure_document ON document_figure (document_id);

-- Embedding em tabela separada: trocar de modelo reconstroi ESTA tabela sem
-- tocar no canonico nem nos chunks (ING-09).
CREATE TABLE IF NOT EXISTS chunk_embedding (
    chunk_id   BIGINT PRIMARY KEY REFERENCES chunk(id) ON DELETE CASCADE,
    space_slug TEXT NOT NULL,
    model      TEXT NOT NULL,
    embedding  vector(3072) NOT NULL
);
CREATE INDEX IF NOT EXISTS chunk_embedding_space ON chunk_embedding (space_slug);

-- ── Token pessoal para os harnesses de IA ──────────────────────────────────
-- O JWT do Identity vive minutos e exige navegador; o token de SERVICO nao tem
-- pessoa e carrega o escopo de administracao. Nenhum dos dois serve para o
-- Claude Desktop ou o Cursor de uma pessoa: o que se quer ali e "o agente
-- alcanca exatamente o que EU alcanco, e nada mais".
--
-- O valor em claro NUNCA e gravado. Guardamos o SHA-256 do token inteiro e um
-- prefixo em claro que serve so de indice de busca -- a API precisa VERIFICAR o
-- token, nunca usa-lo contra outro servico, entao nao ha motivo para ser
-- reversivel.
--
-- Os grupos sao uma FOTOGRAFIA do momento da emissao, e isso e uma limitacao
-- real: quem muda de area continua alcancando a base antiga ate o token expirar
-- ou ser revogado. A tela mostra os grupos de cada token exatamente para essa
-- defasagem ser visivel em vez de silenciosa. Os grants (o outro lado) sao
-- lidos ao vivo, entao mudanca na base vale na hora.
CREATE TABLE IF NOT EXISTS kb_token (
    id           BIGSERIAL PRIMARY KEY,
    name         TEXT NOT NULL DEFAULT '',
    -- sha256 do token inteiro; nunca o token
    token_sha    TEXT NOT NULL UNIQUE,
    -- primeiros caracteres em claro: indice de busca e o que a tela mostra
    prefix       TEXT NOT NULL,
    subject      TEXT NOT NULL DEFAULT '',
    email        TEXT NOT NULL DEFAULT '',
    entra_oid    TEXT NOT NULL DEFAULT '',
    groups       JSONB NOT NULL DEFAULT '[]'::jsonb,
    roles        JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS kb_token_owner ON kb_token (subject);
CREATE INDEX IF NOT EXISTS kb_token_prefix ON kb_token (prefix);

-- ── OAuth: o kb-api como Authorization Server do proprio MCP ───────────────
--
-- POR QUE ISSO EXISTE
--
-- Conector de MCP moderno (Claude Desktop, Claude na web) espera "cole a URL e
-- clique em Entrar": o cliente descobre o servidor de autorizacao, se registra
-- sozinho e leva a pessoa para o login. Ninguem cola token em conversa nem
-- edita JSON -- e o Claude Desktop, alias, NAO consegue editar o arquivo, porque
-- executa comando em container isolado.
--
-- Fazer isso pelo Identity direto exigiria habilitar Dynamic Client Registration
-- no realm COMPARTILHADO, que e decisao de infraestrutura de todo mundo. Em vez
-- disso o kb-api e o proprio Authorization Server e FEDERA o login ao Identity:
-- o usuario faz o login de verdade la, e quem emite o token do MCP e a gente.
-- Nada muda no realm.

-- Cliente registrado dinamicamente (RFC 7591). Registrar nao concede nada: a
-- pessoa ainda precisa logar e o token so nasce depois disso.
CREATE TABLE IF NOT EXISTS oauth_client (
    client_id     TEXT PRIMARY KEY,
    client_name   TEXT NOT NULL DEFAULT '',
    redirect_uris JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Codigo de autorizacao: vida curta, uso unico, amarrado ao PKCE.
-- Guarda o hash, nao o codigo -- vazamento do banco nao vira sessao.
CREATE TABLE IF NOT EXISTS oauth_code (
    code_sha       TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL,
    redirect_uri   TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    resource       TEXT NOT NULL DEFAULT '',
    subject        TEXT NOT NULL DEFAULT '',
    email          TEXT NOT NULL DEFAULT '',
    entra_oid      TEXT NOT NULL DEFAULT '',
    groups         JSONB NOT NULL DEFAULT '[]'::jsonb,
    roles          JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- refresh token do IDENTITY. Fica so no servidor e nunca sai daqui: e ele
    -- que permite reler os grupos da pessoa a cada renovacao, em vez de
    -- carregar para sempre a fotografia do dia do login.
    kc_refresh     TEXT NOT NULL DEFAULT '',
    expires_at     TIMESTAMPTZ NOT NULL,
    used_at        TIMESTAMPTZ
);

-- A sessao concedida: um par access/refresh nosso, por cliente e por pessoa.
CREATE TABLE IF NOT EXISTS oauth_grant (
    id                 BIGSERIAL PRIMARY KEY,
    client_id          TEXT NOT NULL,
    client_name        TEXT NOT NULL DEFAULT '',
    subject            TEXT NOT NULL DEFAULT '',
    email              TEXT NOT NULL DEFAULT '',
    entra_oid          TEXT NOT NULL DEFAULT '',
    groups             JSONB NOT NULL DEFAULT '[]'::jsonb,
    roles              JSONB NOT NULL DEFAULT '[]'::jsonb,
    kc_refresh         TEXT NOT NULL DEFAULT '',
    access_sha         TEXT UNIQUE,
    refresh_sha        TEXT UNIQUE,
    access_expires_at  TIMESTAMPTZ,
    refresh_expires_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at       TIMESTAMPTZ,
    revoked_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS oauth_grant_owner ON oauth_grant (subject);
CREATE INDEX IF NOT EXISTS oauth_grant_access ON oauth_grant (access_sha);

-- ── Log de ingestao ────────────────────────────────────────────────────────
-- Uma linha por TENTATIVA de ingestao, gravada quando comeca e fechada quando
-- termina. Existe por duas perguntas que a tabela `document` nao responde:
--
--   "o que esta processando agora?" -- linha com status 'running'. Sem isso, um
--   PDF de 120 paginas com OCR fica 13 minutos em silencio e quem enviou nao
--   sabe se travou;
--   "quanto tempo levou?" -- e onde. Sem medir, "a ingestao esta lenta" nao tem
--   como virar "este arquivo leva 13 min e os outros levam 20s".
--
-- Fica separada de `document` porque tentativa que FALHA nao produz documento,
-- e e justamente ela que precisa aparecer para ser reprocessada.
CREATE TABLE IF NOT EXISTS ingest_run (
    id           BIGSERIAL PRIMARY KEY,
    space_slug   TEXT NOT NULL,
    filename     TEXT NOT NULL,
    document_id  BIGINT,
    -- running | indexed | failed | skipped
    status       TEXT NOT NULL DEFAULT 'running',
    extractor    TEXT NOT NULL DEFAULT '',
    size_bytes   BIGINT NOT NULL DEFAULT 0,
    pages        INT NOT NULL DEFAULT 0,
    figures      INT NOT NULL DEFAULT 0,
    parents      INT NOT NULL DEFAULT 0,
    children     INT NOT NULL DEFAULT 0,
    embed_tokens INT NOT NULL DEFAULT 0,
    chunk_engine TEXT NOT NULL DEFAULT '',
    total_ms     INT NOT NULL DEFAULT 0,
    error        TEXT NOT NULL DEFAULT '',
    principal    TEXT NOT NULL DEFAULT '',
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ingest_run_recent ON ingest_run (started_at DESC);
CREATE INDEX IF NOT EXISTS ingest_run_status ON ingest_run (status);

-- ── Administracao dentro da aplicacao ──────────────────────────────────────
-- Admin por grupo do Identity (KB_ADMIN_GROUP) resolve o caso normal, mas exige
-- mexer no realm para cada mudanca -- e quem opera a base de conhecimento nem
-- sempre administra o Identity. Esta tabela permite promover alguem AQUI, sem
-- pedir favor para outro time.
--
-- Ela SOMA ao grupo, nunca substitui: quem esta no grupo de admin continua
-- admin mesmo que a tabela esteja vazia. Isso e o que evita o cenario de
-- alguem remover a si mesmo e trancar todo mundo fora.
CREATE TABLE IF NOT EXISTS kb_admin (
    id             BIGSERIAL PRIMARY KEY,
    principal_type TEXT NOT NULL CHECK (principal_type IN ('group','role','entra_oid','email')),
    principal_id   TEXT NOT NULL,
    note           TEXT NOT NULL DEFAULT '',
    created_by     TEXT NOT NULL DEFAULT '',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (principal_type, principal_id)
);

-- ── Telemetria por execucao (FUN-06) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS search_run (
    id            BIGSERIAL PRIMARY KEY,
    query         TEXT NOT NULL,
    spaces        JSONB NOT NULL DEFAULT '[]'::jsonb,
    principal     TEXT NOT NULL DEFAULT '',
    surface       TEXT NOT NULL DEFAULT 'rest',
    -- tecnica aplicada em cada etapa, latencia e custo, por execucao
    stages        JSONB NOT NULL DEFAULT '{}'::jsonb,
    total_ms      INT NOT NULL DEFAULT 0,
    embed_tokens  INT NOT NULL DEFAULT 0,
    result_count  INT NOT NULL DEFAULT 0,
    -- As passagens devolvidas, resumidas (documento, titulo, scores). Sem isso o
    -- historico registra QUE alguem perguntou, nao O QUE a base respondeu -- e
    -- o log deixa de servir para auditoria (WEB-04) e para comparar tecnicas
    -- entre execucoes. Resumidas de proposito: guardar o texto inteiro de cada
    -- trecho duplicaria a base a cada busca.
    results       JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS search_run_created ON search_run (created_at DESC);

-- Migracao de base ja criada antes da coluna `results` existir. O DDL acima e
-- IF NOT EXISTS, entao nao recria a tabela; este ALTER cobre o upgrade.
ALTER TABLE search_run ADD COLUMN IF NOT EXISTS results JSONB NOT NULL DEFAULT '[]'::jsonb;

-- O CHECK de principal_type ganhou 'role' depois de a tabela existir; sem
-- recriar a constraint, um grant de role e recusado no banco ja criado.
ALTER TABLE space_grant DROP CONSTRAINT IF EXISTS space_grant_principal_type_check;
ALTER TABLE space_grant ADD CONSTRAINT space_grant_principal_type_check
    CHECK (principal_type IN ('group','role','entra_oid','email','public'));

-- Colunas acrescentadas depois de a base existir. O ALTER idempotente evita um
-- passo manual de migracao no ambiente de quem ja tem dados.
ALTER TABLE document ADD COLUMN IF NOT EXISTS pages INT NOT NULL DEFAULT 0;
ALTER TABLE chunk ADD COLUMN IF NOT EXISTS page INT;
ALTER TABLE chunk ADD COLUMN IF NOT EXISTS char_start INT;
ALTER TABLE space ADD COLUMN IF NOT EXISTS chunking JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE document ADD COLUMN IF NOT EXISTS chunk_engine TEXT NOT NULL DEFAULT '';
ALTER TABLE ingest_run ADD COLUMN IF NOT EXISTS chunk_engine TEXT NOT NULL DEFAULT '';

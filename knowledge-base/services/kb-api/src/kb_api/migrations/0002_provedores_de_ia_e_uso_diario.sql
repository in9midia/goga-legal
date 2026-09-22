-- 0002 — provedores de IA geridos por tela, e contador diario de uso.
--
-- POR QUE SAIU DA VARIAVEL DE AMBIENTE
--
-- Ate aqui o provedor era fixo: `AZURE_OPENAI_ENDPOINT`/`AZURE_OPENAI_KEY` no
-- ambiente do pod. Trocar de modelo, ou apontar para outro provedor, exigia
-- mexer no GitOps e esperar um deploy -- e comparar dois provedores lado a lado
-- era impossivel.
--
-- ⚠ ISTO CONTRARIA UMA REGRA QUE O PROJETO TINHA ESCRITO ("configuracao por ENV
-- var, nunca em banco de aplicacao"). A inversao e deliberada e o motivo e
-- operacional: quem opera a base precisa trocar de modelo sem abrir um PR de
-- infraestrutura. A mitigacao e a coluna `api_key_enc`: a credencial e cifrada
-- em repouso com uma chave que continua vindo do ambiente (`KB_SECRET_KEY`),
-- entao um dump do banco sozinho nao entrega credencial nenhuma.

CREATE TABLE IF NOT EXISTS ai_provider (
    id          BIGSERIAL PRIMARY KEY,
    -- Rotulo humano, unico. E o que aparece na tela e no dashboard de uso.
    name        TEXT NOT NULL UNIQUE,
    -- Como falar com ele. Cada valor implica uma URL e um cabecalho de auth
    -- diferentes; ver `_DIALETOS` em providers.py.
    kind        TEXT NOT NULL CHECK (kind IN ('azure_openai', 'openai', 'azure_foundry', 'litellm')),
    endpoint    TEXT NOT NULL DEFAULT '',
    -- Credencial CIFRADA (Fernet). Nunca sai da API em texto puro: as rotas
    -- devolvem so os quatro ultimos caracteres, para dar para conferir QUAL
    -- chave esta la sem revela-la.
    api_key_enc TEXT NOT NULL DEFAULT '',
    -- Ultimos 4 caracteres da chave em claro, so para exibicao.
    api_key_tail TEXT NOT NULL DEFAULT '',
    -- Deployment (Azure) ou nome do modelo (OpenAI/Foundry).
    model       TEXT NOT NULL DEFAULT '',
    api_version TEXT NOT NULL DEFAULT '',
    -- Dimensoes que o modelo devolve. NAO e decorativo: a coluna
    -- `chunk_embedding.embedding` e `vector(N)` fixo no DDL, e misturar
    -- dimensoes no mesmo indice e um defeito silencioso -- a busca passa a
    -- comparar vetores de espacos diferentes e piora sem erro nenhum. A API
    -- recusa tornar padrao um provedor cuja dimensao divirja do esquema.
    dimensions  INT NOT NULL DEFAULT 3072,
    -- Para que serve. Hoje so `embedding`; o campo existe para o dia em que
    -- houver reranking ou geracao, sem precisar de outra migracao.
    purpose     TEXT NOT NULL DEFAULT 'embedding',
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    -- O provedor EM USO. Ha no maximo um por proposito -- garantido pelo
    -- indice unico parcial abaixo, e nao por regra na aplicacao: duas
    -- requisicoes concorrentes marcando padrao ao mesmo tempo deixariam dois.
    is_default  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_provider_um_padrao
    ON ai_provider (purpose) WHERE is_default;

-- ── Uso diario ─────────────────────────────────────────────────────────────
--
-- TABELA DE ROLLUP, nao de evento. E a decisao que faz o dashboard ser barato:
-- cada chamada de IA faz UM UPSERT que soma no contador do dia, e a tela le
-- algumas dezenas de linhas (dias x provedor x operacao) em vez de varrer um
-- historico de chamadas que cresce para sempre.
--
-- O caminho alternativo -- gravar um evento por chamada e agregar na leitura --
-- comeca mais simples e fica caro exatamente quando o numero importa: com a
-- base cheia, contar tokens do mes viraria um seq scan de milhoes de linhas a
-- cada abertura da tela.
--
-- O que se perde: nao da para responder "quais foram as chamadas das 14h05".
-- Granularidade de DIA e o que o requisito pede, e e o que cabe num contador.
CREATE TABLE IF NOT EXISTS ai_usage_daily (
    day         DATE NOT NULL,
    -- Sem FK para `ai_provider`: apagar um provedor NAO pode apagar o historico
    -- de gasto dele. O nome fica desnormalizado ao lado pelo mesmo motivo.
    provider_id BIGINT,
    provider    TEXT NOT NULL DEFAULT '',
    model       TEXT NOT NULL DEFAULT '',
    -- index | search | chunking -- de onde veio a chamada.
    operation   TEXT NOT NULL DEFAULT '',
    calls       BIGINT NOT NULL DEFAULT 0,
    tokens      BIGINT NOT NULL DEFAULT 0,
    -- Soma dos tempos; a media sai na divisao por `calls` na leitura.
    latency_ms  BIGINT NOT NULL DEFAULT 0,
    errors      BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (day, provider_id, model, operation)
);

-- A tela pede sempre "os ultimos N dias", entao o indice e por dia decrescente.
CREATE INDEX IF NOT EXISTS ai_usage_daily_dia ON ai_usage_daily (day DESC);

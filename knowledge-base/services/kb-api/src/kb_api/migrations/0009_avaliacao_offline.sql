-- 0009 — avaliacao offline: dataset golden e execucoes de benchmark (FUN-07).
--
-- O QUE E, E POR QUE ESTAS TRES TABELAS
--
-- A especificacao (conceptual-model §5, taxonomy §7) pede um plano transversal
-- que responda "quao boa e a resposta?", com dataset golden curado e metricas
-- Ragas, e com as FASES DE GERACAO E AVALIACAO DESACOPLADAS. O desacoplamento
-- e o que manda no esquema: pergunta e execucao sao coisas separadas, com
-- ciclos de vida diferentes.
--
-- 1. `benchmark_question` e o DATASET GOLDEN. Ele sobrevive as execucoes: a
--    mesma pergunta e respondida de novo a cada mudanca de configuracao, e e
--    isso que permite comparar tecnicas entre si. Guardar a pergunta dentro da
--    execucao impediria exatamente a comparacao que motiva o recurso.
--
-- 2. `benchmark_run` e UMA execucao, com o retrato da configuracao que estava
--    valendo. Sem o retrato, uma tabela de resultados de meses diferentes nao
--    diz nada: "a nota caiu" pode ser regressao ou pode ser outro motor de
--    corte, e nao haveria como distinguir.
--
-- 3. `benchmark_result` e a nota POR PERGUNTA, com as passagens recuperadas e a
--    resposta sintetizada. Guardar so a media esconderia o caso que importa --
--    a pergunta que falhou -- e e justamente nela que se olha para consertar.
--
-- SOBRE `reference` SER OPCIONAL
--
-- `context_precision`, `context_recall` e `answer_correctness` exigem gabarito.
-- `faithfulness` e `answer_relevancy` nao. Uma pergunta sem gabarito continua
-- util (mede o gerador), e exigir gabarito para cadastrar travaria o uso mais
-- simples: "escreva as perguntas que voce faria".
--
-- SOBRE O ESTADO DA PERGUNTA
--
-- A especificacao pede "geracao assistida por LLM e SELECAO HUMANA". Por isso a
-- pergunta gerada nasce `rascunho` e so entra na execucao quando alguem aprova:
-- dataset golden com pergunta que ninguem leu nao e golden, e a nota que sai
-- dele mede o gerador de perguntas, nao a base.

CREATE TABLE IF NOT EXISTS benchmark_question (
    id          BIGSERIAL PRIMARY KEY,
    space_slug  TEXT NOT NULL REFERENCES space(slug) ON DELETE CASCADE,
    question    TEXT NOT NULL,
    -- Resposta de referencia. Vazia e valido: ver o cabecalho.
    reference   TEXT NOT NULL DEFAULT '',
    -- De qual documento a pergunta saiu. `SET NULL` e nao `CASCADE`: a pergunta
    -- continua valendo quando o documento e reprocessado (o que troca o id) ou
    -- removido -- ela vira uma pergunta que a base DEVERIA saber responder, e
    -- essa e uma medicao legitima.
    document_id BIGINT REFERENCES document(id) ON DELETE SET NULL,
    origin      TEXT NOT NULL DEFAULT 'manual',   -- manual | gerada
    status      TEXT NOT NULL DEFAULT 'aprovada', -- rascunho | aprovada | descartada
    created_by  TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS benchmark_question_space
    ON benchmark_question (space_slug, status);

CREATE TABLE IF NOT EXISTS benchmark_run (
    id           BIGSERIAL PRIMARY KEY,
    space_slug   TEXT NOT NULL REFERENCES space(slug) ON DELETE CASCADE,
    -- `recuperacao` mede so o recuperador (barato, sem gerador).
    -- `completo` sintetiza resposta e mede as cinco metricas.
    mode         TEXT NOT NULL DEFAULT 'completo',
    status       TEXT NOT NULL DEFAULT 'running',  -- running | done | failed | cancelled
    total        INT  NOT NULL DEFAULT 0,
    done         INT  NOT NULL DEFAULT 0,
    -- Retrato da configuracao: motor de corte, enriquecimento, representacoes,
    -- modelos. E o que da sentido a comparacao entre duas execucoes.
    config       JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Medias por metrica + a media harmonica, ja calculadas no fim.
    summary      JSONB NOT NULL DEFAULT '{}'::jsonb,
    error        TEXT NOT NULL DEFAULT '',
    started_by   TEXT NOT NULL DEFAULT '',
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS benchmark_run_space
    ON benchmark_run (space_slug, started_at DESC);

CREATE TABLE IF NOT EXISTS benchmark_result (
    id           BIGSERIAL PRIMARY KEY,
    run_id       BIGINT NOT NULL REFERENCES benchmark_run(id) ON DELETE CASCADE,
    -- `SET NULL` pelo mesmo motivo de `document_id`: apagar uma pergunta do
    -- dataset nao pode apagar a historia de que ela ja foi medida.
    question_id  BIGINT REFERENCES benchmark_question(id) ON DELETE SET NULL,
    question     TEXT NOT NULL,
    reference    TEXT NOT NULL DEFAULT '',
    answer       TEXT NOT NULL DEFAULT '',
    -- As passagens que a busca devolveu, com espaco e documento. E o que
    -- permite abrir o caso concreto quando a nota e ruim.
    contexts     JSONB NOT NULL DEFAULT '[]'::jsonb,
    metrics      JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Diagnostico derivado do PADRAO das metricas: recuperador, gerador,
    -- pergunta ou nenhum. Gravado junto porque a regra pode mudar, e uma
    -- execucao antiga precisa continuar dizendo o que ela dizia.
    diagnosis    TEXT NOT NULL DEFAULT '',
    latency_ms   INT NOT NULL DEFAULT 0,
    error        TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS benchmark_result_run ON benchmark_result (run_id);

-- 0004 — cada Espaco escolhe o seu modelo, de embedding e de chat.
--
-- Ate aqui o provedor era UM por proposito, para a instalacao inteira: a linha
-- de `ai_provider` marcada com `is_default`. Isso tinha o mesmo defeito que o
-- motor de corte tinha antes da 0003 -- comparar dois modelos lado a lado era
-- impossivel, e este projeto existe justamente para comparar (FUN-04).
--
-- NULL = "use o padrao da instalacao", e e o valor de todo Espaco ja gravado.
-- Nao e ausencia de informacao: e a escolha de nao escolher, que continua sendo
-- o caso da maioria. Com o default, nenhuma base muda de comportamento por
-- causa desta migracao.
--
-- ON DELETE SET NULL, e nao RESTRICT: apagar um provedor em uso NAO pode
-- quebrar a base que o escolheu. Ela volta para o padrao da instalacao, que e
-- degradacao previsivel. Com RESTRICT, o operador descobriria o vinculo so ao
-- tentar apagar, e teria de cacar quais Espacos apontavam para la sem nenhuma
-- tela que dissesse.

ALTER TABLE space
    ADD COLUMN IF NOT EXISTS embedding_provider_id BIGINT
        REFERENCES ai_provider(id) ON DELETE SET NULL;

ALTER TABLE space
    ADD COLUMN IF NOT EXISTS chat_provider_id BIGINT
        REFERENCES ai_provider(id) ON DELETE SET NULL;

COMMENT ON COLUMN space.embedding_provider_id IS
    'Provedor de embedding DESTE Espaco. NULL = o padrao da instalacao. '
    'A API so aceita provedor cuja dimensao case com a do indice: misturar '
    'dimensoes degrada a busca sem erro nenhum aparecer.';

COMMENT ON COLUMN space.chat_provider_id IS
    'Provedor de chat DESTE Espaco, usado na derivacao de conceito OKF. '
    'NULL = o padrao da instalacao.';

-- Indices para a pergunta que a tela de provedores precisa fazer antes de
-- deixar apagar um: "quais Espacos usam este?". Parciais porque a imensa
-- maioria das linhas e NULL, e um indice cheio teria uma entrada por Espaco
-- para responder sobre os poucos que escolheram.
CREATE INDEX IF NOT EXISTS space_embedding_provider_idx
    ON space (embedding_provider_id) WHERE embedding_provider_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS space_chat_provider_idx
    ON space (chat_provider_id) WHERE chat_provider_id IS NOT NULL;

-- 0010 — como a pergunta foi feita, e de que tipo ela e.
--
-- POR QUE ISTO PRECISA SER COLUNA, E NAO FICAR IMPLICITO
--
-- A primeira execucao completa sobre a base de 275 manuais devolveu
-- `context_recall` = 1,0 em TODAS as dezesseis perguntas. Metrica que nunca
-- varia nao mede nada, e a causa nao era o recuperador ir bem: era o dataset ser
-- facil por construcao. A pergunta gerada herda o VOCABULARIO do documento de
-- origem ("em qual tela...", "Grupos de Descontos"), entao a busca lexical acha
-- o documento por coincidencia de palavra, nao por entender a pergunta.
--
-- A correcao e gerar tambem perguntas DIFICEIS -- que usam as palavras de quem
-- pergunta, e nao as do documento. Mas isso so vira medicao se der para separar
-- os dois conjuntos: "a nota caiu" nao diz nada se metade das perguntas mudou de
-- natureza no meio. Por isso a estrategia fica gravada NA PERGUNTA, e nao na
-- execucao: a mesma execucao mistura as duas, e o relatorio compara.
--
-- `kind` e o tipo de dificuldade, de um vocabulario FIXO. Pela mesma razao dos
-- tipos OKF: com texto livre, quarenta perguntas rendem trinta rotulos
-- quase-iguais e a etiqueta deixa de agrupar. E e util saber QUAL dificuldade
-- quebra a base -- parafrase e problema de embedding, multi-salto e problema de
-- recuperacao de passagem unica, e os consertos sao diferentes.

ALTER TABLE benchmark_question
    ADD COLUMN IF NOT EXISTS strategy TEXT NOT NULL DEFAULT 'direta';

ALTER TABLE benchmark_question
    ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT '';

-- O relatorio agrupa por estrategia, e a tela filtra por ela.
CREATE INDEX IF NOT EXISTS benchmark_question_strategy
    ON benchmark_question (space_slug, strategy);

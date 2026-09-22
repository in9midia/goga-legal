-- 0016 — desde quando e ate quando um conceito vale.
--
-- O QUE ISTO RESOLVE
--
-- A base nao sabia dizer se o que ela recuperou ainda vale. Conteudo revogado
-- responde a pergunta tao bem quanto o vigente -- as palavras sao as mesmas, o
-- vetor e vizinho, o `ts_rank_cd` e alto -- e ele sobe no ranking exatamente
-- como qualquer outro trecho. Nao ha erro, nao ha aviso: a resposta esta
-- ancorada na regra que deixou de valer.
--
-- Isso nao e de um dominio so. Norma revogada, politica interna substituida,
-- versao de manual que saiu de circulacao, tabela de preco do ano passado: em
-- todos, a pergunta certa e "o que valia NAQUELA data", e nao "o que vale hoje".
--
-- POR QUE NAO HA COLUNA NOVA AQUI
--
-- A tentacao era `document.vigencia_de DATE` e `document.vigencia_ate DATE`,
-- que indexam melhor e sao o jeito obvio. Foram recusadas por duas razoes:
--
--   1. **duas fontes de verdade.** O conceito inteiro ja vive em `document.okf`
--      (migracao 0003), escrito pela ingestao a partir do frontmatter. Uma
--      coluna ao lado passaria a divergir do JSONB no primeiro caminho de
--      escrita que esquecesse dela, e a divergencia seria silenciosa -- o filtro
--      usaria a coluna e a tela mostraria o JSONB;
--   2. **nao ha backfill que valha.** Todo documento ja ingerido teria a coluna
--      nula de qualquer jeito: a vigencia so existe se o frontmatter a declarou.
--      Ler do JSONB da o mesmo resultado sem uma passada de UPDATE na tabela
--      inteira com o lock da migracao tomado.
--
-- POR QUE A COMPARACAO E TEXTUAL
--
-- `(okf->'vigencia'->>'ate')::date` seria o natural, e nao entra em indice: o
-- cast de texto para data e `stable`, nao `immutable`, porque depende do
-- `DateStyle` da sessao. Postgres recusa em indice de expressao e em coluna
-- gerada. Texto ISO-8601 com zero a esquerda ordena igual ao calendario, entao
-- `>=` e `<=` sobre a string dao a mesma resposta -- e a garantia de formato
-- fica na ENTRADA, em `okf.data_iso`, que recusa `1990-9-11` antes de gravar.
--
-- O indice e PARCIAL porque declarar vigencia e a excecao: numa base comum
-- quase nenhum documento tem a chave, e um indice cheio teria uma entrada por
-- documento da instalacao para responder uma pergunta que so uma fracao deles
-- sabe responder. E o mesmo desenho do `document_okf_type_idx` da 0003.
CREATE INDEX IF NOT EXISTS document_okf_vigencia_idx
    ON document ((okf->'vigencia'->>'ate'), (okf->'vigencia'->>'de'))
 WHERE okf ? 'vigencia';

COMMENT ON COLUMN document.okf IS
    'Conceito OKF deste documento: tipo, titulo, descricao, tags, nivel de '
    'confianca derivado de `verified`, vigencia (`de`/`ate`, em AAAA-MM-DD), '
    'registro de auditoria, marca de armadilha, e o frontmatter inteiro como '
    'veio. Vazio quando o documento nao e um conceito OKF, que e o caso normal.';

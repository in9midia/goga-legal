-- 0003 — Open Knowledge Format (OKF) como formato de entrada.
--
-- O OKF (GoogleCloudPlatform/knowledge-catalog, v0.2) empacota conhecimento
-- como diretorio de Markdown com frontmatter YAML, um conceito por arquivo. O
-- frontmatter e METADADO: diz o tipo do conceito, o titulo, a descricao e quem
-- validou. Ate aqui esse bloco entrava no indice como prosa -- `type: Metric` e
-- `generated: {by: ...}` iam para o `tsv` e para o vetor de todo conceito do
-- bundle, e a busca lexical passava a casar `type` em todos eles.
--
-- POR QUE UMA COLUNA, E NAO REAPROVEITAR `tags`
--
-- `document.tags` ja existe e e JSONB, e a tentacao era guardar ali. Foi
-- recusado: `tags` e uma LISTA de rotulos do nosso dominio, e o frontmatter OKF
-- e um MAPA de esquema aberto, onde o produtor pode declarar chave que este
-- codigo nao conhece. Misturar os dois obrigaria a inventar um prefixo para
-- distinguir um do outro, e a primeira colisao com um `tags:` do proprio OKF
-- seria silenciosa.
--
-- `'{}'::jsonb` e nao NULL: "nao e conceito OKF" e um estado normal da imensa
-- maioria dos documentos (PDF, docx, planilha), nao ausencia de informacao.
-- Com o default, `okf->>'type'` responde NULL para eles sem precisar de
-- COALESCE em toda consulta.

ALTER TABLE document
    ADD COLUMN IF NOT EXISTS okf JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN document.okf IS
    'Conceito OKF deste documento: tipo, titulo, descricao, tags, nivel de '
    'confianca derivado de `verified`, e o frontmatter inteiro como veio. '
    'Vazio quando o documento nao e um conceito OKF, que e o caso normal.';

-- Indice parcial: so a fracao dos documentos que SAO conceitos OKF entra nele.
-- Um indice cheio teria uma entrada por documento da instalacao inteira para
-- responder uma pergunta que so faz sentido numa base em modo OKF.
CREATE INDEX IF NOT EXISTS document_okf_type_idx
    ON document ((okf->>'type'))
 WHERE okf ? 'type';

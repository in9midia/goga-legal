-- 0017 — o nivel de confianca passa a ser filtro, e precisa de indice.
--
-- O `trust` ja era gravado em `document.okf` desde a 0003, e era so exibicao:
-- a tela mostrava a etiqueta, e a busca devolvia tudo. Quem precisava garantir
-- que nao citaria conteudo nao conferido tinha de conferir DEPOIS, lendo o
-- resultado -- revisao manual, feita por quem le com pressa, no ponto do fluxo
-- em que ninguem quer parar.
--
-- Com `min_trust` na busca (ADR-0025) a clausula entra em toda consulta de
-- quem liga o filtro, e o que era etiqueta vira predicado. Sem indice, esse
-- predicado so existe varrendo.
--
-- PARCIAL, e com o mesmo criterio da 0003: documento que nao e conceito OKF nao
-- tem `trust`, e ele nao precisa estar no indice -- o filtro trata a ausencia
-- como `unverified` pelo COALESCE, e o planejador chega nesses documentos pelo
-- caminho do Espaco, que e o filtro que toda busca aplica.
CREATE INDEX IF NOT EXISTS document_okf_trust_idx
    ON document ((okf->>'trust'))
 WHERE okf ? 'trust';

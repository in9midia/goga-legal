-- 0012 — icone da base, para distinguir uma lista de bases de relance.
--
-- POR QUE UMA COLUNA, E NAO PREFERENCIA DO NAVEGADOR
--
-- O icone identifica a BASE, nao o gosto de quem olha: duas pessoas abrindo a
-- mesma instalacao precisam ver a mesma marca, senao ele deixa de servir para
-- combinar ("abre a base do balaozinho"). `localStorage` daria o oposto disso.
--
-- POR QUE TEXTO LIVRE, E NAO UM ENUM DE ICONES
--
-- Um enum travaria o conjunto no dia em que a tela mudar de biblioteca de
-- icones, e uma migracao de dados para trocar `book` por `library` e trabalho
-- desproporcional para um enfeite. Texto curto guarda um emoji, que ja e
-- universal, colorido e distinguivel de relance -- que e exatamente o que uma
-- lista longa precisa e o que icone monocromatico de tracinho nao entrega.
--
-- O tamanho vem do pior caso real: emoji com modificador de tom de pele e
-- junta ZWJ passa de dez bytes com um unico glifo. 32 cabe com folga e ainda
-- impede que alguem guarde um paragrafo aqui.
ALTER TABLE space ADD COLUMN IF NOT EXISTS icon TEXT NOT NULL DEFAULT '';

ALTER TABLE space DROP CONSTRAINT IF EXISTS space_icon_curto;
ALTER TABLE space ADD CONSTRAINT space_icon_curto CHECK (length(icon) <= 32);

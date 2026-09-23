-- Secao de cada trecho ("Titulo I › Capitulo IV › 1. Controle da qualidade").
--
-- Livro virava UMA unidade: a citacao dizia so a pagina, e "p. 612" de um livro
-- de 1.169 paginas nao diz a quem le em que parte do assunto aquilo esta. O
-- caminho sai dos titulos do canonico (sumario do PDF na extracao hibrida,
-- layout no docling), sem chamada de IA. Vazio em documento sem titulo e em
-- tudo que foi indexado antes desta coluna -- reprocessar preenche.
ALTER TABLE chunk ADD COLUMN IF NOT EXISTS section TEXT NOT NULL DEFAULT '';

-- 0014 — preco por modelo, e o custo em dolar do que ja foi gasto.
--
-- O PROBLEMA
--
-- A tela de uso mostrava CHAMADAS e TOKENS. Token nao e uma unidade que alguem
-- aprova ou recusa: "3,2 milhoes de tokens" nao responde se o mes cabe no
-- orcamento. Dolar responde.
--
-- POR QUE O PRECO FICA NO PROVEDOR
--
-- Preco e do par (modelo, conta). O mesmo `text-embedding-3-large` custa
-- diferente na OpenAI e num LiteLLM com margem, e um cadastro por modelo e
-- exatamente o que o `ai_provider` ja e. Uma tabela de tabela de precos seria
-- uma segunda fonte de verdade para dizer a mesma coisa.
--
-- POR QUE ENTRADA E SAIDA SEPARADAS
--
-- Elas custam diferente -- na maioria dos provedores a saida custa de tres a
-- cinco vezes mais. Um preco unico aplicado ao total erraria para mais em
-- embedding (que so tem entrada) e para menos em chat. E errado com cara de
-- apurado e pior que ausente.
--
-- Cache nao entra: este servico nao mede token de cache em lugar nenhum, e
-- coluna que nunca recebe valor e promessa que a tela nao cumpre.
ALTER TABLE ai_provider ADD COLUMN IF NOT EXISTS price_input_per_1m  NUMERIC(12,4);
ALTER TABLE ai_provider ADD COLUMN IF NOT EXISTS price_output_per_1m NUMERIC(12,4);

-- `NULL` quer dizer "preco nao cadastrado", e nao "de graca". A diferenca
-- importa na tela: sem preco ela diz que nao sabe, em vez de mostrar zero.

-- O uso diario passa a guardar a decomposicao e o custo.
--
-- O CUSTO E CONGELADO NA HORA DO USO, e nao calculado na leitura. Trocar o
-- preco amanha nao pode reescrever o gasto de ontem: o dinheiro de ontem saiu
-- pelo preco de ontem. Recalcular na leitura faria o historico mudar sozinho a
-- cada correcao de tabela, e ninguem consegue auditar um numero assim.
ALTER TABLE ai_usage_daily ADD COLUMN IF NOT EXISTS tokens_in  BIGINT NOT NULL DEFAULT 0;
ALTER TABLE ai_usage_daily ADD COLUMN IF NOT EXISTS tokens_out BIGINT NOT NULL DEFAULT 0;
ALTER TABLE ai_usage_daily ADD COLUMN IF NOT EXISTS cost_usd   NUMERIC(14,6) NOT NULL DEFAULT 0;

-- As linhas que ja existem ficam com `tokens_in = 0` e `tokens_out = 0`
-- enquanto `tokens` continua com o total. Nao da para dividir o passado: o
-- detalhe nunca foi gravado. A tela trata isso mostrando o custo como
-- desconhecido no periodo anterior a esta migracao, em vez de fingir zero.

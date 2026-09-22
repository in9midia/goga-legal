-- Gemini como tipo de provedor de IA.
--
-- A restricao de `kind` e uma lista fechada de propósito: tipo desconhecido
-- significa que nenhum dialeto sabe montar a chamada, e falhar no INSERT e
-- melhor que falhar na primeira ingestao, horas depois, com a credencial ja
-- cadastrada e cifrada.
--
-- Por que ALTER e nao recriar a coluna: a tabela ja tem linhas em ambientes
-- que rodam ha mais tempo, e recriar exigiria copiar credencial cifrada de um
-- lado para o outro. O ALTER e instantaneo e nao toca dado.
ALTER TABLE ai_provider DROP CONSTRAINT IF EXISTS ai_provider_kind_check;
--> statement-breakpoint
ALTER TABLE ai_provider
  ADD CONSTRAINT ai_provider_kind_check
  CHECK (kind IN ('azure_openai', 'openai', 'azure_foundry', 'litellm', 'gemini'));

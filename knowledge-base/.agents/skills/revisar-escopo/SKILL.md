---
name: revisar-escopo
description: Revisa uma mudança em busca de vazamento de escopo entre Espaços ou de credencial. Use antes de entregar qualquer alteração que toque leitura de conteúdo, autenticação ou provedores.
---

# Revisão de escopo e segredo

Recebe em `$ARGUMENTS` o que revisar (um caminho, um diff, ou vazio para o
working tree). Esta revisão é sobre **duas** coisas que este projeto trata como
não negociáveis: o conteúdo de um Espaço não aparece para quem não o alcança, e
credencial não vaza.

Não é uma revisão geral de qualidade. Se o pedido for esse, diga e faça a outra.

## Escopo entre Espaços

Procure, no que mudou:

1. **consulta que lê `chunk`, `document`, `document_figure` ou `search_run` sem
   filtro de Espaço.** O filtro vem do `Principal`; se a consulta nova não tem
   `space_slug` no `WHERE`, explique por que não precisa ou acrescente;

2. **escopo vindo do payload.** Qualquer `spaces` que chegue na requisição só
   pode **restringir**. Confirme que há interseção com o que o `Principal`
   alcança, e não substituição;

3. **erro que confirma existência.** Espaço não alcançável responde igual a
   Espaço inexistente. Um `404` com "Espaço X não encontrado" é aceitável; um
   `403` "sem permissão para o Espaço X" entrega a informação;

4. **rota nova sem dependência de identidade.** `current_principal` ou
   `require_write`. A ausência precisa ser deliberada e comentada;

5. **caminho de arquivo derivado de entrada.** A última parte da chave do object
   store é o nome do arquivo enviado por quem faz upload. Se o código monta
   caminho com isso, precisa recusar o que escapa da raiz.

## Credencial

1. **rota que devolve segredo.** Credencial de provedor de IA sai apenas com os
   quatro últimos caracteres. Token pessoal e de OAuth são gravados como hash,
   nunca o valor;
2. **segredo em log.** Procure por `log.` com variável que possa conter chave,
   token ou senha;
3. **segredo em arquivo versionado.** Se a mudança escreve credencial em arquivo
   do repositório, **pare e pergunte ao operador** antes de continuar;
4. **segredo em mensagem para o usuário ou em prompt.** Foi um erro real deste
   projeto e está registrado no
   [ADR-0007](../../../docs/adr/0007-kb-api-como-authorization-server-do-mcp.md).

## Como reportar

Liste só o que encontrou, com arquivo e linha, e o cenário concreto de falha
(que identidade veria o que não deveria). Se não encontrou nada, diga isso, e
diga **o que verificou**, para a revisão ser auditável.

Não conte como achado uma consulta que já tem o filtro, nem rota de saúde sem
identidade. Falso positivo aqui gasta a atenção que a próxima revisão precisa.

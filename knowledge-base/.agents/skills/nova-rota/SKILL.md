---
name: nova-rota
description: Acrescenta uma rota na API seguindo os padrões do projeto (identidade, escopo, telemetria, erro acionável). Use ao criar endpoint novo no kb-api.
---

# Rota nova no kb-api

Recebe em `$ARGUMENTS` o que a rota precisa fazer. Se vier vago, pergunte o
método, o caminho e quem pode chamar antes de escrever código.

As rotas ficam em `services/kb-api/src/kb_api/main.py`. O arquivo é grande:
localize o vizinho pelo path (`grep -n '"/v1/'`) e ponha a rota nova ao lado das
do mesmo assunto, não no fim.

## O que toda rota precisa decidir

1. **Quem pode chamar.** Três dependências, e a escolha é explícita:

   | dependência | quem passa |
   |---|---|
   | `current_principal` | qualquer identidade autenticada |
   | `require_write` | somente administrador |
   | nenhuma | só para rota de saúde e metadados públicos |

2. **De onde vem o escopo.** Se a rota lê conteúdo de Espaço, os Espaços
   alcançáveis vêm do `Principal`, **nunca** do payload. Parâmetro de
   requisição só **restringe**, e a interseção é feita no servidor. Pedir Espaço
   não alcançável devolve **vazio, não erro**, porque erro confirmaria que ele
   existe. Ver [ADR-0005](../../../docs/adr/0005-permissao-resolvida-no-servidor.md).

3. **O que a rota devolve quando algo falta.** Mensagem de erro aqui é
   acionável: diz o que fazer, não só o que houve. Compare:

   - ruim: `"provider not configured"`;
   - bom: `"nenhum provedor de IA configurado. Cadastre um em Administração >
     Modelos de IA e marque-o como padrão. Sem embedding a busca fica só
     lexical."`

4. **Se a rota gasta IA**, registre o uso com `providers.registrar_uso`, incluindo
   o caso de falha. Ver [ADR-0010](../../../docs/adr/0010-uso-de-ia-medido-por-rollup-diario.md).

5. **Se a rota escreve**, valide a entrada com faixa e recuse o que não faz
   sentido, com o motivo na mensagem. O padrão do projeto está em
   `_validar_chunking` e `_validar_provedor`.

## Depois de escrever

- **exponha no cliente**: `services/kb-ui/src/lib/types.ts` e `lib/api.ts`. O tipo
  é escrito à mão a partir da rota, não gerado;
- rode os gates: `uv run -- python -m scripts.check` e `scripts.test`;
- se a rota for de administração, confirme que ela aparece no menu só para
  administrador (`NAV_GROUPS` com `adminOnly` em `src/Layout.tsx`);
- **teste com identidade que NÃO deveria ter acesso**, não só com a sua. É o
  único jeito de saber que o escopo está aplicado.

## Armadilha específica deste arquivo

`main.py` importa o módulo `tokens`. Não use `tokens` como nome de variável de
laço dentro de uma rota: o linter pega, mas o modo de falha silencioso é uma
função que passa a ver a variável local no lugar do módulo.

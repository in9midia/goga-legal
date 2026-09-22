# ADR-0009 — O provedor de IA sai do ambiente e vira cadastro

- **Status:** Aceito
- **Data:** 2026-09-10
- **Relacionado:** [0002](0002-indice-unico-em-postgres-com-pgvector.md),
  [0010](0010-uso-de-ia-medido-por-rollup-diario.md), ADR-0051 do agentic-sdlc,
  requisito ING-09

## Contexto

O provedor de embedding vivia em variável de ambiente
(`AZURE_OPENAI_ENDPOINT`/`AZURE_OPENAI_KEY`). Trocar de modelo exigia um PR de
infraestrutura e um deploy, e comparar dois provedores lado a lado era
impossível.

Há uma tensão real aqui. O projeto tinha escrito a regra oposta, herdada do
agentic-sdlc: *"configuração por ENV var, nunca em banco de aplicação"*. A regra
existe por um bom motivo, segredo em banco de aplicação amplia a superfície de
vazamento.

## Decisão

**Inverter a regra, para provedor de IA, com cifra em repouso.**

Um provedor é uma linha em `ai_provider`, editável na tela Administração >
Modelos de IA. Quatro tipos, com o que muda entre eles numa tabela de dialetos
em vez de condicionais espalhadas:

| Tipo | URL de embedding | Auth |
|---|---|---|
| Azure OpenAI | `{endpoint}/openai/deployments/{model}/embeddings` | `api-key` |
| OpenAI | `{endpoint}/embeddings` | `Bearer` |
| Azure AI Foundry | `{endpoint}/models/embeddings` | `api-key` |
| LiteLLM | `{endpoint}/v1/embeddings` | `Bearer` (virtual key) |

O LiteLLM segue a **ADR-0051 do agentic-sdlc**: entra como mais um tipo, não como
gateway obrigatório, e a base URL é a **raiz sem `/v1`**, mesma convenção do
cadastro de lá. Assim, acrescentar Bedrock, Vertex ou um modelo local passa a ser
cadastro no gateway, não código aqui.

A mitigação da regra invertida:

- a credencial vai **cifrada** (Fernet) para a coluna `api_key_enc`;
- a chave da cifra continua vindo do ambiente (`KB_SECRET_KEY`), então um dump do
  banco sozinho não entrega credencial;
- a API **nunca** devolve a credencial. Só os quatro últimos caracteres, o
  suficiente para conferir qual chave está lá.

## Consequências

Ganhos:

- **trocar de modelo deixou de exigir deploy**, que era o objetivo;
- **um quinto provedor é uma linha** na tabela de dialetos;
- **a falha aparece no cadastro.** O botão Testar faz uma chamada real, em vez de
  a credencial errada aparecer no meio de uma ingestão de uma hora.

Custos:

- **uma regra do projeto foi invertida.** Está registrado aqui e na migração, e
  a cifra é o que paga a diferença;
- **sobra uma variável de ambiente irredutível**, a `KB_SECRET_KEY`. Trocá-la
  torna ilegíveis as credenciais já gravadas, que precisam ser recadastradas;
- **mais uma dependência na imagem**, o `cryptography`.

Uma trava que vale explicar: a API **recusa** marcar como padrão um provedor cuja
dimensão divirja do índice. Misturar dimensões é defeito silencioso, a gravação
funciona e a busca passa a comparar vetores de espaços diferentes, piorando **sem
erro nenhum**. Por isso é recusa, não aviso.

## Desdobramento

O [ADR-0016](0016-modelo-de-ia-escolhido-por-espaco.md) levou a escolha um nível
adiante: o `is_default` desta decisão passou a ser o **padrão da instalação**, e
cada Espaço pode sobrepô-lo. A cifra da credencial e a regra de nunca devolvê-la
em texto puro continuam valendo sem alteração.

`POST /v1/ai/models` lista os modelos que uma conta expõe, para a tela escolher
em vez de digitar. Ela pode usar a credencial **gravada**, via `provider_id` —
necessário justamente porque a tela nunca a reexibe. Isso abre um caminho que
precisou de amarra explícita:

> usar a credencial gravada **exige** que o tipo e o endpoint informados sejam os
> do próprio cadastro.

Sem ela, um administrador poderia apontar uma chave que ele não tem permissão de
ler para um endpoint próprio e lê-la do outro lado — transformando a rota num
vazador exatamente da credencial que este ADR existe para proteger. A amarra
está travada por teste em `test_provedor_por_espaco.py`.

## Alternativas consideradas

**Manter no ambiente.** É a regra anterior. Descartada pelo custo operacional de
um PR de infraestrutura para trocar um modelo.

**Guardar em texto puro no banco.** Descartada: a cifra custa pouco e é o que
separa "configuração no banco" de "credencial exposta no banco".

**Referenciar um segredo do vault por nome, sem guardar valor.** É o desenho mais
correto, e depende de o segredo existir no vault, que é pedido a outra equipe. O
`ExternalSecret` já está preparado no overlay como caminho de saída.

# ADR-0007 — O serviço é o próprio Authorization Server e federa o login ao Identity

- **Status:** Aceito
- **Data:** 2026-09-10
- **Relacionado:** [0005](0005-permissao-resolvida-no-servidor.md),
  [0006](0006-mcp-devolve-evidencia-nao-resposta.md),
  [decisao-token-mcp.md](../decisao-token-mcp.md) (registro longo, com as defesas
  e o que ficou de fora), ADR-0049 do agentic-sdlc

## Contexto

O editor de quem consulta (Claude Desktop, Claude Code, Cursor) precisa de uma
credencial para chamar o MCP. Nenhuma das que já existiam servia:

| | por que não |
|---|---|
| JWT do Identity | vive minutos e exige navegador. Um editor aberto a semana inteira não renova sozinho |
| token de serviço | não tem pessoa e carrega escopo de administração. Daria ao agente de qualquer um acesso a tudo, e a auditoria registraria "service-token" no lugar de quem perguntou |

A primeira decisão foi emitir **token pessoal** pela aplicação, colado na
configuração do editor. Estava errada, e a implementação mostrou por quê:

1. o token vazava para a conversa. O caminho "cole este prompt e o agente se
   configura" põe o segredo no histórico;
2. o Claude Desktop **não consegue** editar o arquivo de configuração. Ele executa
   comando num container isolado, e nada que escreva chega à máquina de quem
   pediu;
3. pedir caminho de arquivo é empurrar um problema nosso para quem só quer usar a
   base.

O que travava o desenho correto era uma premissa falsa: que OAuth exigiria
habilitar *dynamic client registration* no realm **compartilhado**, decisão de
outra equipe.

## Decisão

A premissa era falsa. **O kb-api é o próprio Authorization Server do MCP, e
federa o login ao Identity.**

```
cliente MCP → 401 + WWW-Authenticate → descobre os metadados
            → POST /oauth/register    (nós registramos, não o Identity)
            → GET  /oauth/authorize   → redireciona para o Identity
            → a pessoa faz o login DE VERDADE lá
            → /oauth/callback         → emitimos um código
            → POST /oauth/token       → access + refresh NOSSOS
```

O client usado contra o Identity é o `kb-ui`, o mesmo da interface, público e
com PKCE. **Nenhum client novo no realm.**

> Este ADR foi escrito quando o issuer era o Identity de outra organização e o
> realm era compartilhado, o que é a razão de a decisão insistir em "zero
> mudança no realm". O issuer passou a ser o Keycloak do Goga em
> [ADR-0023](0023-repontamento-para-o-keycloak-do-goga.md); o desenho não
> mudou, e o argumento ficou mais forte: o realm agora é nosso, e mesmo assim
> não precisamos de client novo nem de DCR.

As defesas (PKCE S256 obrigatório, `redirect_uri` validada no registro, código de
uso único marcado na mesma transação, rotação do refresh, hash de tudo e nunca o
valor) estão em [decisao-token-mcp.md](../decisao-token-mcp.md), com o que cada
uma evita.

## Consequências

Ganhos:

- **nenhum segredo na conversa.** A credencial nasce e vive dentro do editor,
  pelo protocolo;
- **os grupos deixam de ser fotografia.** O refresh token do Identity fica só no
  servidor e é usado a cada renovação para reler a identidade. Pessoa desativada
  lá perde o acesso aqui na renovação seguinte;
- **revogação real.** A pessoa vê os editores conectados e desconecta um a um.

Custos:

- **somos um Authorization Server.** Isso é responsabilidade de segurança de
  verdade, e o registro longo existe para que ela não seja esquecida;
- **sem tela de consentimento.** Quem já está logado é redirecionado e volta
  autorizado. O escopo é um só e de leitura, mas uma tela é o que tornaria
  visível *qual* editor está pedindo;
- **o token pessoal continua, como exceção**, fechado num `<details>` para editor
  sem opção de login, com o custo dito antes do botão.

## Alternativas consideradas

**Token pessoal como caminho principal.** Foi a decisão inicial e está registrada
como revertida acima, com os três motivos.

**Pedir DCR no realm compartilhado.** Desnecessária, e era a premissa que travava
tudo.

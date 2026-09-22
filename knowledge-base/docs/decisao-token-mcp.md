# Como o editor da pessoa se autentica no MCP

- **Status:** decidido e implementado — **revisado em 2026-09-09**
- **Relacionado:** [arquitetura.md](arquitetura.md) (permissão),
  ADR-0049 do agentic-sdlc (ponte MCP do desenvolvedor)

## A pergunta

O Claude Desktop e o Cursor precisam de uma credencial para chamar o MCP. Duas
formas eram plausíveis:

- **A — OAuth de verdade**: o editor descobre que o servidor pede login, se
  registra sozinho e abre o navegador. A pessoa clica em *Entrar*.
- **B — token pessoal** emitido pela aplicação, colado na configuração do editor.

O que já existia não servia para nenhum dos dois casos:

| | por que não |
|---|---|
| JWT do Identity | vive minutos e exige navegador; um editor aberto a semana inteira não renova sozinho |
| token de serviço | não tem pessoa e carrega o escopo de administração — daria ao agente de qualquer um acesso a tudo, e a auditoria registraria "service-token" em vez de quem perguntou |

## A primeira decisão foi B. Estava errada.

O argumento era: OAuth exigiria habilitar *dynamic client registration* no realm
**compartilhado**, e isso é decisão de infraestrutura de todo mundo. Verdadeiro —
mas eu tirei dele a conclusão errada.

O que a implementação de B revelou na prática:

1. **o token vazava para a conversa.** O caminho "cole este prompt no chat e o
   agente se configura" põe o segredo no histórico, que pode ser sincronizado ou
   compartilhado;
2. **o Claude Desktop não consegue editar o arquivo.** Ele executa comando num
   container isolado e efêmero — nada que ele escreva chega à máquina de quem
   pediu. O caminho simplesmente não funcionava para o editor mais usado;
3. **pedir caminho de arquivo é empurrar um problema nosso para o usuário.** Quem
   vai operar a base quer usá-la, não editar JSON.

Nada disso era teórico: apareceu na primeira tentativa real de conectar.

## A decisão atual: A — e sem tocar no realm

A premissa que me travou era falsa. **O kb-api não precisa que o Identity faça
DCR: ele mesmo é o Authorization Server, e federa o login ao Identity.**

```
cliente MCP → 401 + WWW-Authenticate → descobre os metadados
            → POST /oauth/register (nós registramos, não o Identity)
            → GET /oauth/authorize → redireciona para o Identity
            → a pessoa faz o login DE VERDADE lá
            → /oauth/callback → emitimos um código
            → POST /oauth/token → access + refresh NOSSOS
```

O client usado contra o Identity é o `kb-ui`, o mesmo da interface — público,
com PKCE, sem segredo para guardar. **Nenhum client novo no realm.**

### O que isso resolve

| | |
|---|---|
| nenhum segredo na conversa | a credencial nasce e vive dentro do editor, pelo protocolo |
| nenhum arquivo para editar | a configuração é só a URL; no Claude Desktop, nem isso — é a tela de conectores |
| **grupos deixam de ser fotografia** | o refresh token do Identity fica só no servidor e é usado a cada renovação (1 h) para reler a identidade. Pessoa desativada lá perde o acesso aqui na renovação seguinte |
| revogação de verdade | a pessoa vê os editores conectados e desconecta um a um |

### As defesas, e o que cada uma evita

| Defesa | O que evita |
|---|---|
| PKCE **S256 obrigatório** (`plain` recusado) | código interceptado no redirect ser trocado por qualquer um — cliente público não tem segredo para compensar |
| `redirect_uri` só https ou loopback, validada no registro | alguém registrar um cliente que aponta para servidor próprio e colher o código de quem clicar |
| erro de `client_id`/`redirect_uri` **não** volta pelo redirect | virar um redirecionador aberto — justamente com o parâmetro sob suspeita |
| código de uso único, marcado na mesma transação da leitura | dois resgates simultâneos virarem duas sessões |
| rotação do refresh a cada uso | refresh vazado continuar valendo; reutilizado, ele falha |
| access token de 1 h | janela de um token vazado |
| hash (SHA-256) de tudo, nunca o valor | vazamento do banco virar sessão |

Verificado ponta a ponta, no local e pelo túnel: registro → login real no
Identity → código → token → chamada ao MCP → renovação → rotação. Reuso de
código e de refresh antigo falham, e o access anterior devolve 401.

## O token pessoal continua, como exceção

Fechado num `<details>` chamado *"Meu editor não tem opção de login"*, com o
custo dito antes do botão: é um segredo em texto puro no disco e os grupos ficam
congelados no dia da emissão.

Formato `kbp_<43 chars>`, hash no banco, 90 dias, revogável, e **não emite outro
token** — se um vazasse, quem o tivesse não deveria cunhar credencial nova de
vida longa.

## O que ficou de fora

- **Tela de consentimento.** Hoje quem já está logado no Identity é redirecionado
  e volta autorizado, sem um "permitir que este editor acesse suas bases?". O
  escopo é um só e de leitura, e o cliente é registrado na hora — mas uma tela de
  consentimento é o que tornaria visível *qual* editor está pedindo.
- **Resource indicators (RFC 8707) amarrados.** O parâmetro `resource` é aceito e
  guardado, mas o token não é restrito a ele. Com um recurso só, não muda nada;
  com dois, passa a importar.
- **Aviso do ngrok grátis.** O túnel interpõe uma página de aviso em toda
  navegação de navegador, e ela aparece **no meio do login**. Um clique em *Visit
  Site* resolve por navegador; um domínio próprio elimina. A tela avisa, porque
  quem não espera por isso acha que a conexão falhou.

# ADR-0005 — O Espaço é a fronteira, e ela é aplicada em toda leitura

- **Status:** Aceito
- **Data:** 2026-09-10
- **Relacionado:** [0002](0002-indice-unico-em-postgres-com-pgvector.md),
  [0006](0006-mcp-devolve-evidencia-nao-resposta.md),
  [0007](0007-kb-api-como-authorization-server-do-mcp.md), requisitos FUN-08 e FUN-09

## Contexto

A base guarda documento de RH e de Jurídico. Quem alcança um não
necessariamente alcança o outro, e o vazamento aqui não é um bug de tela: é o
conteúdo de uma área inteira aparecendo para quem não deveria.

O agravante é o MCP. O agente de IA faz a mesma busca que a interface, com a
mesma API, e recebe um parâmetro `spaces` que ele mesmo escolhe. Se o filtro
fosse do cliente, bastaria o agente pedir outro Espaço.

Nas ferramentas avaliadas isso aparecia de três formas, todas insuficientes:
permissionamento só na edição Enterprise, escopo por chave de API única, e
segredo na própria URL do endpoint.

## Decisão

O **Espaço** é a unidade de permissão, e a resolução é **do servidor, em toda
leitura**.

- `space_grant` liga um Espaço a um princípio: grupo do Identity, role, object id
  do EntraID, e-mail nominal ou `public`;
- a cada requisição, o servidor resolve os Espaços alcançáveis pelo chamador a
  partir do token e monta a lista;
- o parâmetro `spaces` da busca e da tool MCP **só restringe**, nunca amplia. A
  interseção é feita no servidor;
- pedir um Espaço não alcançável devolve **vazio, não erro**. Erro confirmaria que
  o Espaço existe.

Grupo e role são tipos **separados** de propósito. Num realm corporativo os dois
são namespaces diferentes, e juntá-los faria um grant para o grupo
`/Funcionario/Admin` ser satisfeito por uma role de mesmo nome. Isso chegou a
existir no código e foi corrigido.

Além do grupo do Identity existe a tabela `kb_admin`, que promove administrador
**dentro da aplicação**. Sem ela, dar acesso administrativo dependeria de mexer
no realm compartilhado, que é decisão de outra equipe.

## Consequências

Ganhos:

- **nenhum parâmetro contorna.** Verificado com dois usuários reais em Espaços
  diferentes;
- **o MCP herda a fronteira de graça.** O agente consulta com o acesso da pessoa,
  não com um acesso de serviço;
- **auditoria nominal.** Toda busca fica registrada com quem perguntou.

Custos:

- **o filtro entra em toda consulta.** Esquecer num lugar novo é o modo de falha,
  e a defesa é o `narrow()` centralizado mais o fato de o escopo vir do
  `Principal`, não do payload;
- **base nova nasce invisível.** Só administradores a alcançam até alguém criar o
  vínculo. É o contrário do conveniente, e é deliberado: base nova com conteúdo
  visível por engano custa mais caro que base invisível;
- **depende dos grupos do realm.** Os nomes de grupo do ambiente de teste não
  existem no realm corporativo, então o vínculo é sempre explícito na criação.

## Alternativas consideradas

**Filtro no cliente.** Descartada de imediato: o MCP tornaria isso uma porta
aberta.

**Um índice por Espaço.** Descartada. Resolve o vazamento por construção, mas
multiplica o custo operacional e impede busca que atravessa Espaços para quem
tem acesso aos dois.

# ADR-0025 — O nível de confiança é filtro da busca, e não etiqueta no resultado

- **Status:** Aceito
- **Data:** 2026-09-21
- **Relacionado:** [0005](0005-permissao-resolvida-no-servidor.md),
  [0006](0006-mcp-devolve-evidencia-nao-resposta.md),
  [0015](0015-okf-como-formato-de-entrada.md),
  [0018](0018-wiki-destilada-como-segunda-representacao.md),
  [0026](0026-auditoria-do-conceito-registrada.md), migração 0017,
  requisitos BUS-01, FUN-08

## Contexto

O nível de confiança existe desde o ADR-0015, derivado de `verified` na escala
da especificação: `unverified`, `machine-confirmed`, `human-reviewed`. Ele era
**metadado exibido**. A busca devolvia tudo, a tela mostrava a etiqueta, e quem
precisava garantir que não citaria conteúdo não conferido conferia depois — lendo
o resultado, no ponto do fluxo em que ninguém quer parar.

Isso transfere uma garantia para o lugar errado. Quem consome a busca hoje é, na
maior parte das chamadas, um agente: ele recebe uma lista de passagens e monta
texto com elas. Uma etiqueta no meio do JSON é uma instrução que depende de o
consumidor lê-la e obedecê-la a cada chamada. Instrução que depende de
obediência não é garantia — é recomendação com aparência de garantia.

E há um agravante que só aparece com a wiki ligada: **página de wiki é texto que
um modelo escreveu** (ADR-0018). Ela entra na mesma lista do índice, com o mesmo
contrato, e a distinção fica por conta do campo `representation`. Quem lê rápido
cita a síntese achando que cita a fonte.

## Decisão

**`min_trust` é parâmetro da busca, no REST e na tool MCP, e o filtro roda na
consulta.**

`min_trust=machine-confirmed` devolve `machine-confirmed` e `human-reviewed`;
`min_trust=human-reviewed` devolve só `human-reviewed`. A escala é ordenada, e a
ordem é o contrato — `okf.TRUST_ESCALA` é tupla, não conjunto, exatamente por
isso.

**Sem `min_trust` nada muda.** O default é o comportamento de sempre, e isso não
é timidez: ligar o filtro por padrão mudaria o resultado de toda instalação
existente, inclusive as que não têm conceito OKF em documento nenhum, e o sintoma
seria "a busca parou de achar as coisas".

**Ausência de metadado é `unverified`.** Documento que não é conceito OKF não tem
`trust`, e ele **não passa** no filtro. Não ter sido conferido não é o mesmo que
ter sido conferido, e tratar a ausência como aprovação derrubaria o filtro
inteiro no dia em que alguém o ligasse numa base sem conceito nenhum — de novo,
em silêncio, com resultado abundante e errado.

**A wiki sai inteira acima de `unverified`.** Não há, hoje, fluxo que registre a
revisão humana de uma página destilada; toda página é texto gerado e não revisado
(ADR-0018). Então os dois métodos de acesso da wiki são **curto-circuitados**
quando o chamador pede conteúdo revisado: nem consulta ao banco, nem chamada de
embedding. O dia em que existir revisão de página, é este o ponto que muda, e a
decisão passa a ser por página.

**O filtro só restringe.** `min_trust` não alcança Espaço nenhum que o chamador
já não alcançasse: o escopo continua resolvido no servidor, a partir do
`Principal` (ADR-0005). Um parâmetro de requisição que só corta não é uma porta
de ampliação de escopo — e por isso ele pode vir do payload e da tool sem violar
a regra.

**Valor desconhecido é erro, não silêncio.** `min_trust=human_reviewed`, com
sublinhado no lugar do hífen, ignorado em silêncio, devolveria conteúdo não
revisado para quem pediu exatamente que ele não viesse, e a resposta pareceria
filtrada. O REST responde 400; a tool MCP responde `-32602` (argumento
inválido), e não erro interno: erro interno faz o agente tentar de novo igual.

**A descrição da tool diz o que SOME.** Está escrito nela que documento sem
metadado conta como `unverified`, que a wiki sai, e que resposta vazia com o
filtro ligado significa "a base não tem conteúdo conferido sobre isto", e não "o
assunto não existe". É a mesma regra do `improve_query`: a descrição existe para
o agente **decidir**, e decidir exige saber o custo.

## Consequências

Ganhos:

- **a trava passa a ser estrutural.** Quem precisa citar só conteúdo revisado
  pede `min_trust=human-reviewed` e o não revisado não é recuperado. Não há
  prompt a manter, nem revisão manual de resultado;
- **a wiki para de competir com a fonte** quando o chamador não aceita texto
  gerado, e para de custar embedding nessas chamadas;
- **o filtro é do produto, não de um domínio.** Qualquer base com conteúdo misto
  (rascunho e revisado, importado e conferido) usa o mesmo parâmetro.

Custos e limites:

- **quem não liga, não ganha nada.** A garantia existe para quem passa o
  parâmetro. Este serviço devolve evidência (ADR-0006) e não conhece as regras de
  quem consome — um default por consumidor teria de viver no consumidor;
- **o filtro é grosso: ele é do DOCUMENTO.** Um documento conferido em parte não
  tem como dizer isso. Trust por trecho exigiria conferência por trecho, que
  ninguém faz;
- **a contagem do que foi descartado não aparece na telemetria.** O corte
  acontece no `WHERE`, e o banco não conta o que não devolveu. É consequência
  direta de filtrar na consulta, e o inverso (contar em Python) custaria o
  defeito que a decisão evita;
- **mais um índice parcial em `document`** (migração 0017).

## Alternativas consideradas

**Manter a etiqueta e instruir o consumidor.** É o estado anterior. Descartada
porque garantia que depende de obediência do chamador não é garantia, e porque o
chamador principal é um modelo.

**Rebaixar o resultado no ranking em vez de removê-lo.** Tentador: nada some, o
não conferido só desce. Descartada — conteúdo não conferido em posição 4 é
citado como qualquer outro, e "menos provável de ser citado" não é uma promessa
que dê para fazer a quem pergunta se a peça pode usar aquilo.

**Filtrar em Python, depois da consulta.** Descartada pelo mesmo motivo do
ADR-0024: o `LIMIT` é do banco, e o que se descarta depois não é reposto.

**Amarrar `min_trust` ao token (um nível por `kb_token`).** Parecia mais seguro:
o consumidor não escolheria. Descartada porque o mesmo agente faz chamadas com
exigências diferentes na mesma tarefa (levantar contexto ≠ montar citação), e
amarrar ao token obrigaria a emitir dois tokens para o mesmo consumidor — com a
permissão de Espaço duplicada nos dois, que é o dado que ninguém quer duplicar.

**Um nível numérico em coluna própria, para comparar com `>=`.** Descartada:
introduz uma segunda representação da escala (número e nome) que precisa ser
mantida em sincronia com a da especificação. A lista de níveis aceitos resolve a
comparação ordenada no `= ANY(...)`, sem inventar aritmética.

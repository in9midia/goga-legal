# ADR-0018 — Wiki destilada: páginas OKF atômicas como segunda representação

- **Status:** Aceito
- **Data:** 2026-09-11
- **Relacionado:** [0001](0001-documento-canonico-como-fonte-de-verdade.md),
  [0006](0006-mcp-devolve-evidencia-nao-resposta.md),
  [0015](0015-okf-como-formato-de-entrada.md),
  [0017](0017-representacoes-por-espaco-e-busca-que-funde-metodos.md),
  requisitos ING-11, BUS-07

## Contexto

O índice responde bem à pergunta que usa as palavras do documento. Ele responde
mal à pergunta de alto nível — "como funciona o processo de férias?" — porque a
resposta está espalhada em seis trechos de três documentos, e o trecho é a
unidade de entrega.

A especificação prevê a **wiki destilada** como segunda representação (ING-11):
a LLM lê os documentos canônicos e mantém páginas atômicas em formato OKF. É o
contraste deliberado com a canonicalização — ela **preserva** o texto, a
destilação **reescreve**.

Duas coisas na especificação mudam o desenho de um jeito fácil de errar:

1. a LLM opera **com autonomia sobre a wiki do Espaço** (criar, editar, mesclar,
   reorganizar). Não é uma página por documento;
2. a página **não passa por chunking**. O controle de tamanho vem do contrato de
   destilação, e a rede de segurança é embedding multi-vetor por seção, onde
   *qualquer* vetor que casar devolve a página inteira.

## Decisão

**A wiki é a representação `wiki`**, ligável por Espaço (ADR-0017). Três tabelas
(migração 0007): `wiki_page`, `wiki_page_source` e `wiki_page_vector`.

**A destilação recebe o índice da wiki atual**, e não só o documento. É isso que
dá a autonomia: um documento novo sobre férias pode virar página nova ou ser
incorporado à página que já existe, e as duas saídas são corretas. A consequência
de esquema é direta — uma página deriva de **vários** documentos e um documento
alimenta **várias** páginas, então `wiki_page_source` é tabela, não campo.

**Contrato de destilação**, fixo no prompt: um conceito por página, 200 a 800
palavras, OKF puro (`type` obrigatório, mais `title`, `description`, `tags`),
referências cruzadas como links Markdown.

**`generated` e `sources` são do sistema**, não do modelo. Pedir que ele os
escreva convidaria a inventar id de documento, e a rastreabilidade dependeria de
o modelo acertar um número. O `resource` aponta para o **canônico**, nunca para o
bruto: a auditoria tem de cair no texto que o índice viu.

**Multi-vetor por seção, entrega da página inteira.** É o mesmo padrão do
pai/filho ("casar no pequeno, entregar o inteiro"), com uma diferença que muda o
código: aqui a unidade de entrega já nasceu pronta da destilação. No SQL isso é
um `DISTINCT ON (p.id)` — sem ele, uma página com seis seções que casem viraria
seis candidatos e dominaria o ranking por ter sido cortada em mais pedaços.

**`fetch` generalizado** (BUS-07): `/v1/wiki/pages/{id}` devolve a página inteira
com as referências cruzadas e os documentos de origem, e `/v1/documents/{id}`
passou a listar as páginas derivadas dele. A navegação anda nos dois sentidos.

**A tela diz que o texto é destilado.** Na busca, a passagem da wiki vem com
etiqueta própria; na tela da wiki, as fontes aparecem **antes** do conteúdo. Quem
lê precisa saber que está lendo uma síntese antes de ler a síntese.

## Consequências

Ganhos, medidos no e2e contra a stack real:

- **a wiki contribui evidência na mesma lista do índice**, fundida por RRF. A
  mesma pergunta traz o trecho do documento e a página que o sintetiza;
- **a destilação de fato reorganiza**: numa rodada o documento virou cinco
  páginas, noutra virou uma só que cobria tudo. As duas são corretas — é a
  autonomia funcionando, não instabilidade;
- **rastreabilidade fechada**: toda página registra a fonte, e o `fetch` navega
  da página para o documento e de volta.

Custos e armadilhas:

- **uma destilação por documento, no modelo de chat.** É a representação mais
  cara do sistema;
- **a wiki é regenerável, não idêntica.** Redestilar produz uma wiki válida
  equivalente, não uma cópia. Isso é da natureza da técnica, e a especificação já
  registra;
- **não há índice vetorial.** Medido: `column cannot have more than 2000
  dimensions for ivfflat index`, e o modelo em uso devolve 3072. É a mesma razão
  pela qual `chunk_embedding` nunca teve índice. Aceitável na escala de dezenas
  ou centenas de páginas por Espaço; quando deixar de ser, o caminho é reduzir a
  dimensão do embedding;
- **o piso de 200 palavras precisou ser ensinado.** Na primeira medição as
  páginas saíram com 189 a 198 palavras — fora do contrato por pouco. O prompt
  passou a mandar contar antes de responder, e a rodada seguinte deu 220 a 233;
- **o build da wiki falha sozinho.** A especificação pede isso explicitamente: os
  builds são independentes, e a falha de um não impede os outros. Um documento
  continua buscável pelo índice mesmo com a destilação quebrada.

## Alternativas consideradas

**A wiki como isca de recuperação: casar na página, entregar o trecho original.**
Foi a primeira proposta, e parecia mais alinhada ao ADR-0006. Descartada por
contrariar a especificação, que devolve a página como passagem — e a leitura dela
é melhor: a rastreabilidade vem do `sources` e do `fetch`, não de esconder o que
foi recuperado. A mitigação é a etiqueta na tela.

**Uma página por documento.** Mais simples e determinística. Descartada porque
joga fora justamente o que a destilação agrega: reunir o que está espalhado.

**Chunking na página.** Descartada pela especificação e pelo bom senso: a página
já nasce do tamanho certo, e cortá-la desfaria o trabalho que a destilação pagou.

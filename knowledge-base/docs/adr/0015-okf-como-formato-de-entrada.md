# ADR-0015 — Modo de ingestão é um eixo; OKF é o primeiro modo dele

- **Status:** Parcialmente substituído por
  [0017](0017-representacoes-por-espaco-e-busca-que-funde-metodos.md)

  ⚠ O que este ADR chamou de **"modo de ingestão"** foi reposicionado. A
  especificação do projeto modela a escolha como **conjunto de representações**
  ativas por Espaço, e o que aqui virou "modo `okf`" é, no vocabulário dela, a
  variante *Contextual Chunk Headers* do slot de **enriquecimento de chunk**,
  interno à representação-índice. O comportamento continua existindo e
  funcionando (`space.chunking.enrichment = "conceito"`); o que mudou foi o nome
  e o lugar conceitual. **O resto deste ADR continua valendo**: o formato OKF, a
  derivação de conceito por LLM, a regra de procedência e as armadilhas.
- **Data:** 2026-09-10
- **Relacionado:** [0001](0001-documento-canonico-como-fonte-de-verdade.md),
  [0003](0003-chunking-pai-filho-com-motor-por-espaco.md),
  [0006](0006-mcp-devolve-evidencia-nao-resposta.md),
  [0009](0009-provedores-de-ia-no-banco-cifrados.md),
  [0012](0012-grafo-como-representacao-auxiliar-derivada.md), requisitos ING-03,
  ING-04, ING-07, ING-11, ING-12

## Contexto

O **Open Knowledge Format** (OKF) é uma especificação aberta do Google Cloud
([GoogleCloudPlatform/knowledge-catalog](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md),
v0.2) para empacotar conhecimento de um jeito que um agente leia sem tradutor.
O formato é deliberadamente mínimo: um diretório de arquivos Markdown, cada um
um **conceito**, com frontmatter YAML no topo e links Markdown comuns entre
eles. `type` é o único campo sempre obrigatório, e não há registro de esquema
nem autoridade central.

Duas coisas estavam em jogo, e no começo só uma foi vista.

**A primeira**: ingerido como estava, um bundle OKF entrava neste sistema de um
jeito silenciosamente ruim:

- **o frontmatter virava prosa indexada.** `type: Metric` e
  `generated: {by: ...}` entravam no `tsv` e no vetor de cada conceito. A busca
  lexical passava a casar `type` em todos eles;
- **o título de todo conceito virava `---`.** O `_first_heading` lia a primeira
  linha não vazia do arquivo, e ela é o delimitador do YAML. Isso aparecia na
  tela e, pior, como fonte citada pelo agente;
- **o que o bundle tinha de melhor era jogado fora.** O OKF declara a que
  conceito cada trecho pertence e quais conceitos se referem a quais. Este
  projeto inferia a segunda coisa por termo compartilhado, que é um chute, e a
  primeira não tinha nem como inferir.

**A segunda**, e maior: **quase nada do que uma base corporativa recebe vem
escrito em OKF.** Medido nesta instalação no momento da decisão: 48 documentos
ativos, 25 PDFs, 13 binários diversos, 6 `.txt` e 4 Markdown — e dos 4 Markdown,
**zero** tinham frontmatter. Uma implementação que só soubesse *ler* OKF não
faria nada por nenhum documento que já está aqui; serviria apenas para um bundle
que alguém trouxesse de fora.

A pergunta era onde isso entra. A tela de Bases já tinha um diálogo com quatro
cartões de motor de corte, e um quinto cartão "OKF" custaria dez linhas.

## Decisão

**O modo de ingestão é um eixo ao lado dos motores, não um valor deles.**
`space.chunking` ganhou `mode`, ortogonal a `engine`.

O motor responde **onde cortar a prosa**. O modo responde **o que o pipeline faz
com o documento antes disso**. São perguntas diferentes, e as duas têm resposta
em todo documento.

Dois modos hoje, em `chunking.MODOS`:

| Modo | O que faz | Custo |
|---|---|---|
| `padrao` | extrai, corta e indexa. Nenhum metadado derivado | nenhum |
| `okf` | resolve um conceito por documento e põe a identidade dele em cada trecho | uma chamada de chat por documento não-OKF |

**É um eixo, e não um booleano, porque a lista vai crescer.** Uma destilação em
wiki (ING-11) ou uma ingestão que só alimenta o grafo são outros **modos**, não
outros motores nem outras chaves. Acrescentar um é: uma entrada em
`chunking.MODOS`, o comportamento no pipeline, e uma entrada no catálogo de
`/v1/chunking-engines`. **A tela não muda** — ela desenha o que o servidor
mandar, e nada nela conhece `okf` pelo nome (só os campos opcionais que apenas
um modo que classifica documento preenche).

**O modo não substitui o motor.** O conceito é metadado do documento *inteiro*:
diz o que ele é, não onde o corpo deve ser fatiado, e a especificação não limita
o tamanho de um conceito. Medido: um conceito de 200 caracteres dá 1 pai e 1
filho em qualquer motor; um de 15,5 mil dá 4 pais e 16 a 18 filhos conforme o
motor. O que muda com o modo é o *peso* da escolha do motor, não a necessidade
dela. Um modo que de fato não fatie nada (uma ingestão só para o grafo) declara
`uses_engine: false` no catálogo, e aí a tela apaga as seções de corte e tamanho
— sem precisar conhecer o modo pelo nome.

A primeira versão disto era `okf: boolean`. Virou enum quando ficou claro que
outros modos viriam: dois booleanos ao lado um do outro permitiriam ligar os
dois, e "OKF + só grafo" não quer dizer nada. A leitura do booleano antigo
continua em `_modo()`, para um Espaço gravado naquele formato não voltar em
silêncio para o padrão no primeiro deploy.

**Duas procedências, uma chave.** Com o modo ligado, o pipeline resolve o
conceito de cada documento em duas tentativas, nesta ordem (`okf.resolve`):

1. **escrito** — o arquivo abre com frontmatter YAML contendo `type`. O conceito
   é lido como está, e não custa nada;
2. **derivado** — qualquer outro formato (PDF, docx, planilha, Markdown comum).
   O provedor de `chat` recebe o começo do canônico e devolve `type`, `title`,
   `description` e `tags`, marcados com `generated: {by, at}`.

A ordem não é negociável, e é a única regra rígida aqui: **frontmatter escrito à
mão ganha do modelo sempre.** Ele foi redigido por quem conhece o documento,
pode trazer `verified` com um `human:<id>` de verdade, e deixar a derivação
passar por cima rebaixaria um conceito revisado a `unverified` a cada
reprocessamento — de graça, e ainda pagando uma chamada de IA para piorar o dado.

`generated` e `verified` são campos da própria especificação, não invenção
nossa. Por isso o nível de confiança de um conceito derivado sai `unverified`
sozinho, e um bundle exportado daqui continua dizendo a sua procedência em
qualquer outro consumidor de OKF.

**O vocabulário de tipos é da base.** `space.chunking.okf_types` lista os tipos
que o modelo pode escolher (o padrão da casa: Política, Procedimento, Manual,
Contrato, Norma, Ata, Relatório, Referência). Tipo fora da lista vira
`Documento`. Com tipo livre — que a especificação permite, por não ter taxonomia
fixa — 40 documentos rendem 31 tipos quase-duplicados ("Política", "Política
Interna", "Diretriz") e a etiqueta deixa de agrupar qualquer coisa.

**`purpose="chat"` é um provedor separado.** A tabela `ai_provider` já tinha a
coluna, e nenhum propósito além de `embedding` existia. São modelos diferentes
em quase toda instalação, e forçar o mesmo cadastro obrigaria a escolher entre
um bom embedding e um bom gerador.

Com um conceito resolvido, três pontos mudam, e só esses:

| Onde | O que muda |
|---|---|
| corte (`chunking.py`) | o frontmatter sai do texto cortado (quando existe), e a identidade do conceito (`tipo: título — descrição`) entra na frente de cada pai e de cada filho |
| documento (`ingest.py`) | o conceito é gravado em `document.okf`, e o `title` dele passa a valer mais que o primeiro cabeçalho do arquivo |
| grafo (`graph.py`) | cada link vira aresta `REFERENCES` declarada, ao lado das `MENTIONS` inferidas por termo. Só conceito **escrito** entra: um derivado não tem links, e criar o nó encheria o grafo de conceitos com grau zero |

O canônico gravado **continua tendo o frontmatter**. Ele é parte do arquivo, e
ADR-0001 diz que o canônico é o texto fiel do documento — o que muda é o que vai
para o índice, não o que fica registrado.

**Reconhecimento é conservador.** O arquivo só é conceito se abrir com
frontmatter YAML válido contendo `type` com valor. `---` no meio do texto é
regra horizontal em Markdown, e Markdown de gerador estático (Jekyll, Hugo) tem
frontmatter sem `type`.

**Tolerância é obrigatória.** A especificação proíbe o consumidor de recusar um
bundle por campo opcional ausente, `type` desconhecido, chave extra ou link
quebrado. O parser segue isso: `parse()` devolve `None` apenas quando o arquivo
não é OKF, nunca quando é um OKF imperfeito.

## Consequências

Ganhos:

- **o filho deixa de ser prosa anônima.** "o cálculo roda toda madrugada" não
  fica perto de pergunta nenhuma; com "Metric: Usuários ativos mensais" na
  frente, fica. Esse é o ganho central, e ele é de recuperação, não de exibição;
- **os relacionados passam a ter uma origem declarada.** A tela agora distingue
  "3 links OKF" de "8 termos": o primeiro é o que o autor do bundle escreveu, o
  segundo é inferência estatística;
- **vale para a base que já existe.** Era o ponto todo: sem a derivação, nenhum
  dos 48 documentos desta instalação seria reconhecido;
- **o título melhora onde ele era pior.** Num PDF de contrato, o primeiro
  cabeçalho costuma ser "CLÁUSULA PRIMEIRA" ou o nome do escritório no papel
  timbrado, e era isso que ia para a tela e para a citação do agente.

Custos:

- **o cabeçalho é repetido em todo trecho.** Em um bundle de 300 conceitos são
  300 repetições no texto indexado. O formato é de uma linha por isso, e a
  descrição é truncada em 300 caracteres;
- **a mudança não é retroativa**, pela mesma razão do motor: o que já está
  indexado mantém o corte antigo até ser reprocessado. E aqui pesa mais do que
  no motor — o modo muda o **texto indexado**, não só a fronteira do corte.
  Medido com `ts_rank_cd` do Postgres, no mesmo trecho: a pergunta "qual a
  política de alçadas de contratação" pontua **0,0000** sem o cabeçalho do
  conceito e **0,4000** com ele. Numa base com os dois modos convivendo, metade
  dos documentos responde e a outra metade não. Por isso `document.ingest_mode`
  (migração 0005) entra na conta de "desalinhado", ao lado de `chunk_engine`;
- **mais uma coluna em `document`** (migração 0003), com índice parcial;
- **uma chamada de IA por documento não-OKF**, na ingestão. É a mesma natureza
  de custo do motor `semantic`, e a tela diz isso antes de deixar ligar;
- **o projeto passou a gerar texto.** Até aqui só falava embedding, e não gerar
  era deliberado. O contrato do ADR-0006 continua valendo palavra por palavra:
  o texto gerado aqui vira **metadado do documento**, nunca resposta a uma
  pergunta de usuário. A busca e o MCP seguem devolvendo evidência;
- **sem provedor de `chat`, metade do recurso não acontece** — e em silêncio, se
  a tela não avisar. Por isso `/v1/chunking-engines` devolve `chat_provider`, e
  o diálogo mostra o aviso ao ligar a chave.

Quatro armadilhas que só apareceram implementando:

1. **o cabeçalho tem de entrar DEPOIS de localizar o trecho.** Ele vem do
   frontmatter, que foi retirado da prosa, então um trecho já prefixado não é
   encontrado no canônico: todo offset viraria `-1` e o documento inteiro
   perderia a página de cada evidência. Sem erro nenhum — a ingestão reporta
   sucesso, só a evidência passa a apontar para o arquivo em vez do lugar;
2. **o frontmatter é mascarado, não recortado.** Para localizar os trechos, o
   canônico é usado com o bloco YAML trocado por espaços do **mesmo tamanho**.
   Recortar deslocaria todo offset depois dele pelo tamanho do YAML;
3. **o nó `Concept` existe por causa da ordem de chegada.** Um bundle entra
   arquivo por arquivo, e o conceito A quase sempre referencia um B ainda não
   ingerido. Ligando documento a documento, essa aresta se perderia. Com o
   conceito como ponto de encontro, a ligação se fecha sozinha;
4. **`okf` ausente é `false`.** Todo Espaço já gravado tem `chunking` sem a
   chave, e nenhum deles pode mudar de comportamento por causa desta entrega;
5. **a derivação mora na ingestão, não no corte.** `chunking.plan()` recebe o
   conceito pronto e continua sem tocar a rede — é o que mantém os quatro
   motores testáveis sem provedor de IA nenhum;
6. **`llm.complete_json` nunca levanta.** Provedor ausente, rede fora, HTTP 400,
   modelo sem JSON mode, resposta que não é JSON: tudo vira `None`. Um documento
   sem metadado auxiliar continua perfeitamente buscável; um documento que não
   entrou, não. Esta base já perdeu quatro arquivos para um provedor de IA mal
   configurado (ver ADR-0009 e `test_reprocesso.py`), e a lição valeu aqui.

## Alternativas consideradas

**Um quinto cartão "OKF" entre os motores.** Descartada, e é a decisão deste
ADR. Dois problemas: o corpo de um conceito OKF tem cabeçalhos e ainda precisa
ser cortado, então escolher OKF significaria abrir mão do corte por estrutura; e
a base não é homogênea, então um "motor OKF" teria de decidir o corte dos PDFs
também, degradando em silêncio todo documento que não fosse OKF.

**Um booleano por modo, em vez de um enum.** Descartada assim que o segundo modo
apareceu no horizonte: `okf` e `wiki` ligados ao mesmo tempo não querem dizer
nada, e a tela teria de inventar regras de exclusão que o servidor não tem.

**Só derivar, ignorando o frontmatter escrito.** Seria uma chave com um
comportamento só, mais simples de explicar na tela. Descartada: descarta
metadado que já veio escrito e correto, e rebaixa conceito revisado a
`unverified` a cada reprocessamento.

**Detectar OKF sempre, sem chave na tela.** Tentador — a detecção é barata e
segura. Descartada porque mudaria o texto indexado de bases que nunca pediram
OKF, e reindexação silenciosa é exatamente o tipo de surpresa que este projeto
evita. A única exceção é o **título**: mostrar `---` nunca foi comportamento
pretendido em lugar nenhum, então essa correção vale sempre.

**Ingerir o bundle inteiro como um arquivo só (zip, ou `index.md` seguido).**
Descartada para esta entrega: quebraria o `document` por arquivo, que é a
unidade de permissão, de versão e de evidência do sistema inteiro. O custo é
conhecido e está registrado abaixo.

**Guardar o frontmatter em `document.tags`, que já existe.** Descartada: `tags`
é uma **lista** de rótulos do nosso domínio, e o frontmatter OKF é um **mapa** de
esquema aberto. Misturar exigiria inventar um prefixo, e a primeira colisão com
um `tags:` do próprio OKF seria silenciosa.

## O que ficou de fora

Registrado para não ser redescoberto:

- **`index.md` e `log.md` são reconhecidos como reservados, mas nada os trata.**
  Quem ingerir um bundle inteiro vai indexar o sumário como se fosse conceito.
  `okf.is_reserved()` existe e está testado; falta o filtro na carga em massa;
- **link é resolvido pelo nome final do arquivo**, não pelo caminho no bundle. A
  ingestão recebe arquivos avulsos e guarda `filename`, não a árvore. Dois
  conceitos homônimos em pastas diferentes do mesmo bundle ficam
  indistinguíveis;
- **`Attested Computation` não tem tratamento próprio.** É um conceito como
  outro qualquer, e os campos `runtime`, `computation` e `executor` ficam em
  `document.okf.meta` sem ninguém lê-los;
- **o projeto não *exporta* OKF.** Ele agora **deriva** conceito para dentro,
  mas gerar o bundle de saída (com `index.md`, `log.md` e os links entre
  conceitos) é outro caminho e não foi feito;
- **a derivação não inventa links.** Um PDF não referencia outros conceitos, e
  pedir isso ao modelo seria convidar alucinação. O grafo desses documentos
  continua saindo dos termos compartilhados;
- **a busca não muda de código, só de entrada.** Não há ramo por modo em
  `search.py`: os dois braços operam sobre o que a ingestão gravou. O ganho do
  modo `okf` é de **recuperação** e vem inteiro do texto indexado — no braço
  lexical porque o cabeçalho entra no `tsv`, e no vetorial porque entra no
  vetor do filho.
- **o `okf_derived` não vai para `ingest_run`.** O log de ingestão não separa o
  que custou chamada de IA; isso está na resposta da ingestão e, de forma
  durável, no `generated` de `document.okf`.

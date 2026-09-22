# ADR-0001 — De cada arquivo sai um Markdown limpo, e é ele que a busca indexa

- **Status:** Aceito
- **Data:** 2026-09-10
- **Relacionado:** [0008](0008-bruto-imutavel-com-backend-configuravel.md),
  [0013](0013-ocr-das-imagens-entra-no-canonico.md), requisitos ING-03 e ING-04

## Contexto

Uma base de conhecimento recebe PDF, DOCX, PPTX, XLSX e texto. A tentação óbvia
é indexar cada formato do jeito que ele vem, extraindo texto na hora da busca ou
guardando o resultado da extração como detalhe interno do índice.

Nas três ferramentas de mercado avaliadas (Onyx, RAGFlow e Dify) o texto
extraído não é um artefato visível. Ele existe dentro do pipeline e ninguém
consegue olhar para ele. A consequência prática apareceu na avaliação: quando um
resultado de busca vinha errado, não havia como saber se o problema era a
extração, o corte ou o ranking.

## Decisão

De cada arquivo sai um **documento canônico**: um Markdown limpo, guardado em
`document.canonical_md`, e **é ele que a busca indexa**. Todo o resto do
pipeline (corte, vetor, busca lexical, página do trecho) deriva desse texto e de
nada mais.

O canônico é conteúdo de primeira classe, não cache:

- fica visível na interface, lado a lado com o arquivo original;
- é imutável. Reingerir o mesmo arquivo cria uma versão nova e desativa a
  anterior, em vez de reescrever texto;
- qual extrator o produziu fica gravado em `document.extractor`, o que permite
  comparar técnicas depois.

## Consequências

Ganhos:

- **auditabilidade.** Quando a busca erra, dá para abrir o canônico e ver se o
  texto está lá. Isso encurtou várias investigações neste projeto;
- **reprocessamento sem reenvio.** Com o bruto preservado (ADR-0008) e o canônico
  separado, trocar de extrator ou de motor de corte não pede o arquivo de volta a
  quem enviou;
- **a página do trecho existe.** O canônico guarda a marca de página, e é dela
  que sai o "ir ao trecho no original".

Custos:

- **espaço.** O texto fica em duas formas, o bruto e o canônico. Medido nesta
  base: 180 MB de bruto contra 3,3 MB de canônico, então o custo é irrelevante
  na prática;
- **o canônico pode ficar velho.** Se o extrator melhorar, o texto já gravado
  continua o antigo até alguém reprocessar. É visível na tela (o documento mostra
  extrator e data), mas não se corrige sozinho.

## Alternativas consideradas

**Extrair na hora da busca.** Descartada por custo e por determinismo: a mesma
pergunta poderia devolver texto diferente conforme a versão da biblioteca
instalada no pod que atendeu.

**Guardar só os chunks, sem o texto inteiro.** Descartada porque perde o
contexto entre os cortes, e porque trocar o motor de corte passaria a exigir
reextração de tudo.

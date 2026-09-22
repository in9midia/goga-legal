# ADR-0013 — O que está escrito no print de tela passa a existir para a busca

- **Status:** Aceito
- **Data:** 2026-09-10
- **Relacionado:** [0001](0001-documento-canonico-como-fonte-de-verdade.md),
  [0008](0008-bruto-imutavel-com-backend-configuravel.md), requisito ING-04

## Contexto

Em manual de processo corporativo a instrução de verdade costuma estar no **print
de tela**, não no parágrafo. "Clique em Aprovar" é uma imagem, e o texto ao redor
diz apenas "conforme a tela abaixo".

Sem OCR esse conteúdo simplesmente **não existe** para a busca. O documento é
indexado, aparece na lista, e a pergunta sobre o que fazer na tela não encontra
nada, porque a resposta é um PNG.

Medido nesta base: 478 imagens extraídas, 281 com texto legível. A maior parte do
conteúdo acionável dos manuais estava nelas.

## Decisão

Cada imagem do documento é **extraída, guardada e passada por OCR**, e o texto
lido entra no canônico.

- as imagens vão para o object store, ao lado do bruto, e o ponteiro fica em
  `document_figure`;
- o OCR é o `tesseract` por CLI (`psm=3`, `lang=por+eng`);
- no canônico, cada figura entra como uma marca `<!-- figura fig-N -->` seguida
  do texto lido **e do link da imagem**. O link importa: quem lê o trecho na
  resposta consegue ver a imagem de onde ele saiu;
- a tela de documento tem uma aba de Imagens, cada uma com o que o OCR extraiu.

Duas decisões de qualidade que valem registrar:

- `escape_html=False` na exportação do docling. Com o padrão, "GH & VOCÊ" virava
  "GH &amp; VOCÊ" dentro do canônico;
- imagem sem texto legível **não recebe placeholder**. Um placeholder chegou a
  existir e virou título de documento, porque o extrator de título pega o
  primeiro cabeçalho. Foi removido, e o extrator de título ganhou um filtro.

## Consequências

Ganhos:

- **281 imagens de conteúdo passaram a ser encontráveis** nesta base;
- **a evidência fica completa.** O trecho vem com o link da imagem, então não é
  preciso confiar no OCR às cegas.

Custos:

- **memória.** OCR de documento com muitas imagens foi o que derrubou o pod com
  4 GiB. O limite subiu para 8 GiB, com teto acumulado de bytes de figura e
  liberação da imagem após codificar o PNG. É o maior consumo do serviço, e por
  isso o teto é o que é;
- **tempo.** A ingestão de um PDF de 121 páginas com 60 imagens levou 13,5
  minutos. Isso propagou para todo timeout do caminho (ingress, cliente,
  loadbalancer), e cada um deles já falhou uma vez por estar apertado;
- **OCR erra.** Texto em imagem de baixa resolução sai com ruído, e esse ruído
  vai para o índice. A mitigação é o link da imagem ao lado, que permite conferir.

## Alternativas consideradas

**Captioning por modelo de visão.** Descreveria a imagem em vez de transcrevê-la,
o que é melhor para foto e pior para print de tela, que é o caso dominante aqui.
Custaria uma chamada de modelo por imagem. Descartada por custo e por não
atender ao caso principal.

**Indexar só o texto do parágrafo.** É o comportamento anterior, e o Contexto
descreve o que ele perdia.

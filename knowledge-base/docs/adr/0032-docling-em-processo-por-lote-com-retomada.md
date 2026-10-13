# ADR-0032 — Cada lote do docling num processo próprio, com retomada por lote, e o escaneado direto ao tesseract

- **Status:** Aceito
- **Data:** 2026-10-13
- **Relacionado:** ADR-0031 (ingestão em pod), `retomada.py`, `hibrido.py`, requisito ING-03

## Contexto

A *Novíssima Gramática da Língua Portuguesa* (Cegalla), um livro escaneado
de umas 600 páginas, entrou pela pasta sincronizada do Google Drive e não
saiu mais da fila:

- **a memória crescia de lote em lote.** O docling convertia em lotes de 40
  páginas no mesmo processo, e mesmo soltando o resultado de cada lote a
  memória não voltava. No Job (limite de 4 Gi) passou de 3,5 GiB no terceiro
  lote. No kb-api, chegava às páginas 321-360 em ~2h20 e era OOMKilled;
- **cada tentativa recomeçava da página 1.** O ponto de retomada existente só
  guardava o que vem depois da extração. Foram 79 reinícios do kb-api em uma
  semana e 45 execuções do mesmo arquivo;
- **a busca pagava a conta.** O OCR tomava a CPU do único nó, e 64 de 552
  chamadas de `buscar_kb` do Studio passaram de 30 s entre 06 e 13/10.

E o livro nem precisava de OCR. É um escaneado que já traz a camada de texto
(quem gerou o PDF fez o OCR), e o texto sai limpo pelo PyMuPDF. A triagem do
`hibrido.py` mandou 687 das 695 páginas ao docling por "imagem", porque a
imagem do escaneado cobre a página inteira; com mais de 50% das páginas
marcadas, o arquivo foi inteiro ao docling, a ~25 s por página.

## Decisão

1. **Cada lote do docling roda num processo filho que sai no fim**
   (`KB_DOCLING_ISOLAR_LOTE`, ligado por padrão). O pai nunca importa o
   docling: no modo isolado, o kb-api e o Job não carregam torch. `spawn`, e
   não `fork`, porque o pai tem threads vivas. O filho lê o bruto de um arquivo
   temporário, e não pelo pipe.
2. **Lote cujo processo morre é dividido ao meio** e tentado de novo, até uma
   página. O pico de memória acompanha o tamanho do lote, então a divisão é o
   que faz um lote grande demais caber. Uma página sozinha que mata o processo
   faz o docling falhar, e a cadeia segue para o PyMuPDF.
3. **O resultado de cada lote fica no object store**
   (`_docling/<sha[:2]>/<sha>/<assinatura>/<faixa>.pkl`). A próxima tentativa,
   de qualquer execução e de qualquer Espaço, lê o que está pronto e só
   converte o que falta. A assinatura cobre a versão do docling e a
   configuração de OCR e de figuras; o lote guarda também quantas figuras
   vieram antes dele, porque a numeração `fig-N` é do documento. Os lotes saem
   do object store depois que o documento é gravado.
4. **Página escaneada com camada de texto sai pelo PyMuPDF.** Imagem cobrindo
   ao menos 90% da página (`KB_PDF_ESCANEADO_AREA`) com ao menos 300
   caracteres de texto (`KB_PDF_ESCANEADO_TEXTO_MIN`) não conta como "imagem"
   na triagem: a imagem é o fundo. Na Gramática, de 695 páginas, 9 continuam
   indo ao docling (8 sem texto e 1 imagem de verdade).
5. **PDF escaneado sem camada de texto vai ao tesseract direto** (`KB_PDF_OCR_DIRETO`, ligado), sem
   o docling: o PyMuPDF renderiza a página em tons de cinza
   (`KB_PDF_OCR_DPI`, 300) e o tesseract lê. Só quando o PDF é escaneado de
   fato, isto é, quando a fração de páginas sem texto passa do limite que antes
   mandava o arquivo inteiro ao docling. O OCR também grava por lote no ponto
   de retomada. O extrator aparece como `pymupdf+tesseract`.

## O que fica de fora

- **Tabela em Markdown nas páginas escaneadas.** O tesseract devolve o texto
  corrido. Num livro escaneado isso é aceitável; uma base de documentos
  escaneados cheios de tabela deveria desligar `KB_PDF_OCR_DIRETO`.
- **PDF digital com algumas páginas sem texto** continua mandando essas páginas
  ao docling: costumam ser diagrama ou print, e a figura com legenda vale o
  tempo.
- **PDF curto** (abaixo de `KB_PDF_HIBRIDO_MIN_PAGINAS`) continua indo inteiro
  ao docling, agora em lote isolado.
- **Custo do processo novo.** Cada lote recarrega os modelos do docling, de 5 a
  10 s. Num lote de 40 páginas que leva minutos, é ruído.
- **A detecção de orientação (OSD) do tesseract.** O docling 2.138 (o da imagem) chama
  `tesseract --psm 0 -l osd` em toda região, independente do `psm`
  configurado (armadilha 11 da arquitetura). Continua custando uma chamada por
  região nas páginas que ainda vão ao docling.

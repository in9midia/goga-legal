# ADR-0027 — Conteúdo que engana quem lê rápido chega com o aviso colado

- **Status:** Aceito
- **Data:** 2026-09-21
- **Relacionado:** [0006](0006-mcp-devolve-evidencia-nao-resposta.md),
  [0015](0015-okf-como-formato-de-entrada.md),
  [0018](0018-wiki-destilada-como-segunda-representacao.md),
  [0025](0025-nivel-de-confianca-como-filtro-da-busca.md)

## Contexto

Existe uma classe de conteúdo que é **correto e recuperável, e ainda assim
induz ao erro**: o trecho cujo sentido óbvio na leitura rápida é o inverso do
que ele diz. Não é conteúdo falso (o filtro de confiança não pega), nem conteúdo
revogado (o filtro de vigência não pega). Ele casa com a pergunta pelas palavras
certas e responde o contrário do que quem perguntou supôs.

O caso que motivou a entrega é um precedente de sentido invertido: uma tese
frequentemente citada como fundamento a favor, quando o que ela estabelece é uma
defesa contra. Mas o padrão é geral: a exceção que parece a regra, o exemplo do
"não faça assim" num manual, a cláusula revogada que sobrevive citada em outro
documento, o procedimento de fallback que parece o procedimento principal.

A saída natural seria uma segunda chamada: recuperar o trecho, depois consultar
se ele tem alguma ressalva. Ela não funciona, e o motivo é comportamental. **A
leitura errada acontece na primeira leitura.** Quem lê já entendeu o que achou
que estava escrito, e a segunda chamada só é feita por quem desconfiou — isto é,
por quem não precisava dela.

## Decisão

**`armadilha` é campo do conceito, e o aviso viaja dentro da passagem.**

```yaml
armadilha: "tese defensiva a conhecer, nunca fundamento ofensivo"
```

**Aceita texto ou booleano.** `armadilha: true` recebe um aviso genérico ("o
sentido óbvio na leitura rápida não é o que ele diz"); com texto, o texto é o
aviso. Aceitar os dois é a regra de tolerância do formato — quem escreve o
booleano está dizendo a mesma coisa, só sem explicar. O booleano atravessa o
JSONB como a string `"true"`, então a normalização reconhece as duas formas: sem
isso, a palavra `true` apareceria como aviso para quem lê.

**O campo sai em toda passagem, no mesmo objeto do texto.** `armadilha` é chave
do resultado da busca, ao lado de `content`, `score` e `page` — não de um
endpoint separado, não de um `fetch` posterior. O conteúdo enganoso e o aviso
sobre ele chegam na mesma leitura.

**O texto da evidência não é alterado.** A tentação era prefixar o aviso no
`content`, que garantiria a leitura. Foi recusado: `content` é texto do documento
(ADR-0001), e o contrato do ADR-0006 é que a tool devolve evidência, não texto
montado por nós. Misturar aviso com evidência criaria uma passagem que não existe
em documento nenhum, e ela seria citada como se existisse.

**A contagem vai para a telemetria.** `stages.fusao.armadilhas` diz quantas
passagens da resposta vinham marcadas. É por aí que a curadoria descobre que uma
armadilha está sendo recuperada com frequência — o que costuma significar que
falta, na base, o conteúdo que responde de verdade àquela pergunta.

**A marca é do curador, nunca do modelo.** A derivação de conceito
(`okf.derive`) não pede `armadilha`, e o contrato de destilação da wiki não a
menciona. Um modelo que decide sozinho o que engana produziria o pior dos dois
mundos: aviso onde não precisa (ruído que ensina a ignorar avisos) e ausência
onde precisa.

## Consequências

Ganhos:

- **o aviso chega antes do erro**, e não numa chamada que ninguém faria;
- **a marca é genérica.** Exceção que parece regra, exemplo negativo, fallback
  que parece principal: tudo usa o mesmo campo;
- **a descrição da tool MCP diz o que fazer com ele**, em uma frase: passagem com
  `armadilha` preenchido tem o sentido óbvio invertido, e o aviso se lê antes do
  trecho.

Custos e limites:

- **o aviso é do DOCUMENTO inteiro.** Toda passagem daquele documento carrega o
  mesmo texto, inclusive as que não têm nada de enganoso. É o mesmo limite do
  nível de confiança e da vigência, e a razão é a mesma: a unidade que alguém
  edita é o arquivo, não o trecho;
- **nada obriga o consumidor a ler.** O campo chega; obedecer é de quem lê. O que
  esta decisão garante é que a informação está presente no momento em que ela
  ainda muda alguma coisa;
- **a marca é manual, e envelhece.** Não há verificação de que uma armadilha
  continua sendo armadilha;
- **o aviso é limitado a 300 caracteres.** Ele é repetido em toda passagem
  daquele documento, e um parágrafo aqui competiria com a evidência pelo contexto
  do agente.

## Alternativas consideradas

**Prefixar o aviso no `content` da passagem.** Garantiria a leitura, e foi
recusada: inventa texto que não existe no documento e quebra o contrato de
evidência (ADR-0001, ADR-0006).

**Endpoint separado de ressalvas.** Descartada pelo motivo que abre este ADR: a
segunda chamada só é feita por quem já desconfiou.

**Rebaixar o nível de confiança do conteúdo marcado.** Descartada porque é outra
coisa: a armadilha é conferida, correta e confiável. Rebaixá-la misturaria "não
sei se isto é verdade" com "isto é verdade e você vai entender ao contrário",
e o filtro de confiança perderia o significado.

**Excluir o conteúdo marcado da busca.** Descartada: quem precisa da tese
defensiva é justamente quem vai enfrentá-la. Esconder o conteúdo tiraria da
resposta a informação que evita o erro.

# ADR-0006 — A tool entrega trecho com score e página, nunca texto gerado

- **Status:** Aceito
- **Data:** 2026-09-10
- **Relacionado:** [0004](0004-busca-hibrida-fundida-por-rrf.md),
  [0005](0005-permissao-resolvida-no-servidor.md), requisitos BUS-01 e BUS-07

## Contexto

Havia dois desenhos possíveis para a superfície de IA. No primeiro, o serviço
recebe a pergunta, busca, chama um modelo e devolve **a resposta**. No segundo,
devolve **os trechos** e quem redige é o modelo do editor de quem perguntou.

A avaliação das ferramentas de mercado mostrou o custo do primeiro desenho na
prática: com resposta gerada, quando ela está errada não há como saber se o erro
foi da recuperação ou da redação. E o resultado passa a depender do modelo que a
ferramenta escolheu, não do que o time usa.

## Decisão

As tools do MCP devolvem **evidência**:

- **`search`** devolve passagens com texto, documento, página, o score de cada
  braço e a posição em cada método;
- **`fetch`** devolve o documento canônico inteiro por id, com metadados e os
  relacionados pelo grafo;
- **`list_spaces`** devolve os Espaços que aquele chamador alcança.

Nenhuma chama modelo de linguagem. A única IA do serviço é o embedding
(ADR-0009), e ele serve à recuperação, não à redação.

## Consequências

Ganhos:

- **o erro fica localizável.** Trecho errado é problema de recuperação, resposta
  errada com trecho certo é problema do modelo de quem perguntou;
- **a fonte fica à vista.** Quem lê a resposta consegue abrir o documento na
  página exata e conferir;
- **o modelo é escolha de quem consome.** O serviço não impõe um;
- **custo previsível.** Nenhuma chamada de geração no caminho da busca.

Custos:

- **não é um "pergunte e receba".** Sem um cliente que redija (o editor com MCP,
  ou a pessoa lendo), o resultado é uma lista de trechos. A tela de Simulador
  existe justamente para isso ser inspecionável;
- **sem reranking por modelo.** Um reranker melhoraria a ordem, e seria a
  primeira IA a entrar no caminho de leitura. Ficou de fora.

## Desdobramento

Desde o [ADR-0015](0015-okf-como-formato-de-entrada.md) este serviço **gera
texto** num lugar: derivar o conceito OKF de um documento na ingestão (tipo,
título, descrição, tags). Isso **não** abre exceção ao que está decidido aqui. O
texto gerado ali é metadado do documento, produzido uma vez e gravado; a busca e
o MCP continuam devolvendo trecho com score e página, e nenhuma rota passou a
redigir resposta para uma pergunta.

A distinção que separa os dois casos: aqui o que se recusa é **responder pelo
usuário**. Classificar um arquivo na entrada não responde nada a ninguém.

## Alternativas consideradas

**Devolver resposta gerada.** Descartada pelas razões acima. É o desenho das três
candidatas avaliadas, e é o que torna o erro delas difícil de investigar.

**Devolver resposta gerada com as fontes anexas.** Mais honesta que a anterior,
mas ainda impõe o modelo e ainda paga geração em toda busca. Fica em aberto como
possibilidade de camada acima, fora deste serviço.

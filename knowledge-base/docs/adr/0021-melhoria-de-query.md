# ADR-0021 — Melhoria de query: reescrita e HyDE, desligadas por padrão

- **Status:** Aceito
- **Data:** 2026-09-13
- **Relacionado:** [0004](0004-busca-hibrida-fundida-por-rrf.md),
  [0006](0006-mcp-devolve-evidencia-nao-resposta.md),
  [0019](0019-busca-rapida-com-milhares-de-arquivos.md),
  [0020](0020-avaliacao-offline-com-ragas.md), requisitos BUS-02

## Contexto

Este ADR existe porque uma medição pediu. A avaliação offline (ADR-0020) mostrou
o limite prático da busca: com perguntas escritas nas palavras de quem pergunta
em vez das do manual, a recuperação falhava completamente em 7 de 16 casos.

O experimento que isolou a causa foi buscar o **mesmo documento** com dois
vocabulários:

| consulta | posição |
|---|---|
| "fazer um **intervalo do calendário** valer para uma instituição" | fora do top-40 |
| "vincular um **subperíodo letivo** a uma **unidade de ensino**" | 3ª |

O conteúdo é achável. O que falha é a distância de vocabulário — e o diagnóstico
foi mais fundo: **zero** dos fracassos era de ranking. O documento não aparecia
nem entre os quarenta candidatos, o que descarta reranking como conserto.

A especificação já previa a resposta, e a numeração importa: BUS-02 é
"melhoria de query como etapa opcional, desligada por padrão: rewrite e
step-back; HyDE como técnica de embedding de query". O critério declarado para
promover algo de onda 2 é "sempre uma evidência medida na onda 1" — e ela agora
existe.

## Decisão

**Dois slots, e não um.** A especificação os separa
([retrieval-pipeline §3](../proposal/docs/system-design/retrieval-pipeline.md)) e
a separação tem consequência prática:

- **F1, melhoria de query** reescreve o **texto**, que vale para todos os
  métodos, inclusive o lexical. Variantes `rewrite` e `step_back`;
- **F3, embedding de query** troca o **vetor** do método semântico sem tocar no
  texto que o lexical usa. É onde o HyDE vive.

Juntá-los seria errado na prática: o HyDE gera um parágrafo hipotético de cem
palavras, e mandar esse parágrafo para o braço lexical encheria a consulta de
termos inventados pelo modelo.

**Desligados por padrão**, como a especificação manda. Cada variante custa uma
chamada de LLM **antes** da busca, na frente de quem espera. Para um agente,
reformular é papel dele — ele tem a conversa inteira, a tool só vê a string.

**A escolha vem da chamada**, não do Espaço: é o consumidor que sabe se pode
pagar o custo. O simulador liga e desliga para medir, o benchmark roda A/B com o
mesmo conjunto, e o agente normalmente manda desligado.

**Falha do modelo devolve a pergunta original, não erro.** Mesma regra do método
de acesso que cai: uma busca com a pergunta crua é pior que uma com a pergunta
melhorada, e muito melhor que uma busca que não aconteceu.

**O HyDE concatena pergunta + parágrafo hipotético**, em vez de vetorizar só o
hipotético. Vetorizar só o texto inventado joga fora o sinal da pergunta real —
e quando o modelo inventa para o lado errado, o vetor vai junto.

**A query reescrita entra no trace.** Sem isso, uma busca que trouxe algo
inesperado fica sem explicação: quem audita vê a pergunta original e os
resultados de outra pergunta.

## O que foi medido

Recall determinístico sobre as 16 perguntas difíceis da base de 275 manuais —
o documento de origem apareceu no top-10?

| variante | achou | vs crua | latência mediana |
|---|---|---|---|
| crua | 7/16 | — | 377 ms |
| `rewrite` | 9/16 | +2 | 4.426 ms |
| `hyde` | 9/16 | +2 | 4.760 ms |
| **`rewrite` + `hyde`** | **11/16** | **+4** | 9.170 ms |
| `step_back` | **3/16** | **−4** | 3.638 ms |

Três leituras:

1. **funciona.** As duas juntas recuperam 4 dos 9 casos que a busca crua perdia;
2. **custa 24×.** De 377 ms para 9,2 s. Isso sozinho justifica o default off:
   ninguém quer pagar nove segundos numa busca interativa, e um agente que
   reformula sozinho paga isso à toa;
3. **`step_back` piora, e muito.** Generalizar a pergunta afasta do documento
   específico — o conserto para "qual o prazo?" não é "como funciona o RH?". A
   variante fica registrada e implementada, porque a especificação a nomeia, mas
   com a medição ao lado na própria tela.

E o A/B completo, com as métricas Ragas sobre as **mesmas 32 perguntas**, com e
sem o slot — que é o que o benchmark existe para fazer:

| conjunto | | harmônica | `context_recall` | diagnósticos |
|---|---|---|---|---|
| difíceis | sem | 0,340 | 0,505 | 3 ok · **9 falharam** · 4 fracas |
| difíceis | **com** | **0,661** | **0,854** | **9 ok · 2 falharam** · 5 fracas |
| diretas | sem | 0,824 | 1,000 | 14 ok · 2 fracas |
| diretas | com | 0,880 | 1,000 | 14 ok · 2 fracas |

Nas difíceis: a nota quase dobra e as falhas completas caem de nove para duas.
Nas diretas, onde a recuperação já ia bem, o ganho aparece na **precisão** do
contexto (0,700 → 0,785): a reescrita acrescenta o sinônimo do domínio, e o
conjunto devolvido fica menos poluído. Ou seja, o slot não serve só para salvar
o caso difícil — ele também limpa o caso fácil.

Uma observação de método: numa sonda anterior com **dois** casos, `rewrite+hyde`
parecia piorar. Com dezesseis, é a melhor. Amostra pequena não decide — e foi por
isso que a varredura determinística (rápida, sem juiz) veio antes de gastar uma
execução completa de Ragas.

## Consequências

Ganhos:

- **o caminho de conserto está aberto e medido**, com o A/B embutido no
  benchmark: mesma lista de perguntas, com e sem, diferença atribuível ao slot;
- **o gasto aparece.** Os tokens da melhoria entram no total da busca; deixá-los
  de fora faria a comparação parecer de graça.

Custos e armadilhas:

- **latência.** Nove segundos é muito, e a decisão de ligar é de quem chama;
- **a reescrita pode errar o alvo.** Medido: para "intervalo do calendário" o
  modelo propôs "período específico", e não "subperíodo letivo" — que era o termo
  do manual. A técnica atravessa distância de vocabulário comum, não jargão
  interno arbitrário. Para esse caso, o caminho é do lado do índice (doc
  augmentation), não do lado da query;
- **quatro dos dezesseis continuam fora.** O slot melhora, não resolve.

## Alternativas consideradas

**Reranking (BUS-06).** Era a melhoria mais óbvia de recomendar. Descartada por
medição: zero dos fracassos era de ranking, e reranquear não muda nada quando o
documento não está entre os candidatos.

**Ligar por padrão.** Descartada pela especificação e pela latência medida.

**Configurar por Espaço em vez de por chamada.** O slot é do consumidor, não do
conteúdo: o mesmo Espaço é consultado por um agente (que reformula sozinho) e por
uma tela (que não). Por Espaço obrigaria os dois à mesma escolha.

## O que fica para depois

- **doc augmentation** (perguntas hipotéticas por chunk, onda 2 na taxonomia):
  ataca a mesma lacuna pelo lado do índice, e agora há como comparar as duas por
  medição em vez de por preferência;
- **calibrar quando ligar automaticamente** — por exemplo, ligar só quando a
  primeira passada volta com score baixo. Isso é roteamento, e depende de
  threshold calibrado, que continua em zero.

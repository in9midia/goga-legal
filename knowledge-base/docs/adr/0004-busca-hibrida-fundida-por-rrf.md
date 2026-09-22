# ADR-0004 — Dois braços independentes, fundidos por posição

- **Status:** Aceito
- **Data:** 2026-09-10
- **Relacionado:** [0002](0002-indice-unico-em-postgres-com-pgvector.md),
  [0006](0006-mcp-devolve-evidencia-nao-resposta.md), requisitos BUS-01 e BUS-03

## Contexto

Nenhum dos dois métodos de busca resolve sozinho, e as falhas são
complementares:

- o **vetorial** perde sigla, código de documento e número de norma. "POL-CORP-01-002"
  não tem vizinhança semântica;
- o **lexical** perde sinônimo e paráfrase. Pergunta que não repete as palavras
  do documento não encontra nada.

Combinar os dois exige uma decisão sobre como misturar. Somar os scores não
funciona: as escalas não são comparáveis (distância cosseno contra `ts_rank_cd`),
e a normalização depende da distribuição do resultado, que muda a cada consulta.

## Decisão

Os dois braços rodam **independentes**, cada um devolvendo um pool de candidatos
(40 por padrão), e são fundidos por **Reciprocal Rank Fusion** com `k = 60`.

O RRF usa apenas a **posição** de cada documento em cada lista, nunca o score
absoluto. Isso o torna imune à diferença de escala, que era o problema.

Depois da fusão, o filho vencedor é expandido para o pai (ADR-0003) e a resposta
sai com os dois scores separados, mais a posição em cada método.

Para o braço lexical, três detalhes que custaram caro:

- `unaccent` é obrigatório. Sem ele, "férias" indexa com acento e a consulta sem
  acento (como as pessoas escrevem) não casa com nada. O sintoma era o braço
  lexical devolver zero em quase toda pergunta, sem erro;
- os lexemas são unidos por **OR**, não AND. Com AND, uma palavra fora do
  documento zera o braço inteiro;
- `ts_rank_cd` e não `ts_rank`, porque a proximidade entre os termos importa.

## Consequências

Ganhos:

- **cada braço cobre o buraco do outro**, e a fusão não precisa de calibração;
- **a evidência é auditável.** A resposta mostra o score de cada braço e a
  posição em cada um, então dá para entender por que um trecho ganhou;
- **degradação graciosa.** Sem provedor de IA a busca continua funcionando, só
  lexical.

Custos:

- **duas consultas por pergunta**, em vez de uma;
- **o `k = 60` é herdado da literatura, não calibrado nesta base.** Funciona, mas
  ninguém mediu se 40 ou 80 seriam melhores aqui;
- **sem reranking.** O pool fundido vai direto para a resposta. É a melhoria mais
  óbvia que ficou de fora.

## Alternativas consideradas

**Score combinado com peso.** Descartada pelo problema de escala descrito acima.
Exigiria recalibrar a cada troca de modelo de embedding.

**Só um braço, escolhido por heurística na query.** Descartada: a heurística
erra, e quando erra não há segundo braço para salvar.

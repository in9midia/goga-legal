# Repertório do Goga: o que é configuração, o que é conteúdo

Os artefatos versionados, e os scripts que os aplicam contra uma KB de pé.

| O quê | Onde | Aplica com |
|---|---|---|
| Os provedores de IA (Gemini embedding, DeepSeek chat) | `scripts/register-providers.py` | chaves em `GEMINI_API_KEY` e `DEEPSEEK_API_KEY`, só no ambiente |
| Os 17 Espaços da §2.1, os 5 do MVP e as permissões | [`spaces.yaml`](spaces.yaml) | `scripts/apply-spaces.py` |
| O seed da auditoria de citações | [`auditoria-citacoes/`](auditoria-citacoes/) | `scripts/ingest.sh <slug> content/auditoria-citacoes/<slug> --label "<o rótulo do spaces.yaml>"` |
| A legislação primária (Planalto) | [`legislacao/`](legislacao/) | `scripts/fetch-legislacao.py [--only l14905] [--ingest]` |
| Os modelos de documento | [`modelos/`](modelos/) | `scripts/ingest.sh`, e `scripts/export-templates.py` para o Studio |
| Os conjuntos de avaliação da onda 1 | [`evaluation/`](evaluation/) | `scripts/load-evaluation.py` |

**Tudo de uma vez:** `scripts/populate-kb.sh` (fase F1 do `planning/00-MVP-PLANO.md`)
roda provedores → Espaços → auditoria → legislação → modelos → Espaços de novo →
export dos templates, e para com mensagem clara se faltar uma das duas chaves.

Fonte normativa de tudo aqui: `planning/02-BASE-CONHECIMENTO.md`. Onde este
README diverge dela, a divergência está dita e justificada.

```bash
cd services/kb-api
uv run -- python ../../scripts/apply-spaces.py --dry-run
uv run -- python ../../scripts/apply-spaces.py
uv run -- python ../../scripts/load-evaluation.py
```

> **Armadilha do `ingest.sh`.** Ele cria o Espaço antes de subir os arquivos,
> com rótulo `Base <SLUG>` e descrição vazia — e o upsert **sobrescreve** o que
> o `spaces.yaml` gravou. Passe `--label` com o rótulo do arquivo, ou rode o
> `apply-spaces.py` de novo depois: ele reconverge sem duplicar nada.

---

## 1. `spaces.yaml` — Espaços e permissões

Os 5 Espaços do MVP (`telecom-essenciais`, `transito-veiculos`, `educacao`,
`extrajudicial`, `encaminhamento`) vêm do `planning/00-MVP-PLANO.md` §5.4 item 2,
estão no fim do arquivo com `onda: mvp` e ganham grant só das competências que o
plano nomeia (16, 21 e 54, 22, 52, 5). O resto desta seção vale para os 17.

Os 17 Espaços da §2.1, com motor de corte (§3.1), representação wiki (§6) e onda
(§10); as identidades de runtime com o alcance de leitura de cada uma (§2.2); e
os dois grupos humanos.

**A permissão é o produto aqui, não os Espaços.** Um Espaço a mais é barato; um
grant a mais é um especialista de aéreo lendo repertório bancário, sem nada
falhar e sem nada aparecer. Por isso cada linha de `agents` carrega o `motivo`
que a deriva da §2.1 e do `planning/competencias/INDEX.md`, e por isso
`tests/test_repertorio_do_goga.py` confere que nenhuma identidade alcança os 17.

### O `especialista` aparece uma vez por competência

A §2.2 pede "um token de serviço por agente de runtime". O `especialista` é um
runtime só, parametrizado (D-02) — se ele tivesse uma identidade só, ela
alcançaria os catorze Espaços de mérito somados, e
`planning/05-IDENTIDADE-E-DADOS.md` §3 diz o contrário com todas as letras: "o
`especialista` de aéreo não alcança `bancario`". A instância parametrizada é o
agente de runtime para efeito de identidade. O processo é um; a credencial não.

### Divergência de nome do grupo de curadoria

A §2.2 escreve `curadoria-juridica`. O realm `goga-interno`, o ADR-0023 e o
`KB_ADMIN_GROUP` da instalação já fixaram **`/goga/curadoria`**. Este arquivo
segue o que existe; criar o nome do plano criaria um grupo que não existe em
lugar nenhum.

### Divergência sobre onde fica o responsável técnico

A §2.2 põe o advogado responsável técnico dentro do grupo de curadoria (com
escrita). O ADR-0023 é posterior e mais específico: o responsável técnico "entra
na KB para revisar e assinar (`human-reviewed`). Precisa **ler** o que assina,
não criar Espaço nem cadastrar credencial de modelo". Este arquivo segue o
ADR-0023: `/goga/responsavel-tecnico` com leitura em todos os Espaços.

---

## 2. `auditoria-citacoes/` — o seed da §5.1

Os 43 itens de `research/auditoria_citacoes.md` como conceitos OKF prontos para
ingerir, no frontmatter da §4 do plano, um diretório por Espaço.

| Seção da auditoria | Itens | Conceitos | `auditoria.status` | Nível de confiança derivado |
|---|---|---|---|---|
| §1 verificados e corrigidos | 20 | 42 (a correção **e** o erro; a Súmula 385 em dois Espaços) | `verificada-corrigida` | `machine-confirmed` |
| §2 em verificação | 9 | 9 | `em-verificacao` | `unverified` |
| §3 verificados e mantidos | 14 | 14 | `verificada-mantida` | `machine-confirmed` |
| §4 lacuna normativa incorporada | 2 | 2 | `incorporada-sem-conferencia` | `unverified` |

**67 arquivos.** Os 9 itens `em-verificacao` levam também `verified: false` e
`armadilha` com o aviso "Citação EM VERIFICAÇÃO": o nível já sai `unverified`,
mas o aviso colado chega a quem busca sem `min_trust`, e é ele que a skill
`verificar_citacao` do Studio lê para bloquear (§5.4 item 5 do plano do MVP).

Os resíduos que a auditoria corrigiu e que ainda estavam no texto da pesquisa
(Tema 898/STJ, art. 2º da Lei 10.259/2001, art. 44 da Lei 8.245/91 e Lei
14.870/2024) foram corrigidos em `research/habilidades_juridicas_agentes(1).md`.
O `.docx` de mesmo nome **não** foi alterado e ainda os contém.

O nível de confiança é derivado, nunca declarado (ADR-0015 e
ADR-0025): nenhum arquivo aqui escreve o nível, e nenhum nasce `human-reviewed`
— esse é a assinatura do responsável técnico, etapa 4 do pipeline (§8), e é o
único nível que abre a zona amarela.

### Por que o erro original entra como conceito

§5.1. Um aviso que não chega ao agente que erraria é um aviso que não existe. O
erro entra com `armadilha`, e o aviso viaja colado a toda passagem recuperada
(ADR-0027). A marca está nos 20 registros de erro; está **também** no conceito
correto da Súmula 385/STJ, que é o caso que a §5.1 nomeia: ela tem sentido
**oposto** ao que se supunha, então quem a recupera pelo enunciado certo pode
estar chegando pela lembrança errada.

Nos demais, o conceito correto aponta para o registro do erro por link Markdown
— que o OKF já transforma em aresta do grafo — em vez de carregar a marca. Pôr
`armadilha` nos 20 enunciados corretos diluiria o sinal: o aviso passaria a
aparecer em quase toda passagem, e deixaria de significar alguma coisa.

### Como cada item foi arquivado num Espaço

Regra, nesta ordem:

1. se a coluna "Repertório" da §2.1 **nomeia** a norma ou o precedente, o item
   entra nesse Espaço (ex.: `bancario` nomeia a Lei 14.181/2021 e as Súmulas
   297 e 479);
2. senão, entra nos Espaços das competências que a coluna "Onde" da auditoria
   nomeia, no **conjunto mínimo** que faz toda competência citada alcançar pelo
   menos uma cópia;
3. `calculo-monetario` só recebe item cujo objeto é cálculo, correção, juros ou
   tabela de dano moral — é a definição do próprio Espaço na §2.1;
4. `etica-regulatorio` e `estilo-peca` são repertório operacional e não recebem
   item de mérito.

**Um item pode ficar em dois Espaços.** É o caso da Súmula 385/STJ: a auditoria
a atribui aos Agentes 15, 19 e 23, e o 15 lê `bancario` enquanto o 19 e o 23
leem `cdc`. Uma cópia só deixaria metade dos agentes sem o aviso. As cópias são
byte a byte idênticas, e há teste que prova isso — duplicar conteúdo é o preço
do alcance; duplicar conteúdo divergente é defeito.

Os itens da §3 não têm coluna "Onde". Para eles vale a regra 1 e, na falta dela,
a competência que cita o item em `planning/competencias/`.

### Lacunas registradas

- **item 29** (Súmulas 239, 269, 308 e 541/STJ): a auditoria diz "nos contextos
  indicados" e os contextos foram neutralizados no texto de origem. Nenhum
  documento do repositório diz onde essas súmulas eram citadas. O Espaço (`cdc`)
  é **atribuição provisória da curadoria, não do documento**, e está dito dentro
  do próprio conceito. Como o item é `em-verificacao`, ele não alcança parecer
  nem peça em Espaço nenhum;
- **item 11** (art. 3º da Lei 10.259/2001): a coluna "Onde" cita o Guardrail 4 e
  o Agente 10, e a competência 10 não tem Espaço na §2.1. Arquivado em
  `processual-civil` por objeto, também por atribuição da curadoria;
- **item 41** (art. 784, III, do CPC): arquivado em `processual-civil` porque a
  §2.1 nomeia o CPC/2015 ali. A competência 47, que é quem cita o dispositivo,
  alcança `bancario` e `calculo-monetario` e **não** alcança `processual-civil`.
  O núcleo contratual (45–48) tem necessidade de repertório que a §2.1 não
  cobre, e isso precisa de decisão;
- **`conferido_em` fica vazio em todos**. O documento de auditoria não tem data.
  Preencher com a data em que o arquivo foi escrito afirmaria uma conferência
  que não aconteceu naquele dia;
- **`vigencia` não aparece em nenhum**. A auditoria não fixa vigência de nada, e
  conceito sem vigência é tratado como sempre válido (ADR-0024), que é o lado
  seguro. Vigência entra quando o texto normativo for ingerido.

### `verified: machine:auditoria-de-citacoes`

A conferência da auditoria foi trabalho humano, e mesmo assim entra no nível
`machine-confirmed`. É o que a §5.1 determina, e a razão é sadia: `human-reviewed`
é a assinatura do responsável técnico sobre o repertório **da base**, e é ela que
abre a zona amarela. A auditoria conferiu citações num documento de pesquisa, o
que é menos do que isso.

---

## 3. `legislacao/` e `modelos/` — o texto normativo e os modelos

**`legislacao/<espaço>/`**: gerado pelo `scripts/fetch-legislacao.py` a partir do
texto compilado do Planalto, sem a redação riscada (revogada), com cada artigo
como heading para o motor `markdown` cortar por artigo. CC e CPC saem divididos
por Livro; CDC, CLT, CTN e Lei 8.213 por Título; CTB por Capítulo. Cada arquivo
leva `verified: machine:planalto` (nível `machine-confirmed`) e a URL de origem.
Só a Lei 14.905/2024 está versionada; o resto se baixa com o script. Três
divergências da lista do plano, ditas no próprio script: a Resolução ANAC 400 não
está no Planalto e fica para coleta manual; o Decreto 6.523/2008 foi revogado, e
entra o Decreto 11.034/2022 no lugar; a CF entra só com os artigos listados.

**`modelos/<espaço>/`**: os 13 modelos do §5.4 item 6 (reclamação por canal,
notificações, requerimento ao ente público, checklists dos Agentes 53 e 54), em
OKF `type: Modelo`, com os campos `{{campo}}` declarados no frontmatter. Nascem
`unverified`: ninguém assinou ainda. O mesmo modelo em dois Espaços é cópia
idêntica, e `studio/api/seed/templates.json` é **gerado** deles pelo
`scripts/export-templates.py` (o teste recusa JSON desatualizado).

## 4. `evaluation/` — os conjuntos da onda 1

Cinco arquivos, 50 perguntas cada, 25 em cada voz.

### As duas vozes são as duas estratégias que o harness já tem

Não é apelido. A estratégia `dificil` do `benchmark.py` é definida como "as
palavras de quem pergunta, e não as do documento", que é exatamente a voz do
leigo; a `direta` usa os termos do repertório, que é a voz do técnico.

```
voz de leigo   → strategy: dificil  (+ kind, do vocabulário fixo de TIPOS_DIFICEIS)
voz de técnico → strategy: direta
```

Gravar a voz na coluna `strategy` é o que deixa o relatório comparar os dois
grupos. A migração 0010 existe por isso, depois de uma execução em que o
`context_recall` deu 1,0 em todas as perguntas porque o conjunto era fácil por
construção. Sem a coluna, as duas vozes caem no mesmo grupo e a comparação passa
a ser de um conjunto consigo mesmo.

### Nenhuma pergunta tem gabarito, e isso é a regra-mãe

`reference` está vazio nas 250. Gabarito aqui seria afirmação de direito, e o
repertório ainda não foi ingerido — a única fonte possível seria a memória de
quem escreve, que é exatamente a fonte que o produto existe para não usar (R4).

A consequência, dita em voz alta: sem gabarito, **`context_precision`,
`context_recall` e `answer_correctness` não são medíveis**. `faithfulness` e
`answer_relevancy` são. O esquema admite `reference` vazio de propósito
(migração 0009), e o preenchimento é da etapa 4 do pipeline (§8).

Pela mesma regra, a pergunta cita o dispositivo pelo número mas não diz o que ele
diz: "O que o art. 26 do CDC dispõe sobre prazo de reclamação por vício
aparente?" é pergunta; "o art. 26 do CDC dá 90 dias" seria afirmação.

---

## 5. O que está bloqueado, e por quê

| O quê | Por quê |
|---|---|
| **Ingestão (seed, legislação, modelos)** | Pronta no `scripts/populate-kb.sh`, e depende só das chaves do Gemini e do DeepSeek no ambiente do operador (ADR-0009). Sem elas o upload falha no embedding |
| **Baseline Ragas** | Exige modelo de chat e conteúdo indexado. Sem os dois, a execução mede o vazio |
| **Revisão humana** | É do advogado responsável técnico (etapa 4 do pipeline, trilha R). É ela que promove `machine-confirmed` a `human-reviewed` e abre a zona amarela |
| **Token de serviço por agente** | A KB tem **um** token de serviço estático (`KB_SERVICE_TOKEN` + `KB_SERVICE_TOKEN_GROUPS`), e o token pessoal exige login de pessoa. Os grants por agente já estão aplicados e valem; o que falta é a credencial por agente, que `planning/05-IDENTIDADE-E-DADOS.md` §3 registra como ADR novo a escrever |
| **Grupos do realm** | Os grupos `/goga/agentes/*` não existem no realm `goga-interno`. O grant não depende disso para ser gravado, mas depende para ser satisfeito: sem o grupo no Identity, nenhum token carrega o claim |

### O motor de corte da §3.1 não cabe no Espaço

A §3.1 pede `markdown` para normativa e precedentes e `semantic` para
doutrinária. O motor é do **Espaço** (`space.chunking`), e as três camadas da §3
convivem dentro do mesmo Espaço; o upload de documento não aceita motor próprio.
Os 17 ficam em `markdown`, que é o certo para o que a onda 1 ingere. Manual de
doutrina entrando num destes Espaços seria cortado por heading, que é o que a
§3.1 quer evitar — **onde a camada doutrinária mora é decisão em aberto**, e as
saídas possíveis são um Espaço próprio por área ou motor por documento.

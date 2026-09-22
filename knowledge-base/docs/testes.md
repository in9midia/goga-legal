# Testes

Este documento diz o que é testado, o que **não** é, e por quê. A segunda parte
importa mais: relatar como verificado o que não foi exercitado é o único jeito de
uma suíte verde piorar a confiança no sistema.

## O que existe

### Unitários do kb-api (`services/kb-api/tests/`)

Cobrem lógica pura, que roda sem banco, sem rede e sem cluster:

| Arquivo | O que protege |
|---|---|
| `test_migrate.py` | descoberta, ordenação, checksum e idempotência do runner de migração |
| `test_storage_filesystem.py` | o backend de disco: ida e volta, escrita atômica, e **path traversal** |
| `test_providers.py` | cifra da credencial, os quatro dialetos de provedor, e que a telemetria nunca levanta |
| `test_reprocesso.py` | que a falha no reprocessamento **não** custa o documento: `force` em vez de apagar antes |
| `test_okf.py` | reconhecimento e tolerância do OKF, a regra de procedência (escrito ganha do derivado), e que com o modo desligado nada muda |
| `test_llm.py` | como o pedido de chat é montado em cada dialeto, e que toda falha vira `None` em vez de exceção |
| `test_representacoes.py` | representações como conjunto, o caso das trinta bases, o contrato da wiki, e o construto que derrubava o Memgraph |
| `test_catalog.py` | a listagem de modelos de uma conta: a URL de cada dialeto, o `source` que cada uma promete, e o fallback do Foundry |
| `test_provedor_por_espaco.py` | a escolha de modelo por base, a amarra de endpoint ao usar a credencial gravada, a detecção de documento desalinhado (motor **e** modo) e o teste de cadastro por propósito. **Exige Postgres**; pulado sem ele |
| `test_conceito_datado_e_auditado.py` | vigência, auditoria e armadilha no conceito: normalização de data, a ausência que significa "sempre válido", e a auditoria que só rebaixa |
| `test_recorte_da_busca.py` | `min_trust` e `as_of`: recusa de valor escrito errado, a wiki saindo inteira quando se pede conteúdo revisado, e o filtro contra Postgres de verdade. A parte do banco **exige Postgres**; pulada sem ele |
| `test_repertorio_do_goga.py` | o repertório versionado em `content/`: que nenhuma identidade de agente alcança os 17 Espaços, que o seed da auditoria deriva o nível de confiança que a §5.1 do plano manda, que todo registro de erro carrega a armadilha, e que os conjuntos de avaliação têm as duas vozes em partes iguais |

Os de `test_storage_filesystem.py` que mais importam são os quatro de path
traversal: a última parte da chave do object store é o **nome do arquivo enviado
por quem faz upload**, então `../` chega ali por caminho normal de uso.

Em `test_okf.py`, o teste que mais importa é o de **isolamento**: com o formato
de entrada desligado, o plano de corte tem de sair idêntico ao de antes,
frontmatter incluído. Ele é o que impede o OKF de virar reindexação silenciosa
numa base que nunca o pediu. Os outros cobrem o que a especificação **proíbe**
recusar (campo ausente, `type` desconhecido, chave extra, link quebrado) e o
offset dos trechos: o cabeçalho do conceito entra depois de localizar, e
inverter essa ordem faz todo trecho perder a página sem erro nenhum.

`test_llm.py` existe por uma ausência: a instalação de dev só tem provedor de
`embedding`, então **nenhum teste chega a falar com um modelo de chat**. O que
dá para travar sem rede é a montagem do pedido em cada dialeto (o Azure põe o
deployment no caminho e autentica com `api-key`; a OpenAI põe o modelo no corpo
e usa `Bearer`) e a degradação — toda falha vira `None`, nunca exceção. A
derivação em si é testada com o cliente trocado por um dublê: se a resposta
viesse de um modelo de verdade, o teste mediria o modelo, não o código.

`test_provedor_por_espaco.py` é a exceção que precisa de banco: o que ele trava
é justamente a **consulta** que resolve o provedor, e fingir o banco seria testar
o dublê. Ele aplica as migrações **dentro** da transação e desfaz tudo no fim —
diferente de `test_migrate.py`, que dá `DROP SCHEMA` e por isso só deve apontar
para uma base descartável. O teste que mais importa ali é o do cache: com a
chave só no propósito, duas bases com modelos diferentes se contaminariam por
até 60 s, sem erro nenhum. Os três últimos travam a amarra de segurança da
listagem de modelos: usar a credencial gravada exige o endpoint do próprio
cadastro, senão a rota viraria um jeito de ler uma chave que a tela nunca
reexibe.

⚠ **Duas armadilhas do fixture desse arquivo**, as duas descobertas do jeito
difícil:

1. ele desvia o `conn` de **todo** módulo do pacote, por varredura. Deixar um de
   fora não dá erro, dá **trava**: a migração aplicada dentro da transação toma
   `ACCESS EXCLUSIVE` em `space`, e o módulo esquecido abre conexão do pool de
   verdade e espera o lock até o fim do teste. Foi assim que `search.py` travou
   a suíte;
2. ele entrega uma conexão com **`commit()` neutralizado** (`_SemCommit`). Sem
   isso o rollback do fim não segura nada: `providers.registrar_uso` faz
   `connection.commit()` a cada chamada de IA registrada, e um commit no meio
   publica tudo que a transação acumulou. **Aconteceu**: uma rodada destes
   testes deixou três provedores de mentira gravados na base de dev, porque
   `main.test_ai_provider` chama `registrar_uso`. Foram removidos à mão.

A lição que vale além deste arquivo: **rollback só isola enquanto ninguém
commita no meio.** Ao testar código que grava, verifique se ele commita sozinho
antes de confiar na transação.

`test_repertorio_do_goga.py` testa **conteúdo versionado**, e não código, o que é
incomum aqui e é deliberado. Três propriedades do repertório não sobrevivem a
leitura humana repetida: um grant a mais entre 39 identidades e 17 Espaços passa
em qualquer review e produz um especialista lendo área alheia sem nada falhar; o
nível de confiança do seed é **derivado** do frontmatter, então um `verified`
fora de lugar promove citação em verificação a citação consultável, em silêncio;
e a metade-e-metade das duas vozes do conjunto de avaliação desbalanceia sem
sintoma, fazendo o relatório comparar conjuntos de tamanhos diferentes. É tudo
arquivo e `okf.parse`, então roda sem banco.

```bash
cd services/kb-api && uv run -- python -m scripts.test
```

### Unitários do kb-ui

`src/lib/mcpConfig.test.ts` cobre a geração de configuração de MCP para os cinco
editores. Foi escrito porque a diferença entre eles é sutil (nome da chave,
formato TOML contra JSON, headers presentes ou não) e um erro ali só aparece na
máquina de quem tenta conectar.

`src/lib/leitura.test.ts` cobre a regra que alimenta o robô leitor da tela de
ingestão: qual arquivo está sendo processado agora, quando a fila local desta aba
manda e quando a resposta vem do log do servidor. A cena 3D em si **não é
testada** — WebGL não sobe em ambiente de gate, e o que dá para verificar sem ele
é justamente esta função.

```bash
cd services/kb-ui && npm run test
```

### Ponta a ponta contra a stack (`scripts/e2e.py`)

Não roda no gate e **não é teste de unidade**: fala com a stack de verdade, faz
login real no Identity (authorization code com PKCE, o mesmo fluxo da interface),
gasta IA de verdade e grava dado de verdade — por isso limpa o que cria, num
Espaço com prefixo `e2e-`.

```bash
cd services/kb-api && uv run -- python ../../scripts/e2e.py          # tudo
cd services/kb-api && uv run -- python ../../scripts/e2e.py --keep   # deixa de pé
```

Nove passos, e cada um cobre algo que unitário nenhum alcança: login real,
catálogo de representações, ativação por Espaço (inclusive a recusa de desligar o
índice), ingestão com fan-out das três construções, o contrato OKF das páginas,
o `fetch` nos dois sentidos, a busca heterogênea com os cinco métodos e a fusão,
a prova de que base sem wiki não aciona o método da wiki, e o escopo do servidor.

Ele já achou quatro defeitos reais que nenhum teste unitário pegaria: a travessia
devolvendo zero por acento, as páginas saindo abaixo do piso de 200 palavras, uma
consulta de desenho que **derrubava o Memgraph com SIGSEGV**, e a extração de
grafo reportando `ok` quando o modelo não tinha respondido.

## O que NÃO é testado automaticamente

E a razão de cada um, porque nenhuma é "faltou tempo":

- **extração e OCR.** Dependem do docling, do tesseract e dos modelos de layout.
  Um teste honesto exigiria arquivos reais no repositório e minutos por execução.
  A verificação é manual, contra a base real;
- **busca.** Depende de Postgres com pgvector, de vetores gravados e de um
  provedor de IA. Sem esses, o que sobraria para testar é o SQL como string.
  **Uma exceção entrou**: o recorte (`min_trust`, `as_of`) é exercitado contra
  Postgres de verdade em `test_recorte_da_busca.py`, nos cinco métodos de
  acesso. O que é substituído ali é só o **vetor da pergunta** (e, na travessia,
  o retorno do Memgraph): a consulta, o `JOIN`, o recorte e a expressão de
  distância são os de verdade. O que continua sem teste é tudo o que vem antes
  e depois disso — embedding real, fusão RRF e expansão de pai — e a qualidade
  do que a busca devolve, que não é propriedade de um `WHERE`;
- **permissão.** Depende do Identity e de duas identidades reais em Espaços
  diferentes. Foi verificado à mão, com dois usuários, e é o teste que mais
  merece automação;
- **fluxo OAuth do MCP.** Foi verificado ponta a ponta, no local e por túnel:
  registro, login real no Identity, código, token, chamada, renovação e rotação,
  incluindo os casos negativos (reuso de código e refresh antigo). Manual;
- **a interface.** Não há teste de componente nem E2E de navegador.

## Como verificar de verdade

Enquanto o acima for manual, verificar significa exercitar contra a stack de pé.
A skill `subir-local` tem o roteiro. O mínimo honesto para dizer que uma mudança
funciona:

1. a stack sobe e `/v1/health` reporta `postgres`, `object_store` e `migrations`;
2. uma busca real devolve trecho **com página**;
3. o arquivo original abre a partir do trecho;
4. uma identidade que **não** deveria alcançar o Espaço recebe vazio.

O item 4 é o que costuma ser esquecido, e é o que a skill `revisar-escopo` existe
para lembrar.

## Ao relatar

Diga o que rodou e o que não rodou. "Os testes passaram" com 42 unitários verdes
não é o mesmo que "a busca funciona", e confundir os dois é como uma regressão de
permissão chega em produção.

## Avaliação offline (benchmark)

O que tem teste automático, em `tests/test_benchmark.py`: a agregação por média
harmônica, as regras de diagnóstico (com os números medidos contra o provedor
real) e a adaptação de dialeto do juiz — incluindo a regressão da corrida que
fazia `context_precision` falhar em duas de quatro perguntas quando elas rodavam
em paralelo.

O que **não** tem, e por quê: as métricas do Ragas em si. Elas exigem provedor de
chat e de embedding, e cada uma leva de 8 a 53 s. Um teste que as exercitasse
seria uma ida de minutos ao provedor em todo `scripts.test` — e mediria o
provedor, não o nosso código. A verificação delas é manual, contra a stack:

```bash
# gerar, aprovar, rodar e ler o resultado pela API
python3 scripts/e2e.py            # o e2e não cobre benchmark: ver abaixo
```

O e2e não inclui benchmark de propósito: ele roda em toda verificação e uma
execução completa custa centenas de chamadas ao provedor. O caminho de conferir
é pela tela, em Administração > Benchmark, ou pela API.

**O que olhar quando conferir manualmente**, porque é onde já apareceu problema:

- `parametros_recusados` no resumo. Se `temperature` estiver lá, o juiz rodou com
  a temperatura padrão do modelo e duas execuções do mesmo conjunto podem
  divergir um pouco;
- métrica com `erro` em vez de número. Uma que falha não derruba a execução, e o
  erro fica na própria chave;
- `context_recall` igual a 1,0 em **todas** as perguntas. Não é atestado: num
  dataset só-gerado isso é o esperado, porque a pergunta saiu de um documento que
  está na base. Medido: 16 de 16 na base de manuais do Lyceum.


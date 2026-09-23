# Arquitetura do knowledge-base

Cada peça desta stack existe para atender a um requisito nomeado de
[`requirements.md`](proposal/docs/system-design/requirements.md), e a
forma de rodar veio do [agentic-sdlc](../../../agentic-sdlc), o serviço de onde
esta stack foi espelhada.

## Mapa peça → requisito

| Peça | Requisito | O que resolve |
|---|---|---|
| **Postgres + pgvector** | ING-10, FUN-12 | índice único com busca vetorial (`<=>`) e lexical (`tsvector`) na mesma transação; metadados de Espaço e tags por chunk, independentes dos vetores |
| **MinIO** | ING-02, FUN-12 | documento bruto preservado intacto, para auditoria e reprocessamento com outra técnica. Em produção troca para OCI Object Storage (mesmo SigV4) |
| **Memgraph** | ING-12, BUS-04 | grafo de termos como representação auxiliar, com travessia como método de acesso complementar. **Ligado por padrão** desde que a onda 1 deu a evidência que a especificação pedia. ⚠ a instância de dev é compartilhada: ver armadilha 27 |
| **Docling** | ING-03, ING-04 | documento canônico em Markdown, layout-aware, tabelas preservadas — o artefato do qual tudo o que a busca vê deriva |
| **tesseract (OCR)** | ING-04 | texto de dentro das imagens, que o requisito chama de *captioning de imagens*. Em manual de processo a instrução está no print de tela, não no parágrafo — sem OCR esse conteúdo não existe para a busca |
| **marca de página** | BUS-01 | cada trecho sabe em que página do original está, o que permite levar quem pergunta ao lugar exato em vez de entregar o PDF |
| **`kb_admin`** | FUN-09, WEB-01 | promover administrador dentro da aplicação, sem depender de mexer no realm |
| **OAuth do kb-api** | FUN-10, FUN-11 | o serviço é o Authorization Server do próprio MCP e federa o login ao Identity: o editor descobre, se registra e abre o login sozinho. Sem segredo em arquivo, e os grupos são relidos a cada renovação. Decisão em [decisao-token-mcp.md](decisao-token-mcp.md) |
| **`kb_token`** | FUN-08 | token pessoal, exceção para editor sem fluxo de login: carrega a identidade e não amplia permissão |
| **`ingest_run`** | ING-06 (parcial), FUN-06 | uma linha por tentativa de ingestão: o que está processando agora e quanto levou. A tentativa que falha não vira documento, e sem esta tabela não apareceria em lugar nenhum |
| **LlamaIndex** | ING-07, FUN-04 | os motores de corte pai/filho, escolhidos **por Espaço** (`space.chunking`): heading (padrão), sentença, mudança de assunto ou tamanho fixo. Não existe um corte bom para tudo, e um projeto que compara técnicas precisa rodar duas lado a lado |
| **PyYAML** | ING-03, ING-12 | lê o frontmatter dos conceitos no modo de ingestão OKF. É a outra metade da pergunta que o motor de corte não responde: o que naquele arquivo é prosa e o que é metadado |
| **`kb_api/wiki.py`** | ING-11 | a representação wiki: destilação em páginas OKF atômicas, multi-vetor por seção, e a rastreabilidade até o canônico |
| **`kb_api/llm.py`** | ING-11 | a única chamada de texto **gerado** do projeto: derivar o conceito OKF de um documento que não vem escrito em OKF. Provedor de `purpose="chat"`, separado do de embedding. O contrato do ADR-0006 continua valendo: isto vira metadado do documento, nunca resposta a uma pergunta |
| **`kb_api/query.py`** | BUS-02 | melhoria de query em dois pontos independentes: reescrita do **texto** (`rewrite`, `step_back`) e substituição do **vetor** (HyDE, que embeda um parágrafo hipotético junto da pergunta). Vem desligada: medida num conjunto difícil, subiu a média harmônica de 0,340 para 0,661 e derrubou as falhas de 9 para 2, mas cada uma custa uma ida ao modelo por busca |
| **`kb_api/benchmark.py`** + Ragas | FUN-07 | avaliação offline de verdade: perguntas geradas do conteúdo (diretas ou difíceis) ou cadastradas à mão, execução em segundo plano com progresso, e as cinco métricas do Ragas separadas entre recuperador e gerador. É o que transforma "parece melhor" em número comparável entre versões |
| **`kb_api/retry.py`** | ING-06 (parcial) | retentativa automática do que falhou por motivo **recuperável**, com backoff de 5 a 720 min. O erro definitivo (arquivo protegido, nenhum extrator produziu texto) sai da fila na hora: insistir nele só gastaria OCR |
| **Keycloak do Goga** | FUN-10 | OAuth2/OIDC do projeto (`kc.localtest.me:8481` no local, realm `goga-interno`); quatro grupos sob `/goga`, declarados no import do realm (ADR-0023) |
| **`space_grant`** | FUN-08, FUN-09 | escopo por chamador resolvido no servidor, por grupo, object id do EntraID ou e-mail |
| **`search_run`** | FUN-06 | telemetria por execução: técnica de cada etapa, latência, tokens — devolvida na própria chamada |
| **MCP `search`/`fetch`** | FUN-11, BUS-01, BUS-07 | evidência com score (nunca resposta gerada) e documento canônico por id |
| **kb-ui** (React/Vite) | WEB-01, WEB-02, WEB-03, WEB-04, WEB-05 (parcial) | navegação somente leitura por Espaço (bruto e canônico lado a lado), simulador de recuperação com scores e técnicas, log de consultas, **gestão** (criar e remover base, enviar, reprocessar e remover documento, com o log de processamento), a tela de **Acessos** (quem alcança qual base, quem administra) e a de **Stack** (o retrato técnico). De WEB-05, tempo e custo aparecem por execução; média por técnica ainda não |
| **nginx do kb-ui** | FUN-10 | entrada única: serve o bundle e encaminha `/v1`, `/mcp` e `/auth` no mesmo host, que é o que torna o fluxo OIDC de navegador possível |

## O caminho de um documento

```
arquivo (PDF/DOCX/PPTX/XLSX/TXT)
   │
   │ 1. POST /v1/spaces/<slug>/documents
   ▼
MinIO  ──►  <space>/<sha[:2]>/<sha>/<nome>          bruto INTACTO (ING-02)
   │
   │ 2. extração
   ▼
documento canônico (Markdown)                       FONTE DE VERDADE (ING-03)
   │   docling → pymupdf/python-docx → texto puro
   │   qual ganhou fica em document.extractor        comparável (ING-04, FUN-04)
   │
   │ 3. FAN-OUT: uma construção por REPRESENTAÇÃO ativa no Espaço
   ▼
┌── representação ÍNDICE (sempre) ────────────────────────────────────┐
│  motor de corte → pai (≤4800) ──► filhos (≤1200, overlap 150)       │
│  enriquecimento → identidade do conceito na frente do trecho        │
│  embedding do FILHO ──► chunk_embedding      modelo trocável (ING-09)│
│  auxiliar (ligável): grafo de entidades sobre os chunks PAIS        │
└─────────────────────────────────────────────────────────────────────┘
┌── representação WIKI (ligável) ─────────────────────────────────────┐
│  destilação ──► páginas OKF atômicas (200–800 palavras)             │
│  um vetor por SEÇÃO, todos resolvendo para a página inteira         │
│  wiki_page_source: de quais documentos a página deriva              │
└─────────────────────────────────────────────────────────────────────┘

BUSCA: agrupa os Espaços por MÉTODO, roda cada um uma vez, funde por RRF
  índice → semântica, textual, travessia    wiki → páginas, textual na wiki
```

**Imutabilidade** (FUN-02): reingerir o mesmo arquivo não faz `UPDATE` de texto.
A versão anterior é desativada e uma nova nasce; chunk e embedding da antiga
cascateiam por `ON DELETE CASCADE`. Reingerir arquivo idêntico (mesmo sha256) é
no-op — o que torna a reexecução segura.

## O caminho de uma busca

```
query
  │
  │ 1. escopo — Espaços permitidos do chamador, no SERVIDOR (FUN-08)
  │             o parâmetro `spaces` só RESTRINGE, nunca amplia
  │
  │ 1b. recorte — `min_trust` e `as_of`, se vierem. Viram cláusula DENTRO de
  │               cada consulta, porque o `LIMIT` é do banco: filtrar depois
  │               consumiria o pool sem repor (ADR-0024, ADR-0025)
  ▼
  ├──► 2. vetorial   pgvector, cosseno sobre os filhos
  │
  └──► 3. lexical    Postgres full-text (portuguese + unaccent) sobre os mesmos filhos
         │
         │ 4. fusão — RRF k=60, combina por POSIÇÃO (BUS-05)
         ▼           as duas escalas são incomparáveis; normalizar seria pior
      pool único
         │
         │ 5. expansão — o filho casa, o PAI é entregue (ING-07)
         ▼
      passagens com texto, origem, os DOIS scores separados (BUS-01) e o
      aviso de armadilha colado, quando o conteúdo está marcado (ADR-0027)
         │
         └──► search_run: técnica de cada etapa, latência, tokens (FUN-06)
```

## Permissão: a ponte com o EntraID

O agentic-sdlc reconhece três públicos pelo claim `groups` do JWT e guarda o
"ID do objeto AAD/Teams" por pessoa. Aqui a mesma ideia vira uma tabela:

```sql
space_grant(space_slug, principal_type, principal_id, role)
--   principal_type: 'group' | 'role' | 'entra_oid' | 'email' | 'public'
```

O JWT traz `groups` (caminho completo do grupo no realm, federado do EntraID),
as roles do realm e dos clients, `oid` (object id do EntraID) e `email`.
`Principal.allowed_spaces()` consulta todos de uma vez, então uma pessoa ganha
acesso **por grupo** (o caminho normal), **por role**, ou **nominalmente pelo
object id**, sem depender de criar grupo novo no Identity.

Grupo e role são tipos separados de propósito — ver a decisão 8 abaixo.

Todo caminho de leitura passa por essa função — busca, `fetch`, listagem. Não há
parâmetro que a contorne, que é literalmente o que o FUN-08 exige.

O issuer é o **Keycloak do Goga** (ADR-0023), realm `goga-interno`. Ele não
sobe nesta stack: vive no cluster k3d `goga`, junto com o resto da infra do
produto, e é publicado no host em `http://kc.localtest.me:8481`.

> ⚠ **`kc.localtest.me`, não `localhost`.** O `iss` do token precisa ser o
> mesmo string para o navegador e para os pods. `localhost` dentro de um pod é
> o próprio pod, e a validação do token falha sem erro de configuração nenhum.
> A entrada de DNS que faz o nome resolver dentro deste cluster é injetada no
> `coredns` pelo `20-deploy.sh`. Ver ADR-0023.

Sem `KB_KEYCLOAK_ISSUER` a auth fica desligada e tudo é permitido, igual ao
agentic-sdlc em dev offline. É o que permite subir o ambiente local sem rede.

No deploy local, quem decide é `KB_AUTH` (padrão `off`, pelo §6 do
`planning/00-MVP-PLANO.md`): `off` esvazia o issuer e o `20-deploy.sh` não
toca no `coredns` nem cria o `keycloak-config`; `on` segue o caminho do
Keycloak descrito acima. Com `off` o túnel ngrok é recusado mesmo com token,
porque seria a KB aberta na internet com acesso total.

### O que precisa existir no realm

| | |
|---|---|
| client público | `kb-ui`, standard flow, PKCE, redirect e webOrigins liberados para a URL da UI. O mesmo client federa o login do conector MCP (ADR-0007) |
| mapper no client | group membership → claim `groups` com caminho completo. **Não vem por padrão**; `infra/identity/configure-client.sh` aplica |
| grupo de admin | `KB_ADMIN_GROUP`, por padrão `/goga/curadoria` — a curadoria jurídica, que ingere e corrige o repertório (ADR-0023) |
| grupo por área | o que cada Espaço recebe no grant, passado em `./scripts/ingest.sh <slug> <pasta> --group /Grupo`. Sem `--group` o Espaço nasce alcançável só por administradores; o vínculo pode ser criado depois em *Acessos*, sem reingerir |

## Decisões que custaram caro

Registradas porque o custo delas foi descoberto rodando, não lendo:

1. **`imagePullPolicy: Always` na tag `:dev`.** Com `IfNotPresent`, o nó
   reaproveita a camada cacheada e um `rollout restart` depois de um build novo
   sobe o código **velho**, sem erro nenhum. Um conserto do Docling ficou
   invisível por duas rodadas de ingestão por causa disso.

2. **torch e torchvision do MESMO índice CPU.** Instalar só o torch do índice
   CPU deixava o Docling puxar torchvision do PyPI (build CUDA); o par
   incompatível quebra o registro de operadores
   (`operator torchvision::nms does not exist`), e o sintoma final é
   `AutoImageProcessor` falhando — todo PDF caindo no fallback, sem erro visível.

3. **`transformers<5`.** Com a 5.x o `docling-ibm-models` não carrega o modelo de
   layout. Mesma classe de falha silenciosa.

4. **Um worker uvicorn, não dois.** Cada worker é um processo e carrega a própria
   cópia dos modelos de layout (~700 MB). Com dois, o pod foi OOMKilled no meio
   da ingestão e **todos** os uploads passaram a ser recusados — o sintoma
   aparece no cliente, não no pod.

5. **Memgraph sem volume montado.** Com PVC **ou** emptyDir em
   `/var/lib/memgraph` o processo morre com SIGSEGV dois segundos após subir;
   sem o mount, sobe. Aceitável porque o grafo é derivado e reconstruído na
   ingestão.

6. **`unaccent` no full-text.** Sem ele, `to_tsvector('portuguese', 'férias')`
   não casa com a consulta `ferias` que as pessoas escrevem, e a etapa lexical
   devolve zero candidatos — a busca fica só vetorial, sem erro nenhum.

7. **`_pack` divide bloco maior que o limite.** Documento sem heading (o caso do
   texto corrido) virava **um** pai com o documento inteiro, e a expansão
   pai/filho entregava 40 páginas como "passagem".

8. **Role do realm não é grupo.** O código extraía grupos de `groups`, `roles`
   **e** `realm_access.roles`, tudo normalizado com uma barra na frente. Contra
   um Keycloak de verdade isso apareceu na cara: o usuário chegava com
   `/default-roles-<realm>`, `/offline_access`, `/uma_authorization` como se
   fossem grupos. Além do ruído, é uma brecha: um grant para o grupo
   `/goga/curadoria` passaria a ser satisfeito por uma **role** de mesmo
   nome. Hoje são namespaces separados — `principal_type` `'group'` e
   `'role'`, e as roles de client vêm qualificadas (`realm-management:realm-admin`).

9. **Client novo no Keycloak não emite `groups`.** O claim que carrega a
   permissão não vem por padrão: precisa de um mapper de group membership no
   client. Sem ele o login funciona, o token é válido, e **todo** chamador chega
   sem grupo — a resposta correta passa a ser "nenhum Espaço alcançável", o que
   se parece com base vazia. Duas consequências no código: o script
   [`infra/identity/configure-client.sh`](../infra/identity/configure-client.sh)
   aplica o mapper, e o export do realm do Goga **não o traz** (ADR-0023); e a tela
   de Bases diz explicitamente quando o token chegou sem grupo, em vez de
   mostrar zero e deixar a conclusão errada de pé.

10. **OCR ligado custa memória, não só tempo.** Com OCR e extração de figuras
    o pod foi OOMKilled em 4Gi no meio da ingestão, num PDF de 15 MB com 50
    páginas — e os 24 arquivos seguintes voltaram 502, o que fez a falha parecer
    da rede. Três coisas ao mesmo tempo: teto de 8Gi (o nó tem 20Gi alocáveis e
    o resto da stack usa menos de 2), teto do **acumulado** de figuras por
    documento (cada uma cabia no limite individual, a soma não) e liberação do
    bitmap descomprimido logo depois de gerar o PNG.

    O custo em tempo, medido no mesmo arquivo com o processo quente: 20s sem
    OCR, 40s com OCR de página, 50s com OCR de página e de figura. Em troca, o
    texto indexado quase dobrou — de 2.292 para 4.330 caracteres.

11. **`psm` explícito no tesseract.** O default do docling tenta detectar
    orientação (OSD) em cada região, e região com pouco texto produz
    `OSD failed ... Too few characters` em nível ERROR. Um PDF de 30 páginas
    enchia o log com dezenas de erros que não eram erros, atrapalhando achar as
    falhas de verdade — e cada OSD é uma chamada extra ao binário.

12. **Retentativa no embedding.** Um `Connection refused` passageiro na chamada
    ao Azure já custou dois documentos em ingestões diferentes: o arquivo era
    recusado inteiro por um blip de um segundo e a base ficava sem ele, sem
    ninguém notar. Três tentativas com espera crescente, e só para erro de rede
    e respostas 429/5xx — um 400 é definitivo e repetir só atrasaria a falha.

13. **O load balancer do k3d fecha a conexão em 10 minutos.** Ele é um proxy
    TCP com nginx, e o `proxy_timeout` padrão é 600s. A ingestão de um documento
    é **síncrona**: um PDF de 100 páginas com OCR passa de 10 minutos sem
    tráfego nenhum na conexão, e o LB derruba o socket no meio. O cliente vê
    `RemoteDisconnected`, o nginx registra 499, e a leitura óbvia — e errada — é
    culpar a rede. O servidor continua trabalhando e grava o documento; quem
    perde a resposta é o cliente. Corrigido com
    `--lb-config-override settings.defaultProxyTimeout=3600` no
    `00-cluster-up.sh`.

    Desde a fila de ingestão (armadilha 28) o upload responde `202` assim que o
    arquivo sobe, e a conexão longa só existe para quem pede `?wait=true` (os
    scripts de carga). Para esses, o timeout continua precisando caber no pior
    documento.

14. **`.mjs` não está no `mime.types` do nginx.** O worker do pdf.js é um módulo
    ES, e o nginx o servia como `application/octet-stream` — o navegador recusa
    executar módulo com esse tipo, e o visor de PDF morria com "Failed to fetch
    dynamically imported module". A correção vive num `location` próprio, não
    num bloco `types` no server: `types` em qualquer contexto **substitui** a
    tabela herdada, e declarar só o `mjs` ali derrubaria o tipo de CSS, PNG e de
    todo o resto.

    Detalhe que custa tempo de diagnóstico: o arquivo é servido com
    `Cache-Control: immutable`, então o navegador que baixou a versão com o tipo
    errado continua usando a resposta ruim mesmo depois do conserto. Testar
    exige limpar o cache.

15. **O link da figura obriga a reservar o id antes do chunking.** O canônico
    referencia cada imagem como
    `![legenda](/v1/documents/42/figures/fig-1/image)`, e esse caminho carrega o
    id do documento — que normalmente só existe depois do `INSERT`. Reescrever o
    canônico depois de fatiar mudaria o tamanho do texto e invalidaria **todos**
    os offsets, que são o que dá a página de cada trecho. A ordem correta é
    reservar a chave (`nextval` na sequência), montar o canônico final, e só
    então fatiar e inserir com o id explícito.

    Efeito colateral que precisou de conserto: a sintaxe de imagem entrou no
    texto, e o extrator de termos do grafo passou a contar `documents`,
    `figures` e `image` como os termos mais frequentes de todo documento com
    figura — ligando no grafo documentos sem nada em comum. A limpeza remove a
    imagem inteira (o conteúdo dela entra pelo OCR, logo abaixo) e mantém só o
    texto dos links comuns.

16. **O teto do nó tem de caber a soma dos pods, e o kubelet não avisa.** O
    container do nó k3d estava limitado a 8g e o kb-api sozinho tem limite de
    8Gi (o OCR precisa). O kubelet reporta os ~19Gi da VM como alocáveis — ele
    não enxerga o cgroup do container — então o Kubernetes admitia o pod
    alegremente. Quem morre nesse caso é o **nó inteiro**, todos os pods de uma
    vez, incluindo o Postgres, em vez de um pod só. Nó em 11g.

17. **`?worker` e não `?url` para o worker do pdf.js.** Com `?url` o Vite emite
    o arquivo com a extensão `.mjs`, que não está no `mime.types` do nginx: sai
    como `application/octet-stream` e o navegador recusa executar um módulo ES
    com esse tipo. Pior, o asset é servido com `immutable` — quem baixou a
    resposta ruim continuava com ela mesmo depois do conserto no servidor, e o
    erro "voltava" sem nada ter mudado. Com `?worker` o Vite empacota e emite um
    `.js` normal com hash novo: o problema deixa de existir, em vez de depender
    de configuração de servidor e de cache limpo.

18. **`/mcp` é endpoint E endereço que gente digita.** A tela de conexão nasceu
    em `/mcp`, e o nginx do kb-ui encaminha esse caminho para a API — então o
    navegador recebia o JSON do endpoint e a página vinha **em branco**. A rota
    da SPA virou `/conectar`, mas isso resolve só metade: quem chega em `/mcp`
    por link antigo ou favorito continuava num beco sem saída.

    Hoje o nginx decide por **método + `Accept`**: `GET` pedindo `text/html` é
    pessoa e vai para `/conectar`; `POST` pedindo JSON ou SSE é cliente MCP e
    segue para a API. Não por `User-Agent` — ele é fácil de errar e não é o que
    define a intenção.

    Duas armadilhas no caminho, as duas de configuração de servidor:

    * `absolute_redirect` está **ligado** por padrão, e o nginx montava a URL com
      a porta em que ELE escuta: o navegador era mandado para
      `http://localhost:8080/conectar`, que não existe na máquina de ninguém.
      Atrás de ingress e de túnel o servidor não sabe o endereço público — quem
      sabe é o cliente, então o redirect tem de ser relativo;
    * o `index.html` era servido **sem `Cache-Control`**. Os assets têm hash no
      nome e são imutáveis, mas quem aponta para eles é aquele arquivo: servido
      de cache, o navegador segue carregando o bundle anterior depois do deploy
      — e o sintoma é "a correção não subiu", com o servidor certo. É a mesma
      classe de erro que o `.mjs` com `immutable` (decisão 17), e foi ela que fez
      o erro do visor de PDF parecer ter voltado sozinho.

19. **Dois endereços para o mesmo issuer, quando o issuer é in-cluster.** Não é
    o caso hoje — o Identity é externo e o navegador e o kb-api o alcançam pelo
    mesmo endereço HTTPS. Mas o suporte continua no código
    (`KB_KEYCLOAK_INTERNAL_ISSUER` + `_internal_url` em `auth.py`) porque com um
    Keycloak dentro do cluster o problema é real: o `iss` tem de ser o endereço
    que o navegador usa, e para o pod esse endereço é ele mesmo.

    A tentativa que não funciona é `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true`: os
    endpoints de fundo passam a ser montados com o `Host` de quem pergunta, e o
    `Host` que chega por um ingress é `localhost`, **sem a porta** — a
    `jwks_uri` sai como `http://localhost/auth/...`, que não responde de lugar
    nenhum.

20. **O motor de corte é do Espaço, não do serviço.** Não existe um chunking bom
    para tudo: um manual com heading e uma ata em texto corrido pedem cortes
    diferentes, e antes disso o pipeline aplicava o mesmo nos dois. Pior para um
    projeto que existe para **comparar** técnicas — com o motor fixo em variável
    de ambiente, testar outro exigia reconfigurar o serviço inteiro, e rodar
    dois lado a lado era impossível.

    `space.chunking` é um JSONB por Espaço com `engine` e os tamanhos. Quatro
    motores: `markdown` (padrão, LlamaIndex `MarkdownNodeParser`), `sentence`
    (`SentenceSplitter`), `semantic` (`SemanticSplitterNodeParser`) e `fixed`
    (corte próprio por caracteres, a linha de base). Medido nesta instalação, no
    mesmo arquivo: 15, 17, 20 e 16 filhos — e 3 s, 3,3 s, **34 s** e 2,6 s. O
    semântico embeda cada sentença **na ingestão** para achar a queda de
    similaridade; por isso não é o padrão, mesmo sendo o mais esperto.

    Três detalhes que só aparecem implementando:

    - o `SemanticSplitterNodeParser` exige um `BaseEmbedding`, e o default dele
      é o da OpenAI. `_EmbeddingDoProjeto` embrulha o `embed()` daqui para o
      corte usar o **mesmo modelo** que indexa — dois modelos decidindo coisas
      diferentes sobre o mesmo texto seria um defeito silencioso;
    - `ensure_space(chunking=None)` **preserva** o que está gravado (`COALESCE`).
      A ingestão chama essa função a cada rodada sem saber de chunking; sem o
      `COALESCE` ela apagaria em silêncio o motor escolhido na tela;
    - `fixed` usa corte mecânico **nos dois níveis**. Manter sentença no filho
      misturaria as técnicas, e a linha de base deixaria de medir o que promete.

    A troca vale para o que for ingerido **depois**. Reprocessar sozinho o que já
    está indexado levaria horas sem ninguém pedir — a tela diz isso em vez de
    fingir que a mudança é retroativa.

21. **O modo de ingestão não é um motor, e confundir os dois custa caro.** O
    OKF ([ADR-0015](adr/0015-okf-como-formato-de-entrada.md)) empacota
    conhecimento como diretório de Markdown com frontmatter YAML, um conceito
    por arquivo. A tentação era um quinto cartão no diálogo de corte — e ela
    quebra duas coisas de uma vez: o corpo de um conceito tem cabeçalhos e
    **ainda precisa ser cortado**, então escolher OKF significaria abrir mão do
    corte por estrutura; e a base não é homogênea, então esse "motor" teria de
    decidir o corte dos PDFs também, degradando em silêncio tudo que não fosse
    OKF.

    `space.chunking.okf` é um booleano **ao lado** de `engine`. O motor diz onde
    cortar a prosa; o formato diz o que no arquivo é prosa.

    **E o conceito chega por duas procedências.** Escrito, quando o arquivo abre
    com frontmatter contendo `type` — sai de graça. Derivado, para qualquer
    outro formato, pelo provedor de `chat`. A segunda não é enfeite: medido
    nesta instalação, **zero** dos 48 documentos vinham escritos em OKF, e sem
    derivar o recurso não faria nada por nenhum deles. A ordem é rígida e está
    em `okf.resolve` — **escrito ganha do modelo sempre**, senão um
    reprocessamento rebaixaria a `unverified` um conceito que alguém revisou, de
    graça e ainda pagando IA para piorar o dado.

    Cinco detalhes que custaram atenção:

    - **o cabeçalho entra depois de localizar o trecho.** Ele vem do
      frontmatter, que saiu da prosa, então um trecho já prefixado não é achado
      no canônico: todo offset viraria `-1` e o documento perderia a página de
      cada evidência — sem erro nenhum, só evidência apontando para o arquivo em
      vez do lugar;
    - **o frontmatter é mascarado com espaços, não recortado**, na hora de
      localizar. Recortar deslocaria todo offset depois dele pelo tamanho do
      YAML;
    - **o nó `Concept` existe por causa da ordem de chegada.** O bundle entra
      arquivo por arquivo e o conceito A quase sempre cita um B ainda não
      ingerido. Ligando documento a documento, a aresta se perderia; com o
      conceito como ponto de encontro, ela se fecha sozinha;
    - **reconhecimento é conservador.** Só é conceito o arquivo que abre com
      frontmatter YAML válido **contendo `type`**. `---` no meio do texto é
      regra horizontal, e Markdown de gerador estático tem frontmatter sem
      `type`;
    - **`llm.complete_json` nunca levanta.** Provedor ausente, rede fora, HTTP
      400, modelo sem JSON mode, resposta que não é JSON: tudo vira `None` e a
      ingestão segue sem conceito. Documento sem metadado auxiliar continua
      buscável; documento que não entrou, não — e esta base já perdeu quatro
      arquivos para um provedor de IA mal configurado.

    O canônico gravado **continua tendo o frontmatter**: ele é parte do arquivo,
    e o que muda é o que vai para o índice, não o que fica registrado (ADR-0001).

    **Trocar o modo muda a busca, e mais do que trocar o motor.** O motor muda
    onde o trecho começa e termina; o modo muda o **texto indexado** — e esse
    texto é o que alimenta os dois braços (o `tsv` do lexical e o vetor do
    filho). Medido com `ts_rank_cd`, no mesmo trecho, com e sem o cabeçalho do
    conceito:

    | pergunta | sem | com |
    |---|---|---|
    | qual a política de alçadas de contratação | 0,0000 | 0,4000 |
    | quem aprova contratação acima de quinhentos mil | 0,4000 | 0,7000 |
    | quando o comitê executivo precisa aprovar | 0,2000 | 0,3000 |

    Por isso `document.ingest_mode` entra na conta de "desalinhado" junto com
    `chunk_engine` (migração 0005). Comparar só o motor deixava a troca de modo
    passar em silêncio, e uma base com os dois modos convivendo responde pela
    metade sem nada na tela dizendo por quê. **`search.py` não tem ramo por
    modo** — o que muda é a entrada, não o código.

    O vocabulário de tipos é da base (`space.chunking.okf_types`), e não livre. A
    especificação permite tipo livre, por não ter taxonomia fixa — mas com ele 40
    documentos rendem 31 tipos quase-duplicados e a etiqueta deixa de agrupar
    qualquer coisa. Tipo fora da lista vira `Documento`, e ver muitos deles é o
    sinal de que falta uma entrada naquela base.

22. **O modelo é por base, e o Espaço precisa viajar até a chamada.** O
    provedor saiu da variável de ambiente no ADR-0009 e virou linha de banco,
    mas continuava sendo **um só para a instalação**. É o mesmo defeito que o
    motor de corte tinha, e foi corrigido do mesmo jeito
    ([ADR-0016](adr/0016-modelo-de-ia-escolhido-por-espaco.md)):
    `space.embedding_provider_id` e `space.chat_provider_id`, `NULL` = padrão da
    instalação.

    Três coisas que não dão erro quando saem errado, e por isso estão travadas
    por teste:

    - **a chave do cache é `(propósito, Espaço)`.** Com a chave só no propósito,
      a primeira base a consultar gravaria o provedor dela e as outras usariam o
      modelo errado por até 60 s — vetorizando com um modelo contra um índice de
      outro, sem nada falhar;
    - **`embed()` recebe o Espaço explicitamente**, e não há "Espaço corrente".
      Esquecer de passar não quebra: usa o padrão da instalação e degrada a
      busca daquela base em silêncio;
    - **a busca agrupa por modelo.** Uma pergunta é vetorizada uma vez **por
      modelo em jogo**, não uma vez por busca. Com uma vetorização só, o `<=>`
      compararia o vetor contra vetores de outro modelo — mesma dimensão, outro
      espaço vetorial — e devolveria lixo ordenado sem reclamar.
      `_espacos_por_modelo()` devolve `None` quando não há divergência, e aí o
      caminho é byte a byte o de antes.

    A dimensão continua travada por Espaço, pela mesma razão da armadilha 1:
    `chunk_embedding.embedding` é `vector(N)` fixo no DDL.

    **A listagem de modelos tem api-version própria.** `GET /openai/deployments`
    do Azure vive na `2023-03-15-preview`, e não na api-version que o cadastro
    usa para chamar o modelo. Medido no recurso desta instalação, com chave
    inválida de propósito para só exercitar a rota: `2023-03-15-preview`
    responde **401** (a rota existe) e `2024-10-21` — que é exatamente a
    api-version gravada no cadastro — responde **404**. Usar a do cadastro faria
    a tela dizer "a conta não tem deployment nenhum", que é falso. O Foundry vai além: quando a rota de deployments não
    existe (404), a listagem cai no catálogo do recurso, e aí o `source` muda de
    `deployments` para `catalog` porque a promessa muda junto — um é o que está
    publicado, o outro é o que poderia estar.

    E fica a ressalva que não tem solução barata: quando uma busca abrange bases
    com modelos diferentes, a ordenação final mistura similaridades vindas de
    espaços vetoriais distintos. É aproximação, e a recomendação segue sendo um
    modelo por instalação salvo quando o objetivo é comparar dois.

23. **Representação, slot e estrutura auxiliar são três coisas, e confundi-las
    custou uma reescrita.** O vocabulário está em
    [`conceptual-model.md`](proposal/docs/system-design/conceptual-model.md) §2 e
    é normativo:

    - **representação** é derivada do canônico e construída na ingestão. Duas na
      v1: `índice` (sempre presente) e `wiki` (ligável). É um **conjunto** por
      Espaço, não um enum — `índice + wiki` não é um terceiro valor;
    - **slot** é ponto de troca **dentro** de uma representação. Motor de corte e
      enriquecimento de chunk são slots do índice;
    - **estrutura auxiliar** abre outro caminho até o **mesmo** conteúdo, sem
      criar conteúdo novo. O grafo de entidades é isto: os nós apontam para
      chunks pais que já existem.

    Uma versão anterior deste código chamou o enriquecimento de "modo de
    ingestão" e o pôs no mesmo eixo das representações
    ([ADR-0017](adr/0017-representacoes-por-espaco-e-busca-que-funde-metodos.md)
    corrige). O sintoma de ter errado aparece só quando a segunda representação
    chega: `índice + wiki` não cabe num enum.

    **A busca não vira uma consulta por base.** Os Espaços alcançáveis são
    agrupados pelo método que oferecem, cada método roda **uma vez** sobre o seu
    grupo, e o RRF funde. Trinta bases com duas representações custam cinco
    métodos. E o embedding da pergunta é **um por modelo**, compartilhado: o
    vetor da pergunta não depende da representação consultada.

    Três coisas que quebram em silêncio aqui:

    - **acento na travessia.** O modelo extrai "Política de Férias"; a pergunta
      chega "ferias". O `CONTAINS` do Cypher é literal, e sem normalizar os dois
      lados a travessia devolvia **zero** em quase toda pergunta em português.
      Medido no e2e antes da correção;
    - **`DISTINCT ON (p.id)` na busca de páginas.** Sem ele, uma página com seis
      seções que casem vira seis candidatos e domina o ranking por ter sido
      cortada em mais pedaços;
    - **uma consulta derrubou o Memgraph.** A primeira versão do desenho do
      grafo montava nós e arestas numa consulta só (`collect` + `UNWIND` +
      `OPTIONAL MATCH` + projeção de mapa com `CASE WHEN`). Reproduzido duas
      vezes contra a 2.22.1: `Exit Code 139` (SIGSEGV) e o contador de reinício
      subindo. Não era Cypher inválido — inválido o servidor recusa com erro. O
      desenho passou a usar **duas consultas simples**, e há teste de regressão
      travando isso. Pior que a queda foi o `except` engoli-la e devolver "grafo
      vazio": a tela mostrou base sem grafo em vez de erro, e por isso a falha
      agora devolve `reachable: false`, que é coisa diferente de lista vazia;
    - **sem índice vetorial, e não por escolha.** `column cannot have more than
      2000 dimensions for ivfflat index`, e o modelo devolve 3072. Vale para
      `chunk_embedding` e para `wiki_page_vector`.

24. **O nó do grafo aponta, e o ponteiro precisa apontar para algo que existe.**
    O grafo não guarda texto (ADR-0012): um `:Document` carrega o id da linha no
    Postgres, um `:Chunk` carrega o id do trecho. Três defeitos saíram dessa
    natureza, e os três só apareceram quando a tela passou a **usar** os
    ponteiros:

    - **id interno não é id de domínio.** O desenho precisa de `id(n)` para casar
      nó com aresta, e esse número não significa nada fora dali. A tela usava ele
      para abrir o documento: o nó do documento 381 tinha `id(n) = 63`, e "Abrir
      o documento" caía em `documento 63 não encontrado`. Pior que o erro seria o
      acerto por acaso — se 63 existisse noutro Espaço, abriria o documento
      errado sem falhar. O nó passou a trazer `ref`, o id de domínio, e `name`
      parou de cair em `toString(id(n))`, que deixava a tela salpicada de números
      que não existem em lugar nenhum;
    - **`MERGE` de caminho cria nó.** `MERGE (e)-[:FROM_CHUNK]->(c:Chunk {id:
      $chunk})` casa o **caminho inteiro**: se aquela entidade ainda não aponta
      para aquele trecho, o MERGE cria tudo, inclusive um `:Chunk` novo, em vez
      de reusar o que já existe. Medido: o trecho 4651 virou **oito** nós, um por
      entidade. O nó é casado sozinho, e a aresta vem depois;
    - **o derivado morre com a origem.** `drop_space` e `forget_document`
      apagavam o `:Document` e limpavam termo órfão, mas deixavam `:Entity` e
      `:Chunk` para trás. Depois de um reprocessamento o grafo apontava para
      linhas que o Postgres já tinha apagado, e "ver o trecho" respondia 404 num
      nó visível no desenho. A limpeza é sempre por `degree(n) = 0` ou por
      agregação: `WHERE NOT (t)<-[:MENTIONS]-()` o Memgraph 2.22.1 recusa com
      "Not yet implemented", e o `except` engolia a recusa — foi assim que a
      limpeza passou a não rodar em silêncio.

    E mais duas, que só apareceram numa carga de verdade (40 manuais do Lyceum,
    `.docx` de 1 a 4 MB, 13,6 min, 198 pais e 1.017 filhos):

    - **o `:Term` não tem `space`, e o desenho o excluía.** O nó é compartilhado
      entre bases de propósito — é o que liga bases diferentes pelo mesmo
      assunto, e `related` depende disso. Mas o desenho filtrava
      `WHERE n.space IS NOT NULL`, o que apagava todo termo e, com ele, **toda
      aresta**: no grafo lexical, que é o padrão de qualquer base, `Document
      -[:MENTIONS]-> Term` é a única ligação que existe. O esquema anunciava 209
      termos e a tela mostrava **40 pontos soltos, zero arestas**. O escopo do
      termo vem da **aresta**, não do nó: ele entra quando um documento
      alcançável o menciona, e o grau conta só esses documentos;
    - **foco não é filtro de nome.** A tela promete "focar numa entidade ou termo
      (e a vizinhança dela)", e a implementação casava o nome e parava ali:
      focar `turma` nos 40 manuais dava **2 nós e 0 arestas**. Agora expande um
      salto — e o escopo é **reaplicado no vizinho**, que não é redundância: a
      semente pode ser um termo compartilhado, e expandir dali sem refiltrar
      traria documento de Espaço proibido para dentro da figura. Verificado com
      duas bases compartilhando seis termos; nenhum documento atravessou.

25. **O tempo da busca não era a busca.** Com 365 documentos ela respondia em
    ~1.030 ms, e o Postgres levava 21 ms disso. Os outros 97% eram a ida ao
    provedor de embedding para vetorizar a pergunta: 1.033, 1.119 e 8.435 ms em
    três medições seguidas. Quatro coisas saíram daí, e cada uma vale por si
    (ADR-0019):

    - **`urllib` abre conexão nova a cada chamada.** DNS, TCP e TLS por
      pergunta. Uma sessão com pool no módulo reaproveita a conexão;
    - **o vetor da pergunta era calculado duas vezes.** O ADR-0017 prometia
      "uma vez por modelo, compartilhado entre os métodos", e `semantica` e
      `paginas` chamavam o provedor cada um — uma base com índice + wiki pagava
      duas idas e **cobrava os tokens duas vezes**. Agora há cache com voo
      único, porque os métodos rodam em paralelo e um cache ingênuo deixaria os
      dois threads chamarem mesmo assim. Pergunta repetida: 1.633 ms → **63 ms**;
    - **cache servido não cobra token.** A função devolve se veio do cache, e
      quem soma o uso conta zero. Contar de novo o que não foi gasto inflaria
      exatamente a tela onde alguém vai decidir sobre custo;
    - **o teto de espera depende de quem espera.** Era 180 s com três
      tentativas, o que é certo na ingestão (um blip custa o documento inteiro)
      e na busca dá nove minutos de tela parada. Busca agora é 8 s e duas
      tentativas, e sem vetor o Espaço cai para o lexical em vez de falhar. A
      pior busca do benchmark caiu de 32,5 s para 11,2 s só com isso.

26. **Varredura sequencial é linear, e some no teste pequeno.** O braço vetorial
    não tinha índice — impedimento real e registrado: `column cannot have more
    than 2000 dimensions for ivfflat index`, e o modelo devolve 3072. Com 3.972
    vetores a varredura custa 21 ms e ninguém nota; com 100 mil seriam mais de
    meio segundo e mais de um gigabyte lido **por busca**.

    O que destrava é `halfvec` (pgvector 0.7+, aqui 0.8.6): meia precisão,
    indexável até 4000 dimensões. O índice é sobre a **expressão**
    `embedding::halfvec(3072)`, então a coluna continua guardando o valor exato.
    Plano medido: `Seq Scan` → `Index Scan`, 215 entradas varridas para devolver
    40 linhas.

    Duas armadilhas, as duas silenciosas:

    - **índice de expressão só entra se a consulta repete a expressão.** Voltar
      a `embedding <=> %s::vector` não dá erro — devolve a varredura. Há teste
      travando consulta e migração juntas;
    - **índice aproximado com filtro devolve menos do que devia.** A busca
      sempre restringe por Espaço, e sem `hnsw.iterative_scan` o índice entrega
      40 vizinhos dos quais o filtro deixa três. A base pareceria ter poucos
      resultados, sem erro nenhum.

27. **O Memgraph de dev é compartilhado, e `DELETE` sem dono apaga o dado dos
    outros.** O `MEMGRAPH_HOST` do overlay aponta para a instância da
    plataforma, onde o agentic-sdlc grava `(:Project) (:WorkItem) (:Execution)
    (:File) (:Slice) (:Decision)` e **`(:Concept {name})`**. O overlay afirma
    que não há colisão de rótulo — e essa lista foi escrita quando o
    knowledge-base ainda não gravava conceito. `:Concept` colide.

    As limpezas de órfão eram globais (`MATCH (c:Concept) WHERE degree(c) = 0
    DELETE c`). Reproduzido contra o Memgraph real: com um `(:Concept {name})`
    sem `space`, a forma antiga **apagava** (1 → 0) e a nova preserva. Sem erro
    nenhum e sem rastro, nos dois casos.

    O critério de posse é a propriedade que só o knowledge-base grava: `space`
    no conceito e no trecho, `norm` no termo (que não tem Espaço, por ser
    compartilhado *entre* bases de propósito). Preferir deixar um órfão nosso
    para trás a apagar o dado de outro serviço.

    Vale para `scripts/rebuild-graph.py` também, e lá o estrago seria maior: ele
    apaga `:Chunk` para recriar.

28. **A ingestão era síncrona, e o teto dela era o timeout da borda.** Hoje ela
    é enfileirada (ver o fim deste item); o histórico fica porque explica a fila.
    O `POST` de upload só respondia quando o documento estava indexado. Quem segura a conexão
    todo esse tempo é o nginx do ingress, com `proxy-read-timeout: 1800`.

    Parece folgado até a base carregar em paralelo. Medido numa carga real de
    duas bases ao mesmo tempo: mediana de 89 s numa delas, p95 de 255 s, e
    **um documento de 1042 s** (um manual de onboarding).
    Isso é 58% do teto gasto por um arquivo só, com concorrência de apenas dois.
    Em três a margem acaba, e o modo de falha é o pior possível: a borda devolve
    504, o cliente conclui que falhou, o **servidor continua trabalhando** e
    termina a indexação que ninguém está mais esperando. Se o cliente reenviar,
    o documento entra duas vezes.

    Duas consequências para quem opera:

    - **o timeout do cliente tem que ser maior que o da borda**, não menor. Com
      o cliente desistindo primeiro, ele solta a conexão e o servidor segue com
      o trabalho, sem ninguém para receber a resposta. Foi o que aconteceu na
      carga do GH: três arquivos deram `ReadTimeout` aos 936 s e os três já
      estavam na base. O script de carga passou a perguntar ao servidor antes de
      contar como falha;
    - **desistir do arquivo aumenta a concorrência.** Cliente desiste, manda o
      próximo, e o anterior ainda está ocupando CPU no servidor. A carga se
      alimenta sozinha, e os tempos sobem justamente quando o cliente conclui
      que precisa insistir.

    Em 2026-09-23 isso derrubou o pod: dez PDFs de 10 MB (livros inteiros)
    enviados de uma vez. Um engasgo soltava a conexão, a tela mandava o próximo,
    e o pod ficava com dois docling juntos até ser OOMKilled com 8 Gi, perdendo
    tudo que estava no ar.

    **O conserto (ING-06):** o upload guarda o bruto no object store, abre a
    linha em `ingest_run` como `queued` e responde `202`. Uma thread
    (`fila.py`) processa a fila **um arquivo por vez**, pegando com
    `FOR UPDATE SKIP LOCKED`. Na subida do pod, o que estava `running` volta
    para a fila (o bruto está guardado), até duas vezes: um arquivo que derruba
    o pod toda vez para de ser retomado e fecha como falha, senão a fila vira
    um laço de OOM. `?wait=true` mantém o contrato antigo para os scripts de
    carga, passando pela mesma fila.

    Junto, o docling converte PDF em lotes de `KB_DOCLING_PAGE_BATCH` páginas
    (40): convertido inteiro, um livro de 800+ páginas segurava todas as
    páginas renderizadas até o fim e passava dos 8 Gi sozinho.

29a. **O docling em CPU custa ~3,7 s por página, mesmo em PDF digital.** Medido
    no pod de 3 CPU: o livro "Comentários ao CDC" (1.169 páginas) levaria mais de
    uma hora de extração, para chegar ao mesmo texto que o PyMuPDF lê em 1,1 s
    (1.168 das 1.169 páginas tinham camada de texto limpa). Com oito livros na
    fila, eram horas de CPU disputada com a busca.

    **O conserto (`hibrido.py`):** PDF a partir de `KB_PDF_HIBRIDO_MIN_PAGINAS`
    (80) passa por uma triagem por página em ~1,5 s. Vai para o docling só a
    página sem texto, com imagem grande (`KB_PDF_IMAGEM_AREA`), com texto
    corrompido ou com cara de tabela (`KB_PDF_TABELA_DESENHOS`); o resto sai
    pelo PyMuPDF, com o cabeçalho e o rodapé correntes removidos. O sumário
    embutido no PDF vira os títulos `#`/`##` que o corte `markdown` usa. Se mais
    da metade das páginas precisa do docling (escaneado), o arquivo vai inteiro
    para ele, como antes. Medido no mesmo livro: **~10 s** de extração.

    **O sumário do PDF mente sobre a página.** No mesmo livro, 1.222 das 1.279
    entradas apontavam para as páginas 100-199 (muitas para a 182). Confiando
    nisso, 1.282 títulos caíram nas primeiras páginas e 2.605 trechos receberam
    a mesma seção, sem erro nenhum. Por isso cada entrada é **ancorada no texto**:
    procurada, em ordem de leitura, num bloco que comece pelo título. Entrada não
    achada fica de fora; se menos de 30% forem achadas, o sumário é descartado e
    o corte vai por tamanho. Três armadilhas apareceram nos livros reais, e a
    ancoragem trata as três: o **sumário impresso** do próprio livro casa com
    todos os títulos (página onde 8 ou mais títulos começam bloco é ignorada;
    no Filomeno, 121 de 123 entradas tinham ido parar nas páginas 47-49); o corpo
    sem espaço entre número e título ("1.1Introdução"), resolvido comparando sem
    espaço nem pontuação; e o número impresso separado do título ou o título
    quebrado em duas linhas (Theodoro vol. 2: de 90 para 594 de 768 ancoradas).
    Resultado: Rizzatto 1.273/1.279, Filomeno 104/123, Theodoro vol. 2 594/768.

    Duas consequências do mesmo livro, corrigidas junto:

    - o grafo lia só os **6 primeiros** trechos pai e a wiki só os **12 mil
      primeiros caracteres**: ~1% de um livro (sumário e prefácio). O grafo
      agora amostra pais espalhados pelo documento inteiro, até
      `KB_GRAFO_MAX_PAIS` (40); a wiki destila por seção amostrada, até
      `KB_WIKI_MAX_SECOES` (8). Documento curto continua como antes;
    - a citação dizia só "p. 612". Cada trecho agora guarda o caminho de seções
      (`chunk.section`, "Capítulo I › Art. 1º › 2. Protecionismo"), que vai na
      busca, no MCP e nas evidências do Studio. Nos Espaços com enriquecimento
      `conceito`, a seção entra também no cabeçalho do trecho, junto do conceito.

29. **Reenviar não apaga a versão anterior, e o grafo dela ficava para trás.**
    `FUN-02` versiona: mandar o mesmo nome de arquivo de novo marca a linha
    antiga com `active = FALSE` e insere uma nova com id novo. Não há `DELETE`,
    então não há cascata — e o nó `:Document` da versão velha continuava no
    Memgraph apontando para um id que a API responde com **404**. Clicar nele no
    desenho caía em "documento não encontrado", que é a armadilha 24 chegando
    por um caminho que ninguém tinha olhado.

    O jeito como isso apareceu é a parte que vale guardar. A contagem dizia
    **358 nós para 358 linhas**, e bater não significou nada: havia um órfão a
    mais e um documento a menos — o que falhou na extração, que corretamente não
    tem nó. **Dois erros se cancelando num total.** Só comparar id a id, e não
    contagem com contagem, mostrou o que estava acontecendo.

    Os quatro caminhos que tiram um documento de circulação, e o que cada um
    precisa limpar:

    | caminho | Postgres | grafo | object store |
    |---|---|---|---|
    | remover documento | `DELETE`, cascata | `forget_document` | coleta as chaves antes de apagar |
    | remover Espaço | `DELETE`, cascata | `drop_space` | bruto e imagens |
    | reprocessar | `DELETE` da versão antiga | `forget_document` | mesma chave, sobrescreve |
    | **reenviar (versionar)** | `active = FALSE`, **sem cascata** | era o que faltava | mesma chave, sobrescreve |

    O object store não vaza em nenhum deles porque a chave é endereçada por
    conteúdo (`sha256` do arquivo): reingerir os mesmos bytes reescreve os
    mesmos objetos. A exceção é a extração produzir MENOS figuras na segunda
    passada, e aí sobram os `fig-N.png` excedentes — alguns PNGs, não um vazamento.

    `scripts/rebuild-graph.py` ganhou `limpar_documentos_orfaos()` para alcançar
    o que já estava gravado: a correção na ingestão só vale para o que for
    reenviado depois dela.

30. **Cabeçalho HTTP é latin-1, e o nome do arquivo não é.** `Content-Disposition`
    leva o nome do documento, e o Starlette codifica todo cabeçalho em latin-1 —
    na **construção** da resposta. O que não couber levanta `UnicodeEncodeError`
    ali, e o cliente recebe **HTTP 500** sem nada dizendo que o problema é o
    nome do arquivo.

    O que fez isso demorar a aparecer é que português quase não esbarra nele:
    `Í`, `Ç`, `ã`, `ê` **cabem** em latin-1, então `POLÍTICA DE AVALIAÇÃO.docx`
    baixa normal. O que não cabe é a pontuação tipográfica que o editor de texto
    gera sozinho — travessão (`–`, U+2013), aspas curvas, reticências. Numa base
    de 45 documentos, exatamente um quebrava: `Anexo 1 – Resumo de
    Contratos.pdf`. Todos os vizinhos acentuados funcionavam, o que aponta para
    o lugar errado.

    A saída é a RFC 6266: `filename` degradado para ASCII, para cliente antigo,
    e `filename*=UTF-8''<percent-encoded>` com o nome de verdade, que é o que
    todo navegador atual lê. A aspa também precisa sair da parte ASCII: ela
    fecharia o `filename="…"` no meio e o resto viraria parâmetro solto.

    **O mesmo vale para qualquer cabeçalho montado com texto de fora**, e ali é
    pior. O `WWW-Authenticate` do 401 do MCP carrega `error_description`, que
    inclui o *issuer lido do próprio token*. Um token malformado com caractere
    fora do latin-1 transformaria o 401 em 500 — e é o 401 que carrega o
    `WWW-Authenticate` que dispara a descoberta no cliente. Perder o 401 é
    perder o "clique em Entrar" e voltar para "cole um token".

## O que ficou de fora desta v0

Consciente, não esquecido:

- **Reranking** (BUS-06): o pool fundido vai direto para a resposta.
- **Índice de embedding separado por modelo.** Com modelo por base, a comparação
  entre dois modelos na mesma busca é aproximada. Uma tabela de embedding por
  modelo resolveria de verdade, e multiplicaria DDL, migração e consulta
  (ADR-0016).
- **Bundle OKF como unidade.** O modo `okf` reconhece **conceito**, um
  arquivo por vez. Ingerir um diretório inteiro (com `index.md` e `log.md`
  filtrados, e link resolvido pelo caminho no bundle em vez do nome final do
  arquivo) não existe — e nem **produzir** OKF a partir de uma base, que é o
  caminho inverso.
- **Analytics agregado** (WEB-05, opcional): o histórico mostra tempo e tokens
  **por execução**, e a tela de Stack mostra os totais da instalação. Média por
  técnica e por método de acesso — que é o que o requisito pede — ainda não.

# Guia de operação

Como operar a base no dia a dia: as telas, o que cada uma responde, e as decisões
de comportamento que valem saber antes de usar.

Este conteúdo veio do README, que passou a ser apresentação. O **porquê** de cada
decisão está nos [ADRs](adr/); aqui está o **como**.

## UI de operação

O `kb-ui` é um app React + Vite servido por nginx, no mesmo shape do
`services/ui` do agentic-sdlc: bundle estático, configuração por `env.js` em
runtime (não assada no build), login OIDC com PKCE via `keycloak-js`.

Ele é a **única entrada** da stack: o nginx dele encaminha `/v1` e `/mcp` para o
kb-api. O login não passa por aqui: o issuer é externo e o navegador o alcança
direto em HTTPS. A origem única continua importando por outro motivo — o bundle
chama `/v1` por caminho relativo, então não há CORS nem host de API assado na
imagem, e a mesma imagem serve local, dev e prod.

O menu é lateral e dividido em dois blocos, como no agentic-sdlc: consulta em
cima, administração embaixo. A separação não é estética — o bloco de baixo é o
mesmo que a API barra para quem não é admin, então o menu só mostra o que existe
do lado de lá.

**O que NÃO está no menu, de propósito.** Documentos, Wiki, Grafo e Benchmark
são conteúdo de uma base: nenhuma delas responde nada sem um Espaço escolhido.
No menu, cada uma abria numa tela com um seletor de base no topo, pedindo de
novo uma escolha que já tinha sido feita — dois lugares para decidir a mesma
coisa, e o do menu chegava sem contexto nenhum. Elas se alcançam pelo **card da
base**, e continuam funcionando por URL (`/grafo?espaco=lyceum-ng`) para link e
favorito. Sem o `espaco`, a tela manda para Bases em vez de adotar a primeira
base da lista: aqui o Espaço é a fronteira de permissão, e mostrar conteúdo de
um que ninguém pediu não é conveniência.

**Consulta**

| Tela | Para quê |
|---|---|
| **Início** | o que é a base, quanto tem dentro, por onde começar — e as três escolhas que explicam as outras telas |
| **Bases** | Uma linha por Espaço, com contagem de documentos e trechos, o que está processando agora, e os atalhos para tudo que é daquela base: documentos, wiki, grafo, busca e benchmark. É daqui que se entra em todas elas. Também a **ingestão** de cada uma: modelos de IA, modo de ingestão e motor de corte |
| **Simulador** | A mesma busca que os agentes fazem pelo MCP, com scores de cada braço, RRF e tempo por etapa. Cada resultado leva ao trecho **no original** ou ao canônico |
| **Histórico** | Toda busca registrada: pergunta, trechos devolvidos, página, tempo, tokens (só as suas, se você não é admin) |
| **MCP** | a URL para colar no editor e o botão **Entrar** — login real no Identity, pelo protocolo. Claude Desktop, Claude Code, Cursor, opencode e Codex; token pessoal só como exceção, para editor sem opção de login |

**Administração**

| Tela | Para quê |
|---|---|
| **Acessos** | Quem alcança qual base e quem administra — por grupo, role, e-mail ou object id do EntraID. Mostra também quem já consultou e voltou de mãos vazias, que costuma ser exatamente quem está esperando permissão |
| **Benchmark** | Quão boa é a resposta desta base, com as métricas do Ragas. Entra pelo card da base, e só para administrador: gerar perguntas e rodar uma execução **gastam IA** |
| **Stack** | O retrato técnico: versões, quantos vetores no pgvector, quantos arquivos e bytes no object store, tamanho do grafo, cobertura da página do trecho, e a configuração de OCR, chunking e busca |

A tela de Saúde foi dobrada na de Stack — ela mostrava um subconjunto do mesmo
e eram dois itens de menu para a mesma pergunta. A rota `/saude` continua
redirecionando, porque links antigos apontam para lá.

### Ler o documento inteiro

**Ocultar lista** esconde a coluna de arquivos e dá ao conteúdo a largura da
tela. Um manual com print de tela em página A4 fica ilegível em 60% da largura,
e era essa a única opção.

Esconder a lista dá **largura e altura**: o teto de rolagem do conteúdo sobe
junto. Sem isso o documento continuaria cortado na mesma linha, e o botão
pareceria ter resolvido metade do problema.

A escolha fica guardada no navegador de quem olha, não na URL. Mandar o link de
um documento numa página específica faz sentido; mandar junto "e eu escondi a
lista" não — quem recebe não quer herdar o layout de quem mandou.

Sem documento escolhido o botão fica desabilitado, dizendo por quê: esconder a
lista quando não há nada ao lado deixaria a tela vazia.

### O canônico formatado, e o ícone da base

O canônico abre **formatado**, com um botão para ver o markdown cru ao lado. O
cru continua importando — é literalmente o que a busca indexa, e conferir o
texto exato é metade do trabalho de diagnosticar uma resposta ruim. Mas era a
única opção, e ler um manual de trinta páginas com as tabelas em pipe e os
prints de tela como `<!-- figura fig-3 -->` é ler o esqueleto, não o documento.

No formatado as **imagens aparecem**. Elas não podem ser um `<img src>` apontando
para a API: a rota da figura exige `Authorization: Bearer` e `<img>` não manda
header, então o caminho direto daria 401 e um ícone quebrado. Cada figura vem
por fetch autenticado e vira um blob local, revogado ao sair — um manual com
sessenta prints, sem revogar, deixaria todos presos na memória da aba.

A marca de página (`<!-- pagina 7 -->`) vira um separador visível em vez de
sumir: é a referência que a busca devolve, e sem ela o formatado perderia a
única âncora com o arquivo original.

O renderizador é nosso, e não uma biblioteca. O canônico não é markdown
arbitrário da internet — quem escreve é o pipeline, então o subconjunto é
pequeno e conhecido. Uma biblioteca completa traria HTML embutido junto e a
necessidade de um sanitizador, porque renderizar markdown de documento enviado
por outra pessoa com `dangerouslySetInnerHTML` é o caminho curto para XSS. Aqui
o markdown vira **árvore**, e a árvore vira elemento React: nenhuma string do
documento chega a ser HTML. Um `<script>` dentro do arquivo aparece como texto,
que é o certo — ele é conteúdo, não página.

A página da wiki ganhou o mesmo botão, com uma diferença: o **frontmatter fica
cru**. Ele é estrutura (`type`, `status`, `trust`, os links), e formatá-lo como
prosa transformaria chave e valor numa frase, perdendo a forma que o torna útil.

**O ícone da base** é escolhido por administrador e vale para todo mundo: ele
identifica o Espaço, não a preferência de quem olha, senão deixa de servir para
combinar ("abre a base do balãozinho"). Duas formas: um ícone da biblioteca da
interface, ou uma **imagem enviada**. Base sem ícone cai para a **inicial do
rótulo** — numa lista onde ninguém escolheu nada, trinta ícones iguais não
distinguem nada, e a letra pelo menos separa "Jurídico" de "RH".

A imagem é reduzida para 96px **duas vezes**: no navegador, para não subir uma
foto de 4 MB só para o servidor jogar 99% fora; e no servidor, porque o
downscale do navegador é conveniência e não controle — quem chama a API não é
obrigado a ser esta tela. Sem a segunda redução, um `curl` com um PNG de
8000x8000 entraria na coluna e voltaria em **toda** leitura de `/v1/spaces`,
fazendo a lista de bases custar megabytes sem erro nenhum. O que fica gravado é
WebP de poucos kB, dentro da própria linha da base: no object store, cada linha
da lista viraria uma requisição autenticada a mais só para pintar 44px.

SVG não entra. Ele é documento executável (script, `foreignObject`, referência
externa) e o Pillow não o abre — passaria intacto para dentro de um `<img>` na
tela de todo mundo. Imagem que vira código não entra por um campo de enfeite.

### Preço do modelo, e o gasto em dólar

Cada provedor guarda o **preço por 1M de tokens**, separado em entrada e saída,
porque eles custam diferente: na maioria dos provedores a saída sai de três a
cinco vezes mais cara, e um preço único aplicado ao total erraria para mais no
embedding (que só tem entrada) e para menos no chat.

O número não precisa ser digitado de cabeça: o botão **Buscar preço** consulta o
mesmo catálogo que o agentic-sdlc usa, o `model_prices_and_context_window.json`
do LiteLLM. Ele existe porque digitar à mão erra de duas formas caras — uma
vírgula fora de lugar multiplica o custo por dez na tela, e um preço velho faz o
dashboard divergir da fatura sem nada dizer por quê.

A resposta separa **três** situações, porque a ação de cada uma é diferente:

- **achou** — o preço vem preenchido, com o aviso de conferir: o catálogo é
  público e pode estar à frente ou atrás do seu contrato;
- **o catálogo não conhece este modelo** — normal para deployment do Azure com
  nome próprio. Preencha à mão;
- **não deu para ler o catálogo** — a instalação pode estar sem saída para a
  internet. Um gateway LiteLLM cadastrado serve de fonte pela rede interna, na
  rota `/public/litellm_model_cost_map`.

Juntar as duas últimas numa resposta só foi um defeito real no agentic-sdlc: num
cluster sem saída, a busca respondia "não conheço" até para `gpt-4o`, e quem
visse isso concluiria que o modelo mais comum do mercado não tem preço.

Trocar o modelo **apaga a marca de origem** do preço, mas não o número: preço de
um modelo aplicado a outro produz custo errado com cara de apurado, e apagar o
que alguém digitou à mão seria pior ainda.

Preço em branco quer dizer **não cadastrado**, e não "de graça". A diferença
aparece na tela de Uso de IA: ela mostra quantos tokens ficaram sem preço e
avisa que o custo está incompleto, em vez de somar zero e parecer apurada. Custo
zero e custo desconhecido somam igual — sem esse aviso, uma conta que ninguém
precificou apareceria como economia e o total do mês ficaria abaixo da fatura.

O custo é **congelado na hora do uso**, não calculado na leitura. Trocar o preço
amanhã não reescreve o gasto de ontem: o dinheiro de ontem saiu pelo preço de
ontem, e um histórico que muda sozinho a cada correção de tabela não se audita.

O efeito colateral é que quem cadastra o preço **depois** de já ter rodado fica
com um histórico inteiro em zero — e zero na tela parece "não gastou". Para
isso existe **Aplicar preço ao histórico**, na tela de Uso de IA. É um botão, e
não um recálculo automático na leitura, justamente porque muda número de
histórico: ninguém deve descobrir depois que os valores de ontem mudaram
sozinhos.

Ele não recalcula tudo com a mesma confiança, e a tela diz qual é qual:

- **exato** para embedding. A operação não tem saída, então todo token é de
  entrada por definição da chamada — não há o que supor;
- **exato** para linha já gravada com a decomposição, porque os números vieram
  do próprio provedor;
- **estimado** para chat antigo. Essas linhas guardam só o total, e entrada e
  saída custam diferente. A divisão padrão é 90% de entrada, que vem da forma
  das nossas chamadas (documento inteiro no prompt, JSON curto na resposta), e
  o que for suposto fica contado à parte.

Estimativa somada com apurado, sem nada distinguindo os dois, é pior que número
ausente: os dois somam igual e só um sustenta uma conversa de orçamento.

Linha de provedor sem preço continua fora, e aparece no resumo — a ação ali é
cadastrar o preço, não recalcular de novo.

O cadastro do provedor também passou a ser **editável** — endpoint, modelo,
versão da API, dimensões e preço. O tipo e o propósito ficam travados: o tipo
decide a URL e o cabeçalho de auth, e o propósito é o que as bases apontam. A
credencial em branco mantém a que está lá, porque exigir que ela fosse
redigitada para mexer num preço seria pedir um segredo de volta à toa.

### Ver o arquivo original

| Formato | Como |
|---|---|
| PDF | pdf.js, com navegação de página, zoom e a passagem marcada |
| DOCX | `docx-preview` — mantém tabela, estilo e imagem do Word |
| XLSX / XLS | SheetJS, uma aba por planilha |
| imagens | direto |
| TXT, MD, CSV, JSON, LOG, YAML | texto, com a passagem marcada |
| resto (PPTX…) | diz que não há visualização embutida e oferece o download |

O formato sem visualização **diz isso**, em vez de tentar. Renderizador ruim é
pior que ausência de renderizador: ele parece mostrar o documento e mostra outra
coisa — e o ponto desta aba é conferir o canônico contra a fonte.

### Achar o trecho dentro do original

Cada trecho indexado guarda a **página** do arquivo de onde saiu. Vindo da busca,
o botão *No original* abre o PDF naquela página e marca a passagem na camada de
texto. A pergunta que isso responde é "onde exatamente isso está escrito?" — sem
ela, a evidência aponta para o arquivo, não para o lugar.

O destaque depende da camada de texto do PDF, então quando o trecho veio de uma
imagem (via OCR) a página está certa mas não há o que marcar. A tela diz isso em
vez de fingir que não achou nada.

### Conectar o editor pelo MCP

A ponte é um servidor MCP **remoto**: o editor só precisa da URL e de um header.
Não há nada para baixar nem instalar, e atualizar a ponte é publicar a API.

A tela mostra a **URL do conector** e mais nada: quem conecta cola a URL no
editor e clica em **Entrar**. Nenhum token passa pela conversa, nenhum arquivo
precisa ser editado.

| Editor | Onde colar |
|---|---|
| Claude Desktop | Configurações → Conectores → Adicionar conector personalizado |
| Cursor | botão *Adicionar ao Cursor* (deeplink `cursor://`) ou Settings → MCP |
| Claude Code | um comando `claude mcp add` — sem header |
| opencode, Codex | arquivo com só a URL |

Por baixo, o **kb-api é o Authorization Server do próprio MCP** e federa o login
ao Identity. O editor toma 401 com `WWW-Authenticate`, descobre os metadados, se
registra sozinho (RFC 7591), manda a pessoa ao Identity, e recebe um par
access/refresh nosso.

Isso não exige client novo no realm — o usado é o `kb-ui`, o mesmo da
interface, público e com PKCE.

Dois ganhos sobre o token colado:

- **os grupos deixam de ser uma fotografia.** O refresh token do Identity fica só
  no servidor e é usado a cada renovação (1 h) para reler a identidade. Pessoa
  desativada lá perde o acesso aqui na renovação seguinte;
- **revogação de verdade.** A tela lista os editores conectados e desconecta um a
  um.

Defesas: PKCE S256 obrigatório, `redirect_uri` só https ou loopback, código de
uso único, rotação do refresh, access de 1 h, hash de tudo no banco. Erro de
`client_id` ou de `redirect_uri` **não** volta pelo redirect — isso seria um
redirecionador aberto, com o parâmetro exatamente sob suspeita.

O **token pessoal** continua, fechado atrás de *"Meu editor não tem opção de
login"*, com o custo dito antes do botão: segredo em texto puro no disco e grupos
congelados na emissão.

A decisão inteira, incluindo por que a primeira versão (token colado na conversa)
estava errada: [`docs/decisao-token-mcp.md`](decisao-token-mcp.md).

#### Alcançável de fora: o túnel

Isto vale **só para o ambiente local**. Quando a base já está publicada num
endereço próprio (o endereço do cluster de dev, por exemplo), a tela de
conexão mostra um endereço só e nem menciona o túnel — ele não resolveria
problema nenhum, e a instrução de `.env` não existe naquele ambiente. O sinal é
de onde a tela foi aberta: se você chegou por um nome que não é `localhost`,
quem está na mesma rede chega também.

`http://localhost:8890` só existe na máquina de quem subiu o cluster. Sem túnel,
conectar o editor é uma demonstração de uma pessoa só — não dá para mostrar ao
time, nem conectar o Claude do celular, nem deixar alguém testar da própria
máquina.

Com `NGROK_AUTHTOKEN` preenchido no `.env`, o `20-deploy.sh` sobe um túnel
apontando para o `kb-ui` — que já é a única entrada da stack, então a mesma URL
serve a interface, a API e o MCP. A tela de conexão passa a oferecer os dois
endereços, e a configuração gerada muda junto.

Sem o token o túnel simplesmente não sobe, e o ambiente segue igual: é recurso
opcional, e um pod em CrashLoopBackOff faria um ambiente saudável parecer
quebrado.

⚠ ngrok grátis permite **uma sessão por conta**. Com o túnel do agentic-sdlc de
pé, este não registra (`ERR_NGROK_334`).

### Manter as bases

Tudo abaixo é **só para administradores** — a API barra os mesmos verbos para
quem não é, então esconder o botão não é a defesa, é só coerência.

| Onde | O quê |
|---|---|
| **Bases** | criar base nova, remover base, e escolher a **ingestão** dela: modelos de IA, modo de ingestão e motor de chunking |
| **Documentos → Gerenciar** | enviar arquivos (vários, arrastando), acompanhar o processamento |
| **Documentos → um documento** | reprocessar e remover |
| **Modelos de IA** | cadastrar provedores por **propósito** — `embedding` e `chat`, vários de cada. O "em uso" de cada propósito é o **padrão da instalação**; cada base pode escolher outro. **Listar modelos** consulta a conta e mostra o que ela expõe |

Quatro decisões que valem explicar:

- **Envio em série, um arquivo por vez.** Em paralelo, cada arquivo carrega o
  pipeline de extração no mesmo pod — dois PDFs grandes ao mesmo tempo foi o que
  já derrubou o serviço por falta de memória.
- **Base nova nasce sem nenhum vínculo.** Só administradores a alcançam até
  alguém dar acesso em *Acessos*. É o contrário do conveniente, e de propósito:
  base nova com conteúdo visível por engano é mais caro que base invisível.
- **Remover base pede o identificador digitado**, não um "ok". Saem documentos,
  vetores, imagens e os arquivos originais de uma área inteira, sem desfazer.
- **Reprocessar parte do bruto guardado**, sem reenviar nada. É o caminho para o
  documento que falhou na extração e para o que foi indexado por um pipeline
  antigo — de antes do OCR, por exemplo. O arquivo original está intacto no
  object store; pedir de novo a quem enviou seria absurdo.

### A ingestão de cada base: quatro decisões

O botão `configuração` no card de **Bases** abre as quatro decisões daquela base,
em seções numeradas na ordem em que o pipeline as toma:

1. **modelos de IA** — com quem esta base fala;
2. **representações** — o que a ingestão constrói a partir de cada documento;
3. **índice: corte e enriquecimento** — onde a prosa é fatiada, e o que é
   prependado a cada trecho antes do embedding;
4. **tamanhos** — de que tamanho ficam pai e filho.

As quatro são independentes, e a segunda é a que muda mais: **representações se
somam**, não se substituem. O índice existe em todo Espaço; a wiki é ligável; o
grafo não é representação, é estrutura auxiliar do índice.

#### Modelos de IA desta base

Dois, e independentes:

| Modelo | Para quê | Sem ele |
|---|---|---|
| **Embedding** | vetoriza o texto, na ingestão e em cada pergunta | a busca funciona, mas fica **só lexical**: casa palavra, não sentido |
| **Chat** | o que os modos que classificam documento usam (hoje, derivar o conceito OKF) | esses modos só reconhecem o que já vier pronto no arquivo |

**"Padrão da instalação" é uma escolha legítima**, e é o estado de toda base que
nunca mexeu aqui — não é um campo por preencher. Cadastre os provedores em
*Administração > Modelos de IA* (podem ser vários, de cada propósito); o marcado
como "em uso" lá é o padrão, e aqui cada base pode sobrepô-lo.

Duas coisas que valem saber:

- **trocar o embedding não reindexa.** Os trechos já indexados continuam com os
  vetores do modelo anterior; reprocesse em *Documentos* para alinhar. É a mesma
  regra do motor de corte;
- **o modelo de embedding precisa ter a dimensão do índice.** A tela recusa o
  contrário: misturar dimensões degrada a busca sem erro nenhum aparecer.

E uma ressalva, se você usar modelos diferentes em bases diferentes: uma busca
que abranja as duas mistura, na ordenação, similaridades vindas de modelos
distintos. É aproximação. A recomendação é um modelo por instalação, salvo
quando o objetivo é justamente comparar dois.

#### Modo de ingestão

O padrão é `Padrão`: extrai, corta e indexa, sem derivar metadado nenhum. É o
que toda base usa hoje.

O outro modo é `Conceitos (OKF)`. Nele, **todo documento passa a ter um
conceito**
([*Open Knowledge Format*](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md),
do Google Cloud) — e ele chega por duas procedências:

| Procedência | Quando | Custo |
|---|---|---|
| **escrito** | o arquivo `.md` já abre com frontmatter YAML contendo `type` | nenhum |
| **derivado** | qualquer outro formato: PDF, docx, planilha, `.md` comum | **uma chamada ao provedor de chat, por documento** |

Você **não precisa** enviar arquivo em formato nenhum especial. Mande o que já
manda; o que não vier escrito em OKF é lido pelo modelo, que devolve o tipo, o
título, a descrição e as tags. O resultado fica marcado como **gerado pela IA**
na tela, e nunca aparece como revisado — só um `verified` escrito no arquivo dá
esse selo.

Conceito escrito **ganha** do derivado. Reprocessar um bundle feito à mão não
rebaixa o que alguém revisou, e não gasta chamada de IA à toa.

Com um conceito resolvido, três coisas mudam:

- **o frontmatter sai do texto indexado.** Sem isso, `type: Metric` e
  `generated: {by: ...}` entram na busca lexical de todo conceito do bundle;
- **a identidade do conceito entra na frente de cada trecho.** É o ganho
  principal, e ele é de recuperação: "o cálculo roda toda madrugada" solto não
  fica perto de pergunta nenhuma; com "Metric: Usuários ativos mensais" na
  frente, fica;
- **o título melhora onde ele era pior.** Num PDF de contrato, o primeiro
  cabeçalho costuma ser "CLÁUSULA PRIMEIRA" ou o nome do escritório no papel
  timbrado, e era isso que ia para a tela e para a citação do agente;
- **os links entre conceitos viram relação no grafo** (só nos escritos: um PDF
  não referencia outros conceitos). Em *Documentos*, o painel de relacionados
  passa a distinguir `3 links OKF` de `8 termos`.

**Os tipos são seus.** O campo no diálogo lista o que o modelo pode escolher —
por padrão Política, Procedimento, Manual, Contrato, Norma, Ata, Relatório e
Referência. Ele escolhe **um da lista**; quando nenhum serve, cai em
`Documento`. Ver muitos `Documento` é o sinal de que falta um tipo ali. A lista
não é livre de propósito: com tipo livre, 40 documentos rendem 31 tipos quase
iguais e a etiqueta deixa de agrupar qualquer coisa.

**Precisa de um modelo de `chat`** — o do bloco acima. Sem ele, a derivação não
acontece e só os arquivos já escritos em OKF são reconhecidos. O diálogo avisa
quando falta.

E duas coisas que a tela deixa explícitas:

- **o modo vale junto com o motor, não no lugar dele.** O corpo continua sendo
  cortado pelo motor escolhido;
- **não é retroativo, e isso pesa mais aqui do que no motor.** O modo muda o
  *texto indexado*, então a mesma pergunta pode achar um documento e não achar
  o outro enquanto os dois modos convivem. Em *Documentos*, o que estiver
  desalinhado ganha etiqueta com o modo antigo, e o botão **Reprocessar
  desalinhados** já conta modo e motor juntos.

**O modo não substitui o motor de corte.** O conceito é metadado do documento
*inteiro*: diz o que ele é, não onde o corpo deve ser fatiado — e a especificação
não limita o tamanho de um conceito. Medido nesta instalação, com os tamanhos
padrão:

| Conceito | markdown | sentenças | tamanho fixo |
|---|---|---|---|
| curto (200 caracteres) | 1 pai, 1 trecho | 1, 1 | 1, 1 |
| longo (15,5 mil) | 4 pais, 16 trechos | 4, 18 | 4, 16 |

Ou seja: num conceito que cabe num trecho só, os três motores dão o mesmo
resultado e a escolha não importa. Num conceito longo, ela decide onde as
fronteiras caem. Se um modo futuro não fatiar o documento, as seções 3 e 4
aparecem apagadas — a tela sabe disso pelo próprio catálogo.

> A lista de modos vem do servidor. Quando um modo novo for acrescentado (uma
> destilação em wiki, uma ingestão que só alimente o grafo), ele aparece no combo
> sozinho, com a própria descrição, o próprio custo e dizendo se corta ou não —
> a tela não precisa mudar.

#### Motor de corte

Não existe um corte bom para tudo. Um manual com heading e uma ata em texto
corrido pedem estratégias diferentes, e o pipeline aplicava a mesma nos dois.

| Motor | Corta por | Biblioteca | Custo |
|---|---|---|---|
| **Estrutura do documento** (padrão) | cabeçalho, depois sentença | LlamaIndex `MarkdownNodeParser` + `SentenceSplitter` | nenhum |
| **Sentenças** | fronteira de sentença, ignorando a estrutura | `SentenceSplitter` | nenhum |
| **Mudança de assunto** | queda de similaridade entre sentenças vizinhas | `SemanticSplitterNodeParser` | **embeda cada sentença na ingestão** |
| **Tamanho fixo** | número de caracteres, com sobreposição | corte próprio | nenhum |

O mesmo arquivo de RH, medido nesta instalação: 15, 17, 20 e 16 filhos — em
3,0 s, 3,3 s, **34,1 s** e 2,6 s. O semântico é o mais esperto e o único que
gasta para decidir onde cortar; por isso não é o padrão.

Três coisas que a tela deixa explícitas sobre o corte, porque errar nelas é
fácil:

- **a troca vale para o que entrar depois.** O que já está indexado continua com
  o corte antigo até ser reprocessado em *Documentos*. Reprocessar sozinho
  levaria horas sem ninguém pedir;
- **o filho tem de ser menor que o pai** — a API recusa o contrário, senão a
  expansão pai/filho não entrega contexto nenhum;
- **o semântico usa o mesmo modelo de embedding que indexa.** O
  `SemanticSplitterNodeParser` traria o da OpenAI por padrão; dois modelos
  decidindo coisas diferentes sobre o mesmo texto seria um defeito silencioso.

### Cadastrar um modelo sem decorar o nome

Errar o nome do modelo **não dá erro no cadastro**: ele salva, e a falha aparece
depois, como um 404 do provedor no meio de uma ingestão. No Azure é pior — o que
vai na URL não é o nome do modelo, e sim o **deployment**, que quem publicou pode
ter chamado de qualquer coisa (`gpt-4o-prod`, `emb-large-v2`).

O botão **Listar modelos** consulta a conta e mostra o que ela tem. Clique num
item para preencher o campo. Ele funciona em dois momentos:

- **no formulário**, com a credencial que você acabou de digitar;
- **num provedor já salvo**, pelo botão `Modelos` no card — aí a chave gravada é
  usada sem você redigitá-la (a tela nunca a reexibe).

O texto acima da lista diz **o que ela promete**, e a diferença importa:

| Origem | O que significa |
|---|---|
| deployments | o que está **publicado** naquele recurso Azure. Se não aparece, não existe ali |
| conta | o que **esta credencial** alcança (OpenAI, gateway LiteLLM). Uma virtual key restrita vê só o subconjunto dela |
| catálogo | o que o recurso **poderia** usar, e não o que está publicado. É o fallback do Foundry para recurso que não expõe a rota de deployments — confirme antes de confiar num item |

### O grafo, desenhado

A tela **Grafo** mostra o que a base ligou: entidades, termos, documentos e as
relações entre eles, sobre o `vis-network` — a mesma base do Memgraph Lab.

Duas visões, e a ordem entre elas é de propósito:

1. **forma do grafo** — rótulos e tipos de aresta com contagem. É o mapa, e
   responde "que forma isto tem" sem trazer um nó sequer;
2. **o grafo em si** — os nós de verdade, os de maior grau primeiro, porque são
   eles que dão a forma. O tamanho do nó é o grau.

Três coisas que valem saber:

- **o grafo não guarda texto.** Ele é estrutura auxiliar: os nós apontam para
  trechos que já existem no índice. Clicar num nó abre o que ele representa —
  documento leva ao documento, trecho mostra o texto ali mesmo (lido do índice,
  não do grafo), e entidade leva à busca pelo nome. O grafo é o caminho, o
  índice é o destino;
- **o nó cinza numerado é um trecho.** Ele não tem nome porque um trecho não
  tem: é um pedaço de texto identificado por número, e o número é o do trecho no
  índice. Selecionando, o conteúdo aparece com a página e se é pai ou filho;
- **o desenho é cortado.** Acima de algumas centenas de nós a figura deixa de
  informar e vira tinta. Quando corta, a tela diz de quantos;
- **o escopo é o seu.** O grafo desenha só o que você alcança. Sem esse filtro,
  a figura mostraria nome de entidade e título de documento de base proibida —
  vazamento por imagem, que nenhuma outra tela permite.

O campo de foco traz o que casa **e a vizinhança de um salto**, e ignora acento:
`diario` acha `diário`, `matricula` acha `matrícula`, `pré-matrícula` e
`matriculadas`. Sem a vizinhança o foco devolveria nós soltos, que é o que ele
fazia antes: `turma` nos 40 manuais dava dois pontos e nenhuma ligação.

O termo aparece no desenho sem base própria (`compartilhado entre bases`): o nó é
o mesmo para todo mundo, e é ele que liga bases diferentes pelo mesmo assunto. O
escopo dele vem da ligação — ele só entra se um documento que você alcança o
menciona, e expandir a partir dele nunca traz documento de base que você não
alcança.

**Redesenhar** relê o grafo e remonta o desenho. As duas coisas: só reler não
mudava nada na tela, porque um resultado igual volta na mesma referência e o
desenho nunca era refeito — o clique não fazia nada visível, que é pior do que
não ter o botão.

### Enviar documentos

Duas fases, de propósito. **Escolher não é enviar**: os arquivos caem numa lista
de conferência com nome, tamanho e extensão, e nada sai dali até você clicar em
enviar. Antes disso dá para filtrar por nome, desligar uma extensão inteira ou
tirar um arquivo da lista — foi assim que um `.gitkeep` arrastado junto com a
pasta deixou de virar uma falha no log.

Durante o envio a fila fica visível: qual está agora, quantos faltam, e o que já
passou. Cada envio só **sobe** o arquivo: o servidor o guarda, põe na fila e
responde, então a lista anda na velocidade do upload. O processamento acontece
depois, um arquivo por vez, e aparece no log como `na fila` e `processando`.
**Cancelar** interrompe o envio e deixa o resto ainda escolhido, para não ter de
selecionar noventa arquivos de novo. O que já tinha subido está na fila do
servidor e **será processado** mesmo assim.

Junto da fila vai um **progresso com prazo**: quantos do total já passaram,
quanto tempo já correu, e a estimativa do que falta. A média sai do **tempo de
relógio** entre o primeiro e o último arquivo, não da soma das durações: com
duas cargas ao mesmo tempo a soma conta o mesmo minuto duas vezes e a estimativa
sai pela metade.

Quando a carga **não** é desta tela — outra pessoa enviando, ou um script —, a
estimativa não aparece. A tela não sabe o total e uma barra com total chutado
andaria para trás, que é pior que não ter barra. Aparece o que é medível: quantos
entraram e o ritmo.

Enquanto houver documento processando, a contagem de documentos e trechos na
tela de Bases e na de Documentos **se atualiza sozinha**, a cada 10 s. Parada
quando não há nada rodando, porque consulta de contagem em base grande não é de
graça. Antes disso a tela mostrava 40 documentos e 639 trechos enquanto a API já
tinha 44 e 660: números velhos, sem nada indicando que estavam velhos.

### Benchmark: quão boa é a resposta

A tela **Benchmark** (Administração) responde a pergunta que a telemetria não
responde. Ela tem duas metades, e a separação é de propósito: o conjunto de
perguntas muda devagar, as execuções se repetem a cada mudança de configuração —
e é a repetição sobre o mesmo conjunto que permite comparar técnicas entre si.

**1. O conjunto de perguntas.** *Gerar com IA* lê documentos reais e propõe
perguntas com resposta de referência. Elas nascem em **rascunho** e não entram em
nenhuma execução até você aprovar. Ao lado fica o cadastro à mão, com o mesmo
destaque: a pergunta que você escreve porque sabe que a base erra nela é a mais
valiosa do conjunto — as geradas são fáceis por construção, porque saíram de um
documento que está na base.

Sem resposta de referência, três das cinco métricas não têm como ser calculadas.
A tela avisa na própria linha, em vez de deixar a execução voltar com metade das
colunas vazias.

**Melhoria de query.** Ao lado do modo há dois seletores, desligados por padrão.
Eles existem para o A/B: a mesma lista de perguntas, com e sem, e a diferença
atribuível ao slot. Medido sobre 16 perguntas difíceis nos manuais do Lyceum:

| | achou o documento no top-10 | latência |
|---|---|---|
| pergunta crua | 7/16 | 377 ms |
| reescrita no vocabulário do manual | 9/16 | 4,4 s |
| HyDE | 9/16 | 4,8 s |
| **as duas juntas** | **11/16** | 9,2 s |
| step-back | 3/16 | 3,6 s |

`step-back` **piora**: generalizar a pergunta afasta do documento específico. Ele
fica na lista porque a especificação o nomeia, com a medição ao lado.

O custo é 24× a latência, e é por isso que o padrão é desligado — quem chama
decide se pode pagar. Um agente costuma reformular sozinho e não precisa disto.

**2. Executar.** Dois modos:

| modo | o que mede | custo |
|---|---|---|
| só recuperação | precisão e cobertura do contexto | ~um terço do completo |
| completo | as cinco métricas | ~1 min por pergunta (medido) |

O modo completo sintetiza uma resposta a partir das passagens **só para medir** —
em produção o sistema devolve evidência, não resposta. É o que permite separar a
falha do recuperador da falha do gerador. A execução roda em segundo plano, com
progresso e cancelamento.

**O resultado aponta onde está o problema.** A nota geral é média harmônica: uma
métrica ruim derruba o conjunto, porque um sistema que não recupera o contexto
certo não é 80% bom. Abaixo dela, três leituras:

- **por métrica** — qual delas puxou a nota para baixo, com a marca dos 0,7;
- **composição dos diagnósticos** — quantas perguntas falharam por recuperação e
  quantas por resposta;
- **dispersão** — recuperação no eixo horizontal, resposta no vertical. À
  esquerda da linha, a busca não achou e mexer no prompt não resolve; abaixo
  dela, o contexto chegou e a resposta estragou.

E a lista por pergunta, com os trechos que a busca devolveu. A média esconde o
caso que interessa, e é nele que se olha para consertar.

### Quando uma representação não sai

O documento abre com um aviso quando **alguma representação falhou**, dizendo
qual e por quê. Só aparece no caso ruim: a que deu certo já se vê na aba dela.

O caso que motivou isto é silencioso. Numa carga de 45 documentos, **9 fecharam
com a wiki em zero páginas** e o grafo dos mesmos documentos saiu inteiro. Na
tela, uma wiki vazia era indistinguível de uma base sem wiki ligada, e a razão
já estava gravada em `document_representation` desde sempre — sem nenhuma rota
que a devolvesse. As três razões que a destilação distingue agora:

- **o modelo de chat não respondeu** — problema de provedor, e insistir ajuda;
- **o documento já está coberto pela wiki atual** — o modelo julgou, e não é
  falha nenhuma: é a wiki funcionando como wiki em vez de virar uma página por
  documento;
- **as páginas voltaram e foram recusadas na porta** — caminho inválido ou OKF
  malformado. Aqui o conserto é do lado de cá.

Sem separar as três, as três apareciam como "zero páginas" e levavam à conclusão
errada. O texto do erro sai **mascarado**: ele carrega o corpo de recusa do
provedor, e corpo de recusa às vezes traz pedaço de credencial.

### O log de processamento

O log guarda **todos** os arquivos processados, e pagina: 50, 100, 250 ou 500 por
vez, com o total ao lado para "50 linhas" não ser confundido com "só houve 50".
Há um atalho para ver **só as falhas**, e ele filtra no banco, não na página —
filtrar depois de cortar mostraria só as falhas que por acaso caíssem na primeira
página.

A ingestão é enfileirada: o `POST` volta assim que o arquivo sobe, e o servidor
processa a fila um por vez, então enviar dez livros juntos não multiplica a
memória do pod. Um PDF grande com OCR ainda leva minutos (o maior desta base
levou **13,5 minutos**, 121 páginas e 60 imagens), mas isso deixou de prender
uma conexão. Se o pod reiniciar no meio, o arquivo volta para a fila sozinho;
se ele derrubar o pod duas vezes, fecha como falha com essa explicação. O
porquê está na armadilha 28 da arquitetura.

O log responde as duas perguntas que a tabela de documentos não responde:

- **o que está processando agora** — linha `processando`, com o relógio correndo.
  Sem ela, treze minutos de silêncio são indistinguíveis de travamento;
- **quanto levou, e onde** — sem medir, "a ingestão está lenta" não vira "este
  arquivo leva 13 min e os outros levam 20 s".

Ele fica separado da tabela `document` porque tentativa que **falha** não produz
documento — e é justamente ela que precisa aparecer para ser reprocessada.

#### O robô leitor

Acima do log, enquanto houver processamento, aparece uma cena 3D: um robô lendo,
numa poltrona, com a marca da casa num quadro na parede, o **livro que tem na
capa o nome do arquivo que está sendo processado agora**. Quando o pipeline passa para o próximo arquivo, o robô fecha
o livro, guarda na pilha da direita (os lidos) e pega o próximo da pilha da
esquerda (os que faltam). Nada ali é enfeite solto: as duas pilhas são as
contagens reais da fila.

Ela existe por causa dos treze minutos. O log responde "o que está processando" a
quem lê tabela; a cena responde a mesma coisa de longe, e dá o que olhar em vez
do relógio.

O botão com o ícone de robô, na barra do log, abre e fecha a cena. Começando um
processamento ela abre sozinha; fora disso o robô aparece **ocioso**, sem livro
nas mãos. Fechada, nada é carregado — nem o chunk 3D, nem contexto de WebGL.

Ao lado dele, **só em `localhost`**, há `simular atividade`: alimenta a cena com
nomes tirados do próprio log e troca de livro a cada 4 s, para dar para ver o
comportamento sem enviar documento nenhum. Não fala com o servidor, e a cena
mostra o selo `simulação` enquanto está ligado — sem ele, um nome de arquivo
girando na tela pareceria ingestão de verdade. O teste é pelo hostname, e não
por `DEV`: a stack local roda o build de produção atrás do nginx, onde `DEV` é
falso.

O custo é zero para quem não está ingerindo, e isso foi condição de projeto:

- a biblioteca 3D (≈540 KB) está num chunk separado, carregado por `import()`
  dinâmico só quando há processamento. Nenhuma outra tela baixa isso;
- a cena é destruída quando o processamento acaba. Contexto WebGL é recurso
  escasso: o navegador derruba o mais antigo depois de cerca de dezesseis;
- qualquer falha dentro dela (WebGL bloqueado, driver antigo, chunk que não
  baixou) morre numa barreira de erro e some sem levar nada junto. O nome do
  arquivo e o progresso continuam escritos em HTML embaixo da cena, que é o que
  o leitor de tela lê;
- com `prefers-reduced-motion`, a cena é desenhada parada, sem laço de animação.

### A fila de ingestão

**Fila de ingestão**, no menu, mostra a fila do servidor inteira, de todas as
bases. O servidor processa **um arquivo por vez**, então dez livros enviados para
uma base atrás de três de outra só andam quando chega a vez deles, e é aqui que
isso fica visível.

A tela tem três blocos:

- **em processamento**: o arquivo que está rodando, com a **etapa** (extraindo
  texto, cortando, gerando embeddings, gravando, extraindo grafo), o **detalhe**
  (por exemplo "docling: páginas 41-80 de 912") e o **percentual**. O percentual
  sai do trabalho feito (lotes de página, lotes de embedding, trechos do grafo),
  não do tempo: um livro pode ficar minutos no mesmo número enquanto um lote de
  40 páginas passa pelo OCR;
- **na fila**: a ordem em que o worker vai pegar, com o botão **tirar da fila**.
  Só dá para tirar o que ainda não começou; o que está rodando termina;
- **concluídos recentemente**: o resultado e **até onde chegou**. Numa falha,
  isso diz onde olhar: parar em ~3% é a extração (arquivo), em 50-78% é o
  embedding (quase sempre cota do provedor de IA).

PDFs longos (80 páginas ou mais) passam por uma **triagem** antes da extração,
e a decisão aparece no log: por exemplo "triagem: 1.165 págs pelo PyMuPDF, 4
pelo docling (sem texto: 1, imagem: 1, tabela: 2)". Só as páginas que precisam
de OCR ou de leitura de tabela vão ao docling, então um livro digital de mil
páginas extrai em segundos. O extrator do documento aparece como
`pymupdf+docling` (ou `pymupdf`, quando nenhuma página precisou).

Todo documento tem um **log**, que se abre na linha: cada troca de etapa e cada
marco (cada lote do docling, cada 10% do embedding e do grafo), com hora e
percentual. Execuções anteriores à fila não têm log detalhado.

Se o serviço reiniciar no meio, o arquivo volta para a fila sozinho e aparece
como **retomado**. Se ele derrubar o serviço duas vezes, fecha como falha em vez
de tentar para sempre.

### A retentativa automática

Documento que falha por motivo **passageiro** (provedor devolveu 429, a rede
piscou, o OCR estourou o tempo) volta sozinho para a fila e é retentado, com
espera crescente: 5, 15, 45, 180 e 720 minutos. Cinco tentativas, e depois para.

Erro **definitivo** não entra nessa fila. Arquivo protegido por senha, corrompido
ou do qual nenhum extrator tirou texto não melhora com insistência — insistir só
gastaria OCR. Ele aparece no log como falha e espera uma pessoa.

Duas coisas que a rota `/v1/retry` responde e que valem para operar:

- **`next_retry_at` nulo quer dizer "parou de tentar"**, não "esperando a vez". É
  o que separa o que ainda vai voltar sozinho do que precisa de alguém;
- **a rodada é adiada enquanto houver ingestão de usuário rodando**, e a resposta
  diz quantas. Isso vale inclusive para o disparo manual: "agora" não passa na
  frente de quem está esperando na tela. Nada se perde — a fila fica intacta e a
  próxima rodada pega os mesmos documentos.

O adiamento não é zelo abstrato. Os documentos da fila falharam por motivo
passageiro, e motivo passageiro durante uma carga é quase sempre *o sistema
ocupado*. Retentar no meio da carga deixa a carga mais pesada, tem mais chance de
falhar de novo, e cada falha dessas queima uma tentativa do backoff contra um
sistema que estava ocupado, não quebrado. Medido: com duas ingestões simultâneas
um documento passou de 267 s para 1042 s — a terceira viria da retentativa.

### O retrato técnico

`/v1/stack` mede a instalação e a tela **Stack** a mostra. É deliberadamente
**diferente** do `/v1/health`: o health responde "está de pé?" e serve à sonda do
kubelet, por isso é barato e não conta nada. O stack responde "o que exatamente
está rodando aqui, com quantos vetores, quantos arquivos e que tamanho de grafo".

O que ela expõe e por quê:

| | |
|---|---|
| vetores no pgvector, por **modelo** | mais de um modelo no índice é um defeito silencioso: a busca passa a comparar vetores de espaços diferentes e piora sem nenhum erro aparecer |
| objetos e bytes no object store | é o bruto preservado; o número diz se a auditoria tem com o que trabalhar |
| nós e arestas no Memgraph | por label, não um total: "42 documentos e 1.805 termos" mostra a forma do grafo e revela na hora quando a ingestão gravou documento sem termo |
| **cobertura da página** | quantos trechos sabem em que página do original estão — é a métrica que diz se o "ir ao trecho" funciona ou cai na página 1 sem avisar |
| cada biblioteca, com a versão **e o arquivo onde ela é usada** | a versão sozinha não explica nada: a pergunta útil não é "que versão do docling", é "o que quebra se o docling sair". Neste projeto a diferença entre uma extração boa e uma ruim já foi literalmente uma versão de biblioteca |
| tamanho de cada tabela | onde o disco está indo |

Quem não é admin vê os números, mas não o issuer nem o grupo de administração:
são detalhes de configuração de segurança, não métrica de operação.

### OCR das imagens

Em manual de processo a instrução de verdade costuma estar no **print de tela**,
não no parágrafo. Sem OCR esse conteúdo não existe para a busca: o documento
aparece indexado, com a resposta certa escondida numa imagem que ninguém leu.

O OCR é o tesseract (`por` + `eng`), chamado só onde não há camada de texto — PDF
digital continua saindo pelo caminho rápido. Cada figura é guardada no object
store com o texto lido ao lado, e as duas coisas aparecem juntas na aba
**Imagens**: mostrar a imagem ao lado do texto é o que permite conferir se o OCR
acertou.

Medido num manual de 6 páginas cheio de prints, com o processo quente: 20 s sem
OCR, 50 s com OCR de página e de figura — e o texto indexado quase dobrou (2.292
→ 4.330 caracteres). Desligar: `KB_OCR=0` / `KB_FIGURES=0`.

No canônico, cada figura aparece como um **link Markdown para a imagem
guardada**, com a legenda e a página, seguido do texto do OCR:

```markdown
![Tela de agendamento (pagina 3)](/v1/documents/42/figures/fig-1/image)
Agendamento de ferias. O colaborador escolhe o periodo desejado...
```

Isso tem uma consequência de ordem no pipeline: o link carrega o id do
documento, então o id é **reservado** (`nextval` na sequência) antes do
chunking. Reescrever depois mudaria o tamanho do texto e invalidaria todos os
offsets — que são justamente o que dá a página de cada trecho.

Para desenvolver a UI sem rebuildar imagem:

```bash
cd services/kb-ui
npm install
VITE_KEYCLOAK_URL=http://kc.localtest.me:8481 \
VITE_KEYCLOAK_REALM=goga-interno \
VITE_KEYCLOAK_CLIENT_ID=kb-ui \
npm run dev        # http://localhost:3010, com proxy para o cluster
```

## Carga em massa

A UI tem *Documentos → Gerenciar* para enviar arquivos. Para carga inicial ou
reprocessamento de uma pasta inteira, o script faz o mesmo pela API:

```bash
./scripts/ingest.sh rh ./caminho/dos/documentos --group /goga/responsavel-tecnico
```

Um arquivo por vez, em série — de propósito. Em paralelo, cada arquivo carrega o
pipeline de extração no mesmo pod, e dois PDFs grandes ao mesmo tempo já
derrubaram o serviço por falta de memória.

Sem `--group`, o Espaço nasce alcançável só por administradores. É o contrário
do conveniente, e é intencional: base nova com conteúdo visível por engano custa
mais caro que base invisível. O vínculo pode ser criado depois em *Acessos*, sem
reingerir.

Reingerir o mesmo arquivo é seguro: sha256 idêntico é no-op, e conteúdo
diferente cria uma versão nova e desativa a anterior, sem `UPDATE` de texto.

## Acessos: quem alcança o que

A tela **Acessos** (só para administradores) edita os vínculos de permissão sem
passar pelo Identity:

| | |
|---|---|
| por **grupo** | caminho do grupo no realm, ex.: `/goga/responsavel-tecnico` |
| por **role** | role do realm, ou `cliente:role` |
| por **e-mail** | pessoa nominal, pelo claim `email` do token |
| por **EntraID** | `oid` da conta — a ponte de conta do agentic-sdlc |
| **público** | qualquer chamador autenticado |

Grupo e role são tipos **separados** de propósito: num realm corporativo os dois
são namespaces diferentes, e juntá-los faria um vínculo para o grupo
`/goga/curadoria` ser satisfeito por uma *role* de mesmo nome.

Administradores vêm de duas fontes. A primeira é o grupo configurado no deploy
(`KB_ADMIN_GROUP`, por padrão `/goga/curadoria`), que **não** é removível pela
tela — é ela que garante que existe um caminho de administração mesmo com a
tabela vazia, e sem isso alguém poderia se remover e trancar todo mundo fora. A
segunda é a tabela `kb_admin`, editável na tela, para promover alguém sem pedir
mudança no realm compartilhado.

A tela mostra também **quem já consultou**, do log de buscas. A aplicação não
tem cadastro de usuários — quem tem é o Identity — mas quem aparece com muitas
buscas e nenhum resultado costuma ser exatamente quem está esperando permissão.

## Permissão provada, não prometida

O isolamento por Espaço foi medido com três identidades de grupos diferentes:

```
usuario            grupos                    Espaços alcançados
ana.rh             ['/RH']                   ['rh']
bruno.juridico     ['/Juridico']             ['juridico']
admin.kb           ['/goga/curadoria']       ['juridico', 'rh']
```

A mesma pergunta ("como solicitar férias") devolve documentos de RH para a Ana e
documentos do Jurídico para o Bruno. E quando o Bruno pede **explicitamente**
`spaces: ["rh"]`, a resposta vem vazia com
`escopo: {espacos: [], resultado: "nenhum Espaço alcançável"}` — o parâmetro só
restringe, nunca amplia. É literalmente o que o FUN-08 exige: aplicado no
servidor, antes de qualquer método de acesso, não contornável por parâmetro.

Uma ressalva sobre os nomes de grupo: no realm `goga-interno` não existem `/RH`
nem `/Juridico` (os de lá são `/goga/curadoria`, `/goga/responsavel-tecnico`,
`/goga/advogados-parceiros` e `/goga/ops`), e qual grupo "é" o dono de um
Espaço não é decisão de código. Por isso o grant é sempre explícito, na carga
ou na tela:

```bash
./scripts/ingest.sh rh ./docs-rh --group /goga/responsavel-tecnico
```

O vínculo funciona por **grupo**, por **role** (namespace separado do grupo),
por **object id do EntraID** (`oid`, a ponte de conta do agentic-sdlc) ou por
e-mail — todos resolvidos na mesma consulta a `space_grant`.

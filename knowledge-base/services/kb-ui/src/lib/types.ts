/** Contratos do kb-api, escritos a mao a partir das rotas de main.py. */

export type Principal = {
  source: string;
  email?: string | null;
  groups: string[];
  /** Roles do realm e dos clients — namespace separado dos grupos. */
  roles?: string[];
  entra_oid?: string | null;
  /** Grupo (ou role) de administracao: alcanca todos os Espacos. */
  unrestricted: boolean;
};

/** Como o Espaco corta os documentos. Vale para o que for ingerido DEPOIS. */
export type ChunkConfig = {
  engine: string;
  child_chars: number;
  child_overlap: number;
  parent_chars: number;
  breakpoint_percentile: number;
  /** Variante do slot de enriquecimento de chunk, interno ao índice: o que é
   *  prependado a cada trecho antes do embedding. Não confundir com
   *  representação — essa é outro eixo, e vive em `representations`. */
  enrichment: string;
  /** Tipos que a derivação pode escolher. Chega sempre resolvido — quando a
   *  base não define nenhum, vem o padrão da casa, para a tela mostrar o que
   *  está em vigor em vez de um campo vazio. */
  okf_types: string[];
};

export type ChunkEngine = {
  id: string;
  label: string;
  lib: string;
  cuts_by: string;
  good_for: string;
  cost: string;
};

/** Um modo de ingestão. Vem da mesma rota dos motores porque a tela é uma só,
 *  mas em chave separada: escolher um modo não substitui o motor, soma a ele.
 *
 *  A tela DESENHA O QUE VIER. Acrescentar um modo no servidor (uma destilação
 *  em wiki, uma ingestão que só alimenta o grafo) não deve exigir mudança
 *  aqui — por isso nada nesta tela conhece `okf` pelo nome, fora os campos
 *  opcionais que só ele preenche. */
export type Enrichment = {
  id: string;
  label: string;
  /** Uma linha, para a opção do combo. */
  summary: string;
  /** O parágrafo que explica o modo escolhido. */
  does: string;
  good_for: string;
  cost: string;
  /** Precisa de um modelo de chat na base? A tela avisa antes de deixar
   *  escolher, senão o modo é ligado e metade dele não acontece em silêncio. */
  needs_chat: boolean;
  /** O motor de corte se aplica neste modo? Um modo que só alimente o grafo
   *  não fatia nada, e aí as seções de corte e tamanho não são decisão — são
   *  campos que não fazem efeito. */
  uses_engine: boolean;
  /** A especificação que o modo segue, quando há uma. */
  spec: string;
  /** Só os modos que classificam documentos preenchem estes. */
  default_types?: string[];
  generic_type?: string;
};

/** Um modelo EM VIGOR num Espaço — o que de fato vai ser usado, não o id que
 *  foi escolhido. Quando o provedor escolhido é apagado ou desativado, a base
 *  cai para o padrão da instalação, e é esse que aparece aqui. */
export type SpaceProvider = {
  id: number;
  name: string;
  model: string;
  kind: string;
  /** `false` = veio do padrão da instalação, inclusive quando a escolha da base
   *  caiu porque o provedor sumiu. */
  from_space: boolean;
};

export type SpaceAi = {
  embedding: SpaceProvider | null;
  chat: SpaceProvider | null;
};

/** Uma representação: estrutura derivada do canônico, construída na ingestão.
 *
 *  O `índice` é a de base e existe em todo Espaço (`optional: false`). A `wiki`
 *  é ligável. Não confundir com **auxiliar**: essa não cria conteúdo, só abre
 *  outro caminho até o conteúdo que a representação dela já tem. */
export type Representation = {
  id: string;
  label: string;
  summary: string;
  builds: string;
  methods: { id: string; label: string; delivers: string }[];
  optional: boolean;
  needs_chat: boolean;
  cost: string;
  requirement: string;
};

export type Auxiliary = {
  id: string;
  label: string;
  summary: string;
  /** De qual representação ela é auxiliar. */
  of: string;
  methods: { id: string; label: string; delivers: string }[];
  needs_chat: boolean;
  cost: string;
  requirement: string;
};

export type Space = {
  slug: string;
  label: string;
  description?: string | null;
  documents: number;
  failed: number;
  chunks: number;
  chunking: ChunkConfig;
  ai?: SpaceAi;
  /** Representações e auxiliares ativas, como conjunto. `indice` sempre true. */
  representations?: Record<string, boolean>;
  /** A marca da base numa lista longa. Texto curto, normalmente um emoji.
   *  Vazio é o normal: a lista cai para a inicial do rótulo. */
  icon?: string;
};

export type SpacesResponse = { spaces: Space[]; principal: Principal };

export type DocumentSummary = {
  id: number;
  filename: string;
  title?: string | null;
  extractor?: string | null;
  status: string;
  version: number;
  size_bytes?: number | null;
  error?: string | null;
  indexed_at?: string | null;
  /** Páginas do original; 0 quando o formato não tem paginação. */
  pages: number;
  mime: string;
  /** Imagens extraídas (com o texto lido por OCR). */
  figures: number;
  chunks: number;
  /** Motor que cortou ESTE documento — pode diferir do atual da base. */
  chunk_engine: string;
  /** Tipo do conceito OKF; vazio quando o arquivo não foi reconhecido como um.
   *  É o que revela um bundle em que o modo não pegou em nada. */
  okf_type?: string;
  /** Variante de enriquecimento que ingeriu ESTE documento — pode diferir da
   *  atual da base. Vazio = indexado antes da coluna, e conta como desalinhado. */
  chunk_enrichment?: string;
};

export type DocumentFigure = {
  ref: string;
  page: number | null;
  caption: string;
  ocr_text: string;
  has_image: boolean;
  bytes: number;
};

export type RelatedDocument = {
  id: number;
  title?: string | null;
  shared: number;
  /** `okf` = relação declarada nos links do conceito; `termos` = inferida por
   *  termo compartilhado. A primeira é afirmação, a segunda é palpite. */
  via?: 'okf' | 'termos';
};

/** O conceito OKF de um documento. Vazio quando o documento não é um. */
export type OkfConcept = {
  type?: string;
  title?: string;
  description?: string;
  status?: string;
  tags?: string[];
  resource?: string;
  /** Derivado de `verified`, nunca declarado pelo próprio conceito. */
  trust?: 'unverified' | 'machine-confirmed' | 'human-reviewed';
  /** O conceito foi gerado por um modelo em vez de vir escrito no arquivo.
   *  Lido de `generated`, que é o campo que a própria especificação reserva
   *  para isso. */
  derived?: boolean;
  meta?: Record<string, unknown>;
};

export type DocumentDetail = {
  id: number;
  space: string;
  title?: string | null;
  filename: string;
  canonical_md: string;
  extractor: string;
  mime?: string | null;
  size_bytes?: number | null;
  version: number;
  content_sha?: string | null;
  created_at?: string | null;
  indexed_at?: string | null;
  tags?: string[];
  pages: number;
  okf?: OkfConcept;
  related?: RelatedDocument[];
  /** O RESULTADO do build de cada representação neste documento.
   *
   *  Não confundir com `Space.representations`, que é o mapa liga/desliga. Aqui
   *  a pergunta é outra: a wiki deste documento saiu, e se não saiu, por quê.
   *  A tela mostrava zero páginas sem dizer se foi o modelo, o contrato ou a
   *  base — e a resposta já estava gravada, só não tinha por onde sair. */
  representation_status?: RepresentationStatus[];
};

export type RepresentationStatus = {
  representation: string;
  status: 'ok' | 'falha' | string;
  /** Já vem com o que tem forma de credencial mascarado pelo servidor. */
  error?: string | null;
  updated_at?: string | null;
};

export type Passage = {
  chunk_id: number;
  document_id: number;
  space: string;
  title?: string | null;
  filename: string;
  content: string;
  score: number;
  scores: {
    vector: number | null;
    lexical: number | null;
    vector_rank: number | null;
    lexical_rank: number | null;
    /** Posição e score por método de acesso. As duas chaves acima seguem saindo
     *  porque o histórico já gravado tem aquela forma. */
    by_method?: Record<string, { score: number | null; rank: number }>;
  };
  /** Página do original onde a evidência está, quando se sabe. */
  page: number | null;
  document_pages: number;
  /** O trecho curto que casou — é ele que localiza a passagem no PDF. */
  match: string;
  /** De qual representação a evidência veio. Um trecho do índice e uma página
   *  destilada não são a mesma coisa, mesmo chegando na mesma lista. */
  representation?: string;
  /** Aviso de armadilha, quando o conteúdo está marcado: o sentido óbvio na
   *  leitura rápida é o inverso do que ele diz. Chega DENTRO da passagem, e não
   *  numa segunda chamada — a leitura errada acontece na primeira leitura. */
  armadilha?: string;
};

/** Uma etapa do pipeline de busca, como o kb-api a reporta. */
export type Stage = {
  tecnica?: string;
  espacos?: string | string[];
  resultado?: string;
  candidatos?: number;
  candidatos_unicos?: number;
  devolvidos?: number;
  tokens?: number;
  embed_ms?: number;
  latencia_ms?: number;
  erro?: string;
};

export type Telemetry = {
  run_id: number | null;
  total_ms: number;
  embed_tokens: number;
  stages: Record<string, Stage>;
};

export type SearchOutcome = { results: Passage[]; telemetry: Telemetry };

/** Resumo do trecho gravado no historico (search_run.results). */
export type RunResult = {
  document_id?: number;
  filename?: string;
  title?: string | null;
  space?: string;
  score: number;
  vector_score?: number | null;
  lexical_score?: number | null;
  page?: number | null;
  excerpt?: string;
};

export type SearchRun = {
  id: number;
  query: string;
  spaces: string[] | null;
  principal: string;
  surface: string;
  total_ms: number;
  embed_tokens: number;
  result_count: number;
  stages: Record<string, Stage>;
  results: RunResult[];
  created_at?: string | null;
};

export type Health = {
  status: string;
  env: string;
  auth: string;
  postgres: boolean;
  object_store: boolean;
  graph: { enabled: boolean; reachable: boolean; documents?: number; erro?: string };
  embedding_model: string;
  error?: string;
};

// ── permissão ─────────────────────────────────────────────────────────────

export type GrantKind = 'group' | 'role' | 'entra_oid' | 'email' | 'public';

export type Grant = {
  id: number;
  principal_type: GrantKind;
  principal_id: string;
  role: 'reader' | 'editor' | 'owner';
  created_at?: string | null;
};

export type SpaceGrants = { slug: string; label: string; grants: Grant[] };

export type AdminRule = {
  id: number;
  principal_type: Exclude<GrantKind, 'public'>;
  principal_id: string;
  note: string;
  created_by: string;
  created_at?: string | null;
};

export type AdminsResponse = {
  /** Grupo do Identity que dá acesso total — não removível pela tela. */
  identity_group: string;
  identity_role: string;
  admins: AdminRule[];
};

export type ObservedPrincipal = {
  principal: string;
  searches: number;
  last_seen?: string | null;
  /** Buscas que voltaram vazias: sinal de quem está esperando permissão. */
  empty_results: number;
};

// ── retrato técnico da instalação (/v1/stack) ─────────────────────────────

/** Uma peça da stack: versão instalada e ONDE ela entra na arquitetura. */
export type Library = {
  name: string;
  version: string;
  layer: string;
  role: string;
  module: string;
};

export type StackInfo = {
  env: string;
  auth: { mode: string; issuer?: string; admin_group?: string; admin_role?: string };
  pipeline: {
    extractors: string[];
    ocr: {
      enabled: boolean;
      engine: string;
      languages: string[];
      force_full_page: boolean;
      psm: number;
    };
    figures: { enabled: boolean; scale: number; max_per_document: number };
    chunking: {
      technique: string;
      /** Motor aplicado a um Espaço que não escolheu nenhum. */
      default_engine: string;
      engines: string[];
      representations: string[];
      auxiliaries: string[];
      enrichments: string[];
      default_enrichment: string;
      okf_chat_provider: boolean;
      child_chars: number;
      child_overlap: number;
      parent_chars: number;
    };
  };
  search: {
    vector: string;
    lexical: string;
    fusion: string;
    candidate_pool: number;
    default_top_k: number;
    embedding_dim: number;
  };
  postgres: {
    reachable: boolean;
    error?: string;
    version?: string;
    extensions?: Record<string, string>;
    counts?: {
      spaces: number;
      documents: number;
      failed_documents: number;
      parent_chunks: number;
      child_chunks: number;
      embeddings: number;
      figures: number;
      figures_with_ocr: number;
      search_runs: number;
      grants: number;
      pages: number;
    };
    /** Quantos trechos sabem a página do original — a métrica do "ir ao trecho". */
    page_coverage?: { with_page: number; total: number; pct: number | null };
    embedding_models?: Record<string, number>;
    table_bytes?: Record<string, number>;
    database_bytes?: number;
  };
  object_store: {
    reachable: boolean;
    endpoint: string;
    bucket?: string;
    objects?: number;
    bytes?: number;
    error?: string;
  };
  graph: {
    enabled: boolean;
    reachable: boolean;
    host: string;
    documents?: number;
    terms?: number;
    edges?: number;
    version?: string | null;
    error?: string;
  };
  versions: Record<string, string>;
  /** A mesma lista, com camada e arquivo de uso. */
  libraries: Library[];
  service: { started_at: string; uptime_seconds: number };
};

// ── gestão (só admin) ─────────────────────────────────────────────────────

/** Uma tentativa de ingestão. `running` é a que está acontecendo agora. */
export type IngestRun = {
  id: number;
  space: string;
  filename: string;
  document_id: number | null;
  status: 'running' | 'indexed' | 'failed' | 'skipped';
  extractor: string;
  size_bytes: number;
  pages: number;
  figures: number;
  parents: number;
  children: number;
  embed_tokens: number;
  chunk_engine: string;
  /** Enquanto roda, é o relógio desde o início — não zero. */
  total_ms: number;
  error: string;
  principal: string;
  started_at: string | null;
  finished_at: string | null;
};

/** Uma página do log de ingestão. `total` conta o filtro inteiro, não a página:
 *  sem ele, "40 linhas" é indistinguível de "só houve 40 arquivos". */
export type IngestRunPage = {
  runs: IngestRun[];
  total: number;
  limit: number;
  offset: number;
};

// ── avaliação offline: dataset golden e benchmark (FUN-07) ────────────────

/** Uma pergunta do dataset golden. `reference` vazio é válido: sem gabarito
 *  ainda dá para medir o gerador, e exigir gabarito para cadastrar travaria o
 *  uso mais simples ("escreva as perguntas que você faria"). */
export type BenchmarkQuestion = {
  id: number;
  question: string;
  reference: string;
  document_id: number | null;
  origin: 'manual' | 'gerada';
  status: 'rascunho' | 'aprovada' | 'descartada';
  /** Como a pergunta foi feita. `direta` tira do conteúdo como ele está;
   *  `dificil` deriva uma pergunta que NÃO reusa o vocabulário do documento —
   *  que é o que a busca lexical usa para acertar sem entender. */
  strategy: 'direta' | 'dificil';
  /** O tipo de dificuldade, de vocabulário fixo. Saber qual delas quebra a base
   *  importa: paráfrase mal é problema de embedding, multi-salto é problema de
   *  recuperar uma passagem só — e os consertos são diferentes. */
  kind: string;
  created_by: string;
  created_at: string | null;
  filename: string | null;
  title: string | null;
};

/** Uma métrica que saiu, ou o erro de quem não saiu. Métrica que falha não
 *  derruba a execução, e a tela precisa dizer qual não saiu. */
export type BenchmarkMetric = number | { erro: string };

export type BenchmarkSummary = {
  medias?: Record<string, number>;
  /** Média harmônica das médias: penaliza qualquer métrica individual baixa. */
  harmonica?: number | null;
  avaliadas?: number;
  diagnosticos?: Record<string, number>;
  latencia_mediana_ms?: number;
  modelos?: { chat?: string; embedding?: string };
  /** Os slots de melhoria de query desta execução. É o que torna duas execuções
   *  comparáveis: o mesmo conjunto, com e sem, e a diferença atribuível ao slot. */
  melhoria_query?: { rewrite?: string; query_embedding?: string };
  /** A comparação entre as duas estratégias é o ponto de existirem duas: uma
   *  nota geral misturando diretas e difíceis esconde as duas leituras. */
  por_estrategia?: Record<
    string,
    {
      perguntas: number;
      medias: Record<string, number>;
      harmonica: number | null;
      diagnosticos: Record<string, number>;
    }
  >;
  por_tipo?: Record<string, { perguntas: number; harmonica: number | null; falhas: number }>;
  /** O que o modelo do juiz recusou (`max_tokens`, `top_p`, `temperature`…).
   *  Vai para o trace porque explica uma execução com temperatura diferente da
   *  pedida — e sem isso a diferença ficaria invisível. */
  parametros_recusados?: string[];
};

export type BenchmarkRun = {
  id: number;
  mode: 'recuperacao' | 'completo';
  status: 'running' | 'done' | 'failed' | 'cancelled';
  total: number;
  done: number;
  config: Record<string, unknown>;
  summary: BenchmarkSummary;
  error: string;
  started_by: string;
  started_at: string | null;
  finished_at: string | null;
};

export type BenchmarkContext = {
  chunk_id: number;
  document_id: number;
  filename: string;
  title: string | null;
  representation: string;
  score: number;
  content: string;
};

export type BenchmarkResult = {
  id: number;
  question_id: number | null;
  question: string;
  reference: string;
  answer: string;
  contexts: BenchmarkContext[];
  metrics: Record<string, BenchmarkMetric>;
  /** Onde está o problema, pelo PADRÃO das métricas — não por uma delas. */
  diagnosis:
    | 'ok'
    | 'recuperador'
    | 'gerador'
    | 'recuperador_fraco'
    | 'gerador_fraco'
    | 'sem_metrica'
    | 'erro';
  latency_ms: number;
  error: string;
  strategy: 'direta' | 'dificil';
  kind: string;
};

export type BenchmarkRunDetail = BenchmarkRun & { space: string; results: BenchmarkResult[] };

// ── token pessoal (Conectar MCP) ──────────────────────────────────────────

export type PersonalToken = {
  id: number;
  name: string;
  /** Primeiros caracteres do valor. O resto nunca é lido de volta. */
  prefix: string;
  /** Fotografia dos grupos no instante da emissão — não muda depois. */
  groups: string[];
  created_at: string | null;
  expires_at: string | null;
  last_used_at: string | null;
  revoked: boolean;
  expired: boolean;
};

export type IssuedToken = {
  id: number;
  name: string;
  /** Só existe nesta resposta. */
  token: string;
  prefix: string;
  expires_at: string | null;
  groups: string[];
};

/** Um editor conectado pelo fluxo de login (OAuth). */
export type Connection = {
  id: number;
  client_name: string;
  /** Grupos da última renovação — relidos do Identity, não congelados. */
  groups: string[];
  created_at: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  revoked: boolean;
};

// ── Modelos de IA ──────────────────────────────────────────────────────────

/** Um tipo de provedor suportado, com o que cada campo significa na tela. */
export type AiKind = {
  id: string;
  label: string;
  endpoint_default: string;
  api_version_default: string;
  needs_api_version: boolean;
  /** "Deployment" no Azure OpenAI, "Modelo" nos demais. */
  model_label: string;
  endpoint_hint: string;
};

/** Para que a base usa um modelo. `embedding` é o original; `chat` entrou com a
 *  derivação de conceito OKF e é o único lugar onde este projeto pede texto
 *  gerado — a busca continua devolvendo evidência, nunca resposta. */
export type AiPurpose = {
  id: string;
  label: string;
  description: string;
  /** Só o embedding precisa casar com a dimensão do índice. */
  needs_dimensions: boolean;
};

/** De onde a lista de modelos veio. Não é decoração: cada valor promete uma
 *  coisa diferente, e prometer demais aqui custa uma investigação.
 *  - `deployments`: o que está PUBLICADO no recurso Azure;
 *  - `account`: o que ESTA credencial alcança (OpenAI, gateway LiteLLM);
 *  - `catalog`: o que o recurso PODERIA usar — fallback do Foundry, pode não
 *    responder. */
export type ModelSource = 'deployments' | 'account' | 'catalog';

/** Um modelo que a conta expõe. No Azure o `id` é o nome do DEPLOYMENT, que
 *  pode não ter relação com o nome do modelo — daí o `model` ao lado. */
export type CatalogModel = { id: string; model: string; label: string };

export type ModelListing = {
  source: ModelSource;
  /** O que esta lista promete, em uma frase. Vem da rota, não da tela: outro
   *  cliente precisa da mesma frase sem reescrevê-la. */
  note: string;
  models: CatalogModel[];
};

export type AiProvider = {
  id: number;
  name: string;
  kind: string;
  kind_label: string;
  /** Bases que escolheram ESTE provedor. Apagá-lo não dá erro: cada uma cai
   *  para o padrão da instalação, em silêncio — por isso a tela mostra. */
  spaces?: string[];
  endpoint: string;
  model: string;
  api_version: string;
  dimensions: number;
  purpose: string;
  active: boolean;
  is_default: boolean;
  /** Só os quatro últimos caracteres — a credencial nunca volta inteira. */
  api_key_tail: string;
  has_key: boolean;
  updated_at?: string | null;
  updated_by: string;
  /** Preço em dólar por 1M de tokens. `null` = NÃO cadastrado, que não é o
   *  mesmo que zero: sem preço a tela de uso diz que não sabe o custo, em vez
   *  de somar zero e parecer apurada. */
  price_input_per_1m?: number | null;
  price_output_per_1m?: number | null;
};

/** Resposta da busca de preço no catálogo.
 *
 *  `fonte` separa três situações com ações diferentes: `catalogo` achou;
 *  `nenhum` é o catálogo respondendo que não conhece o modelo (deployment com
 *  nome próprio — preencha à mão); `indisponivel` é não ter dado para LER o
 *  catálogo. Juntar as duas últimas faria a tela dizer "não conheço" até para
 *  um modelo comum, numa instalação sem saída para a internet. */
export type PriceLookup = {
  fonte: 'catalogo' | 'nenhum' | 'indisponivel';
  chave?: string;
  price_input_per_1m: number | null;
  price_output_per_1m: number | null;
};

export type AiProviderTest = {
  ok: boolean;
  error?: string;
  /** O que foi exercitado. Um teste de `chat` não tem dimensão para reportar —
   *  e mandar um embedding para um modelo de chat é o que fazia o Azure
   *  responder `OperationNotSupported` num cadastro correto. */
  purpose?: string;
  latency_ms?: number;
  tokens?: number;
  dimensions?: number;
  dimension_mismatch?: boolean;
  schema_dimensions?: number;
};

/** Contadores comuns a todo recorte do uso (dia, operação, provedor).
 *
 *  `sem_preco` são os tokens que NÃO viraram custo por falta de preço
 *  cadastrado no provedor. Ele existe porque custo zero e custo desconhecido
 *  somam igual: sem este número, uma conta que ninguém precificou apareceria
 *  como economia. */
export type AiUsageContadores = {
  calls: number;
  tokens: number;
  tokens_in: number;
  tokens_out: number;
  errors: number;
  cost_usd: number;
  sem_preco: number;
  /** Tokens cujo custo saiu de uma divisão SUPOSTA entre entrada e saída.
   *
   *  Só aparece em linha recalculada: o chat antigo guardava apenas o total, e
   *  entrada e saída custam diferente. Existe para a tela não somar estimativa
   *  com apurado sem dizer — os dois somam igual, e só um sustenta uma conversa
   *  de orçamento. */
  tokens_estimados: number;
};

/** O que o recálculo do histórico fez. */
export type RecalculoDeCusto = {
  linhas: number;
  atualizadas: number;
  exatas: number;
  estimadas: number;
  sem_preco: number;
  sem_provedor: number;
  tokens_exatos: number;
  tokens_estimados: number;
  custo_usd: number;
  fracao_entrada: number;
};

export type AiUsageBucket = AiUsageContadores & { name: string };

export type AiUsage = {
  days: number;
  total: AiUsageContadores & { latency_ms: number; avg_latency_ms: number };
  daily: (AiUsageContadores & { day: string })[];
  by_operation: AiUsageBucket[];
  by_provider: AiUsageBucket[];
};

/** Progresso do reprocessamento de um Espaço. Em memória no servidor: some se o
 *  pod reiniciar, porque a thread morre com ele. */
export type ReprocessStatus = {
  space: string;
  status: 'parado' | 'rodando' | 'concluido' | 'cancelado';
  total?: number;
  done?: number;
  failed?: number;
  current?: string;
  errors?: string[];
  only_outdated?: boolean;
  started_at?: string | null;
  finished_at?: string | null;
  started_by?: string;
  /** Quantos documentos estão cortados por um motor diferente do atual. */
  outdated: number;
};

// ── wiki ───────────────────────────────────────────────────────────────────

/** Uma página da wiki no índice do Espaço. */
export type WikiPageSummary = {
  id: number;
  path: string;
  type: string;
  title: string;
  description: string;
  words: number;
  updated_at: string | null;
  sources: number;
  /** Fora da faixa de 200 a 800 palavras do contrato de destilação. A página
   *  continua valendo — é marcação para o lint, não recusa. */
  out_of_contract: boolean;
};

export type WikiIndex = {
  space: string;
  pages: WikiPageSummary[];
  contract: { min_words: number; max_words: number };
};

/** Uma página inteira, com a navegação (BUS-07). */
export type WikiPage = {
  id: number;
  space: string;
  path: string;
  type: string;
  title: string;
  description: string;
  /** O arquivo OKF completo: frontmatter mais corpo. */
  content: string;
  frontmatter: Record<string, unknown>;
  words: number;
  updated_at: string | null;
  /** Links cruzados para outras páginas do mesmo Espaço. */
  references: { id: number; path: string; title: string }[];
  /** Documentos canônicos de onde esta página foi destilada. */
  sources: { id: number; filename: string; title: string | null }[];
};

/** Onde um trecho está: o documento, a página e o texto. É o que permite ver o
 *  conteúdo de um nó `Chunk` — o grafo não guarda texto, só aponta. */
export type ChunkLocation = {
  chunk_id: number;
  document_id: number;
  space: string;
  content: string;
  page: number | null;
  char_start: number | null;
  is_parent: boolean;
  filename: string;
  title: string | null;
  mime: string;
  document_pages: number;
};

// ── grafo (WEB-02) ─────────────────────────────────────────────────────────

/** Um nó do grafo, para desenhar. `grau` decide o tamanho: o nó que liga muita
 *  coisa precisa saltar aos olhos, porque é ele que explica a forma. */
export type GraphNode = {
  /** Id interno do nó no Memgraph. Serve para casar nó com aresta no desenho e
   *  **não significa nada fora do retorno do grafo**. Nunca use para navegar. */
  id: number;
  label: string;
  space: string;
  name: string;
  type: string;
  grau: number;
  /** O id de domínio: documento no Postgres num `Document`, trecho num `Chunk`.
   *  É este que abre alguma coisa. Nulo em `Entity`, `Term` e `Concept`, que não
   *  têm linha própria em lugar nenhum — só nome. */
  ref: number | null;
};

export type GraphEdge = { source: number; target: number; type: string };

/** A forma do grafo, sem trazer nó nenhum: o mapa que se olha antes. */
export type GraphSchema = {
  enabled: boolean;
  reachable: boolean;
  error?: string;
  nodes: { label: string; total: number }[];
  edges: { de: string; tipo: string; para: string; total: number }[];
};

export type GraphInstance = {
  enabled: boolean;
  reachable: boolean;
  error?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  total?: number;
  /** O desenho foi cortado no teto de nós. Precisa aparecer na tela: uma figura
   *  com 300 de 2.700 nós, sem dizer, passa a impressão de grafo pequeno. */
  truncated: boolean;
};

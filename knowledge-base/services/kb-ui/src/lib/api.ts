import axios, { type AxiosInstance } from 'axios';
import { ensureFreshToken } from './auth';
import { env } from './env';
import { httpErrMsg } from './errors';
import type {
  AdminsResponse,
  AiKind,
  AiProvider,
  AiProviderTest,
  AiPurpose,
  AiUsage,
  BenchmarkQuestion,
  BenchmarkRun,
  BenchmarkRunDetail,
  ChunkConfig,
  ChunkEngine,
  ChunkLocation,
  Connection,
  DocumentDetail,
  DocumentFigure,
  DocumentSummary,
  Grant,
  GrantKind,
  GraphInstance,
  GraphSchema,
  Health,
  IngestEvent,
  IngestQueue,
  IngestRunPage,
  QueueRun,
  Auxiliary,
  Enrichment,
  ReprocessStatus,
  IssuedToken,
  ModelListing,
  PriceLookup,
  RecalculoDeCusto,
  ObservedPrincipal,
  PersonalToken,
  SearchOutcome,
  SearchRun,
  SpaceGrants,
  Representation,
  SpaceAi,
  SpacesResponse,
  StackInfo,
  WikiIndex,
  WikiPage,
} from './types';

export const api: AxiosInstance = axios.create({
  baseURL: env.apiBaseUrl(),
  // 60s e nao 15s: uma busca fria paga o embedding da pergunta no Azure, e a
  // primeira chamada apos o pod subir pode passar de 15s.
  timeout: 60_000,
});

api.interceptors.request.use(async (config) => {
  const token = await ensureFreshToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Normaliza a mensagem aqui, uma vez: quem so mostra `err.message` recebe texto
// legivel em vez do texto padrao do axios.
api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (axios.isAxiosError(err)) err.message = httpErrMsg(err);
    return Promise.reject(err);
  },
);

export const kb = {
  spaces: () => api.get<SpacesResponse>('/spaces').then((r) => r.data),

  documents: (slug: string) =>
    api
      .get<{ space: string; documents: DocumentSummary[] }>(
        `/spaces/${encodeURIComponent(slug)}/documents`,
      )
      .then((r) => r.data.documents),

  document: (id: number) => api.get<DocumentDetail>(`/documents/${id}`).then((r) => r.data),

  /** Arquivo ORIGINAL. Vem por fetch autenticado; `<a download>` nao manda header. */
  raw: (id: number) =>
    api.get<Blob>(`/documents/${id}/raw`, { responseType: 'blob' }).then((r) => r.data),

  search: (body: {
    query: string;
    spaces?: string[];
    top_k?: number;
    rewrite?: string;
    query_embedding?: string;
  }) =>
    // Timeout maior: com a melhoria de query ligada, a busca passa de ~0,4s
    // para ~9s (duas idas ao modelo antes de procurar).
    api.post<SearchOutcome>('/search', body, { timeout: 120_000 }).then((r) => r.data),

  runs: (limit = 60) =>
    api
      .get<{ scope: string; runs: SearchRun[] }>('/runs', { params: { limit } })
      .then((r) => r.data),

  health: () => api.get<Health>('/health').then((r) => r.data),

  /** Retrato técnico: versões, contagens e tamanho de cada peça da stack. */
  stack: () => api.get<StackInfo>('/stack').then((r) => r.data),

  figures: (id: number) =>
    api
      .get<{ document_id: number; figures: DocumentFigure[] }>(`/documents/${id}/figures`)
      .then((r) => r.data.figures),

  // ── permissão (só admin) ──
  grants: () => api.get<{ spaces: SpaceGrants[] }>('/grants').then((r) => r.data.spaces),

  addGrant: (body: {
    space: string;
    principal_type: GrantKind;
    principal_id: string;
    role?: string;
  }) => api.post<Grant>('/grants', body).then((r) => r.data),

  removeGrant: (id: number) => api.delete(`/grants/${id}`).then((r) => r.data),

  admins: () => api.get<AdminsResponse>('/admins').then((r) => r.data),

  addAdmin: (body: { principal_type: string; principal_id: string; note?: string }) =>
    api.post('/admins', body).then((r) => r.data),

  removeAdmin: (id: number) => api.delete(`/admins/${id}`).then((r) => r.data),

  principals: () =>
    api.get<{ principals: ObservedPrincipal[] }>('/principals').then((r) => r.data.principals),

  // ── gestão (só admin) ──
  createSpace: (body: { slug: string; label: string; description?: string }) =>
    api.post('/spaces', body).then((r) => r.data),

  removeSpace: (slug: string) =>
    api.delete(`/spaces/${encodeURIComponent(slug)}`).then((r) => r.data),

  /** Dispara o reprocessamento do Espaço com o motor de corte ATUAL. Volta na
   *  hora: o trabalho roda em segundo plano, porque leva cerca de uma hora. */
  startReprocess: (slug: string, onlyOutdated: boolean) =>
    api
      .post<{ space: string; started: boolean; total: number; reason?: string }>(
        `/spaces/${encodeURIComponent(slug)}/reprocess`,
        { only_outdated: onlyOutdated },
      )
      .then((r) => r.data),

  reprocessStatus: (slug: string) =>
    api.get<ReprocessStatus>(`/spaces/${encodeURIComponent(slug)}/reprocess`).then((r) => r.data),

  cancelReprocess: (slug: string) =>
    api.delete(`/spaces/${encodeURIComponent(slug)}/reprocess`).then((r) => r.data),

  /** Motores de corte e formatos de entrada, com o custo de cada um. */
  chunkingEngines: () =>
    api
      .get<{
        default: string;
        default_enrichment: string;
        engines: ChunkEngine[];
        enrichments: Enrichment[];
        representations: Representation[];
        auxiliaries: Auxiliary[];
      }>('/chunking-engines')
      .then((r) => r.data),

  /** Escolhe os modelos DESTA base. `null` em qualquer um volta ao padrão da
   *  instalação — trocar o de embedding não reindexa nada, do mesmo jeito que
   *  trocar o motor de corte não reprocessa. */
  setSpaceAi: (
    slug: string,
    body: { embedding_provider_id?: number | null; chat_provider_id?: number | null },
  ) =>
    api
      .put<{ space: string; ai: SpaceAi }>(`/spaces/${encodeURIComponent(slug)}/ai`, body)
      .then((r) => r.data),

  /** Liga e desliga representações e auxiliares desta base. O `indice` não
   *  entra: ele existe em todo Espaço e a API recusa desligá-lo. */
  setRepresentations: (slug: string, body: Record<string, boolean>) =>
    api
      .put<{ space: string; representations: Record<string, boolean> }>(
        `/spaces/${encodeURIComponent(slug)}/representations`,
        body,
      )
      .then((r) => r.data),

  /** A marca da base. String vazia tira o ícone e volta para a inicial. */
  setSpaceIcon: (slug: string, icon: string) =>
    api
      .put<{ space: string; icon: string }>(`/spaces/${encodeURIComponent(slug)}/icon`, { icon })
      .then((r) => r.data),

  /** A forma do grafo: rótulos e tipos de aresta, com contagem. */
  graphSchema: () => api.get<GraphSchema>('/graph/schema').then((r) => r.data),

  /** O grafo para desenhar. `space` só RESTRINGE o escopo — quem decide o que é
   *  alcançável é o servidor. */
  graph: (p: { space?: string; focus?: string; limit?: number; labels?: string[] }) =>
    api
      .get<GraphInstance>('/graph', {
        params: {
          space: p.space || undefined,
          focus: p.focus || undefined,
          limit: p.limit,
          // Vazio some do pedido: lista vazia e ausente querem dizer a mesma
          // coisa para o servidor ("desenhe tudo"), e mandar `labels=` daria a
          // impressão de um filtro que não existe.
          labels: p.labels?.length ? p.labels.join(',') : undefined,
        },
      })
      .then((r) => r.data),

  /** O texto de um trecho, e onde ele está. O grafo aponta para o chunk sem
   *  guardar conteúdo, então ver o trecho de um nó passa por aqui. */
  locateChunk: (id: number) => api.get<ChunkLocation>(`/chunks/${id}/locate`).then((r) => r.data),

  /** O índice da wiki de um Espaço: o ponto de partida da navegação. */
  wikiIndex: (slug: string) =>
    api.get<WikiIndex>(`/spaces/${encodeURIComponent(slug)}/wiki`).then((r) => r.data),

  /** Uma página inteira, com referências cruzadas e as fontes (BUS-07). */
  wikiPage: (id: number) => api.get<WikiPage>(`/wiki/pages/${id}`).then((r) => r.data),

  setChunking: (slug: string, body: Partial<ChunkConfig> & { engine: string }) =>
    api
      .put<{ space: string; chunking: ChunkConfig }>(
        `/spaces/${encodeURIComponent(slug)}/chunking`,
        body,
      )
      .then((r) => r.data),

  /** Um POST por arquivo. A API guarda o arquivo, põe na fila e responde 202
   *  com `status: 'queued'`; o processamento acontece depois, um por vez, e
   *  aparece no log de ingestão. */
  upload: (slug: string, file: File, signal?: AbortSignal) => {
    const form = new FormData();
    form.append('file', file);
    return api
      .post(`/spaces/${encodeURIComponent(slug)}/documents`, form, {
        // O POST cobre só a SUBIDA do arquivo (até 100 MB), não o
        // processamento. Dez minutos é folga para upload lento; a ingestão, que
        // já levou 13 min num PDF com OCR, acontece depois, fora da conexão.
        timeout: 600_000,
        // Abortar corta a subida. Se o arquivo já tinha chegado, ele está na
        // fila e será processado mesmo assim.
        signal,
      })
      .then((r) => r.data);
  },

  removeDocument: (id: number) => api.delete(`/documents/${id}`).then((r) => r.data),

  reprocess: (id: number) =>
    api.post(`/documents/${id}/reprocess`, undefined, { timeout: 3_600_000 }).then((r) => r.data),

  // ── avaliação offline (FUN-07) ──

  benchmarkQuestions: (slug: string, status = '') =>
    api
      .get<{ questions: BenchmarkQuestion[] }>(
        `/spaces/${encodeURIComponent(slug)}/benchmark/questions`,
        { params: { status: status || undefined } },
      )
      .then((r) => r.data.questions),

  /** A LLM lê documentos reais e propõe perguntas. Elas nascem em RASCUNHO: a
   *  especificação pede "geração assistida por LLM e seleção humana", e dataset
   *  golden que ninguém leu mede o gerador de perguntas, não a base. */
  /** Inicia a geração em segundo plano. `count` nulo = todos os documentos que
   *  ainda não têm pergunta desta estratégia. */
  generateBenchmarkQuestions: (slug: string, count: number | null, strategy: string) =>
    api
      .post<{ status: string; total?: number; pendentes?: number; erro?: string }>(
        `/spaces/${encodeURIComponent(slug)}/benchmark/questions/generate`,
        { count, strategy },
      )
      .then((r) => r.data),

  benchmarkGenerationStatus: (slug: string) =>
    api
      .get<{
        running: {
          total: number;
          done: number;
          criadas: number;
          descartadas: number;
          estrategia: string;
        } | null;
        pendentes: Record<string, number>;
      }>(`/spaces/${encodeURIComponent(slug)}/benchmark/questions/generate`)
      .then((r) => r.data),

  cancelBenchmarkGeneration: (slug: string) =>
    api
      .delete(`/spaces/${encodeURIComponent(slug)}/benchmark/questions/generate`)
      .then((r) => r.data),

  createBenchmarkQuestion: (slug: string, body: { question: string; reference: string }) =>
    api.post(`/spaces/${encodeURIComponent(slug)}/benchmark/questions`, body).then((r) => r.data),

  updateBenchmarkQuestion: (
    id: number,
    body: { status?: string; question?: string; reference?: string },
  ) => api.put(`/benchmark/questions/${id}`, body).then((r) => r.data),

  removeBenchmarkQuestion: (id: number) =>
    api.delete(`/benchmark/questions/${id}`).then((r) => r.data),

  startBenchmarkRun: (
    slug: string,
    mode: string,
    melhoria: { rewrite: string; query_embedding: string },
  ) =>
    api
      .post<{ run_id: number; total: number }>(
        `/spaces/${encodeURIComponent(slug)}/benchmark/runs`,
        { mode, ...melhoria },
      )
      .then((r) => r.data),

  benchmarkRuns: (slug: string) =>
    api
      .get<{ runs: BenchmarkRun[] }>(`/spaces/${encodeURIComponent(slug)}/benchmark/runs`)
      .then((r) => r.data.runs),

  benchmarkRun: (id: number) =>
    api.get<BenchmarkRunDetail>(`/benchmark/runs/${id}`).then((r) => r.data),

  cancelBenchmarkRun: (id: number) => api.delete(`/benchmark/runs/${id}`).then((r) => r.data),

  // ── modelos de IA (só admin) ──
  aiKinds: () =>
    api
      .get<{ kinds: AiKind[]; purposes: AiPurpose[]; schema_dimensions: number }>('/ai/kinds')
      .then((r) => r.data),

  /** Lista os modelos que a conta expõe, para a tela escolher em vez de digitar.
   *  A credencial vai no corpo quando o cadastro ainda não existe; com
   *  `provider_id`, o servidor usa a que já está gravada (nunca reexibida). */
  listAiModels: (body: {
    kind: string;
    endpoint?: string;
    api_key?: string;
    provider_id?: number;
  }) => api.post<ModelListing>('/ai/models', body).then((r) => r.data),

  aiProviders: () =>
    api.get<{ providers: AiProvider[] }>('/ai/providers').then((r) => r.data.providers),

  createAiProvider: (body: Partial<AiProvider> & { api_key: string }) =>
    api.post<AiProvider>('/ai/providers', body).then((r) => r.data),

  /** `api_key` vazio = mantém a que já está lá (a tela nem a mostra). */
  updateAiProvider: (id: number, body: Partial<AiProvider> & { api_key?: string }) =>
    api.put<AiProvider>(`/ai/providers/${id}`, body).then((r) => r.data),

  /** O preço deste modelo no catálogo. Não grava nada: quem decide se aceita o
   *  número é quem está no formulário. */
  lookupPrice: (body: { kind?: string; model?: string; endpoint?: string; provider_id?: number }) =>
    api.post<PriceLookup>('/ai/price-lookup', body).then((r) => r.data),

  setDefaultAiProvider: (id: number) =>
    api.post<AiProvider>(`/ai/providers/${id}/default`).then((r) => r.data),

  removeAiProvider: (id: number) => api.delete(`/ai/providers/${id}`).then((r) => r.data),

  /** Faz uma chamada REAL ao provedor. Conta no dashboard como qualquer outra. */
  testAiProvider: (id: number) =>
    api
      .post<AiProviderTest>(`/ai/providers/${id}/test`, undefined, { timeout: 120_000 })
      .then((r) => r.data),

  /** Reaplica o preço ATUAL ao uso já gravado. Muda número de histórico, então
   *  é uma ação explícita — nunca um recálculo automático na leitura. */
  recalcularCusto: (fracao_entrada?: number) =>
    api
      .post<RecalculoDeCusto>(
        '/ai/usage/recalculate',
        fracao_entrada === undefined ? {} : { fracao_entrada },
        { timeout: 180_000 },
      )
      .then((r) => r.data),

  aiUsage: (days = 30) => api.get<AiUsage>('/ai/usage', { params: { days } }).then((r) => r.data),

  /** Uma página do log. `total` é o que permite dizer "40 de 313" em vez de
   *  deixar parecer que só houve 40 — foi assim que uma carga de 273 arquivos
   *  ficou invisível na tela. */
  ingestRuns: (limit = 50) =>
    api.get<IngestRunPage>('/ingest-runs', { params: { limit } }).then((r) => r.data.runs),

  ingestRunPage: (p: { limit: number; offset: number; space?: string; status?: string }) =>
    api
      .get<IngestRunPage>('/ingest-runs', {
        params: {
          limit: p.limit,
          offset: p.offset,
          space: p.space || undefined,
          status: p.status || undefined,
        },
      })
      .then((r) => r.data),

  clearIngestRuns: () => api.delete('/ingest-runs').then((r) => r.data),

  ingestQueue: (recent = 30) =>
    api.get<IngestQueue>('/ingest-queue', { params: { recent } }).then((r) => r.data),

  ingestRunEvents: (id: number) =>
    api
      .get<{ run: QueueRun; events: IngestEvent[] }>(`/ingest-runs/${id}/events`)
      .then((r) => r.data),

  cancelIngestRun: (id: number) => api.post(`/ingest-runs/${id}/cancel`).then((r) => r.data),

  // ── token pessoal (qualquer pessoa logada, para os seus próprios) ──
  tokens: () =>
    api.get<{ tokens: PersonalToken[]; default_days: number }>('/tokens').then((r) => r.data),

  createToken: (body: { name: string; days?: number }) =>
    api.post<IssuedToken>('/tokens', body).then((r) => r.data),

  revokeToken: (id: number) => api.delete(`/tokens/${id}`).then((r) => r.data),

  /** URL pública do túnel, quando existe. `url` vazia = sem túnel, não é erro. */
  publicUrl: () => api.get<{ url: string; reason: string }>('/public-url').then((r) => r.data),

  /** Editores conectados pelo fluxo de login. */
  connections: () => api.get<{ connections: Connection[] }>('/connections').then((r) => r.data),

  revokeConnection: (id: number) => api.delete(`/connections/${id}`).then((r) => r.data),
};

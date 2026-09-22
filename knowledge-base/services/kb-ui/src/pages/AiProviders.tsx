import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  CircleAlert,
  DollarSign,
  ListChecks,
  Pencil,
  Plus,
  Save,
  Star,
  Trash2,
  Zap,
} from 'lucide-react';
import { kb } from '../lib/api';
import { fmtWhen } from '../lib/format';
import type {
  AiKind,
  AiProvider,
  AiProviderTest,
  AiPurpose,
  ModelListing,
  PriceLookup,
} from '../lib/types';
import {
  Button,
  Card,
  ErrorBox,
  Field,
  PageHeader,
  Pill,
  Spinner,
  inputClass,
  selectClass,
} from '../components/Ui';

/**
 * Cadastro dos provedores de IA.
 *
 * Antes desta tela o provedor vivia em variável de ambiente: trocar de modelo
 * exigia um PR de infraestrutura e um deploy, e comparar dois lado a lado era
 * impossível. Agora é uma linha de banco.
 *
 * O que a tela NUNCA mostra é a credencial. Ela sai da API só com os quatro
 * últimos caracteres — o suficiente para conferir *qual* chave está lá sem
 * revelá-la, e o bastante para descobrir que alguém colou a chave errada.
 */
export function AiProvidersPage() {
  const cliente = useQueryClient();
  const kinds = useQuery({ queryKey: ['ai-kinds'], queryFn: kb.aiKinds });
  const lista = useQuery({ queryKey: ['ai-providers'], queryFn: kb.aiProviders });
  const [criando, setCriando] = useState(false);
  /** O provedor aberto para edição. O formulário é o mesmo do cadastro novo. */
  const [editando, setEditando] = useState<AiProvider | null>(null);
  const [erro, setErro] = useState('');
  const [testes, setTestes] = useState<Record<number, AiProviderTest | 'rodando'>>({});

  const invalidar = () => {
    void cliente.invalidateQueries({ queryKey: ['ai-providers'] });
    void cliente.invalidateQueries({ queryKey: ['stack'] });
    void cliente.invalidateQueries({ queryKey: ['health'] });
  };

  const tornarPadrao = useMutation({
    mutationFn: (id: number) => kb.setDefaultAiProvider(id),
    onSuccess: () => {
      setErro('');
      invalidar();
    },
    onError: (e) => setErro((e as Error).message),
  });

  const remover = useMutation({
    mutationFn: (id: number) => kb.removeAiProvider(id),
    onSuccess: invalidar,
    onError: (e) => setErro((e as Error).message),
  });

  const testar = async (id: number) => {
    setTestes((atual) => ({ ...atual, [id]: 'rodando' }));
    try {
      const resultado = await kb.testAiProvider(id);
      setTestes((atual) => ({ ...atual, [id]: resultado }));
    } catch (e) {
      setTestes((atual) => ({ ...atual, [id]: { ok: false, error: (e as Error).message } }));
    }
  };

  // Listagem do provedor JÁ SALVO. Usa a credencial gravada, que a tela nunca
  // reexibe (ADR-0009) — é o único jeito de ver os deployments de um recurso
  // cujo cadastro existe sem pedir a chave de novo a quem opera.
  const [listagens, setListagens] = useState<Record<number, ModelListing | 'rodando' | string>>({});

  const listarDoSalvo = async (p: AiProvider) => {
    setListagens((atual) => ({ ...atual, [p.id]: 'rodando' }));
    try {
      const dados = await kb.listAiModels({ kind: p.kind, provider_id: p.id });
      setListagens((atual) => ({ ...atual, [p.id]: dados }));
    } catch (e) {
      setListagens((atual) => ({ ...atual, [p.id]: (e as Error).message }));
    }
  };

  if (lista.isLoading || kinds.isLoading) return <Spinner label="Lendo os provedores…" />;
  if (lista.error) return <ErrorBox>{(lista.error as Error).message}</ErrorBox>;

  const provedores = lista.data ?? [];
  const semPadrao = provedores.length > 0 && !provedores.some((p) => p.is_default);

  return (
    <>
      <PageHeader title="Modelos de IA">
        Onde a base fala com um modelo. <strong>Embedding</strong> é o que a busca vetorial usa para
        transformar texto em vetor, na ingestão e em cada pergunta. <strong>Chat</strong> é opcional
        e serve a um lugar só: derivar o conceito OKF de um documento na ingestão — a busca continua
        devolvendo evidência, nunca resposta gerada. Cada propósito tem o seu provedor “em uso”. A
        credencial fica <strong>cifrada</strong> no banco e nunca volta para esta tela.
      </PageHeader>

      {provedores.length === 0 ? (
        <ErrorBox>
          Nenhum provedor cadastrado. Sem embedding a busca funciona, mas fica{' '}
          <strong>só lexical</strong>: casa palavra, não sentido. Cadastre um abaixo.
        </ErrorBox>
      ) : null}
      {semPadrao ? (
        <ErrorBox>
          Nenhum provedor está marcado como <strong>em uso</strong>. Marque um com a estrela.
        </ErrorBox>
      ) : null}
      {erro ? <ErrorBox>{erro}</ErrorBox> : null}

      <div className="mb-4">
        <Button
          variant="primary"
          onClick={() => {
            setEditando(null);
            setCriando((v) => !v);
          }}
        >
          <Plus size={14} /> Novo provedor
        </Button>
      </div>

      {criando || editando ? (
        <NovoProvedor
          // `key` força o formulário a remontar ao trocar de alvo. Sem isso o
          // `useState` de cada campo manteria o valor do provedor anterior, e
          // editar um segundo cadastro abriria com os dados do primeiro.
          key={editando ? `edita-${editando.id}` : 'novo'}
          kinds={kinds.data?.kinds ?? []}
          purposes={kinds.data?.purposes ?? []}
          dimensaoDoEsquema={kinds.data?.schema_dimensions ?? 3072}
          editando={editando ?? undefined}
          onCancelar={() => {
            setCriando(false);
            setEditando(null);
          }}
          onPronto={() => {
            setCriando(false);
            setEditando(null);
            invalidar();
          }}
        />
      ) : null}

      {provedores.length === 0 ? null : (
        <div className="grid gap-3">
          {provedores.map((p) => (
            <Card key={p.id} className="px-5 py-4">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <strong className="text-[15px]">{p.name}</strong>
                    <Pill>{p.kind_label}</Pill>
                    {/* O propósito precisa aparecer aqui: com dois na lista,
                        "em uso" sozinho sugere um provedor único quando na
                        verdade há um padrão por propósito. */}
                    <Pill tone={p.purpose === 'chat' ? 'warn' : 'neutral'}>{p.purpose}</Pill>
                    {p.is_default ? <Pill tone="good">em uso</Pill> : null}
                    {!p.active ? <Pill tone="warn">inativo</Pill> : null}
                  </div>
                  <div className="mono text-[12px] text-text-dim">
                    {p.model || '(sem modelo)'}
                    {p.purpose === 'embedding' ? ` · ${p.dimensions} dimensões` : ''}
                    {p.endpoint ? ` · ${p.endpoint}` : ''}
                  </div>
                  {/* O preço aparece na lista porque a falta dele tem
                      consequência visível noutra tela: sem preço, o uso deste
                      provedor entra no dashboard sem custo, e o total do mês
                      fica menor do que a fatura. Dizer isso aqui é mais barato
                      que descobrir lá. */}
                  <div className="mt-1 text-[12px]">
                    {p.price_input_per_1m == null && p.price_output_per_1m == null ? (
                      <span className="text-amber">
                        sem preço cadastrado — o uso não vira custo no dashboard
                      </span>
                    ) : (
                      <span className="text-text-muted">
                        US$ {p.price_input_per_1m ?? 0}/1M entrada
                        {p.purpose === 'embedding'
                          ? ''
                          : ` · US$ ${p.price_output_per_1m ?? 0}/1M saída`}
                      </span>
                    )}
                  </div>
                  {/* Apagar um provedor em uso NÃO dá erro: cada base cai para
                      o padrão da instalação, em silêncio. Sem isto aqui, o
                      operador só descobriria pela busca piorando. */}
                  {p.spaces && p.spaces.length > 0 ? (
                    <div className="mt-1 text-[12px] text-text-muted">
                      escolhido por{' '}
                      {p.spaces.map((slug) => (
                        <code key={slug} className="mr-1">
                          {slug}
                        </code>
                      ))}
                    </div>
                  ) : null}
                  <div className="mt-1 text-[12px] text-text-muted">
                    credencial {p.has_key ? <code>••••{p.api_key_tail}</code> : '(ausente)'}
                    {p.updated_by ? ` · alterado por ${p.updated_by}` : ''}
                    {p.updated_at ? ` · ${fmtWhen(p.updated_at)}` : ''}
                  </div>
                  <Resultado resultado={testes[p.id]} />
                  {typeof listagens[p.id] === 'string' && listagens[p.id] !== 'rodando' ? (
                    <p className="mt-2 flex items-start gap-1.5 text-[12.5px] text-rose">
                      <CircleAlert size={13} className="mt-[2px] shrink-0" />
                      <span className="break-words">{listagens[p.id] as string}</span>
                    </p>
                  ) : null}
                  {listagens[p.id] && typeof listagens[p.id] === 'object' ? (
                    <ListaDeModelos
                      listagem={listagens[p.id] as ModelListing}
                      escolhido={p.model}
                      onEscolher={() => {}}
                    />
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    onClick={() => void listarDoSalvo(p)}
                    disabled={listagens[p.id] === 'rodando'}
                  >
                    <ListChecks size={13} />{' '}
                    {listagens[p.id] === 'rodando' ? 'buscando…' : 'Modelos'}
                  </Button>
                  <Button onClick={() => void testar(p.id)} disabled={testes[p.id] === 'rodando'}>
                    <Zap size={13} /> {testes[p.id] === 'rodando' ? 'testando…' : 'Testar'}
                  </Button>
                  <Button
                    onClick={() => {
                      setCriando(false);
                      setEditando(p);
                    }}
                  >
                    <Pencil size={13} /> Editar
                  </Button>
                  {!p.is_default ? (
                    <Button
                      onClick={() => tornarPadrao.mutate(p.id)}
                      disabled={tornarPadrao.isPending}
                    >
                      <Star size={13} /> Usar este
                    </Button>
                  ) : null}
                  <button
                    title="Remover o provedor"
                    disabled={remover.isPending}
                    onClick={() => {
                      // O histórico de gasto NÃO some junto — `ai_usage_daily`
                      // não tem FK para o cadastro, de propósito.
                      if (
                        confirm(
                          `Remover o provedor "${p.name}"?\n\n` +
                            `O histórico de gasto dele continua no dashboard.` +
                            (p.is_default
                              ? `\n\n⚠ Ele é o que está EM USO: a busca fica só lexical até você marcar outro.`
                              : ''),
                        )
                      )
                        remover.mutate(p.id);
                    }}
                    className="rounded-lg border border-line bg-ink-800 p-2 text-text-dim transition-colors hover:border-rose hover:text-rose disabled:opacity-40"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

function Resultado({ resultado }: { resultado?: AiProviderTest | 'rodando' }) {
  if (!resultado || resultado === 'rodando') return null;
  if (!resultado.ok)
    return (
      <p className="mt-2 flex items-start gap-1.5 text-[12.5px] text-rose">
        <CircleAlert size={13} className="mt-[2px] shrink-0" />
        <span className="break-words">{resultado.error}</span>
      </p>
    );
  // Dimensão só existe no teste de embedding. Num provedor de chat o que se
  // confirma é que o modelo RESPONDE — e foi tentar medir dimensão aqui que
  // levou o teste a mandar um embedding para um modelo que não faz embedding.
  const embedding = resultado.purpose !== 'chat';
  return (
    <p className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] text-text-muted">
      <Check size={13} className="text-emerald" />
      respondeu em {resultado.latency_ms} ms
      {embedding ? ` · ${resultado.dimensions} dimensões` : ''} · {resultado.tokens} tokens
      {embedding && resultado.dimension_mismatch ? (
        <Pill tone="bad">
          o índice espera {resultado.schema_dimensions} — este modelo não pode ser o padrão
        </Pill>
      ) : null}
    </p>
  );
}

/** Os modelos que a conta expôs, para clicar em vez de digitar.
 *
 *  O `source` decide o texto, e isso não é detalhe: `deployments` afirma que o
 *  modelo está PUBLICADO, `account` que a credencial o ALCANÇA, e `catalog`
 *  apenas que o recurso PODERIA usá-lo. Mostrar os três com a mesma frase faria
 *  a tela prometer mais do que a rota entrega — e o item do catálogo que não
 *  responde só apareceria como erro na primeira ingestão. */
function ListaDeModelos({
  listagem,
  escolhido,
  onEscolher,
}: {
  listagem: ModelListing;
  escolhido: string;
  onEscolher: (id: string) => void;
}) {
  if (listagem.models.length === 0) {
    return (
      <p className="mt-3 text-[12px] leading-relaxed text-amber">
        Esta conta não expôs nenhum modelo. Confira a credencial e o endpoint, e se há deployments
        publicados no recurso.
      </p>
    );
  }

  return (
    <div
      className={`mt-3 max-h-52 overflow-y-auto rounded-lg border p-2.5 ${
        listagem.source === 'catalog' ? 'border-amber/30 bg-amber/5' : 'border-line bg-ink-950'
      }`}
    >
      <p className="mb-2 text-[11.5px] leading-relaxed text-text-muted">
        {listagem.note} Clique para preencher o campo.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {listagem.models.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => onEscolher(m.id)}
            title={m.label || m.model || m.id}
            className={`mono rounded border px-2 py-1 text-[11.5px] transition-colors ${
              escolhido === m.id
                ? 'border-emerald/40 bg-emerald/10 text-emerald'
                : 'border-line text-text-muted hover:border-ink-500 hover:text-text'
            }`}
          >
            {m.id}
            {/* O modelo-base ao lado é o que permite reconhecer um deployment de
                nome próprio (`emb-large-v2`) como o que ele de fato é. */}
            {m.model && m.model !== m.id ? (
              <span className="text-text-dim"> · {m.model}</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Formulário de cadastro. Os campos mudam conforme o tipo escolhido. */
/**
 * O formulário de provedor, que CRIA e EDITA.
 *
 * Um só, e não dois: os campos são os mesmos e o que muda é o destino. Um
 * formulário separado para editar divergiria do de criar na primeira vez que
 * alguém mexesse só num deles.
 *
 * `kind` e `purpose` ficam TRAVADOS na edição. Trocar o tipo troca o dialeto
 * (URL e cabeçalho de auth), e trocar o propósito quebraria as bases que
 * escolheram este cadastro para embedding ou para chat. A API também não
 * atualiza esses dois: a tela reflete o que existe do lado de lá em vez de
 * oferecer um campo que seria ignorado em silêncio.
 */
function NovoProvedor({
  kinds,
  purposes,
  dimensaoDoEsquema,
  editando,
  onPronto,
  onCancelar,
}: {
  kinds: AiKind[];
  purposes: AiPurpose[];
  dimensaoDoEsquema: number;
  /** Ausente = cadastro novo. */
  editando?: AiProvider;
  onPronto: () => void;
  onCancelar?: () => void;
}) {
  const [kind, setKind] = useState(editando?.kind ?? kinds[0]?.id ?? 'azure_openai');
  const [purpose, setPurpose] = useState(editando?.purpose ?? 'embedding');
  const [name, setName] = useState(editando?.name ?? '');
  const [endpoint, setEndpoint] = useState(editando?.endpoint ?? '');
  const [model, setModel] = useState(editando?.model ?? '');
  const [apiVersion, setApiVersion] = useState(editando?.api_version ?? '');
  const [apiKey, setApiKey] = useState('');
  const [dimensions, setDimensions] = useState(String(editando?.dimensions ?? dimensaoDoEsquema));
  const [precoEntrada, setPrecoEntrada] = useState(
    editando?.price_input_per_1m == null ? '' : String(editando.price_input_per_1m),
  );
  const [precoSaida, setPrecoSaida] = useState(
    editando?.price_output_per_1m == null ? '' : String(editando.price_output_per_1m),
  );
  const [erro, setErro] = useState('');
  const [listagem, setListagem] = useState<ModelListing | null>(null);
  /** De onde veio o preço que está nos campos. `null` = ninguém buscou ainda.
   *  Serve para a tela dizer se o número foi achado ou digitado — preço que
   *  aparece sozinho sem dizer de onde veio é preço em que ninguém confia. */
  const [fontePreco, setFontePreco] = useState<PriceLookup['fonte'] | null>(null);

  // A listagem NÃO é uma query: ela depende de campos que o operador ainda está
  // digitando, e refazê-la sozinha a cada tecla mandaria a credencial para o
  // provedor a cada letra. É uma ação, disparada no botão.
  const listar = useMutation({
    mutationFn: () =>
      kb.listAiModels({
        kind,
        endpoint: endpoint.trim(),
        api_key: apiKey.trim() || undefined,
      }),
    onSuccess: (dados) => {
      setErro('');
      setListagem(dados);
    },
    onError: (e) => {
      setListagem(null);
      setErro((e as Error).message);
    },
  });

  const escolhido = kinds.find((k) => k.id === kind);
  const proposito = purposes.find((p) => p.id === purpose);

  // Trocar tipo, endpoint ou credencial muda a CONTA: a lista anterior passa a
  // ser de outro lugar, e deixá-la na tela convidaria a escolher um deployment
  // que não existe na conta nova.
  const contaMudou = () => {
    setListagem(null);
    listar.reset();
  };

  // A busca de preço NÃO é uma query: ela depende do modelo que está sendo
  // digitado, e refazê-la a cada tecla bateria no catálogo por letra. É uma
  // ação, no botão — igual à listagem de modelos logo acima.
  const buscarPreco = useMutation({
    mutationFn: () =>
      kb.lookupPrice({
        kind,
        model: model.trim(),
        endpoint: endpoint.trim() || undefined,
        provider_id: editando?.id,
      }),
    onSuccess: (r) => {
      setErro('');
      setFontePreco(r.fonte);
      // Só sobrescreve o que o catálogo SABE. Um `null` vindo de lá não apaga
      // um preço que a pessoa acabou de digitar — para embedding, a saída volta
      // nula sempre, e limpar o campo cada vez seria um bug com cara de regra.
      if (r.price_input_per_1m != null) setPrecoEntrada(String(r.price_input_per_1m));
      if (r.price_output_per_1m != null) setPrecoSaida(String(r.price_output_per_1m));
    },
    onError: (e) => {
      setFontePreco(null);
      setErro((e as Error).message);
    },
  });

  /** Texto vazio vira `null`, e não zero: apagar o campo quer dizer "não sei
   *  quanto custa", que na tela de uso aparece diferente de "custou nada". */
  const preco = (texto: string): number | null => {
    const limpo = texto.trim().replace(',', '.');
    return limpo === '' ? null : Number(limpo);
  };

  const salvar = useMutation({
    mutationFn: () => {
      const corpo = {
        name: name.trim(),
        endpoint: endpoint.trim(),
        model: model.trim(),
        api_version: apiVersion.trim() || escolhido?.api_version_default || '',
        dimensions: Number(dimensions) || dimensaoDoEsquema,
        price_input_per_1m: preco(precoEntrada),
        price_output_per_1m: preco(precoSaida),
      };
      // Na edição a credencial vazia MANTÉM a que está lá — a tela nunca a
      // mostra, e exigir que fosse redigitada para trocar um preço seria pedir
      // um segredo de volta só para mexer num número.
      return editando
        ? kb.updateAiProvider(editando.id, {
            ...corpo,
            ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
          } as Partial<AiProvider> & { api_key?: string })
        : kb.createAiProvider({
            ...corpo,
            kind,
            purpose,
            api_key: apiKey.trim(),
          } as Partial<AiProvider> & { api_key: string });
    },
    onSuccess: onPronto,
    onError: (e) => setErro((e as Error).message),
  });

  return (
    <Card className="mb-4 px-5 py-4">
      <form
        onSubmit={(evento) => {
          evento.preventDefault();
          if (!name.trim()) {
            setErro('informe o nome do provedor');
            return;
          }
          if (!editando && !apiKey.trim()) {
            setErro('a credencial é obrigatória no cadastro novo');
            return;
          }
          for (const [rotulo, texto] of [
            ['entrada', precoEntrada],
            ['saída', precoSaida],
          ] as const) {
            const valor = preco(texto);
            if (valor !== null && (!Number.isFinite(valor) || valor < 0)) {
              setErro(`o preço de ${rotulo} precisa ser um número em dólar, ou vazio`);
              return;
            }
          }
          salvar.mutate();
        }}
      >
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Propósito">
            <select
              className={selectClass}
              value={purpose}
              disabled={!!editando}
              title={editando ? 'o propósito não muda: as bases apontam para ele' : undefined}
              onChange={(e) => setPurpose(e.target.value)}
            >
              {purposes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Tipo">
            <select
              className={selectClass}
              value={kind}
              disabled={!!editando}
              title={
                editando ? 'o tipo não muda: ele decide a URL e o cabeçalho de auth' : undefined
              }
              onChange={(e) => {
                setKind(e.target.value);
                setApiVersion('');
                setEndpoint('');
              }}
            >
              {kinds.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Nome">
            <input
              className={inputClass}
              value={name}
              placeholder="Azure OpenAI — produção"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Endpoint">
            <input
              className={inputClass}
              value={endpoint}
              placeholder={escolhido?.endpoint_hint}
              onChange={(e) => {
                setEndpoint(e.target.value);
                contaMudou();
              }}
            />
          </Field>
          <Field label={escolhido?.model_label ?? 'Modelo'}>
            <div className="flex gap-2">
              <input
                className={`${inputClass} flex-1`}
                value={model}
                placeholder="text-embedding-3-large"
                onChange={(e) => {
                  setModel(e.target.value);
                  // Preço de um modelo aplicado a outro produz custo errado com
                  // cara de apurado. A marca de origem cai; o número fica, para
                  // não apagar o que alguém digitou à mão.
                  setFontePreco(null);
                }}
              />
              {/* Existe porque errar o nome aqui NÃO dá erro: o cadastro salva e
                  a falha aparece depois, como um 404 do provedor no meio de uma
                  ingestão. No Azure é pior — o que vai na URL é o nome do
                  deployment, que quem publicou pode ter chamado de qualquer
                  coisa. */}
              <button
                type="button"
                onClick={() => listar.mutate()}
                disabled={
                  listar.isPending || !apiKey.trim() || (!endpoint.trim() && kind !== 'openai')
                }
                title={
                  !apiKey.trim()
                    ? 'Preencha a credencial para consultar a conta'
                    : !endpoint.trim() && kind !== 'openai'
                      ? 'Preencha o endpoint para consultar o recurso'
                      : 'Consultar os modelos que esta conta expõe'
                }
                className="shrink-0 rounded-lg border border-line bg-ink-800 px-2.5 text-[12px] text-text-muted transition-colors hover:border-ink-500 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ListChecks size={13} className="mr-1 inline" />
                {listar.isPending ? 'buscando…' : 'Listar modelos'}
              </button>
            </div>
          </Field>
          {escolhido?.needs_api_version ? (
            <Field label="Versão da API">
              <input
                className={inputClass}
                value={apiVersion}
                placeholder={escolhido.api_version_default}
                onChange={(e) => setApiVersion(e.target.value)}
              />
            </Field>
          ) : null}
          {/* Dimensão só faz sentido para embedding: ela existe para casar com
              o índice. Pedi-la de um modelo de chat seria pedir um número que
              não significa nada e que a API validaria contra o índice errado. */}
          {proposito?.needs_dimensions ? (
            <Field label="Dimensões">
              <input
                className={inputClass}
                value={dimensions}
                inputMode="numeric"
                onChange={(e) => setDimensions(e.target.value.replace(/\D/g, ''))}
              />
            </Field>
          ) : null}
          <div className="md:col-span-2">
            <Field label={editando ? 'Credencial (em branco mantém a atual)' : 'Credencial'}>
              <input
                className={inputClass}
                type="password"
                value={apiKey}
                autoComplete="new-password"
                placeholder={
                  editando
                    ? `mantém a que termina em ${editando.api_key_tail || '····'}`
                    : kind === 'litellm'
                      ? 'virtual key do gateway'
                      : 'chave da API'
                }
                onChange={(e) => {
                  setApiKey(e.target.value);
                  contaMudou();
                }}
              />
            </Field>
          </div>

          {/* PREÇO POR 1M DE TOKENS, em dólar.
              Entrada e saída separadas porque custam diferente — na maioria dos
              provedores a saída sai de três a cinco vezes mais cara. Um preço
              único aplicado ao total erraria para mais no embedding (que só tem
              entrada) e para menos no chat.
              Em branco = preço não cadastrado. Na tela de uso isso aparece como
              "sem preço", e não como gasto zero: os dois somam igual, mas só um
              deles é verdade. */}
          <Field label="Preço de entrada (US$ por 1M de tokens)">
            <div className="flex gap-2">
              <input
                className={`${inputClass} flex-1`}
                value={precoEntrada}
                inputMode="decimal"
                placeholder="ex.: 0.13"
                onChange={(e) => {
                  setPrecoEntrada(e.target.value);
                  setFontePreco(null);
                }}
              />
              {/* Existe pelo mesmo motivo do "Listar modelos" ao lado: o número
                  certo não está na cabeça de ninguém. Uma vírgula fora de lugar
                  multiplica o custo por dez na tela de uso, e um preço velho faz
                  o dashboard divergir da fatura sem nada dizer por quê. */}
              <button
                type="button"
                onClick={() => buscarPreco.mutate()}
                disabled={buscarPreco.isPending || !model.trim()}
                title={
                  model.trim()
                    ? 'Buscar o preço deste modelo no catálogo'
                    : 'Preencha o modelo para buscar o preço'
                }
                className="shrink-0 rounded-lg border border-line bg-ink-800 px-2.5 text-[12px] text-text-muted transition-colors hover:border-ink-500 hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
              >
                <DollarSign size={13} className="mr-1 inline" />
                {buscarPreco.isPending ? 'buscando…' : 'Buscar preço'}
              </button>
            </div>
          </Field>
          <Field
            label={
              proposito?.needs_dimensions
                ? 'Preço de saída (embedding não tem saída)'
                : 'Preço de saída (US$ por 1M de tokens)'
            }
          >
            <input
              className={inputClass}
              value={precoSaida}
              inputMode="decimal"
              disabled={proposito?.needs_dimensions}
              placeholder={proposito?.needs_dimensions ? 'não se aplica' : 'ex.: 10.00'}
              onChange={(e) => {
                setPrecoSaida(e.target.value);
                setFontePreco(null);
              }}
            />
          </Field>

          {/* AS TRÊS RESPOSTAS DA BUSCA PEDEM AÇÕES DIFERENTES, e por isso
              aparecem diferentes. Juntar "não conheço este modelo" com "não
              consegui ler o catálogo" mandaria o operador preencher à mão um
              preço que a próxima tentativa acharia sozinha. */}
          {fontePreco ? (
            <div className="text-[12px] md:col-span-2">
              {fontePreco === 'catalogo' ? (
                <span className="text-text-muted">
                  preço do catálogo do LiteLLM. Confira antes de salvar: ele é público e pode estar
                  à frente ou atrás do seu contrato.
                </span>
              ) : fontePreco === 'nenhum' ? (
                <span className="text-amber">
                  o catálogo não conhece <code>{model.trim()}</code>. É o normal para deployment do
                  Azure com nome próprio — preencha o preço à mão.
                </span>
              ) : (
                <span className="text-amber">
                  não consegui ler o catálogo (esta instalação pode estar sem saída para a
                  internet). Preencha à mão, ou cadastre um gateway LiteLLM, que serve de fonte pela
                  rede interna.
                </span>
              )}
            </div>
          ) : null}
        </div>

        {listagem ? (
          <ListaDeModelos listagem={listagem} escolhido={model} onEscolher={setModel} />
        ) : null}

        {proposito ? (
          <p className="mt-3 text-[12.5px] leading-relaxed text-text-muted">
            <strong className="text-text">{proposito.label}</strong>: {proposito.description}.
          </p>
        ) : null}

        <p className="mt-3 text-[12.5px] leading-relaxed text-text-dim">
          A credencial é cifrada antes de ir para o banco e <strong>nunca mais é exibida</strong> —
          a tela passa a mostrar só os quatro últimos caracteres.
          {proposito?.needs_dimensions && Number(dimensions) !== dimensaoDoEsquema ? (
            <>
              {' '}
              <span className="text-amber">
                O índice desta instalação tem {dimensaoDoEsquema} dimensões: com um número
                diferente, este provedor não poderá ser marcado como “em uso”. Misturar dimensões no
                mesmo índice piora a busca sem erro nenhum aparecer.
              </span>
            </>
          ) : null}
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" type="submit" disabled={salvar.isPending}>
            {editando ? <Save size={14} /> : <Plus size={14} />}
            {editando ? 'Salvar' : 'Cadastrar'}
          </Button>
          {onCancelar ? (
            <Button type="button" onClick={onCancelar}>
              Cancelar
            </Button>
          ) : null}
        </div>
      </form>
      {erro ? <ErrorBox>{erro}</ErrorBox> : null}
    </Card>
  );
}

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  Copy,
  ExternalLink,
  Globe,
  KeyRound,
  Laptop,
  LogIn,
  Plug,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { kb } from '../lib/api';
import { currentUser } from '../lib/auth';
import { env } from '../lib/env';
import { fmtWhen } from '../lib/format';
import {
  HARNESS_TARGETS,
  type HarnessId,
  cursorDeeplink,
  installCommand,
  renderConfig,
  serverUrl,
} from '../lib/mcpConfig';
import {
  Button,
  Card,
  EstadoVazio,
  ErrorBox,
  Field,
  PageHeader,
  Pill,
  Spinner,
  inputClass,
} from '../components/Ui';
import type { Connection } from '../lib/types';

/**
 * Conectar o editor à base.
 *
 * O caminho principal é OAuth: cola a URL, clica em Entrar, faz o login. Nenhum
 * segredo passa pela conversa nem por arquivo de configuração.
 *
 * A versão anterior desta tela oferecia um token pessoal para colar num prompt
 * da conversa. Estava errado por três motivos que apareceram na prática: o
 * token ia parar no histórico (que pode ser sincronizado), o Claude Desktop
 * **não consegue** editar o arquivo — ele executa comando em container isolado
 * e efêmero — e pedir caminho de arquivo a quem só quer usar a base é empurrar
 * um problema nosso para o usuário.
 *
 * O token continua existindo, fechado num `<details>`, para editor que não
 * implementa o fluxo de login.
 */
export function ConnectPage() {
  const cliente = useQueryClient();
  const user = currentUser();
  const origem = useMemo(() => env.mcpUrl().replace(/\/mcp$/, '') || window.location.origin, []);

  const publica = useQuery({ queryKey: ['public-url'], queryFn: kb.publicUrl });
  const conexoes = useQuery({ queryKey: ['connections'], queryFn: kb.connections });
  const [usarPublica, setUsarPublica] = useState(false);
  const [harness, setHarness] = useState<HarnessId>('claude-code');

  const urlPublica = publica.data?.url ?? '';
  // A base já está num endereço que não é desta máquina? Então ela já é
  // alcançável por quem precisa, e o túnel não resolve problema nenhum —
  // mostrá-lo só ofereceria uma alternativa pior que a atual, com uma instrução
  // de `.env` que não existe num cluster. O sinal é de onde a tela foi aberta,
  // e não uma variável de ambiente: se você chegou aqui por este nome, quem
  // está na mesma rede chega também.
  const soNestaMaquina = /^https?:\/\/(localhost|127\.|\[::1\])/.test(origem);
  const base = soNestaMaquina && usarPublica && urlPublica ? urlPublica : origem;
  const cfg = { origin: base };
  const alvo = HARNESS_TARGETS.find((t) => t.id === harness)!;
  const local = base.startsWith('http://localhost') || base.startsWith('http://127.');

  const revogar = useMutation({
    mutationFn: (id: number) => kb.revokeConnection(id),
    onSuccess: () => cliente.invalidateQueries({ queryKey: ['connections'] }),
  });

  return (
    <>
      <PageHeader title="Conectar MCP">
        Ligue o seu editor à base e pergunte de dentro dele. O agente recebe{' '}
        <strong>evidência com score</strong> — o trecho, o documento e a página — não uma resposta
        pronta: quem redige a resposta é o modelo que você já usa, com a fonte à vista.
      </PageHeader>

      <Card className="mb-6 px-5 py-4">
        <p className="text-[13px] text-text-muted">
          Você <strong>não precisa copiar senha nem token</strong>. O editor descobre sozinho que
          esta base pede login, abre o Identity do Goga Legal, e pronto — o mesmo login que você
          usou para entrar aqui.
        </p>
        <p className="mt-2 text-[13px] text-amber">
          O agente alcança <strong>exatamente</strong> o que você alcança
          {user?.groups.length ? ` (${user.groups.join(', ')})` : ''}. Base que você não vê aqui,
          ele também não vê.
        </p>
      </Card>

      {/* ── 1. endereço ── */}
      <Passo numero={1} icone={Globe} titulo="Copie o endereço da base">
        {soNestaMaquina ? (
          <div className="mb-3.5 flex flex-wrap gap-2">
            <Endereco
              ativo={!usarPublica}
              onClick={() => setUsarPublica(false)}
              icone={Laptop}
              titulo="Nesta máquina"
              url={origem}
              nota="Funciona só no computador em que a base está rodando."
            />
            <Endereco
              ativo={usarPublica}
              onClick={() => urlPublica && setUsarPublica(true)}
              desabilitado={!urlPublica}
              icone={Globe}
              titulo="Pela internet"
              url={urlPublica || 'túnel desligado'}
              nota={
                urlPublica
                  ? 'Alcançável de qualquer lugar — dá para mostrar ao time e conectar do celular.'
                  : 'Ligue o túnel para mostrar ao time sem publicar a base.'
              }
              detalhe={urlPublica ? undefined : publica.data?.reason}
            />
          </div>
        ) : (
          // Já publicada: um endereço só, e nenhuma alternativa a oferecer.
          <div className="mb-3.5 flex items-start gap-2 rounded-lg border border-line bg-ink-950 px-3 py-2.5">
            <Globe size={14} className="mt-[3px] shrink-0 text-emerald" />
            <div className="min-w-0">
              <div className="mb-0.5 flex flex-wrap items-center gap-2">
                <strong className="text-[13px]">Publicada</strong>
                <Pill tone="good">alcançável pelo time</Pill>
              </div>
              <code className="mono break-all text-[12px] text-text-muted">{origem}</code>
            </div>
          </div>
        )}

        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-dim">
          URL do conector
        </div>
        <CopiavelInline valor={serverUrl(cfg)} />

        {local && !alvo.local ? (
          /* Conector personalizado do Claude é do tipo **Web**: quem chama o MCP
             são os servidores da Anthropic, não o aplicativo na máquina.
             `localhost` ali é o localhost DELES. Dizer "editor de desktop
             alcança normalmente" era errado e mandaria a pessoa para um erro de
             conexão sem explicação. */
          <p className="mt-2.5 rounded-r-lg border-l-2 border-rose bg-ink-850 px-3 py-2 text-[12.5px] text-text-muted">
            <strong>O {alvo.label} não alcança este endereço.</strong> O conector personalizado é do
            tipo <em>Web</em> — quem chama a base são os servidores da Anthropic, não o aplicativo
            na sua máquina, e para eles <code>localhost</code> é outro computador. Use o endereço
            público.
          </p>
        ) : local ? (
          <p className="mt-2.5 rounded-r-lg border-l-2 border-amber bg-ink-850 px-3 py-2 text-[12.5px] text-text-muted">
            Este endereço só existe no seu computador. O {alvo.label} roda aí e alcança normalmente.
          </p>
        ) : base.includes('ngrok') ? (
          /* Não é detalhe: o aviso do ngrok grátis aparece no MEIO do login,
             quando o navegador é redirecionado — e quem não espera por ele acha
             que a conexão falhou. Um clique em "Visit Site" grava um cookie e o
             assunto acaba. */
          <p className="mt-2.5 rounded-r-lg border-l-2 border-amber bg-ink-850 px-3 py-2 text-[12.5px] text-text-muted">
            Na primeira vez, o ngrok mostra uma página de aviso antes do login. Clique em{' '}
            <strong>Visit Site</strong> e siga — acontece uma vez por navegador.
          </p>
        ) : null}
      </Passo>

      {/* ── 2. editor ── */}
      <Passo numero={2} icone={Plug} titulo="Cole no seu editor e clique em Entrar">
        <div className="mb-3.5 flex flex-wrap gap-1.5">
          {HARNESS_TARGETS.map((item) => (
            <button
              key={item.id}
              onClick={() => setHarness(item.id)}
              className={`rounded-lg border px-3 py-1.5 text-[13px] transition-colors ${
                item.id === harness
                  ? 'border-line bg-ink-800 font-semibold text-text'
                  : 'border-transparent text-text-muted hover:bg-ink-850'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {alvo.orgOnly ? (
          <div className="mb-3.5 rounded-lg border border-amber/40 bg-ink-850 px-3.5 py-3">
            <div className="mb-1 flex items-center gap-2">
              <ShieldAlert size={15} className="text-amber" />
              <strong className="text-[13.5px]">
                No {alvo.label}, quem adiciona é o administrador
              </strong>
            </div>
            <p className="text-[13px] text-text-muted">
              Em conta de organização, conector personalizado é cadastrado no nível da organização —
              por isso os que você vê na lista (Asana, Atlassian, Notion) estão lá sem você ter
              feito nada, e não existe botão de adicionar para membro comum.
            </p>
            <p className="mt-2 text-[13px] text-text-muted">
              Peça a quem administra o Claude na sua organização para cadastrar o conector com a URL
              acima. Feito isso, ele aparece para todo mundo e cada pessoa clica em{' '}
              <strong>Vincular</strong> — o login é individual, e cada uma alcança só as suas bases.
            </p>
            <p className="mt-2 text-[12.5px] text-text-dim">
              Para testar agora, sem depender de ninguém: use o <strong>Claude Code</strong> ou o{' '}
              <strong>Cursor</strong> nas abas acima.
            </p>
          </div>
        ) : alvo.connectorPath ? (
          <div className="mb-3.5 rounded-lg border border-accent/30 bg-ink-850 px-3.5 py-3">
            <div className="mb-1 flex items-center gap-2">
              <LogIn size={15} className="text-text-muted" />
              <strong className="text-[13.5px]">No {alvo.label}</strong>
            </div>
            <p className="text-[13px] text-text-muted">{alvo.connectorPath}</p>
          </div>
        ) : null}

        {alvo.id === 'cursor' ? (
          <div className="mb-3.5">
            <a
              href={cursorDeeplink(cfg)}
              className="inline-flex items-center gap-2 rounded-lg bg-blue px-3.5 py-2 text-[13px] font-semibold !text-white no-underline hover:opacity-90"
            >
              <ExternalLink size={14} /> Adicionar ao Cursor
            </a>
            <p className="mt-1.5 text-[12px] text-text-dim">
              Um clique, sem abrir arquivo. Depende de a sua versão do Cursor ter registrado o
              esquema <code>cursor://</code> — se nada acontecer, use o caminho abaixo.
            </p>
          </div>
        ) : null}

        {installCommand(alvo, cfg) ? (
          <div className="mb-3.5">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-dim">
              Um comando, no terminal
            </div>
            <Copiavel texto={installCommand(alvo, cfg)!} />
            <p className="mt-1.5 text-[12px] text-text-dim">
              Sem token no comando: o login abre no navegador na primeira pergunta.
            </p>
          </div>
        ) : null}

        <details className="rounded-lg border border-line bg-ink-850 px-3.5 py-3">
          <summary className="cursor-pointer text-[13px] font-semibold text-text-muted">
            Configurar por arquivo
          </summary>
          <div className="mt-3.5">
            <div className="mb-1.5 flex flex-wrap items-baseline gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-text-dim">
                Arquivo
              </span>
              <code className="text-[12px]">{alvo.path}</code>
            </div>
            <Copiavel texto={renderConfig(alvo, cfg)} />
            <p className="mt-2 text-[12px] text-text-dim">
              Só a URL — sem credencial no arquivo. O login acontece na primeira chamada.
            </p>
          </div>
        </details>

        {alvo.caveat ? (
          <p className="mt-2.5 rounded-r-lg border-l-2 border-amber bg-ink-850 px-3 py-2 text-[12.5px] text-text-muted">
            {alvo.caveat}
          </p>
        ) : null}
      </Passo>

      {/* ── 3. conexões ── */}
      <Passo numero={3} icone={KeyRound} titulo="Os editores conectados a você">
        <Conexoes
          consulta={conexoes}
          onRevogar={(id) => {
            if (confirm('Desconectar este editor? Ele perde o acesso na hora.')) revogar.mutate(id);
          }}
        />
        <TokenManual />
      </Passo>

      {/* ── 4. tools ── */}
      <Passo numero={4} icone={Plug} titulo="As ferramentas que o seu agente ganha">
        <Card className="overflow-hidden">
          <table className="w-full text-[13px]">
            <tbody>
              {[
                [
                  'search',
                  'Busca híbrida (vetorial + lexical, fundidas por RRF). Devolve os trechos com score de cada braço, o documento e a página — evidência, não resposta.',
                ],
                [
                  'fetch',
                  'O documento canônico inteiro por id. É o que o agente usa quando o trecho não basta e ele precisa do contexto em volta.',
                ],
                [
                  'list_spaces',
                  'As bases que VOCÊ alcança. O agente descobre o escopo em vez de adivinhar nomes.',
                ],
              ].map(([nome, descricao]) => (
                <tr key={nome} className="border-b border-line-soft last:border-0">
                  <td className="w-[10rem] px-5 py-3 align-top">
                    <code>{nome}</code>
                  </td>
                  <td className="px-5 py-3 text-text-muted">{descricao}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </Passo>
    </>
  );
}

function Passo({
  numero,
  icone: Icone,
  titulo,
  children,
}: {
  numero: number;
  icone: typeof KeyRound;
  titulo: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <div className="mb-2.5 flex items-center gap-2.5">
        <span className="grid h-6 w-6 place-items-center rounded-md border border-line bg-ink-800 text-[12px] font-semibold text-text-muted">
          {numero}
        </span>
        <Icone size={15} className="text-text-muted" />
        <h2 className="text-[15px] font-semibold">{titulo}</h2>
      </div>
      <Card className="px-5 py-4">{children}</Card>
    </section>
  );
}

function Conexoes({
  consulta,
  onRevogar,
}: {
  consulta: ReturnType<typeof useQuery<{ connections: Connection[] }>>;
  onRevogar: (id: number) => void;
}) {
  if (consulta.isLoading) return <Spinner />;
  if (consulta.error) return <ErrorBox>{(consulta.error as Error).message}</ErrorBox>;
  const itens = (consulta.data?.connections ?? []).filter((c) => !c.revoked);
  if (itens.length === 0) {
    return (
      <EstadoVazio icone={Plug} titulo="Nenhum editor conectado ainda">
        Faça o passo 2 no seu editor. Na primeira pergunta ele abre o login, e a partir daí aparece
        aqui — e é aqui que se desconecta.
      </EstadoVazio>
    );
  }
  return (
    <ul className="grid gap-1.5">
      {itens.map((item) => (
        <li
          key={item.id}
          className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-ink-850 px-3 py-2 text-[12.5px]"
        >
          <Pill tone="good">conectado</Pill>
          <span className="font-semibold">{item.client_name || 'editor'}</span>
          {/* Os grupos aparecem por conexão, mas aqui eles NÃO envelhecem como
              no token pessoal: a cada renovação o Identity é relido. */}
          <code className="text-text-dim">{item.groups.join(' ') || 'sem grupo'}</code>
          <span className="text-text-dim">
            desde {fmtWhen(item.created_at)} · último uso{' '}
            {item.last_used_at ? fmtWhen(item.last_used_at) : 'nunca'}
          </span>
          <button
            onClick={() => onRevogar(item.id)}
            title="desconectar"
            className="ml-auto rounded p-1 text-text-dim hover:text-rose"
          >
            <Trash2 size={14} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * O token pessoal, agora como exceção.
 *
 * Fica fechado e explicado: é para editor que não implementa o fluxo de login.
 * Quem abre isto está aceitando guardar um segredo num arquivo, e a tela diz
 * isso antes de mostrar o botão.
 */
function TokenManual() {
  const cliente = useQueryClient();
  const lista = useQuery({ queryKey: ['tokens'], queryFn: kb.tokens, enabled: false });
  const [nome, setNome] = useState('editor sem login');
  const [emitido, setEmitido] = useState('');
  const [erro, setErro] = useState('');

  const emitir = useMutation({
    mutationFn: () => kb.createToken({ name: nome.trim() }),
    onSuccess: (corpo) => {
      setEmitido(corpo.token);
      setErro('');
      void cliente.invalidateQueries({ queryKey: ['tokens'] });
      void lista.refetch();
    },
    onError: (err) => setErro((err as Error).message),
  });
  const revogar = useMutation({
    mutationFn: (id: number) => kb.revokeToken(id),
    onSuccess: () => lista.refetch(),
  });

  return (
    <details
      className="mt-3.5 rounded-lg border border-line bg-ink-850 px-3.5 py-3"
      onToggle={(event) => {
        if ((event.currentTarget as HTMLDetailsElement).open) void lista.refetch();
      }}
    >
      <summary className="cursor-pointer text-[13px] font-semibold text-text-muted">
        Meu editor não tem opção de login
      </summary>
      <div className="mt-3.5">
        <p className="mb-3 text-[12.5px] text-text-muted">
          Aí o jeito é um <strong>token pessoal</strong>, escrito no arquivo de configuração do
          editor. Funciona, mas é um segredo em texto puro no disco e os seus grupos ficam
          congelados no dia da emissão — por isso não é o caminho padrão.
        </p>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            emitir.mutate();
          }}
        >
          <div className="min-w-[14rem] flex-1">
            <Field label="Nome (para reconhecer depois)">
              <input
                className={inputClass}
                value={nome}
                onChange={(event) => setNome(event.target.value)}
              />
            </Field>
          </div>
          <Button type="submit" disabled={emitir.isPending}>
            <KeyRound size={14} /> {emitir.isPending ? 'Emitindo…' : 'Emitir token'}
          </Button>
        </form>

        {emitido ? (
          <div className="mt-3 rounded-lg border border-emerald/40 bg-ink-900 px-3 py-2.5">
            <div className="mb-1.5 text-[12.5px] text-text-muted">
              Guarde agora: este valor não é mostrado de novo.
            </div>
            <CopiavelInline valor={emitido} />
          </div>
        ) : null}
        {erro ? <ErrorBox>{erro}</ErrorBox> : null}

        {(lista.data?.tokens ?? []).length > 0 ? (
          <ul className="mt-3 grid gap-1.5">
            {(lista.data?.tokens ?? []).map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-ink-900 px-3 py-2 text-[12.5px]"
              >
                <span className="font-semibold">{item.name}</span>
                <code className="text-text-dim">{item.prefix}…</code>
                {item.revoked ? (
                  <Pill tone="bad">revogado</Pill>
                ) : item.expired ? (
                  <Pill tone="warn">expirado</Pill>
                ) : (
                  <Pill tone="good">ativo</Pill>
                )}
                <span className="text-text-dim">expira {fmtWhen(item.expires_at)}</span>
                {!item.revoked ? (
                  <button
                    onClick={() => revogar.mutate(item.id)}
                    title="revogar"
                    className="ml-auto rounded p-1 text-text-dim hover:text-rose"
                  >
                    <Trash2 size={14} />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </details>
  );
}

/** Um endereço possível para o MCP: esta máquina ou a URL pública do túnel. */
function Endereco({
  ativo,
  desabilitado,
  onClick,
  icone: Icone,
  titulo,
  url,
  nota,
  detalhe,
}: {
  ativo: boolean;
  desabilitado?: boolean;
  onClick: () => void;
  icone: typeof Globe;
  titulo: string;
  url: string;
  nota: string;
  detalhe?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={desabilitado}
      title={detalhe}
      className={`min-w-[16rem] flex-1 rounded-lg border px-3.5 py-3 text-left transition-colors disabled:opacity-50 ${
        ativo ? 'border-accent/50 bg-ink-800' : 'border-line bg-ink-850 hover:border-ink-500'
      }`}
    >
      <div className="mb-1 flex items-center gap-2">
        <Icone size={14} className="text-text-muted" />
        <strong className="text-[13px]">{titulo}</strong>
        {ativo ? <Pill tone="good">em uso</Pill> : null}
      </div>
      <code className="block break-all text-[12px] text-text-muted">{url}</code>
      <p className="mt-1 text-[11.5px] text-text-dim">{nota}</p>
    </button>
  );
}

function Copiavel({ texto }: { texto: string }) {
  const [copiado, setCopiado] = useState(false);
  return (
    <div className="relative">
      <pre className="canonical max-h-72 overflow-auto rounded-lg border border-line bg-ink-850 p-3.5 pr-24">
        {texto}
      </pre>
      <div className="absolute right-2.5 top-2.5">
        <Button
          onClick={() => {
            void navigator.clipboard.writeText(texto);
            setCopiado(true);
            setTimeout(() => setCopiado(false), 1500);
          }}
        >
          {copiado ? <Check size={14} /> : <Copy size={14} />}
          {copiado ? 'Copiado' : 'Copiar'}
        </Button>
      </div>
    </div>
  );
}

function CopiavelInline({ valor }: { valor: string }) {
  const [copiado, setCopiado] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="min-w-0 flex-1 break-all rounded border border-line bg-ink-900 px-2.5 py-2 text-[13px]">
        {valor}
      </code>
      <Button
        variant="primary"
        onClick={() => {
          void navigator.clipboard.writeText(valor);
          setCopiado(true);
          setTimeout(() => setCopiado(false), 1500);
        }}
      >
        {copiado ? <Check size={14} /> : <Copy size={14} />}
        {copiado ? 'Copiado' : 'Copiar'}
      </Button>
    </div>
  );
}

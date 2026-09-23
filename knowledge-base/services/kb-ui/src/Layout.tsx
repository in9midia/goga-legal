import { type ReactNode, useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Brain,
  ChartColumn,
  Cpu,
  History,
  Home,
  ListOrdered,
  Library,
  LogOut,
  type LucideIcon,
  Menu,
  Plug,
  Search,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import { currentUser, initialsFromName, keycloak, logout } from './lib/auth';
import { kb } from './lib/api';

type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean };

/**
 * O menu é dividido em dois blocos porque as duas metades pertencem a papéis
 * diferentes: o primeiro é consulta (qualquer pessoa com acesso a alguma base),
 * o segundo é operação da instalação. Separar deixa explícito onde termina o uso
 * e começa a administração — e o bloco de baixo é o mesmo que a API barra para
 * quem não é admin, então o menu só reflete o que existe do lado de lá.
 */
const NAV_GROUPS: { label?: string; adminOnly?: boolean; items: NavItem[] }[] = [
  {
    items: [
      { to: '/', label: 'Início', icon: Home, end: true },
      { to: '/bases', label: 'Bases', icon: Library },
      // A fila e da instalacao, nao de uma base: o servidor processa um
      // arquivo por vez, de todas elas. Por isso fica no menu, e nao no card.
      { to: '/fila', label: 'Fila de ingestão', icon: ListOrdered },
      // DOCUMENTOS, WIKI, GRAFO E BENCHMARK SAÍRAM DAQUI, de propósito.
      //
      // As quatro são "por base": nenhuma delas responde nada sem um Espaço
      // escolhido. No menu, cada uma abria numa tela com um seletor de base no
      // topo — dois lugares para escolher a mesma coisa, e o do menu chegava
      // sem contexto nenhum. Agora elas se alcançam pelo card da base, que é
      // onde a escolha já foi feita.
      //
      // O que sobra aqui é o que vale para a instalação inteira: buscar
      // atravessa todas as bases alcançáveis, e o histórico é da pessoa.
      { to: '/buscar', label: 'Simulador', icon: Search },
      { to: '/historico', label: 'Histórico', icon: History },
      // Fica no bloco de consulta, e não no de administração, porque conectar o
      // PRÓPRIO editor é uso — não exige alcançar a instalação inteira.
      { to: '/conectar', label: 'MCP', icon: Plug },
    ],
  },
  {
    label: 'Administração',
    adminOnly: true,
    items: [
      { to: '/acessos', label: 'Acessos', icon: Users },
      { to: '/modelos-ia', label: 'Modelos de IA', icon: Brain },
      { to: '/uso-ia', label: 'Uso de IA', icon: ChartColumn },
      // Benchmark saiu daqui junto com as outras telas por base. Continua só
      // para administrador — gerar perguntas e rodar uma execução GASTAM IA, e
      // a API barra pelo mesmo motivo —, mas o caminho agora é o card da base,
      // que é o único lugar onde a escolha do Espaço faz sentido.
      { to: '/stack', label: 'Stack', icon: Cpu },
    ],
  },
];

export function Layout({ children }: { children: ReactNode }) {
  const user = currentUser();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);

  // Quem é admin vem da API, não do token: além do grupo do Identity existe a
  // tabela `kb_admin`, e o token não sabe dela.
  const spaces = useQuery({ queryKey: ['spaces'], queryFn: kb.spaces });
  const admin = spaces.data?.principal.unrestricted ?? false;
  const grupos = NAV_GROUPS.filter((g) => admin || !g.adminOnly);

  // Fecha o menu ao navegar (só afeta o drawer no mobile).
  useEffect(() => setNavOpen(false), [location.pathname]);

  return (
    <div className="flex h-screen overflow-hidden bg-ink-950">
      <a
        href="#conteudo"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:border focus:border-line focus:bg-ink-800 focus:px-3 focus:py-2 focus:text-sm focus:text-text"
      >
        Pular para o conteúdo
      </a>

      {/* Barra superior só no mobile: abre o menu. */}
      <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-ink-900/95 px-4 backdrop-blur md:hidden">
        <button
          type="button"
          onClick={() => setNavOpen(true)}
          aria-label="Abrir menu"
          className="-ml-1 grid h-9 w-9 place-items-center rounded-md text-text-muted transition-colors hover:bg-ink-850 hover:text-text"
        >
          <Menu size={18} strokeWidth={1.75} />
        </button>
        <div className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-text text-xs font-bold text-ink-950">
          G
        </div>
        <h1 className="truncate text-sm font-semibold tracking-tight">Base de conhecimento</h1>
      </header>

      {navOpen ? (
        <div
          aria-hidden
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
        />
      ) : null}

      <aside
        className={`fixed left-0 top-0 z-50 flex h-screen w-60 shrink-0 flex-col border-r border-line bg-sidebar transition-transform duration-200 ease-out md:sticky md:translate-x-0 ${
          navOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        }`}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-5 pb-5 pt-6">
          {/* Mesmo cabeçalho do Goga Studio: monograma + nome + subtítulo, para
              as duas interfaces se lerem como o mesmo produto. */}
          <NavLink
            to="/"
            end
            aria-label="Ir para o início"
            className="flex min-w-0 flex-1 items-center gap-2.5"
          >
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-text text-sm font-bold text-ink-950">
              G
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold leading-tight text-text">Goga KB</div>
              <div className="text-[0.68rem] text-text-dim">documentos · interno</div>
            </div>
          </NavLink>
          <button
            type="button"
            onClick={() => setNavOpen(false)}
            aria-label="Fechar menu"
            className="-mr-1 grid h-8 w-8 place-items-center rounded-md text-text-muted transition-colors hover:bg-ink-850 hover:text-text md:hidden"
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>

        <nav className="flex flex-1 flex-col overflow-y-auto px-2 py-4">
          {grupos.map((grupo, indice) => (
            <div key={grupo.label ?? 'consulta'} className="flex flex-col gap-0.5">
              {indice > 0 ? (
                <div className="mb-1 mt-4 flex items-center gap-2 px-3">
                  <span aria-hidden className="h-px flex-1 bg-line" />
                  {grupo.label ? (
                    <span className="text-[0.62rem] uppercase tracking-wider text-text-dim">
                      {grupo.label}
                    </span>
                  ) : null}
                  <span aria-hidden className="h-px flex-1 bg-line" />
                </div>
              ) : null}
              {grupo.items.map(({ to, label, icon: Icon, end }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    `flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
                      isActive
                        ? 'bg-ink-800 text-text'
                        : 'text-text-muted hover:bg-ink-850 hover:text-text'
                    }`
                  }
                >
                  <Icon size={16} strokeWidth={1.75} className="shrink-0" />
                  <span className="font-medium">{label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="space-y-3 border-t border-line px-4 py-3.5">
          <SaudeIndicador />

          {user ? (
            <div className="flex items-center gap-2">
              <div className="relative shrink-0">
                <div
                  title={user.email ?? user.login}
                  className={`grid h-9 w-9 place-items-center rounded-full border bg-ink-800 text-[11px] font-semibold text-text-muted ${
                    admin ? 'border-amber/60' : 'border-line'
                  }`}
                >
                  {initialsFromName(user.displayName)}
                </div>
                {admin ? (
                  <span
                    title="Administrador — alcança todas as bases"
                    className="absolute -bottom-0.5 -right-0.5 grid h-4 w-4 place-items-center rounded-full bg-amber text-ink-950 ring-2 ring-ink-900"
                  >
                    <ShieldCheck size={10} strokeWidth={2.5} />
                  </span>
                ) : null}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[0.72rem] text-text" title={user.email ?? user.login}>
                  {user.displayName}
                </p>
                {/* Os grupos ficam à vista porque são eles que definem o que a
                    pessoa alcança. Numa base com fronteira de permissão, "quem
                    sou eu aqui" é informação de operação, não enfeite. */}
                <p
                  className="mono truncate text-[0.6rem] text-text-dim"
                  title={user.groups.join(' ')}
                >
                  {user.groups.length ? user.groups.join(' ') : 'sem grupo'}
                </p>
                {keycloak ? (
                  <button
                    type="button"
                    onClick={logout}
                    className="inline-flex items-center gap-1 text-[0.66rem] text-text-dim hover:text-text"
                  >
                    <LogOut size={10} /> sair
                  </button>
                ) : null}
              </div>
            </div>
          ) : (
            <p className="text-[0.66rem] text-text-dim">autenticação desligada</p>
          )}
        </div>
      </aside>

      <main
        id="conteudo"
        className="h-screen min-w-0 flex-1 overflow-y-auto overflow-x-hidden pt-14 md:pt-0"
      >
        <div className="mx-auto max-w-[1240px] px-4 py-6 sm:px-6 md:px-8 md:py-8">{children}</div>
      </main>
    </div>
  );
}

/** Ponto verde/vermelho no pé do menu: a API responde? */
function SaudeIndicador() {
  const { data, isLoading } = useQuery({
    queryKey: ['health'],
    queryFn: kb.health,
    refetchInterval: 30_000,
    retry: false,
  });
  const online = data?.status === 'ok';
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 text-[0.72rem] text-text-muted"
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${
          isLoading ? 'bg-text-dim' : online ? 'bg-emerald' : 'bg-rose'
        }`}
      />
      <span>{isLoading ? 'verificando…' : online ? 'API conectada' : 'API degradada'}</span>
    </div>
  );
}

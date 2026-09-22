import { NavLink, Outlet } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, BrainCircuit, ClipboardList, ExternalLink, FlaskConical, History, LibraryBig, LogOut, type LucideIcon, MessagesSquare, Receipt, ShieldCheck, Users, Workflow } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

type Item = { to: string; label: string; icon: LucideIcon; admin?: boolean; external?: boolean };

// Mesma organizacao do agentic-sdlc: trabalho do dia a dia em cima,
// administracao embaixo, separada por um divisor rotulado.
const groups: { label?: string; items: Item[] }[] = [
  {
    label: "Studio",
    items: [
      { to: "/flows", label: "Fluxos", icon: Workflow },
      { to: "/simulator", label: "Simulador", icon: MessagesSquare },
      { to: "/history", label: "Histórico", icon: History },
      { to: "/eval", label: "Avaliação em lote", icon: FlaskConical },
      { to: "/costs", label: "Custos", icon: Receipt },
      { to: "/audit", label: "Auditoria", icon: ClipboardList, admin: true },
    ],
  },
  { label: "Conhecimento", items: [{ to: "kb", label: "Bases (KB)", icon: LibraryBig, external: true }] },
  {
    label: "Administração",
    items: [
      { to: "/admin/providers", label: "Provedores e modelos", icon: BrainCircuit },
      { to: "/admin/users", label: "Usuários", icon: Users, admin: true },
      { to: "/admin/catalogs", label: "Catálogos", icon: BookOpen },
    ],
  },
];

export function Layout() {
  const { user, isAdmin, logout } = useAuth();
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.get("/health").then(() => true).catch(() => false), refetchInterval: 30_000 });
  const kb = useQuery({ queryKey: ["kb-spaces"], queryFn: () => api.get<{ available: boolean; uiUrl: string }>("/kb/spaces"), staleTime: 60_000 });

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-sidebar">
        <div className="border-b border-line px-5 pt-6 pb-5">
          <NavLink to="/" className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-text text-sm font-bold text-ink-950">G</div>
            <div>
              <div className="text-sm leading-tight font-semibold">Goga Studio</div>
              <div className="text-[0.68rem] text-text-dim">agentes jurídicos · interno</div>
            </div>
          </NavLink>
        </div>
        <nav className="flex flex-1 flex-col overflow-y-auto px-2 py-4">
          {groups.map((g, gi) => (
            <div key={g.label} className="flex flex-col gap-0.5">
              <div className={cn("mb-1 flex items-center gap-2 px-3", gi > 0 && "mt-4")}>
                <span className="h-px flex-1 bg-line" />
                <span className="text-[0.62rem] tracking-wider text-text-dim uppercase">{g.label}</span>
                <span className="h-px flex-1 bg-line" />
              </div>
              {g.items
                .filter((i) => !i.admin || isAdmin)
                .map((i) =>
                  i.external ? (
                    <a key={i.to} href={kb.data?.uiUrl ?? "#"} target="_blank" rel="noreferrer" className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-text-muted transition-colors hover:bg-ink-850 hover:text-text">
                      <i.icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                      <span className="flex-1 font-medium">{i.label}</span>
                      <span title={kb.data?.available ? "KB no ar" : "KB fora do ar"} className={cn("h-1.5 w-1.5 rounded-full", kb.data?.available ? "bg-emerald-500" : "bg-rose-500")} />
                      <ExternalLink className="h-3 w-3 text-text-dim" />
                    </a>
                  ) : (
                    <NavLink key={i.to} to={i.to} className={({ isActive }) => cn("flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors", isActive ? "bg-ink-800 text-text" : "text-text-muted hover:bg-ink-850 hover:text-text")}>
                      <i.icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                      <span className="font-medium">{i.label}</span>
                    </NavLink>
                  ),
                )}
            </div>
          ))}
        </nav>
        <div className="space-y-3 border-t border-line px-4 py-3.5">
          <div className="flex items-center gap-2 text-[0.72rem] text-text-muted">
            <span className={cn("h-1.5 w-1.5 rounded-full", health.data ? "bg-emerald-500" : health.isLoading ? "bg-text-dim" : "bg-rose-500")} />
            {health.isLoading ? "verificando…" : health.data ? "API conectada" : "API offline"}
          </div>
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-ink-700 text-xs font-semibold">{user?.name?.[0]?.toUpperCase()}</div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium">{user?.name}</div>
              <div className="flex items-center gap-1 truncate text-[0.68rem] text-text-dim">
                {isAdmin && <ShieldCheck className="h-3 w-3" />}
                {user?.role}
              </div>
            </div>
            <button onClick={() => logout()} title="Sair" className="rounded-md p-1.5 text-text-muted hover:bg-ink-850 hover:text-text">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}

/** Conteudo centralizado com max-w (todas as telas, menos editor e simulador). */
export function Page({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-6xl space-y-6 px-6 py-7">{children}</div>;
}

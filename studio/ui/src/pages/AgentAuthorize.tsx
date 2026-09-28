import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2, ShieldAlert, TerminalSquare, XCircle } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ErrorBox, Field, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface LoginRequest {
  client: string;
  userCode: string;
  status: "pending" | "approved" | "denied" | "consumed" | "expired";
  expiresAt: string;
}

// Tela que o `goga.mjs login` abre: a pessoa (ja logada, ou logando pelo Gate)
// confere o codigo do terminal e autoriza o agente a agir em seu nome.
export function AgentAuthorizePage() {
  const [params] = useSearchParams();
  const code = (params.get("codigo") ?? "").toUpperCase();
  const { user } = useAuth();
  const [days, setDays] = useState("90");
  const q = useQuery({
    queryKey: ["agent-login", code],
    queryFn: () => api.get<LoginRequest>(`/agent/login/${encodeURIComponent(code)}`),
    enabled: !!code,
    retry: false,
  });
  const decide = useMutation({
    mutationFn: (approve: boolean) => api.post<{ status: string }>(`/agent/login/${encodeURIComponent(code)}/decide`, { approve, expiresInDays: days === "never" ? null : Number(days) }),
  });

  const status = decide.data?.status ?? q.data?.status;

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-950 px-4">
      <div className="w-full max-w-md space-y-5 rounded-xl border border-line bg-ink-900 p-6">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-ink-800">
            <TerminalSquare className="h-5 w-5" />
          </div>
          <div>
            <div className="font-semibold">Autorizar agente</div>
            <div className="text-xs text-text-muted">Goga Studio · {user?.email}</div>
          </div>
        </div>

        {!code ? (
          <ErrorBox error={new Error("Link sem código. Rode o login de novo no terminal.")} />
        ) : q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorBox error={q.error} />
        ) : status === "approved" || status === "consumed" ? (
          <Result icon={<CheckCircle2 className="h-5 w-5 text-emerald-400" />} title="Autorizado">
            Pode voltar ao terminal: o agente já recebeu o acesso. Tokens ficam em Administração → Agentes externos, onde dá para revogar.
          </Result>
        ) : status === "denied" ? (
          <Result icon={<XCircle className="h-5 w-5 text-rose-400" />} title="Recusado">
            O agente não recebeu acesso.
          </Result>
        ) : status === "expired" ? (
          <Result icon={<ShieldAlert className="h-5 w-5 text-amber-400" />} title="Pedido expirado">
            Rode o login de novo no terminal.
          </Result>
        ) : (
          <>
            <p className="text-sm text-text-muted">
              <span className="font-medium text-text">{q.data?.client}</span> quer operar o Goga Studio como você ({user?.role}): ler, testar e — se o seu papel permitir — alterar fluxos, skills e catálogos. Publicar e excluir continuam pedindo sua aprovação na conversa com o agente.
            </p>
            <div className="rounded-lg border border-line bg-ink-950 py-3 text-center">
              <div className="text-[0.7rem] tracking-wide text-text-dim uppercase">Confira o código no terminal</div>
              <div className="mt-1 font-mono text-2xl font-semibold tracking-[0.2em]">{q.data?.userCode}</div>
            </div>
            <Field label="Validade do acesso">
              <Select value={days} onValueChange={setDays}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7">7 dias</SelectItem>
                  <SelectItem value="30">30 dias</SelectItem>
                  <SelectItem value="90">90 dias</SelectItem>
                  <SelectItem value="365">1 ano</SelectItem>
                  <SelectItem value="never">Não expira</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <p className="text-xs text-text-dim">Se você não iniciou este login agora, ou o código não bate com o do terminal, recuse.</p>
            <ErrorBox error={decide.error} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" disabled={decide.isPending} onClick={() => decide.mutate(false)}>
                Recusar
              </Button>
              <Button disabled={decide.isPending} onClick={() => decide.mutate(true)}>
                {decide.isPending && <Loader2 className="animate-spin" />} Autorizar
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Result({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 font-medium">
        {icon} {title}
      </div>
      <p className="text-sm text-text-muted">{children}</p>
    </div>
  );
}

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorBox, Field } from "@/components/common";
import { useAuth } from "@/lib/auth";

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form
        className="w-full max-w-sm space-y-5 rounded-xl border border-line bg-ink-900 p-7"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await login(email, password);
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-text font-bold text-ink-950">G</div>
          <div>
            <div className="font-semibold">Goga Studio</div>
            <div className="text-xs text-text-dim">ferramenta interna de simulação</div>
          </div>
        </div>
        <Field label="E-mail">
          <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </Field>
        <Field label="Senha">
          <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <ErrorBox error={error} />
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Entrando…" : "Entrar"}
        </Button>
        <p className="text-center text-[0.72rem] text-text-dim">Sem cadastro público. Peça acesso a um administrador.</p>
      </form>
    </div>
  );
}

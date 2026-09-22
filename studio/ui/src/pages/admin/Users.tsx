import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { KeyRound, Loader2, Pencil, Plus, ShieldCheck, Users } from "lucide-react";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import type { User } from "@/lib/types";
import { Page } from "@/Layout";
import { Empty, ErrorBox, Field, Loading, PageHeader, Pill } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const ROLES: Record<User["role"], string> = { admin: "Administrador", operador: "Operador" };

export function UsersPage() {
  const { isAdmin, user: me } = useAuth();
  const [editing, setEditing] = useState<User | "new" | null>(null);
  const q = useQuery({ queryKey: ["users"], queryFn: () => api.get<{ users: User[] }>("/users").then((r) => r.users), enabled: isAdmin });

  return (
    <Page>
      <PageHeader
        icon={<Users />}
        title="Usuários"
        description="Quem acessa o Studio. Administradores editam fluxos, provedores e catálogos; operadores usam o simulador e consultam histórico e custos."
        actions={
          isAdmin && (
            <Button size="sm" onClick={() => setEditing("new")}>
              <Plus /> Novo usuário
            </Button>
          )
        }
      />

      {isAdmin && (
        <>
          <ErrorBox error={q.error} />
          {q.isLoading ? (
            <Loading />
          ) : !q.data?.length ? (
            <Empty icon={<Users />}>Nenhum usuário.</Empty>
          ) : (
            <div className="rounded-[10px] border border-line bg-ink-900">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Nome</TableHead>
                    <TableHead>E-mail</TableHead>
                    <TableHead>Papel</TableHead>
                    <TableHead>Ativo</TableHead>
                    <TableHead>Criado em</TableHead>
                    <TableHead className="w-12 pr-4" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {q.data.map((u) => (
                    <TableRow key={u.id} className={u.active === false ? "opacity-60" : undefined}>
                      <TableCell className="pl-4 font-medium">
                        {u.name}
                        {u.id === me?.id && <span className="ml-2 text-xs text-text-dim">(você)</span>}
                      </TableCell>
                      <TableCell className="text-text-muted">{u.email}</TableCell>
                      <TableCell>
                        {u.role === "admin" ? (
                          <Pill tone="info">
                            <ShieldCheck className="h-3 w-3" /> {ROLES.admin}
                          </Pill>
                        ) : (
                          <Pill>{ROLES.operador}</Pill>
                        )}
                      </TableCell>
                      <TableCell>{u.active === false ? <Pill tone="neutral">inativo</Pill> : <Pill tone="ok">ativo</Pill>}</TableCell>
                      <TableCell className="text-text-muted tabular-nums">{dateTime(u.createdAt)}</TableCell>
                      <TableCell className="pr-4">
                        <Button size="icon-xs" variant="ghost" onClick={() => setEditing(u)} title="Editar">
                          <Pencil />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}

      <MyPasswordCard />

      {editing && <UserDialog user={editing === "new" ? null : editing} isSelf={editing !== "new" && editing.id === me?.id} onClose={() => setEditing(null)} />}
    </Page>
  );
}

function UserDialog({ user, isSelf, onClose }: { user: User | null; isSelf: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [role, setRole] = useState<User["role"]>(user?.role ?? "operador");
  const [active, setActive] = useState(user?.active ?? true);
  const [password, setPassword] = useState("");
  const pwdOk = user ? password === "" || password.length >= 8 : password.length >= 8;

  const save = useMutation({
    mutationFn: () => {
      if (!user) return api.post("/users", { name: name.trim(), email: email.trim(), role, password });
      const body: Record<string, unknown> = { name: name.trim(), role, active };
      if (password) body.password = password;
      return api.put(`/users/${user.id}`, body);
    },
    onSuccess: () => {
      toast.success(user ? "Usuário atualizado" : "Usuário criado");
      qc.invalidateQueries({ queryKey: ["users"] });
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{user ? "Editar usuário" : "Novo usuário"}</DialogTitle>
          {user && <DialogDescription>{user.email}</DialogDescription>}
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label="Nome">
            <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </Field>
          {!user && (
            <Field label="E-mail">
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </Field>
          )}
          <Field label="Papel" hint={isSelf ? "Você não pode rebaixar a si mesmo." : undefined}>
            <Select value={role} onValueChange={(v) => setRole(v as User["role"])} disabled={isSelf}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">{ROLES.admin}</SelectItem>
                <SelectItem value="operador">{ROLES.operador}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {user && (
            <div className="flex items-center gap-2">
              <Switch id="u-active" checked={active} onCheckedChange={setActive} disabled={isSelf} />
              <Label htmlFor="u-active" className="text-sm text-text-muted">
                Ativo {isSelf && <span className="text-xs text-text-dim">(não pode desativar a si mesmo)</span>}
              </Label>
            </div>
          )}
          <Field label={user ? "Nova senha (opcional)" : "Senha"} hint={user ? "Deixe vazio para manter a senha atual. Mínimo de 8 caracteres." : "Mínimo de 8 caracteres."}>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required={!user} />
          </Field>
          <ErrorBox error={save.error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={!name.trim() || (!user && !email.trim()) || !pwdOk || save.isPending}>
              {save.isPending && <Loader2 className="animate-spin" />} Salvar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MyPasswordCard() {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = confirm !== "" && confirm !== password;
  const save = useMutation({
    mutationFn: () => api.post("/auth/password", { current, password }),
    onSuccess: () => {
      toast.success("Senha alterada");
      setCurrent("");
      setPassword("");
      setConfirm("");
    },
  });
  return (
    <div className="max-w-xl rounded-[10px] border border-line bg-ink-900 p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium">
        <KeyRound className="h-4 w-4 text-text-muted" /> Minha senha
      </div>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Senha atual">
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Nova senha" hint="Mínimo de 8 caracteres.">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
          </Field>
          <Field label="Confirmar nova senha" hint={mismatch ? <span className="text-rose-300">as senhas não conferem</span> : undefined}>
            <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
          </Field>
        </div>
        <ErrorBox error={save.error} />
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={!current || password.length < 8 || password !== confirm || save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />} Alterar senha
          </Button>
        </div>
      </form>
    </div>
  );
}

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Copy, KeyRound, Loader2, Plus, TerminalSquare, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { Page } from "@/Layout";
import { Empty, ErrorBox, Field, Loading, PageHeader, Pill } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

// Agentes externos (Claude Code, Codex, Gemini CLI) usam a skill goga-studio,
// que chama as mesmas ferramentas do Assistente com um token pessoal.
const SKILL = ".agents/skills/goga-studio";

function CopyBlock({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="group relative">
      <pre className="overflow-x-auto rounded-md border border-line bg-ink-950 px-3 py-2 pr-10 font-mono text-[0.78rem] text-text">{text}</pre>
      <button
        type="button"
        title="Copiar"
        className="absolute top-1.5 right-1.5 rounded p-1 text-text-muted hover:bg-ink-800 hover:text-text"
        onClick={() => {
          navigator.clipboard.writeText(text).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          });
        }}
      >
        {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

export function AgentsPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["agent-tokens"], queryFn: () => api.get<{ tokens: ApiToken[] }>("/agent/tokens").then((r) => r.tokens) });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/agent/tokens/${id}`),
    onSuccess: () => {
      toast.success("Token revogado");
      qc.invalidateQueries({ queryKey: ["agent-tokens"] });
    },
  });
  const origin = window.location.origin;

  return (
    <Page>
      <PageHeader
        icon={<TerminalSquare />}
        title="Agentes externos"
        description="Claude Code, Codex e Gemini CLI operam o Studio com as mesmas ferramentas do Assistente, pela skill goga-studio. Cada token age como você: mesmo papel, mesmas permissões, e as alterações aparecem na auditoria com o seu nome."
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus /> Novo token
          </Button>
        }
      />

      <ErrorBox error={q.error ?? revoke.error} />
      {q.isLoading ? (
        <Loading />
      ) : !q.data?.length ? (
        <Empty icon={<KeyRound />}>Nenhum token ativo. Crie um para conectar um agente.</Empty>
      ) : (
        <div className="rounded-[10px] border border-line bg-ink-900">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Nome</TableHead>
                <TableHead>Token</TableHead>
                <TableHead>Criado em</TableHead>
                <TableHead>Último uso</TableHead>
                <TableHead>Expira</TableHead>
                <TableHead className="w-12 pr-4" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((t) => {
                const expired = t.expiresAt && new Date(t.expiresAt) < new Date();
                return (
                  <TableRow key={t.id} className={expired ? "opacity-60" : undefined}>
                    <TableCell className="pl-4 font-medium">{t.name}</TableCell>
                    <TableCell className="font-mono text-xs text-text-muted">{t.prefix}…</TableCell>
                    <TableCell className="text-text-muted tabular-nums">{dateTime(t.createdAt)}</TableCell>
                    <TableCell className="text-text-muted tabular-nums">{t.lastUsedAt ? dateTime(t.lastUsedAt) : "nunca"}</TableCell>
                    <TableCell className="tabular-nums">{expired ? <Pill tone="neutral">expirado</Pill> : <span className="text-text-muted">{t.expiresAt ? dateTime(t.expiresAt) : "não expira"}</span>}</TableCell>
                    <TableCell className="pr-4">
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        title="Revogar"
                        disabled={revoke.isPending}
                        onClick={() => confirm(`Revogar o token "${t.name}"? Agentes que o usam perdem o acesso na hora.`) && revoke.mutate(t.id)}
                      >
                        <Trash2 />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="max-w-3xl space-y-4 rounded-[10px] border border-line bg-ink-900 p-4 text-sm">
        <div className="font-medium">Como conectar</div>
        <div className="space-y-1.5">
          <div className="text-text-muted">Num terminal com Node 18+, rode (instala a skill para Claude Code, Codex e Gemini CLI e abre esta página para você autorizar):</div>
          <CopyBlock text={`curl -fsSL ${origin}/skills/goga.mjs | node - instalar`} />
          <div className="text-xs text-text-dim">
            Só alguns agentes: acrescente <code>--agentes claude,codex</code>. Máquina sem navegador (SSH): <code>--sem-navegador</code> e abra o link impresso em qualquer lugar. Dentro do repositório a skill já está disponível; lá basta <code>node {SKILL}/scripts/goga.mjs login</code>.
          </div>
        </div>
        <div className="space-y-1.5">
          <div className="text-text-muted">Alternativa manual: crie um token acima e rode</div>
          <CopyBlock text={`node ~/.agents/skills/goga-studio/scripts/goga.mjs configurar --url ${origin} --token <token>`} />
        </div>
        <p className="text-xs text-text-dim">
          Publicar, excluir, restaurar padrão, rodar lote e escrita genérica na API exigem confirmação: o agente mostra o resumo e só executa depois que você aprovar na conversa. {user?.role !== "admin" && "Como operador, o agente pode ler e testar, mas não alterar."}
        </p>
      </div>

      {creating && (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreated={(token) => {
            setCreating(false);
            setCreated(token);
          }}
        />
      )}
      {created && <ShowTokenDialog token={created} origin={origin} onClose={() => setCreated(null)} />}
    </Page>
  );
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (token: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [days, setDays] = useState("90");
  const create = useMutation({
    mutationFn: () => api.post<{ token: string }>("/agent/tokens", { name: name.trim(), expiresInDays: days === "never" ? null : Number(days) }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["agent-tokens"] });
      onCreated(r.token);
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Novo token de API</DialogTitle>
          <DialogDescription>Um token por agente e máquina facilita revogar só o que vazou.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label="Nome">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Claude Code no notebook" required autoFocus />
          </Field>
          <Field label="Validade">
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
          <ErrorBox error={create.error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              {create.isPending && <Loader2 className="animate-spin" />} Criar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ShowTokenDialog({ token, origin, onClose }: { token: string; origin: string; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Token criado</DialogTitle>
          <DialogDescription>Copie agora: ele não será mostrado de novo. Não cole o token na conversa com o agente — rode o comando abaixo você mesmo.</DialogDescription>
        </DialogHeader>
        <CopyBlock text={token} />
        <div className="space-y-1.5 text-sm text-text-muted">
          <div>Configure o cliente:</div>
          <CopyBlock text={`node ~/.agents/skills/goga-studio/scripts/goga.mjs configurar --url ${origin} --token ${token}`} />
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Pronto</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, FileText, Loader2, LogOut, MessageCircle, Pencil, Plus, QrCode, RefreshCw, RotateCcw, Rocket, Trash2, Users } from "lucide-react";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import type { FlowSummary } from "@/lib/types";
import { Page } from "@/Layout";
import { Empty, ErrorBox, Field, Loading, PageHeader, Pill, type Tone } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type State = "not_created" | "connecting" | "open" | "close";

interface WaNumber {
  id: string;
  name: string;
  instanceName: string;
  useProduction: boolean;
  flowId: string | null;
  flowName: string | null;
  enabled: boolean;
  state: State;
  qrCode: string | null;
  pairingCode: string | null;
  number: string | null;
  profileName: string | null;
  statusReason: number | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
  lastEventAt: string | null;
  contacts: number;
  pendingOut: number;
  failedOut: number;
}

interface Contact {
  id: string;
  jid: string;
  phone: string | null;
  name: string | null;
  sessionId: string | null;
  busyRunId: string | null;
  lastInboundAt: string | null;
  sessions: number;
  lastText: string | null;
}

interface Failed {
  id: string;
  jid: string;
  text: string;
  fileId: string | null;
  error: string | null;
  createdAt: string;
}

const STATE: Record<State, [string, Tone]> = {
  not_created: ["não conectado", "neutral"],
  connecting: ["aguardando leitura do QR", "info"],
  open: ["conectado", "ok"],
  close: ["desconectado", "bad"],
};

const PROD = "__prod__";

export function WhatsAppPage() {
  const { isAdmin } = useAuth();
  const [editing, setEditing] = useState<WaNumber | "new" | null>(null);
  const status = useQuery({ queryKey: ["wa-status"], queryFn: () => api.get<{ configured: boolean; autoRestart: boolean }>("/whatsapp/status"), enabled: isAdmin });
  const q = useQuery({
    queryKey: ["wa-numbers"],
    queryFn: () => api.get<{ numbers: WaNumber[]; production: { flowName: string; revision: number } | null }>("/whatsapp/numbers"),
    enabled: isAdmin,
    refetchInterval: 10_000,
  });
  const flows = useQuery({ queryKey: ["flows"], queryFn: () => api.get<{ flows: FlowSummary[] }>("/flows").then((r) => r.flows), enabled: isAdmin });

  return (
    <Page>
      <PageHeader
        icon={<MessageCircle />}
        title="WhatsApp"
        description="Números de WhatsApp (não oficial, via Evolution API) que atendem pelos fluxos do Goga. Cada número é ligado a um fluxo; a pessoa conversa, manda fotos e documentos, e usa /nova, /limpar, /cancelar e /ajuda."
        actions={
          isAdmin && (
            <Button size="sm" onClick={() => setEditing("new")} disabled={status.data?.configured === false}>
              <Plus /> Novo número
            </Button>
          )
        }
      />
      {!isAdmin ? (
        <Empty icon={<MessageCircle />}>Apenas administradores gerenciam os números de WhatsApp.</Empty>
      ) : (
        <>
          {status.data?.configured === false && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> O Evolution API não está configurado neste Studio (EVOLUTION_API_KEY vazia).
            </div>
          )}
          <div className="mb-4 rounded-lg border border-amber-500/20 bg-ink-900 p-3 text-xs leading-relaxed text-text-muted">
            <strong className="text-amber-300">Atenção:</strong> a conexão por QR code (como o WhatsApp Web) não é a API oficial da Meta e pode levar ao banimento do número. Use um número dedicado ao atendimento e nunca para disparos em massa. Um número deve estar conectado a um único lugar.
          </div>
          <ErrorBox error={q.error} />
          {q.isLoading ? (
            <Loading />
          ) : !q.data?.numbers.length ? (
            <Empty icon={<MessageCircle />}>Nenhum número cadastrado. Use “Novo número” e leia o QR code no celular.</Empty>
          ) : (
            <div className="grid gap-4">
              {q.data.numbers.map((n) => (
                <NumberCard key={n.id} n={n} production={q.data!.production} onEdit={() => setEditing(n)} autoRestart={!!status.data?.autoRestart} />
              ))}
            </div>
          )}
        </>
      )}
      {editing && <NumberDialog number={editing === "new" ? null : editing} flows={flows.data ?? []} onClose={() => setEditing(null)} />}
    </Page>
  );
}

function NumberCard({ n, production, onEdit, autoRestart }: { n: WaNumber; production: { flowName: string; revision: number } | null; onEdit: () => void; autoRestart: boolean }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<"logout" | "delete" | null>(null);
  const [showContacts, setShowContacts] = useState(false);
  // Enquanto espera o QR, consulta o numero a cada 3 s (QR renovado e conexao ao vivo).
  const live = useQuery({
    queryKey: ["wa-number", n.id],
    queryFn: () => api.get<{ number: WaNumber }>(`/whatsapp/numbers/${n.id}`).then((r) => r.number),
    enabled: n.state === "connecting",
    refetchInterval: 3000,
  });
  const cur = { ...n, ...(n.state === "connecting" && live.data ? live.data : {}) };
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["wa-numbers"] });
    qc.invalidateQueries({ queryKey: ["wa-number", n.id] });
  };
  const act = useMutation({
    mutationFn: (a: "connect" | "logout" | "delete" | "toggle") =>
      a === "delete" ? api.del(`/whatsapp/numbers/${n.id}`) : a === "toggle" ? api.put(`/whatsapp/numbers/${n.id}`, { enabled: !n.enabled }) : api.post(`/whatsapp/numbers/${n.id}/${a}`),
    onSuccess: (_r, a) => {
      if (a === "delete") toast.success("Número removido");
      if (a === "logout") toast.success("Sessão encerrada");
      refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const [label, tone] = STATE[cur.state];
  const flowLabel = cur.useProduction ? `Produção${production ? ` (${production.flowName} · rev ${production.revision})` : " — nada publicado"}` : (cur.flowName ?? "fluxo removido");

  return (
    <div className={`rounded-[10px] border border-line bg-ink-900 p-4 ${n.enabled ? "" : "opacity-70"}`}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{cur.name}</span>
            <Pill tone={tone}>{label}</Pill>
            {!n.enabled && <Pill tone="warn">atendimento pausado</Pill>}
            {cur.number && <span className="text-sm text-text-muted tabular-nums">+{cur.number}</span>}
            {cur.profileName && <span className="text-xs text-text-dim">{cur.profileName}</span>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-text-muted">
            {cur.useProduction ? <Rocket className="h-3.5 w-3.5 text-emerald-400" /> : null}
            Fluxo: {flowLabel}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-dim">
            <span>{n.contacts} contato(s)</span>
            {cur.connectedAt && cur.state === "open" && <span>conectado desde {dateTime(cur.connectedAt)}</span>}
            {cur.state === "close" && cur.disconnectedAt && (
              <span className="text-rose-300">
                caiu em {dateTime(cur.disconnectedAt)}
                {cur.statusReason ? ` (motivo ${cur.statusReason}${cur.statusReason === 428 ? ": conexão travada" : cur.statusReason === 401 ? ": desconectado no celular" : ""})` : ""}
              </span>
            )}
            {cur.lastEventAt && <span>último evento {dateTime(cur.lastEventAt)}</span>}
            {n.pendingOut > 0 && <span className="text-amber-300">{n.pendingOut} mensagem(ns) na fila de envio</span>}
            {n.failedOut > 0 && <span className="text-rose-300">{n.failedOut} envio(s) com falha</span>}
          </div>
          {cur.state === "close" && cur.statusReason === 428 && (
            <p className="mt-2 text-xs text-amber-200">
              A sessão travou (o WhatsApp derrubou a conexão sem avisar). {autoRestart ? "O Studio reinicia o Evolution sozinho (no máximo a cada 15 min); em geral volta em até 2 minutos, sem QR." : "Reconecte o número."}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {cur.state !== "open" && (
            <Button size="sm" variant={cur.state === "connecting" ? "outline" : "default"} onClick={() => act.mutate("connect")} disabled={act.isPending}>
              {act.isPending && act.variables === "connect" ? <Loader2 className="animate-spin" /> : cur.state === "connecting" ? <RefreshCw /> : <QrCode />}
              {cur.state === "connecting" ? "Novo QR code" : cur.state === "not_created" ? "Conectar" : "Reconectar"}
            </Button>
          )}
          {(cur.state === "open" || cur.state === "connecting") && (
            <Button size="sm" variant="outline" onClick={() => setConfirm("logout")}>
              <LogOut /> Desconectar
            </Button>
          )}
          <div className="flex items-center gap-1.5 px-1" title="Com o atendimento pausado, as mensagens recebidas são ignoradas">
            <Switch checked={n.enabled} onCheckedChange={() => act.mutate("toggle")} />
            <span className="text-xs text-text-muted">atender</span>
          </div>
          <Button size="icon-xs" variant="ghost" title="Editar" onClick={onEdit}>
            <Pencil />
          </Button>
          <Button size="icon-xs" variant="ghost" title="Remover número" onClick={() => setConfirm("delete")}>
            <Trash2 />
          </Button>
        </div>
      </div>

      {cur.state === "connecting" && (
        <div className="mt-4 flex flex-wrap items-center gap-5 rounded-lg border border-line bg-ink-850 p-4">
          {cur.qrCode ? <img src={cur.qrCode} alt="QR code do WhatsApp" className="h-56 w-56 rounded-md bg-white p-2" /> : <div className="flex h-56 w-56 items-center justify-center text-xs text-text-dim"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> gerando QR…</div>}
          <ol className="max-w-sm list-decimal space-y-1.5 pl-4 text-sm text-text-muted">
            <li>No celular do número, abra o WhatsApp.</li>
            <li>
              Toque em <strong>Aparelhos conectados</strong> › <strong>Conectar um aparelho</strong>.
            </li>
            <li>Aponte a câmera para este QR code. Ele se renova sozinho; esta tela muda para “conectado” assim que a leitura terminar.</li>
            {cur.pairingCode && (
              <li>
                Ou use o código de pareamento: <code className="text-text">{cur.pairingCode}</code>
              </li>
            )}
          </ol>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
        <Button size="sm" variant="ghost" onClick={() => setShowContacts((v) => !v)}>
          <Users /> {showContacts ? "Esconder contatos" : "Contatos e conversas"}
        </Button>
      </div>
      {showContacts && <Contacts numberId={n.id} failed={n.failedOut} />}

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "delete" ? "Remover este número?" : "Desconectar este número?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "delete"
                ? "A sessão é encerrada, a instância sai do Evolution e os contatos e filas deste número são apagados. As conversas continuam no histórico de execuções."
                : "O número sai dos aparelhos conectados do WhatsApp e para de atender. Para voltar, será preciso ler o QR code de novo."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirm && act.mutate(confirm)}>{confirm === "delete" ? "Remover" : "Desconectar"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Contacts({ numberId, failed }: { numberId: string; failed: number }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["wa-contacts", numberId], queryFn: () => api.get<{ contacts: Contact[] }>(`/whatsapp/numbers/${numberId}/contacts`).then((r) => r.contacts), refetchInterval: 10_000 });
  const f = useQuery({ queryKey: ["wa-failed", numberId], queryFn: () => api.get<{ messages: Failed[] }>(`/whatsapp/numbers/${numberId}/failed`).then((r) => r.messages), enabled: failed > 0 });
  const retry = useMutation({
    mutationFn: (id: string) => api.post(`/whatsapp/outbound/${id}/retry`),
    onSuccess: () => {
      toast.success("Envio na fila de novo");
      qc.invalidateQueries({ queryKey: ["wa-failed", numberId] });
      qc.invalidateQueries({ queryKey: ["wa-numbers"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className="mt-2 space-y-3">
      <ErrorBox error={q.error} />
      {q.isLoading ? (
        <Loading />
      ) : !q.data?.length ? (
        <p className="px-2 text-xs text-text-dim">Ninguém escreveu para este número ainda.</p>
      ) : (
        <div className="rounded-md border border-line">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-3">Contato</TableHead>
                <TableHead>Última mensagem</TableHead>
                <TableHead>Quando</TableHead>
                <TableHead>Conversas</TableHead>
                <TableHead className="pr-3" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="pl-3">
                    <div className="font-medium">{c.name ?? "—"}</div>
                    <div className="text-xs text-text-dim tabular-nums">{c.phone ?? c.jid}</div>
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-text-muted" title={c.lastText ?? ""}>
                    {c.busyRunId && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />}
                    {c.lastText || "—"}
                  </TableCell>
                  <TableCell className="text-xs text-text-muted tabular-nums">{c.lastInboundAt ? dateTime(c.lastInboundAt) : "—"}</TableCell>
                  <TableCell className="text-xs">{c.sessions}</TableCell>
                  <TableCell className="pr-3 text-right">
                    {c.sessionId && (
                      <a className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text" href={`/api/v1/sessions/${c.sessionId}/transcript`} target="_blank" rel="noreferrer" title="Transcrição da conversa atual">
                        <FileText className="h-3.5 w-3.5" /> transcrição
                      </a>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {failed > 0 && f.data && f.data.length > 0 && (
        <div className="rounded-md border border-rose-500/30 p-3">
          <div className="mb-2 text-xs font-medium text-rose-300">Envios com falha</div>
          <div className="space-y-1.5">
            {f.data.map((m) => (
              <div key={m.id} className="flex items-start gap-2 text-xs">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-text-muted">{m.fileId ? "(arquivo)" : m.text}</div>
                  <div className="text-text-dim">
                    {m.jid.split("@")[0]} · {dateTime(m.createdAt)} · {m.error}
                  </div>
                </div>
                <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => retry.mutate(m.id)}>
                  <RotateCcw className="h-3 w-3" /> reenviar
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function NumberDialog({ number, flows, onClose }: { number: WaNumber | null; flows: FlowSummary[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(number?.name ?? "");
  const [target, setTarget] = useState(number ? (number.useProduction ? PROD : (number.flowId ?? "")) : PROD);
  const [enabled, setEnabled] = useState(number?.enabled ?? true);
  const save = useMutation({
    mutationFn: async () => {
      const body = { name: name.trim(), useProduction: target === PROD, flowId: target === PROD ? null : target, enabled };
      if (number) return api.put(`/whatsapp/numbers/${number.id}`, body);
      const r = await api.post<{ number: WaNumber }>("/whatsapp/numbers", body);
      // Ja pede o QR: o proximo passo e sempre ler no celular.
      await api.post(`/whatsapp/numbers/${r.number.id}/connect`).catch((e) => toast.error(`Número criado, mas o QR falhou: ${(e as Error).message}`));
      return r;
    },
    onSuccess: () => {
      toast.success(number ? "Número atualizado" : "Número criado: leia o QR code no celular");
      qc.invalidateQueries({ queryKey: ["wa-numbers"] });
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{number ? "Editar número" : "Novo número de WhatsApp"}</DialogTitle>
          <DialogDescription>Cada número atende por um fluxo. Trocar o fluxo vale a partir da próxima mensagem.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Nome">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Atendimento Consumidor" />
          </Field>
          <Field label="Fluxo de atendimento" hint="Produção segue o que for publicado. Um fluxo específico roda a última versão publicada dele (sem publicação, o rascunho).">
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Escolha um fluxo" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={PROD}>
                  <Rocket className="h-3.5 w-3.5 text-emerald-400" /> Fluxo em produção
                </SelectItem>
                <SelectGroup>
                  <SelectLabel>Fluxo específico</SelectLabel>
                  {flows.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <div className="flex items-center gap-2">
            <Switch id="wa-enabled" checked={enabled} onCheckedChange={setEnabled} />
            <Label htmlFor="wa-enabled">Atender mensagens</Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => save.mutate()} disabled={!name.trim() || !target || save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />}
            {number ? "Salvar" : "Criar e gerar QR"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

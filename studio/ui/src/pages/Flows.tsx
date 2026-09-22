import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Copy, MessagesSquare, MoreHorizontal, Plus, Rocket, Trash2, Workflow } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { dateTime } from "@/lib/format";
import type { Flow, FlowSummary } from "@/lib/types";
import { Page } from "@/Layout";
import { Empty, ErrorBox, Field, Loading, PageHeader, Pill } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export function FlowsPage() {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const flows = useQuery({ queryKey: ["flows"], queryFn: () => api.get<{ flows: FlowSummary[] }>("/flows").then((r) => r.flows) });
  const [creating, setCreating] = useState(false);
  const [dup, setDup] = useState<FlowSummary | null>(null);
  const [del, setDel] = useState<FlowSummary | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ["flows"] });
  const duplicate = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.post<{ flow: Flow }>(`/flows/${id}/duplicate`, { name }),
    onSuccess: (r) => {
      toast.success("Fluxo duplicado");
      refresh();
      setDup(null);
      nav(`/flows/${r.flow.id}`);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/flows/${id}`),
    onSuccess: () => {
      toast.success("Fluxo excluído");
      refresh();
      setDel(null);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Page>
      <PageHeader
        icon={<Workflow />}
        title="Fluxos"
        description="Quantos fluxos quiser; só um fica em produção. Editar um fluxo nunca afeta a produção: publicar cria uma release imutável."
        actions={isAdmin && <Button size="sm" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Novo fluxo</Button>}
      />
      <ErrorBox error={flows.error} />
      {flows.isLoading ? (
        <Loading />
      ) : !flows.data?.length ? (
        <Empty icon={<Workflow />}>Nenhum fluxo ainda.</Empty>
      ) : (
        <div className="grid gap-3">
          {flows.data.map((f) => (
            <div key={f.id} className="flex items-center gap-4 rounded-[10px] border border-line bg-ink-900 px-4 py-3.5 transition-colors hover:border-ink-500">
              <Link to={`/flows/${f.id}`} className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{f.name}</span>
                  {f.isProduction && (
                    <Pill tone="ok" title={`Release de produção: revisão ${f.productionRevision}`}>
                      <Rocket className="h-3 w-3" /> Produção · rev {f.productionRevision}
                    </Pill>
                  )}
                  {f.unpublishedChanges && (
                    <Pill tone="warn" title="O rascunho mudou depois da publicação. A produção continua na release anterior.">
                      <AlertTriangle className="h-3 w-3" /> alterações não publicadas
                    </Pill>
                  )}
                </div>
                {f.description && <p className="mt-0.5 line-clamp-1 text-[0.8rem] text-text-muted">{f.description}</p>}
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[0.72rem] text-text-dim">
                  <span>{f.nodeCount} nós · {f.specialistCount} especialistas</span>
                  <span>revisão {f.revision}</span>
                  <span>atualizado {dateTime(f.updatedAt)}</span>
                  {f.lastPublishedRevision && !f.isProduction && <span>última publicação: rev {f.lastPublishedRevision}</span>}
                </div>
              </Link>
              <Button variant="outline" size="sm" asChild>
                <Link to={`/simulator?flow=${f.id}`}><MessagesSquare className="h-4 w-4" /> Simular</Link>
              </Button>
              {isAdmin && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label="Ações"><MoreHorizontal className="h-4 w-4" /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setDup(f)}><Copy className="h-4 w-4" /> Duplicar</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem disabled={f.isProduction} onClick={() => setDel(f)} className="text-rose-300">
                      <Trash2 className="h-4 w-4" /> Excluir{f.isProduction ? " (em produção)" : ""}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          ))}
        </div>
      )}

      <NewFlowDialog open={creating} onClose={() => setCreating(false)} onCreated={(id) => { refresh(); nav(`/flows/${id}`); }} />

      <Dialog open={!!dup} onOpenChange={(o) => !o && setDup(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Duplicar fluxo</DialogTitle></DialogHeader>
          <form id="dup" onSubmit={(e) => { e.preventDefault(); const name = new FormData(e.currentTarget).get("name") as string; if (dup) duplicate.mutate({ id: dup.id, name }); }}>
            <Field label="Nome da cópia"><Input name="name" defaultValue={dup ? `${dup.name} (cópia)` : ""} autoFocus /></Field>
          </form>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDup(null)}>Cancelar</Button>
            <Button type="submit" form="dup" disabled={duplicate.isPending}>Duplicar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!del} onOpenChange={(o) => !o && setDel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir "{del?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>O rascunho e as releases deste fluxo serão apagados. As execuções já feitas continuam no histórico (com o grafo que rodou). A exclusão fica registrada na auditoria.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => del && remove.mutate(del.id)}>Excluir</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}

function NewFlowDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const create = useMutation({
    mutationFn: () => api.post<{ flow: Flow }>("/flows", { name, description }),
    onSuccess: (r) => {
      toast.success("Fluxo criado");
      onClose();
      setName("");
      setDescription("");
      onCreated(r.flow.id);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Novo fluxo</DialogTitle></DialogHeader>
        <p className="text-[0.8rem] text-text-muted">Começa com Entrada, Classificador, Consolidador, Compliance e Saída, com as regras globais da pesquisa. Os especialistas você adiciona no editor.</p>
        <Field label="Nome"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <Field label="Descrição"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} /></Field>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>Criar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

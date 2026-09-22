import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ShieldCheck, Trash2, UserCheck } from 'lucide-react';
import { kb } from '../lib/api';
import { currentUser } from '../lib/auth';
import { fmtWhen } from '../lib/format';
import {
  Button,
  Card,
  Empty,
  ErrorBox,
  Field,
  PageHeader,
  Pill,
  Spinner,
  inputClass,
} from '../components/Ui';
import type { GrantKind, SpaceGrants } from '../lib/types';

const TIPOS: { value: GrantKind; label: string; hint: string }[] = [
  { value: 'group', label: 'Grupo', hint: 'caminho do grupo no Identity, ex.: /goga/curadoria' },
  { value: 'role', label: 'Role', hint: 'role do realm, ou cliente:role' },
  { value: 'email', label: 'E-mail', hint: 'pessoa nominal, pelo e-mail do token' },
  { value: 'entra_oid', label: 'EntraID', hint: 'object id da conta no EntraID' },
  {
    value: 'public',
    label: 'Qualquer autenticado',
    hint: 'abre o Espaço para todo mundo que logar',
  },
];

export function AccessPage() {
  const cliente = useQueryClient();
  const grants = useQuery({ queryKey: ['grants'], queryFn: kb.grants });
  const admins = useQuery({ queryKey: ['admins'], queryFn: kb.admins });
  const vistos = useQuery({ queryKey: ['principals'], queryFn: kb.principals });

  const invalidar = () => {
    void cliente.invalidateQueries({ queryKey: ['grants'] });
    void cliente.invalidateQueries({ queryKey: ['admins'] });
    // A lista de Espaços do próprio usuário muda quando ele mesmo é afetado.
    void cliente.invalidateQueries({ queryKey: ['spaces'] });
  };

  if (grants.isLoading) return <Spinner label="Lendo os vínculos de permissão…" />;

  // 403 aqui não é falha: é a resposta correta para quem não é admin. Dizer
  // isso é melhor que mostrar uma tela vazia e deixar a pessoa procurando o
  // botão que não existe.
  if (grants.error) {
    const mensagem = (grants.error as Error).message;
    return (
      <>
        <PageHeader title="Acessos" />
        <ErrorBox>
          {mensagem.includes('alcanca') || mensagem.includes('exige') ? (
            <>
              Esta tela é de administração. Seu acesso (
              {currentUser()?.groups.join(', ') || 'sem grupo'}) não alcança — quem administra a
              base pode te incluir aqui.
            </>
          ) : (
            mensagem
          )}
        </ErrorBox>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Acessos">
        Quem alcança qual base, e quem administra. Tudo aqui é aplicado <strong>no servidor</strong>
        , em todo caminho de leitura — busca, <code>fetch</code> e MCP — não só nesta tela.
      </PageHeader>

      <section className="mb-7">
        <h2 className="mb-1 flex items-center gap-2 text-[15px] font-semibold">
          <UserCheck size={15} /> Acesso por base
        </h2>
        <p className="mb-3.5 text-[13px] text-text-muted">
          Um Espaço sem nenhum vínculo não é alcançável por ninguém — a não ser pelos
          administradores, que veem tudo.
        </p>
        <div className="grid gap-3">
          {(grants.data ?? []).map((space) => (
            <SpaceCard key={space.slug} space={space} onChange={invalidar} />
          ))}
          {(grants.data ?? []).length === 0 ? (
            <Card className="px-5">
              <Empty>Nenhum Espaço criado ainda.</Empty>
            </Card>
          ) : null}
        </div>
      </section>

      <section className="mb-7">
        <h2 className="mb-1 flex items-center gap-2 text-[15px] font-semibold">
          <ShieldCheck size={15} /> Administradores
        </h2>
        <p className="mb-3.5 text-[13px] text-text-muted">
          Administrador alcança todas as bases e pode mudar esta tela.
        </p>
        {admins.error ? (
          <ErrorBox>{(admins.error as Error).message}</ErrorBox>
        ) : (
          <AdminCard data={admins.data} onChange={invalidar} />
        )}
      </section>

      <section>
        <h2 className="mb-1 text-[15px] font-semibold">Quem já consultou</h2>
        <p className="mb-3.5 text-[13px] text-text-muted">
          A aplicação não tem cadastro de usuários — quem tem é o Identity. Esta lista sai do log de
          buscas, e serve para uma coisa concreta: quem aparece com{' '}
          <strong>muitas buscas vazias</strong> costuma ser exatamente quem está esperando
          permissão.
        </p>
        <Card className="overflow-x-auto">
          {vistos.isLoading ? (
            <Spinner />
          ) : (vistos.data ?? []).length === 0 ? (
            <div className="px-5">
              <Empty>Nenhuma busca registrada ainda.</Empty>
            </div>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-[11px] uppercase tracking-wider text-text-dim">
                  <th className="px-4 py-2.5 text-left font-semibold">Identidade</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Buscas</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Sem resultado</th>
                  <th className="px-4 py-2.5 text-left font-semibold">Última</th>
                </tr>
              </thead>
              <tbody>
                {(vistos.data ?? []).map((p) => (
                  <tr key={p.principal} className="border-b border-line-soft last:border-0">
                    <td className="mono px-4 py-2.5">{p.principal}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{p.searches}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {p.empty_results > 0 && p.empty_results === p.searches ? (
                        <Pill tone="warn">
                          {p.empty_results} de {p.searches}
                        </Pill>
                      ) : (
                        p.empty_results
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-text-muted">{fmtWhen(p.last_seen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </section>
    </>
  );
}

function SpaceCard({ space, onChange }: { space: SpaceGrants; onChange: () => void }) {
  const [tipo, setTipo] = useState<GrantKind>('group');
  const [valor, setValor] = useState('');
  const [erro, setErro] = useState('');

  const adicionar = useMutation({
    mutationFn: () =>
      kb.addGrant({ space: space.slug, principal_type: tipo, principal_id: valor.trim() }),
    onSuccess: () => {
      setValor('');
      setErro('');
      onChange();
    },
    onError: (err) => setErro((err as Error).message),
  });

  const remover = useMutation({
    mutationFn: (id: number) => kb.removeGrant(id),
    onSuccess: onChange,
    onError: (err) => setErro((err as Error).message),
  });

  const dica = TIPOS.find((t) => t.value === tipo)?.hint ?? '';

  return (
    <Card className="px-5 py-4">
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <strong className="text-[14px]">{space.label}</strong>
        <code className="text-text-dim">{space.slug}</code>
        {space.grants.length === 0 ? (
          <Pill tone="warn">sem nenhum vínculo</Pill>
        ) : (
          <Pill>
            {space.grants.length} vínculo{space.grants.length > 1 ? 's' : ''}
          </Pill>
        )}
      </div>

      {space.grants.length > 0 ? (
        <ul className="mb-3.5 grid gap-1.5">
          {space.grants.map((grant) => (
            <li
              key={grant.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-ink-850 px-3 py-2"
            >
              <Pill>
                {TIPOS.find((t) => t.value === grant.principal_type)?.label ?? grant.principal_type}
              </Pill>
              <code className="text-[12.5px]">{grant.principal_id || 'qualquer autenticado'}</code>
              <span className="text-[12px] text-text-dim">{grant.role}</span>
              <button
                onClick={() => remover.mutate(grant.id)}
                disabled={remover.isPending}
                title="remover vínculo"
                className="ml-auto rounded p-1 text-text-dim hover:text-rose disabled:opacity-40"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <form
        className="flex flex-wrap items-end gap-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (tipo !== 'public' && !valor.trim()) {
            setErro('informe o grupo, role, e-mail ou object id');
            return;
          }
          adicionar.mutate();
        }}
      >
        <div className="w-[13rem]">
          <Field label="Tipo">
            <select
              className={inputClass}
              value={tipo}
              onChange={(event) => setTipo(event.target.value as GrantKind)}
            >
              {TIPOS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {tipo !== 'public' ? (
          <div className="min-w-[15rem] flex-1">
            <Field label="Identificador">
              <input
                className={inputClass}
                value={valor}
                placeholder={dica}
                onChange={(event) => setValor(event.target.value)}
              />
            </Field>
          </div>
        ) : (
          <p className="flex-1 text-[12.5px] text-amber">{dica}</p>
        )}
        <Button variant="primary" type="submit" disabled={adicionar.isPending}>
          <Plus size={14} /> Dar acesso
        </Button>
      </form>

      {erro ? <ErrorBox>{erro}</ErrorBox> : null}
    </Card>
  );
}

function AdminCard({
  data,
  onChange,
}: {
  data: import('../lib/types').AdminsResponse | undefined;
  onChange: () => void;
}) {
  const [tipo, setTipo] = useState('email');
  const [valor, setValor] = useState('');
  const [nota, setNota] = useState('');
  const [erro, setErro] = useState('');

  const adicionar = useMutation({
    mutationFn: () =>
      kb.addAdmin({ principal_type: tipo, principal_id: valor.trim(), note: nota.trim() }),
    onSuccess: () => {
      setValor('');
      setNota('');
      setErro('');
      onChange();
    },
    onError: (err) => setErro((err as Error).message),
  });
  const remover = useMutation({
    mutationFn: (id: number) => kb.removeAdmin(id),
    onSuccess: onChange,
    onError: (err) => setErro((err as Error).message),
  });

  if (!data) return <Spinner />;

  return (
    <Card className="px-5 py-4">
      {/* A regra do Identity aparece primeiro e sem botão de remover, porque é
          ela que garante que existe um caminho de administração mesmo com a
          lista abaixo vazia. Esconder isso sugeriria que a lista é a única
          fonte de poder — e alguém tentaria se remover e trancar todo mundo. */}
      <div className="mb-3.5 rounded-lg border border-line bg-ink-850 px-3 py-2.5">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-text-dim">
          Pelo Identity · fixo
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone="good">Grupo</Pill>
          <code className="text-[12.5px]">{data.identity_group}</code>
          {data.identity_role ? (
            <>
              <Pill tone="good">Role</Pill>
              <code className="text-[12.5px]">{data.identity_role}</code>
            </>
          ) : null}
          <span className="text-[12px] text-text-dim">
            configurado no deploy; muda no Identity, não aqui
          </span>
        </div>
      </div>

      {data.admins.length > 0 ? (
        <ul className="mb-3.5 grid gap-1.5">
          {data.admins.map((admin) => (
            <li
              key={admin.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-ink-850 px-3 py-2"
            >
              <Pill>
                {TIPOS.find((t) => t.value === admin.principal_type)?.label ?? admin.principal_type}
              </Pill>
              <code className="text-[12.5px]">{admin.principal_id}</code>
              {admin.note ? (
                <span className="text-[12px] text-text-muted">{admin.note}</span>
              ) : null}
              <span className="text-[11px] text-text-dim">
                por {admin.created_by} · {fmtWhen(admin.created_at)}
              </span>
              <button
                onClick={() => remover.mutate(admin.id)}
                disabled={remover.isPending}
                title="remover administrador"
                className="ml-auto rounded p-1 text-text-dim hover:text-rose disabled:opacity-40"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>
          Nenhum administrador acrescentado aqui. Quem está no grupo acima já administra.
        </Empty>
      )}

      <form
        className="flex flex-wrap items-end gap-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valor.trim()) {
            setErro('informe o e-mail, grupo, role ou object id');
            return;
          }
          adicionar.mutate();
        }}
      >
        <div className="w-[13rem]">
          <Field label="Tipo">
            <select
              className={inputClass}
              value={tipo}
              onChange={(event) => setTipo(event.target.value)}
            >
              {TIPOS.filter((t) => t.value !== 'public').map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="min-w-[14rem] flex-1">
          <Field label="Identificador">
            <input
              className={inputClass}
              value={valor}
              placeholder={TIPOS.find((t) => t.value === tipo)?.hint ?? ''}
              onChange={(event) => setValor(event.target.value)}
            />
          </Field>
        </div>
        <div className="min-w-[11rem] flex-1">
          <Field label="Motivo (opcional)">
            <input
              className={inputClass}
              value={nota}
              placeholder="por que esta pessoa administra"
              onChange={(event) => setNota(event.target.value)}
            />
          </Field>
        </div>
        <Button variant="primary" type="submit" disabled={adicionar.isPending}>
          <Plus size={14} /> Tornar admin
        </Button>
      </form>

      {erro ? <ErrorBox>{erro}</ErrorBox> : null}
    </Card>
  );
}

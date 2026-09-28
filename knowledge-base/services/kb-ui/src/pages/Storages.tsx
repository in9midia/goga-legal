import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Check,
  CircleAlert,
  Copy,
  FolderSync,
  HardDrive,
  Pencil,
  Plus,
  Save,
  Trash2,
  Upload,
  Zap,
} from 'lucide-react';
import { kb } from '../lib/api';
import { fmtWhen } from '../lib/format';
import type { StorageConnection, StorageKind, StorageTest } from '../lib/types';
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
import { SyncStatus } from '../components/SyncPanel';

/**
 * Cadastro dos armazenamentos externos de onde uma base pode sincronizar pastas.
 *
 * Aqui só se cadastra a CREDENCIAL. Qual pasta entra em qual base se escolhe na
 * própria base (Documentos > Gerenciar), que é onde a escolha do Espaço já foi
 * feita — mesmo motivo por que as telas por base saíram do menu.
 *
 * A chave da conta de serviço nunca volta para esta tela (ADR-0009). O e-mail
 * volta, e em destaque: é ele que a pessoa precisa para compartilhar a pasta, e
 * esquecer de compartilhar é o erro número um.
 */
export function StoragesPage() {
  const cliente = useQueryClient();
  const lista = useQuery({ queryKey: ['storages'], queryFn: kb.storages });
  const syncs = useQuery({
    queryKey: ['syncs', ''],
    queryFn: () => kb.syncs(),
    refetchInterval: 15_000,
  });
  const [criando, setCriando] = useState(false);
  const [editando, setEditando] = useState<StorageConnection | null>(null);
  const [erro, setErro] = useState('');
  const [testes, setTestes] = useState<Record<number, StorageTest | 'rodando'>>({});

  const invalidar = () => {
    void cliente.invalidateQueries({ queryKey: ['storages'] });
    void cliente.invalidateQueries({ queryKey: ['syncs'] });
  };

  const remover = useMutation({
    mutationFn: (id: number) => kb.removeStorage(id),
    onSuccess: () => {
      setErro('');
      invalidar();
    },
    onError: (e) => setErro((e as Error).message),
  });

  const testar = async (id: number) => {
    setTestes((atual) => ({ ...atual, [id]: 'rodando' }));
    try {
      const resultado = await kb.testStorage(id);
      setTestes((atual) => ({ ...atual, [id]: resultado }));
    } catch (e) {
      setTestes((atual) => ({
        ...atual,
        [id]: { ok: false, client_email: '', error: (e as Error).message },
      }));
    }
  };

  if (lista.isLoading) return <Spinner label="Lendo os armazenamentos…" />;
  if (lista.error) return <ErrorBox>{(lista.error as Error).message}</ErrorBox>;

  const conexoes = lista.data?.storages ?? [];
  const tipos = lista.data?.kinds ?? [];
  const pastas = syncs.data ?? [];

  return (
    <>
      <PageHeader title="Armazenamentos">
        De onde uma base pode <strong>sincronizar uma pasta</strong>: tudo o que está nela entra na
        base, o que muda vira versão nova e o que sai da pasta sai da base. Documentos enviados à
        mão nunca são tocados. Aqui você cadastra a credencial; a pasta se escolhe na própria base,
        em <strong>Documentos › Gerenciar</strong>.
      </PageHeader>

      {erro ? <ErrorBox>{erro}</ErrorBox> : null}

      <div className="mb-4">
        <Button
          variant="primary"
          onClick={() => {
            setEditando(null);
            setCriando((v) => !v);
          }}
        >
          <Plus size={14} /> Novo armazenamento
        </Button>
      </div>

      {criando || editando ? (
        <FormConexao
          key={editando ? `edita-${editando.id}` : 'novo'}
          tipos={tipos}
          editando={editando ?? undefined}
          onCancelar={() => {
            setCriando(false);
            setEditando(null);
          }}
          onPronto={() => {
            setCriando(false);
            setEditando(null);
            invalidar();
          }}
        />
      ) : null}

      {conexoes.length === 0 && !criando ? (
        <Card className="px-5 py-4">
          <EstadoVazio
            icone={HardDrive}
            titulo="Nenhum armazenamento cadastrado"
            acao={
              <Button variant="primary" onClick={() => setCriando(true)}>
                <Plus size={14} /> Cadastrar o Google Drive
              </Button>
            }
          >
            Cadastre uma conta de serviço do Google, compartilhe com ela a pasta do escritório e
            ligue a sincronização na base.
          </EstadoVazio>
        </Card>
      ) : (
        <div className="grid gap-3">
          {conexoes.map((c) => (
            <Card key={c.id} className="px-5 py-4">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <strong className="text-[15px]">{c.label}</strong>
                    <Pill>{c.kind_label}</Pill>
                    {c.syncs ? (
                      <Pill tone="good">
                        {c.syncs} pasta{c.syncs > 1 ? 's' : ''} sincronizada{c.syncs > 1 ? 's' : ''}
                      </Pill>
                    ) : null}
                  </div>
                  <EmailDaConta email={c.client_email} />
                  <div className="mt-1 text-[12px] text-text-muted">
                    chave <code>{c.secret_hint || '(ausente)'}</code>
                    {c.project_id ? ` · projeto ${c.project_id}` : ''}
                    {c.updated_at ? ` · alterado ${fmtWhen(c.updated_at)}` : ''}
                  </div>
                  <ResultadoTeste resultado={testes[c.id]} />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={() => void testar(c.id)} disabled={testes[c.id] === 'rodando'}>
                    <Zap size={13} /> {testes[c.id] === 'rodando' ? 'testando…' : 'Testar'}
                  </Button>
                  <Button
                    onClick={() => {
                      setCriando(false);
                      setEditando(c);
                    }}
                  >
                    <Pencil size={13} /> Editar
                  </Button>
                  <button
                    title={
                      c.syncs
                        ? 'Remova antes as sincronizações que usam este armazenamento'
                        : 'Remover o armazenamento'
                    }
                    disabled={remover.isPending || c.syncs > 0}
                    onClick={() => {
                      if (confirm(`Remover o armazenamento "${c.label}"?`)) remover.mutate(c.id);
                    }}
                    className="rounded-lg border border-line bg-ink-800 p-2 text-text-dim transition-colors hover:border-rose hover:text-rose disabled:opacity-40"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {pastas.length ? (
        <>
          <h2 className="mb-3 mt-8 text-[13px] font-semibold uppercase tracking-wider text-text-dim">
            Pastas sincronizadas
          </h2>
          <Card className="overflow-hidden">
            <ul>
              {pastas.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center gap-3 border-b border-line-soft px-5 py-3 last:border-b-0"
                >
                  <FolderSync size={15} className="shrink-0 text-text-dim" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold">{s.folder_name || s.folder_id}</div>
                    <div className="text-[12px] text-text-muted">
                      {s.connection_label} → base <code>{s.space}</code> · {s.documents} documentos
                    </div>
                  </div>
                  <SyncStatus sync={s} />
                  <Link
                    to={`/documentos?espaco=${encodeURIComponent(s.space)}&sync=1`}
                    className="text-[12px] font-semibold text-accent hover:underline"
                  >
                    abrir na base
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </>
      ) : null}
    </>
  );
}

function EmailDaConta({ email }: { email: string }) {
  const [copiado, setCopiado] = useState(false);
  if (!email) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-text-muted">
      compartilhe as pastas com
      <code className="mono text-text">{email}</code>
      <button
        type="button"
        title="Copiar o e-mail"
        onClick={() => {
          void navigator.clipboard.writeText(email).then(() => {
            setCopiado(true);
            setTimeout(() => setCopiado(false), 1500);
          });
        }}
        className="rounded border border-line p-1 text-text-dim hover:text-text"
      >
        {copiado ? <Check size={12} className="text-emerald" /> : <Copy size={12} />}
      </button>
    </div>
  );
}

function ResultadoTeste({ resultado }: { resultado?: StorageTest | 'rodando' }) {
  if (!resultado || resultado === 'rodando') return null;
  if (!resultado.ok)
    return (
      <p className="mt-2 flex items-start gap-1.5 text-[12.5px] text-rose">
        <CircleAlert size={13} className="mt-[2px] shrink-0" />
        <span className="break-words">{resultado.error}</span>
      </p>
    );
  return (
    <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-text-muted">
      <Check size={13} className="text-emerald" />
      conectado ·{' '}
      {resultado.folders
        ? `${resultado.folders} pasta(s) compartilhada(s) com a conta`
        : 'nenhuma pasta compartilhada com a conta ainda'}
    </p>
  );
}

/** Cadastro e edição. A chave entra colando o JSON ou escolhendo o arquivo. */
function FormConexao({
  tipos,
  editando,
  onCancelar,
  onPronto,
}: {
  tipos: StorageKind[];
  editando?: StorageConnection;
  onCancelar: () => void;
  onPronto: () => void;
}) {
  const [kind, setKind] = useState(editando?.kind ?? tipos[0]?.kind ?? 'google_drive');
  const [label, setLabel] = useState(editando?.label ?? '');
  const [credencial, setCredencial] = useState('');
  const [erro, setErro] = useState('');
  const arquivo = useRef<HTMLInputElement>(null);

  const salvar = useMutation({
    mutationFn: () =>
      editando
        ? kb.updateStorage(editando.id, { label, credential: credencial.trim() || undefined })
        : kb.createStorage({ kind, label, credential: credencial }),
    onSuccess: onPronto,
    onError: (e) => setErro((e as Error).message),
  });

  return (
    <Card className="mb-4 px-5 py-4">
      <form
        className="grid gap-4"
        onSubmit={(evento) => {
          evento.preventDefault();
          setErro('');
          salvar.mutate();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
          <Field label="Tipo">
            <select
              className={inputClass}
              value={kind}
              disabled={Boolean(editando)}
              onChange={(e) => setKind(e.target.value)}
            >
              {tipos.map((t) => (
                <option key={t.kind} value={t.kind}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Nome">
            <input
              className={inputClass}
              value={label}
              placeholder="Drive do escritório"
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
        </div>

        <Field
          label={
            editando
              ? 'Chave da conta de serviço (vazio = manter a atual)'
              : 'Chave da conta de serviço (JSON)'
          }
        >
          <textarea
            className={`${inputClass} mono min-h-[7rem] text-[12px]`}
            value={credencial}
            spellCheck={false}
            autoComplete="off"
            placeholder='{"type": "service_account", "client_email": "…", "private_key": "…"}'
            onChange={(e) => setCredencial(e.target.value)}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-text-muted">
          <input
            ref={arquivo}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const escolhido = e.target.files?.[0];
              if (escolhido) void escolhido.text().then(setCredencial);
              e.target.value = '';
            }}
          />
          <Button onClick={() => arquivo.current?.click()}>
            <Upload size={13} /> Escolher arquivo .json
          </Button>
          <span>
            Google Cloud › IAM › Contas de serviço › Chaves › Adicionar chave › JSON. Ative a{' '}
            <strong>Google Drive API</strong> no mesmo projeto. A chave fica cifrada e não volta
            para esta tela.
          </span>
        </div>

        {erro ? <ErrorBox>{erro}</ErrorBox> : null}

        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={salvar.isPending}>
            <Save size={14} /> {salvar.isPending ? 'Validando…' : 'Salvar'}
          </Button>
          <Button onClick={onCancelar}>Cancelar</Button>
        </div>
      </form>
    </Card>
  );
}

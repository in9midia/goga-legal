import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  ChevronRight,
  CircleAlert,
  Folder,
  FolderSync,
  HardDrive,
  List,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { kb } from '../lib/api';
import { fmtBytes, fmtWhen } from '../lib/format';
import type { StorageFolder, StorageSync, SyncItem } from '../lib/types';
import {
  Button,
  Card,
  Dialog,
  EstadoVazio,
  ErrorBox,
  Field,
  Pill,
  Spinner,
  inputClass,
  selectClass,
} from './Ui';

const INTERVALOS = [5, 10, 15, 30, 60, 180, 720, 1440];

function rotuloIntervalo(minutos: number) {
  if (minutos < 60) return `a cada ${minutos} min`;
  if (minutos < 1440) return `a cada ${minutos / 60} h`;
  return 'uma vez por dia';
}

/** Estado de uma pasta numa etiqueta só. Usado aqui e na tela de Armazenamentos. */
export function SyncStatus({ sync }: { sync: StorageSync }) {
  if (!sync.enabled) return <Pill tone="neutral">pausada</Pill>;
  if (sync.status === 'running')
    return (
      <Pill tone="warn">
        <Loader2 size={10} className="animate-spin" /> sincronizando
      </Pill>
    );
  if (sync.status === 'error')
    return (
      <Pill tone="bad" title={sync.last_error}>
        <CircleAlert size={10} /> erro
      </Pill>
    );
  if (sync.pending)
    return (
      <Pill tone="warn" title="arquivos desta pasta esperando na fila de ingestão">
        {sync.pending} na fila
      </Pill>
    );
  return (
    <Pill tone="good" title={sync.last_ok_at ? `última rodada ${fmtWhen(sync.last_ok_at)}` : ''}>
      em dia
    </Pill>
  );
}

function Resumo({ sync }: { sync: StorageSync }) {
  const r = sync.last_summary;
  if (!sync.last_run_at) return <span>primeira rodada em instantes</span>;
  // Rodada que falhou não listou nada: "0 arquivos · nada mudou" pareceria uma
  // pasta vazia em dia, quando o que houve foi não conseguir ler.
  if (sync.status === 'error')
    return <span>última tentativa {fmtWhen(sync.last_run_at)} falhou; nada foi alterado</span>;
  const partes = [
    r.novos ? `${r.novos} novo(s)` : '',
    r.atualizados ? `${r.atualizados} atualizado(s)` : '',
    r.renomeados ? `${r.renomeados} renomeado(s)` : '',
    r.removidos ? `${r.removidos} removido(s)` : '',
  ].filter(Boolean);
  return (
    <span>
      última rodada {fmtWhen(sync.last_run_at)} · {r.arquivos ?? 0} arquivo(s) na pasta
      {partes.length ? ` · ${partes.join(', ')}` : ' · nada mudou'}
    </span>
  );
}

/**
 * As pastas sincronizadas desta base, dentro de Documentos › Gerenciar.
 *
 * Fica ao lado do envio manual de propósito: são as duas portas de entrada de
 * documento, e quem gerencia a base precisa ver as duas no mesmo lugar.
 */
export function SyncPanel({ space }: { space: string }) {
  const cliente = useQueryClient();
  const syncs = useQuery({
    queryKey: ['syncs', space],
    queryFn: () => kb.syncs(space),
    // Enquanto alguma pasta roda ou tem arquivo na fila, o número anda.
    refetchInterval: (q) =>
      (q.state.data ?? []).some((s) => s.status === 'running' || s.pending) ? 4_000 : 20_000,
  });
  const [criando, setCriando] = useState(false);
  const [itensDe, setItensDe] = useState<StorageSync | null>(null);
  const [removendo, setRemovendo] = useState<StorageSync | null>(null);
  const [erro, setErro] = useState('');

  const invalidar = () => {
    void cliente.invalidateQueries({ queryKey: ['syncs'] });
    void cliente.invalidateQueries({ queryKey: ['documents', space] });
    void cliente.invalidateQueries({ queryKey: ['spaces'] });
  };

  const rodar = useMutation({
    mutationFn: (id: number) => kb.runSync(id),
    onSuccess: invalidar,
    onError: (e) => setErro((e as Error).message),
  });
  const atualizar = useMutation({
    mutationFn: (p: { id: number; body: Parameters<typeof kb.updateSync>[1] }) =>
      kb.updateSync(p.id, p.body),
    onSuccess: invalidar,
    onError: (e) => setErro((e as Error).message),
  });

  const lista = syncs.data ?? [];

  return (
    <Card className="px-5 py-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <FolderSync size={16} className="text-text-dim" />
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold">Pastas sincronizadas</h3>
          <p className="text-[12px] text-text-muted">
            O que está na pasta entra, o que muda vira versão nova, o que sai da pasta sai da base.
            Os documentos enviados à mão não são tocados.
          </p>
        </div>
        <Button variant="primary" onClick={() => setCriando(true)}>
          <Plus size={14} /> Sincronizar pasta
        </Button>
      </div>

      {erro ? <ErrorBox>{erro}</ErrorBox> : null}
      {syncs.error ? <ErrorBox>{(syncs.error as Error).message}</ErrorBox> : null}

      {syncs.isLoading ? (
        <Spinner />
      ) : lista.length === 0 ? (
        <p className="text-[12.5px] text-text-muted">Nenhuma pasta sincronizada com esta base.</p>
      ) : (
        <ul className="grid gap-2">
          {lista.map((s) => (
            <li key={s.id} className="rounded-lg border border-line-soft bg-ink-850 px-4 py-3">
              <div className="flex flex-wrap items-start gap-3">
                <Folder size={15} className="mt-[3px] shrink-0 text-text-dim" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-[13.5px]">{s.folder_name || s.folder_id}</strong>
                    <SyncStatus sync={s} />
                    <Pill>{s.connection_label}</Pill>
                    {s.recursive ? <Pill>com subpastas</Pill> : null}
                  </div>
                  <div className="mt-1 text-[12px] text-text-muted">
                    {s.documents} documento(s) · <Resumo sync={s} />
                    {s.skipped ? ` · ${s.skipped} ignorado(s)` : ''}
                    {s.errors ? (
                      <span className="text-rose"> · {s.errors} com erro de download</span>
                    ) : null}
                  </div>
                  {s.status === 'error' && s.last_error ? (
                    <p className="mt-1 flex items-start gap-1.5 text-[12px] text-rose">
                      <CircleAlert size={12} className="mt-[2px] shrink-0" />
                      <span className="break-words">{s.last_error}</span>
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className={`${selectClass} py-1.5 text-[12.5px]`}
                    value={s.interval_minutes}
                    aria-label="Intervalo"
                    onChange={(e) =>
                      atualizar.mutate({
                        id: s.id,
                        body: { interval_minutes: Number(e.target.value) },
                      })
                    }
                  >
                    {[...new Set([...INTERVALOS, s.interval_minutes])]
                      .sort((a, b) => a - b)
                      .map((m) => (
                        <option key={m} value={m}>
                          {rotuloIntervalo(m)}
                        </option>
                      ))}
                  </select>
                  <Button
                    onClick={() => rodar.mutate(s.id)}
                    disabled={!s.enabled || s.status === 'running' || rodar.isPending}
                  >
                    <RefreshCw size={13} /> Sincronizar agora
                  </Button>
                  <Button
                    onClick={() => atualizar.mutate({ id: s.id, body: { enabled: !s.enabled } })}
                  >
                    {s.enabled ? <Pause size={13} /> : <Play size={13} />}
                    {s.enabled ? 'Pausar' : 'Retomar'}
                  </Button>
                  <Button onClick={() => setItensDe(s)}>
                    <List size={13} /> Arquivos
                  </Button>
                  <button
                    title="Parar de sincronizar esta pasta"
                    onClick={() => setRemovendo(s)}
                    className="rounded-lg border border-line bg-ink-800 p-2 text-text-dim transition-colors hover:border-rose hover:text-rose"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        aberto={criando}
        titulo="Sincronizar uma pasta"
        descricao={
          <>
            Todos os arquivos da pasta entram na base <code>{space}</code> e ela passa a ser
            acompanhada. A primeira rodada começa logo depois de salvar.
          </>
        }
        onClose={() => setCriando(false)}
      >
        {criando ? (
          <NovaSincronizacao
            space={space}
            onPronto={() => {
              setCriando(false);
              invalidar();
            }}
          />
        ) : null}
      </Dialog>

      <Dialog
        aberto={Boolean(itensDe)}
        titulo={`Arquivos de "${itensDe?.folder_name ?? ''}"`}
        descricao="O que a última rodada encontrou na pasta, e o que aconteceu com cada arquivo."
        onClose={() => setItensDe(null)}
        largura="max-w-4xl"
      >
        {itensDe ? <ItensDaPasta sync={itensDe} space={space} /> : null}
      </Dialog>

      <Dialog
        aberto={Boolean(removendo)}
        titulo="Parar de sincronizar"
        descricao={
          <>
            A pasta <strong>{removendo?.folder_name}</strong> deixa de ser acompanhada. Nada é
            apagado no Drive. O que fazer com os {removendo?.documents ?? 0} documento(s) que vieram
            dela?
          </>
        }
        onClose={() => setRemovendo(null)}
      >
        {removendo ? (
          <RemoverSincronizacao
            sync={removendo}
            onPronto={() => {
              setRemovendo(null);
              invalidar();
            }}
          />
        ) : null}
      </Dialog>
    </Card>
  );
}

function RemoverSincronizacao({ sync, onPronto }: { sync: StorageSync; onPronto: () => void }) {
  const [erro, setErro] = useState('');
  const remover = useMutation({
    mutationFn: (manter: boolean) => kb.removeSync(sync.id, manter),
    onSuccess: onPronto,
    onError: (e) => setErro((e as Error).message),
  });
  return (
    <div className="grid gap-3">
      {erro ? <ErrorBox>{erro}</ErrorBox> : null}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => remover.mutate(true)} disabled={remover.isPending}>
          Manter os documentos na base
        </Button>
        <button
          type="button"
          disabled={remover.isPending}
          onClick={() => remover.mutate(false)}
          className="inline-flex items-center gap-2 rounded-lg border border-rose/50 bg-ink-800 px-3 py-2 text-[13px] font-semibold text-rose transition-colors hover:border-rose disabled:opacity-50"
        >
          <Trash2 size={14} /> Remover os documentos também
        </button>
      </div>
      <p className="text-[12px] text-text-muted">
        Mantidos, eles passam a valer como enviados à mão. Removidos, saem da base e da busca.
        {remover.isPending ? ' Removendo…' : ''}
      </p>
    </div>
  );
}

/** O formulário de ligar uma pasta: armazenamento, pasta (navegando ou pelo link) e o ritmo. */
function NovaSincronizacao({ space, onPronto }: { space: string; onPronto: () => void }) {
  const armazenamentos = useQuery({ queryKey: ['storages'], queryFn: kb.storages });
  const conexoes = armazenamentos.data?.storages ?? [];
  const [conexao, setConexao] = useState<number | null>(null);
  const escolhida = conexao ?? conexoes[0]?.id ?? null;
  const [pasta, setPasta] = useState<StorageFolder | null>(null);
  const [link, setLink] = useState('');
  const [recursivo, setRecursivo] = useState(true);
  const [intervalo, setIntervalo] = useState(10);
  const [erro, setErro] = useState('');

  const criar = useMutation({
    mutationFn: () =>
      kb.createSync(space, {
        connection_id: escolhida!,
        folder: link.trim() || pasta!.id,
        recursive: recursivo,
        interval_minutes: intervalo,
      }),
    onSuccess: onPronto,
    onError: (e) => setErro((e as Error).message),
  });

  if (armazenamentos.isLoading) return <Spinner />;
  if (!conexoes.length)
    return (
      <EstadoVazio
        icone={HardDrive}
        titulo="Nenhum armazenamento cadastrado"
        acao={
          <Link
            to="/armazenamentos"
            className="text-[13px] font-semibold text-accent hover:underline"
          >
            Ir para Armazenamentos
          </Link>
        }
      >
        Cadastre antes a conta de serviço do Google Drive em Administração › Armazenamentos.
      </EstadoVazio>
    );

  const pronto = escolhida != null && (Boolean(link.trim()) || pasta != null);

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setErro('');
        criar.mutate();
      }}
    >
      <Field label="Armazenamento">
        <select
          className={inputClass}
          value={escolhida ?? ''}
          onChange={(e) => {
            setConexao(Number(e.target.value));
            setPasta(null);
          }}
        >
          {conexoes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label} ({c.kind_label})
            </option>
          ))}
        </select>
      </Field>

      {escolhida != null ? (
        <SeletorDePasta
          key={escolhida}
          connectionId={escolhida}
          escolhida={pasta}
          onEscolher={(p) => {
            setPasta(p);
            setLink('');
          }}
        />
      ) : null}

      <Field label="…ou cole o link da pasta">
        <input
          className={inputClass}
          value={link}
          placeholder="https://drive.google.com/drive/folders/…"
          onChange={(e) => setLink(e.target.value)}
        />
      </Field>

      <div className="flex flex-wrap items-end gap-4">
        <Field label="Verificar mudanças">
          <select
            className={selectClass}
            value={intervalo}
            onChange={(e) => setIntervalo(Number(e.target.value))}
          >
            {INTERVALOS.map((m) => (
              <option key={m} value={m}>
                {rotuloIntervalo(m)}
              </option>
            ))}
          </select>
        </Field>
        <label className="flex items-center gap-2 pb-2 text-[13px]">
          <input
            type="checkbox"
            checked={recursivo}
            onChange={(e) => setRecursivo(e.target.checked)}
          />
          incluir subpastas
        </label>
      </div>

      {erro ? <ErrorBox>{erro}</ErrorBox> : null}

      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={!pronto || criar.isPending}>
          <FolderSync size={14} />{' '}
          {criar.isPending
            ? 'Conferindo a pasta…'
            : pasta && !link.trim()
              ? `Sincronizar "${pasta.name}"`
              : 'Sincronizar'}
        </Button>
      </div>
    </form>
  );
}

/** Navega pelas pastas que a conta de serviço alcança. */
function SeletorDePasta({
  connectionId,
  escolhida,
  onEscolher,
}: {
  connectionId: number;
  escolhida: StorageFolder | null;
  onEscolher: (p: StorageFolder) => void;
}) {
  // O caminho percorrido. Vazio = a raiz (o que foi compartilhado com a conta).
  const [trilha, setTrilha] = useState<StorageFolder[]>([]);
  const atual = trilha[trilha.length - 1];
  const pastas = useQuery({
    queryKey: ['storage-folders', connectionId, atual?.id ?? ''],
    queryFn: () => kb.storageFolders(connectionId, atual?.id),
    retry: false,
  });

  return (
    <div>
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-text-dim">
        Pasta
      </span>
      <div className="rounded-lg border border-line bg-ink-850">
        <div className="flex flex-wrap items-center gap-1 border-b border-line-soft px-3 py-2 text-[12.5px]">
          <button
            type="button"
            className="font-semibold text-accent hover:underline"
            onClick={() => setTrilha([])}
          >
            Compartilhadas comigo
          </button>
          {trilha.map((p, i) => (
            <span key={p.id} className="flex items-center gap-1">
              <ChevronRight size={12} className="text-text-dim" />
              <button
                type="button"
                className="hover:underline"
                onClick={() => setTrilha(trilha.slice(0, i + 1))}
              >
                {p.name}
              </button>
            </span>
          ))}
          {atual ? (
            <button
              type="button"
              onClick={() => onEscolher(atual)}
              className="ml-auto rounded-md border border-line bg-ink-800 px-2 py-0.5 text-[12px] font-semibold hover:border-ink-500"
            >
              {escolhida?.id === atual.id ? '✓ escolhida' : 'Usar esta pasta'}
            </button>
          ) : null}
        </div>
        <div className="max-h-64 overflow-y-auto">
          {pastas.isLoading ? (
            <Spinner label="Lendo o Drive…" />
          ) : pastas.error ? (
            <div className="px-3">
              <ErrorBox>{(pastas.error as Error).message}</ErrorBox>
            </div>
          ) : (pastas.data?.folders ?? []).length === 0 ? (
            <p className="px-3 py-4 text-[12.5px] text-text-muted">
              {atual ? (
                'Sem subpastas aqui.'
              ) : (
                <>
                  Nada compartilhado com <code>{pastas.data?.client_email}</code> ainda. No Drive,
                  compartilhe a pasta com esse e-mail (leitor basta) e volte aqui.
                </>
              )}
            </p>
          ) : (
            <ul>
              {(pastas.data?.folders ?? []).map((p) => (
                <li
                  key={p.id}
                  className="flex items-center border-b border-line-soft last:border-b-0"
                >
                  <button
                    type="button"
                    onClick={() => setTrilha([...trilha, p])}
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-ink-800"
                  >
                    {p.shared_drive ? (
                      <HardDrive size={14} className="shrink-0 text-text-dim" />
                    ) : (
                      <Folder size={14} className="shrink-0 text-text-dim" />
                    )}
                    <span className="truncate">{p.name}</span>
                    <ChevronRight size={13} className="ml-auto shrink-0 text-text-dim" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onEscolher(p)}
                    className={`mr-2 rounded-md border px-2 py-0.5 text-[12px] font-semibold ${
                      escolhida?.id === p.id
                        ? 'border-emerald/50 text-emerald'
                        : 'border-line bg-ink-800 hover:border-ink-500'
                    }`}
                  >
                    {escolhida?.id === p.id ? '✓ escolhida' : 'Usar'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function ItensDaPasta({ sync, space }: { sync: StorageSync; space: string }) {
  const itens = useQuery({
    queryKey: ['sync-items', sync.id],
    queryFn: () => kb.syncItems(sync.id),
  });
  if (itens.isLoading) return <Spinner />;
  if (itens.error) return <ErrorBox>{(itens.error as Error).message}</ErrorBox>;
  const lista = itens.data ?? [];
  if (!lista.length)
    return <p className="text-[12.5px] text-text-muted">A pasta ainda não foi lida.</p>;
  return (
    <ul className="max-h-[60vh] overflow-y-auto">
      {lista.map((i) => (
        <li
          key={i.ref}
          className="flex flex-wrap items-center gap-2 border-b border-line-soft py-2"
        >
          <span className="min-w-0 flex-1 break-words text-[12.5px]">{i.path}</span>
          <span className="mono text-[11px] text-text-dim">{fmtBytes(i.size_bytes)}</span>
          <EstadoDoItem item={i} />
          {i.document_id ? (
            <Link
              to={`/documentos?espaco=${encodeURIComponent(space)}&doc=${i.document_id}`}
              className="text-[12px] font-semibold text-accent hover:underline"
            >
              abrir
            </Link>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function EstadoDoItem({ item }: { item: SyncItem }) {
  if (item.status === 'skipped')
    return (
      <Pill tone="neutral" title={item.error}>
        ignorado: {item.error}
      </Pill>
    );
  if (item.status === 'error')
    return (
      <Pill tone="bad" title={item.error}>
        erro ao baixar
      </Pill>
    );
  if (item.run_status === 'queued' || item.run_status === 'running')
    return <Pill tone="warn">{item.run_status === 'queued' ? 'na fila' : 'processando'}</Pill>;
  if (item.document_status === 'failed' || item.run_status === 'failed')
    return (
      <Pill tone="bad" title={item.run_error}>
        falhou
      </Pill>
    );
  if (item.document_id) return <Pill tone="good">indexado</Pill>;
  return <Pill>{item.run_status ?? '—'}</Pill>;
}

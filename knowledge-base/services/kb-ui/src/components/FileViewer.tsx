import { useEffect, useRef, useState } from 'react';
import { Download, FileQuestion } from 'lucide-react';
import { PdfViewer } from './PdfViewer';
import { Button, Empty, ErrorBox, Spinner } from './Ui';

/**
 * Visualização do arquivo ORIGINAL, por formato.
 *
 * Existe porque o canônico é o que a busca indexou, não o que a pessoa assinou.
 * Conferir um contra o outro é o ponto do requisito de bruto preservado — e sem
 * ver o original na tela, "conferir" vira baixar o arquivo e alternar janelas.
 *
 * O que NÃO tem visualização embutida diz isso explicitamente e oferece o
 * download. Renderizador ruim é pior que ausência de renderizador: ele parece
 * mostrar o documento e mostra outra coisa.
 */

type Props = {
  url: string;
  filename: string;
  mime: string;
  page?: number | null;
  highlight?: string;
};

type Kind = 'pdf' | 'docx' | 'xlsx' | 'image' | 'text' | 'none';

const TEXT_EXT = new Set(['txt', 'md', 'csv', 'json', 'log', 'yaml', 'yml', 'vtt', 'properties']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);

function kindOf(filename: string, mime: string): Kind {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf' || mime.includes('pdf')) return 'pdf';
  if (ext === 'docx') return 'docx';
  if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') return ext === 'csv' ? 'text' : 'xlsx';
  if (IMAGE_EXT.has(ext) || mime.startsWith('image/')) return 'image';
  if (TEXT_EXT.has(ext) || mime.startsWith('text/')) return 'text';
  return 'none';
}

export function FileViewer({ url, filename, mime, page, highlight }: Props) {
  const kind = kindOf(filename, mime);

  if (kind === 'pdf') return <PdfViewer url={url} page={page} highlight={highlight} />;
  if (kind === 'docx') return <DocxViewer url={url} highlight={highlight} />;
  if (kind === 'xlsx') return <XlsxViewer url={url} />;
  if (kind === 'image') return <ImageViewer url={url} filename={filename} />;
  if (kind === 'text') return <TextViewer url={url} highlight={highlight} />;

  const ext = filename.split('.').pop()?.toUpperCase() ?? 'este formato';
  return (
    <div className="rounded-lg border border-line bg-ink-850 px-5 py-8 text-center">
      <FileQuestion size={22} className="mx-auto mb-2 text-text-dim" />
      <p className="text-[13.5px] text-text-muted">
        Não há visualização embutida para <strong>{ext}</strong>.
      </p>
      <p className="mx-auto mt-1 max-w-md text-[12.5px] text-text-dim">
        O arquivo está íntegro no object store — baixe para abrir no aplicativo. A aba{' '}
        <strong>Canônico</strong> mostra o texto que a busca extraiu dele.
      </p>
    </div>
  );
}

/** Envolve o conteúdo renderizado numa caixa com rolagem própria. */
function Moldura({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-h-[var(--altura-conteudo,70vh)] min-w-0 overflow-auto rounded-lg border border-line bg-ink-950 p-3">
      {children}
    </div>
  );
}

/** Busca o arquivo (já é um blob local) e devolve o ArrayBuffer. */
function useArrayBuffer(url: string) {
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelado = false;
    setBuffer(null);
    setError('');
    fetch(url)
      .then((r) => r.arrayBuffer())
      .then((b) => !cancelado && setBuffer(b))
      .catch((e) => !cancelado && setError(String(e?.message ?? e)));
    return () => {
      cancelado = true;
    };
  }, [url]);
  return { buffer, error };
}

function DocxViewer({ url, highlight }: { url: string; highlight?: string }) {
  const alvo = useRef<HTMLDivElement | null>(null);
  const { buffer, error } = useArrayBuffer(url);
  const [falha, setFalha] = useState('');
  const [pronto, setPronto] = useState(false);

  useEffect(() => {
    if (!buffer || !alvo.current) return;
    let cancelado = false;
    setPronto(false);
    setFalha('');
    // Import dinâmico: o docx-preview só é baixado por quem abre um .docx.
    void import('docx-preview')
      .then(({ renderAsync }) =>
        renderAsync(buffer, alvo.current!, undefined, {
          className: 'docx',
          inWrapper: true,
          // Ignora a largura da página do Word: a coluna aqui é menor que um
          // A4, e respeitar a largura original obrigaria a rolar na horizontal
          // para ler cada linha.
          ignoreWidth: true,
          ignoreHeight: true,
          breakPages: true,
          experimental: true,
        }),
      )
      .then(() => !cancelado && setPronto(true))
      .catch((e) => !cancelado && setFalha(String(e?.message ?? e)));
    return () => {
      cancelado = true;
    };
  }, [buffer]);

  useEffect(() => {
    if (pronto && highlight && alvo.current) marcarTexto(alvo.current, highlight);
  }, [pronto, highlight]);

  if (error) return <ErrorBox>Não consegui buscar o arquivo: {error}</ErrorBox>;
  if (falha)
    return (
      <ErrorBox>
        Não consegui renderizar o .docx: {falha}. O arquivo continua íntegro — use
        &quot;Baixar&quot;.
      </ErrorBox>
    );
  return (
    <>
      {!buffer || !pronto ? <Spinner label="Renderizando o documento…" /> : null}
      <Moldura>
        {/* O docx-preview injeta o CSS do próprio documento (fundo branco, fonte
            do Word). Não vale a pena forçar o tema escuro por cima: o ponto
            desta aba é ver o documento COMO ELE É, para comparar com o
            canônico. */}
        <div ref={alvo} className="docx-host rounded bg-white text-black" />
      </Moldura>
    </>
  );
}

function XlsxViewer({ url }: { url: string }) {
  const { buffer, error } = useArrayBuffer(url);
  const [abas, setAbas] = useState<{ nome: string; html: string }[]>([]);
  const [ativa, setAtiva] = useState(0);
  const [falha, setFalha] = useState('');

  useEffect(() => {
    if (!buffer) return;
    let cancelado = false;
    void import('xlsx')
      .then((XLSX) => {
        const wb = XLSX.read(buffer, { type: 'array' });
        const paginas = wb.SheetNames.map((nome) => ({
          nome,
          html: XLSX.utils.sheet_to_html(wb.Sheets[nome]!, { id: `aba-${nome}` }),
        }));
        if (!cancelado) {
          setAbas(paginas);
          setAtiva(0);
        }
      })
      .catch((e) => !cancelado && setFalha(String(e?.message ?? e)));
    return () => {
      cancelado = true;
    };
  }, [buffer]);

  if (error) return <ErrorBox>Não consegui buscar o arquivo: {error}</ErrorBox>;
  if (falha) return <ErrorBox>Não consegui ler a planilha: {falha}</ErrorBox>;
  if (!buffer || abas.length === 0) return <Spinner label="Lendo a planilha…" />;

  return (
    <>
      {abas.length > 1 ? (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {abas.map((aba, indice) => (
            <button
              key={aba.nome}
              onClick={() => setAtiva(indice)}
              className={`rounded-lg border px-2.5 py-1 text-[12.5px] transition-colors ${
                indice === ativa
                  ? 'border-line bg-ink-800 font-semibold text-text'
                  : 'border-transparent text-text-muted hover:bg-ink-850'
              }`}
            >
              {aba.nome}
            </button>
          ))}
        </div>
      ) : null}
      <Moldura>
        <div
          className="planilha rounded bg-white p-2 text-black"
          dangerouslySetInnerHTML={{ __html: abas[ativa]?.html ?? '' }}
        />
      </Moldura>
    </>
  );
}

function ImageViewer({ url, filename }: { url: string; filename: string }) {
  return (
    <Moldura>
      <img src={url} alt={filename} className="mx-auto max-w-full rounded" />
    </Moldura>
  );
}

function TextViewer({ url, highlight }: { url: string; highlight?: string }) {
  const [texto, setTexto] = useState<string | null>(null);
  const [error, setError] = useState('');
  const alvo = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    let cancelado = false;
    fetch(url)
      .then((r) => r.text())
      .then((t) => !cancelado && setTexto(t))
      .catch((e) => !cancelado && setError(String(e?.message ?? e)));
    return () => {
      cancelado = true;
    };
  }, [url]);

  useEffect(() => {
    if (texto !== null && highlight && alvo.current) marcarTexto(alvo.current, highlight);
  }, [texto, highlight]);

  if (error) return <ErrorBox>Não consegui ler o arquivo: {error}</ErrorBox>;
  if (texto === null) return <Spinner label="Lendo o arquivo…" />;
  return (
    <Moldura>
      <pre ref={alvo} className="canonical p-1">
        {texto}
      </pre>
    </Moldura>
  );
}

/**
 * Marca no DOM já renderizado as palavras distintivas do trecho.
 *
 * O mesmo problema do visor de PDF, outro meio: o texto do canônico passou por
 * um extrator e o do documento vem do arquivo, então comparar frase inteira
 * nunca casa. Aqui dá para usar o DOM — percorre os nós de texto e envolve as
 * ocorrências em `<mark>`.
 */
function marcarTexto(raiz: HTMLElement, trecho: string) {
  const termos = trecho
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 6)
    .slice(0, 8);
  if (termos.length === 0) return;

  raiz.querySelectorAll('mark[data-kb]').forEach((m) => m.replaceWith(...m.childNodes));

  const alvo = new RegExp(`(${termos.map(escapeRe).join('|')})`, 'gi');
  const passeio = document.createTreeWalker(raiz, NodeFilter.SHOW_TEXT);
  const nos: Text[] = [];
  let atual = passeio.nextNode();
  while (atual) {
    if ((atual.textContent ?? '').trim()) nos.push(atual as Text);
    atual = passeio.nextNode();
  }

  let primeiro: HTMLElement | null = null;
  for (const no of nos) {
    const bruto = no.textContent ?? '';
    const semAcento = bruto.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (!alvo.test(semAcento)) continue;
    alvo.lastIndex = 0;

    const fragmento = document.createDocumentFragment();
    let cursor = 0;
    for (const achado of semAcento.matchAll(alvo)) {
      const inicio = achado.index ?? 0;
      fragmento.append(bruto.slice(cursor, inicio));
      const marca = document.createElement('mark');
      marca.dataset.kb = '1';
      marca.style.background = 'rgba(37, 99, 235, 0.32)';
      marca.style.color = 'inherit';
      marca.textContent = bruto.slice(inicio, inicio + achado[0].length);
      fragmento.append(marca);
      if (!primeiro) primeiro = marca;
      cursor = inicio + achado[0].length;
    }
    fragmento.append(bruto.slice(cursor));
    no.replaceWith(fragmento);
  }
  primeiro?.scrollIntoView({ block: 'center' });
}

function escapeRe(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function BotaoBaixar({ onClick }: { onClick: () => void }) {
  return (
    <Button onClick={onClick}>
      <Download size={14} /> Baixar
    </Button>
  );
}

export function SemArquivo() {
  return <Empty>Este documento não tem o arquivo original guardado.</Empty>;
}

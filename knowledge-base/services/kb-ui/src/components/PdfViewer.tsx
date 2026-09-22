import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Crosshair, Minus, Plus } from 'lucide-react';
import * as pdfjs from 'pdfjs-dist';
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';
import { Button, ErrorBox, Spinner } from './Ui';

// O worker do pdf.js sai do PRÓPRIO bundle. Buscá-lo de CDN quebraria a página
// em rede fechada e colocaria um terceiro no caminho de um documento interno.
//
// `?worker` e não `?url`: com `?url` o Vite emite o arquivo com a extensão
// original `.mjs`, que NÃO está no mime.types do nginx — ele sai como
// application/octet-stream e o navegador recusa executar um módulo ES com esse
// tipo ("Failed to fetch dynamically imported module"). Pior, o arquivo é
// servido com `immutable`, então quem baixou a resposta ruim continuava com ela
// mesmo depois do conserto no servidor. Com `?worker` o Vite empacota e emite
// um `.js` normal, com hash novo no nome — o problema deixa de existir em vez
// de depender de configuração de servidor e de cache limpo.
pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();

type Props = {
  /** URL do arquivo original. Vem autenticada via blob, não como href direto. */
  url: string;
  /** Página onde a evidência está, quando se sabe. */
  page?: number | null;
  /** Texto do trecho a destacar na camada de texto. */
  highlight?: string;
};

/** Normaliza para comparar: sem acento, sem pontuação, espaço colapsado.
 *
 *  O texto do canônico passou por um extrator; o da camada do PDF vem do
 *  próprio arquivo. Os dois raramente são idênticos byte a byte — comparar cru
 *  simplesmente nunca casa. */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** As palavras mais distintivas do trecho, para procurar na página.
 *
 *  Frase inteira não casa (o extrator reordena e junta linhas), e palavra
 *  comum casa em tudo. O meio útil são termos longos: eles são os que
 *  identificam o parágrafo. */
function keywords(text: string, limit = 12): string[] {
  const stop = new Set([
    'para',
    'como',
    'pelo',
    'pela',
    'dos',
    'das',
    'com',
    'que',
    'uma',
    'por',
    'nao',
    'sao',
    'ser',
    'seu',
    'sua',
    'ate',
    'mais',
    'esse',
    'essa',
    'este',
    'esta',
    'isso',
    'the',
    'and',
    'of',
  ]);
  const seen = new Set<string>();
  const words: string[] = [];
  for (const word of normalize(text).split(' ')) {
    if (word.length < 5 || stop.has(word) || seen.has(word)) continue;
    seen.add(word);
    words.push(word);
    if (words.length >= limit) break;
  }
  return words;
}

export function PdfViewer({ url, page, highlight }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const docRef = useRef<pdfjs.PDFDocumentProxy | null>(null);
  // Guarda a tarefa de render em curso: trocar de página rápido dispara duas, e
  // sem cancelar a primeira o canvas fica com a página errada.
  const renderRef = useRef<pdfjs.RenderTask | null>(null);

  const boxRef = useRef<HTMLDivElement | null>(null);

  const [total, setTotal] = useState(0);
  const [current, setCurrent] = useState(page && page > 0 ? page : 1);
  // `null` = ainda não medido; ajusta à largura do painel na primeira página.
  // Uma escala fixa fazia a página de A4 vazar o painel e empurrar a barra de
  // rolagem horizontal para a JANELA — em vez de rolar dentro do visor, a
  // aplicação inteira andava para o lado.
  const [scale, setScale] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hits, setHits] = useState(0);

  const terms = useMemo(() => (highlight ? keywords(highlight) : []), [highlight]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    const task = pdfjs.getDocument({ url, isEvalSupported: false });
    task.promise.then(
      (doc) => {
        if (cancelled) {
          void doc.destroy();
          return;
        }
        docRef.current = doc;
        setTotal(doc.numPages);
        setCurrent(page && page > 0 && page <= doc.numPages ? page : 1);
        setLoading(false);
      },
      (err) => {
        if (!cancelled) {
          setError(String(err?.message || err));
          setLoading(false);
        }
      },
    );
    return () => {
      cancelled = true;
      void task.destroy();
      docRef.current = null;
    };
  }, [url, page]);

  const draw = useCallback(async () => {
    const doc = docRef.current;
    const canvas = canvasRef.current;
    const layer = layerRef.current;
    if (!doc || !canvas || !layer) return;

    try {
      renderRef.current?.cancel();
    } catch {
      /* cancelar uma tarefa já concluída lança; não é erro nosso */
    }

    const pdfPage = await doc.getPage(current);

    // Mede uma vez, na primeira renderização, e deixa o operador ajustar depois.
    let escala = scale;
    if (escala === null) {
      const natural = pdfPage.getViewport({ scale: 1 }).width;
      const disponivel = (boxRef.current?.clientWidth ?? 0) - 24; // padding do box
      escala = disponivel > 120 ? Math.min(2, disponivel / natural) : 1.2;
      setScale(escala);
    }
    const viewport = pdfPage.getViewport({ scale: escala });
    // devicePixelRatio: sem isso o texto do PDF fica borrado em tela retina, o
    // que num visor de documento é exatamente o defeito que importa.
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    const task = pdfPage.render({ canvasContext: context, viewport });
    renderRef.current = task;
    try {
      await task.promise;
    } catch (err) {
      if ((err as { name?: string })?.name === 'RenderingCancelledException') return;
      throw err;
    }

    // ── destaque na camada de texto ──
    layer.innerHTML = '';
    layer.style.width = `${Math.floor(viewport.width)}px`;
    layer.style.height = `${Math.floor(viewport.height)}px`;
    if (terms.length === 0) {
      setHits(0);
      return;
    }

    const content = await pdfPage.getTextContent();
    let found = 0;
    for (const item of content.items) {
      const text = (item as { str?: string }).str ?? '';
      if (!text.trim()) continue;
      const normalized = normalize(text);
      if (!terms.some((term) => normalized.includes(term))) continue;

      const transform = (item as { transform: number[] }).transform;
      const width = (item as { width: number }).width * escala;
      const height = (item as { height: number }).height * escala;
      // A matriz do PDF tem origem embaixo; a da página, em cima.
      const x = transform[4] * escala;
      const y = viewport.height - transform[5] * escala - height;

      const mark = document.createElement('mark');
      mark.textContent = '';
      mark.style.position = 'absolute';
      mark.style.left = `${x}px`;
      mark.style.top = `${y - height * 0.15}px`;
      mark.style.width = `${Math.max(width, 4)}px`;
      mark.style.height = `${height * 1.35}px`;
      mark.style.background = 'rgba(37, 99, 235, 0.32)';
      mark.style.borderRadius = '2px';
      mark.style.pointerEvents = 'none';
      layer.appendChild(mark);
      found += 1;
    }
    setHits(found);
  }, [current, scale, terms]);

  useEffect(() => {
    if (loading || error) return;
    void draw().catch((err) => setError(String(err?.message || err)));
  }, [draw, loading, error]);

  if (loading) return <Spinner label="Abrindo o original…" />;
  if (error)
    return (
      <ErrorBox>
        Não consegui renderizar o PDF: {error}. O arquivo continua íntegro — use &quot;Baixar o
        original&quot;.
      </ErrorBox>
    );

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button onClick={() => setCurrent((p) => Math.max(1, p - 1))} disabled={current <= 1}>
          <ChevronLeft size={14} />
        </Button>
        <span className="mono min-w-[6.5rem] text-center text-[13px] text-text-muted">
          {current} / {total}
        </span>
        <Button
          onClick={() => setCurrent((p) => Math.min(total, p + 1))}
          disabled={current >= total}
        >
          <ChevronRight size={14} />
        </Button>

        {page && page > 0 ? (
          <Button onClick={() => setCurrent(page)} variant={current === page ? 'ghost' : 'primary'}>
            <Crosshair size={14} /> ir ao trecho (p. {page})
          </Button>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          <Button onClick={() => setScale((s) => Math.max(0.4, (s ?? 1) - 0.2))}>
            <Minus size={14} />
          </Button>
          <span className="mono w-12 text-center text-[12px] text-text-dim">
            {Math.round((scale ?? 1) * 100)}%
          </span>
          <Button onClick={() => setScale((s) => Math.min(3, (s ?? 1) + 0.2))}>
            <Plus size={14} />
          </Button>
        </div>
      </div>

      {terms.length > 0 ? (
        <p className="mb-2 text-[12px] text-text-dim">
          {hits > 0 ? (
            <>
              {hits} marca{hits > 1 ? 's' : ''} do trecho nesta página.
            </>
          ) : (
            <>
              Nada marcado nesta página. O trecho pode ter vindo de uma imagem (OCR) ou de outra
              página — o destaque depende da camada de texto do PDF.
            </>
          )}
        </p>
      ) : null}

      <div
        ref={boxRef}
        className="max-h-[var(--altura-conteudo,70vh)] min-w-0 overflow-auto rounded-lg border border-line bg-ink-950 p-3"
      >
        <div className="relative mx-auto" style={{ width: 'fit-content' }}>
          <canvas ref={canvasRef} className="block rounded" />
          <div ref={layerRef} className="pointer-events-none absolute left-0 top-0" />
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { api } from '../lib/api';
import { fmtBytes } from '../lib/format';
import { Empty, Pill } from './Ui';
import type { DocumentFigure } from '../lib/types';

/**
 * As imagens do documento com o texto que o OCR leu dentro delas.
 *
 * Esta tela existe por um motivo concreto: em manuais de processo a instrução
 * de verdade está no print de tela, não no parágrafo. Sem OCR esse conteúdo não
 * existia para a busca, e o documento aparecia indexado com a resposta certa
 * escondida numa imagem. Mostrar a imagem AO LADO do texto lido é o que permite
 * conferir se o OCR acertou — o texto sozinho seria uma afirmação sem prova.
 */
export function FigureGallery({
  documentId,
  figures,
}: {
  documentId: number;
  figures: DocumentFigure[];
}) {
  if (figures.length === 0) {
    return <Empty>Nenhuma imagem extraída deste documento.</Empty>;
  }
  const comTexto = figures.filter((f) => f.ocr_text.trim()).length;
  return (
    <>
      <p className="mb-3.5 text-[13px] text-text-muted">
        {figures.length === 1 ? '1 imagem extraída' : `${figures.length} imagens extraídas`},{' '}
        {comTexto} com texto legível pelo OCR. O texto abaixo de cada imagem entrou no canônico e é
        indexado como qualquer outro parágrafo.
      </p>
      <div className="grid max-h-[var(--altura-conteudo,62vh)] gap-3.5 overflow-y-auto pr-1">
        {figures.map((figura) => (
          <FigureCard key={figura.ref} documentId={documentId} figura={figura} />
        ))}
      </div>
    </>
  );
}

function FigureCard({ documentId, figura }: { documentId: number; figura: DocumentFigure }) {
  const [falhou, setFalhou] = useState(false);
  // A imagem é buscada com o bearer pelo interceptor do axios e servida como
  // blob: `<img src>` não manda header, então o caminho direto daria 401.
  const [src, setSrc] = useState('');

  useEffect(() => {
    if (!figura.has_image) return;
    let cancelado = false;
    let criado = '';
    api
      .get<Blob>(`/documents/${documentId}/figures/${figura.ref}/image`, { responseType: 'blob' })
      .then((response) => {
        if (cancelado) return;
        criado = URL.createObjectURL(response.data);
        setSrc(criado);
      })
      .catch(() => {
        if (!cancelado) setFalhou(true);
      });
    return () => {
      cancelado = true;
      // Sem revogar, cada figura aberta fica presa na memória da aba. Um
      // documento com 60 prints de tela custaria dezenas de MB por visita.
      if (criado) URL.revokeObjectURL(criado);
    };
  }, [documentId, figura.ref, figura.has_image]);

  return (
    <div className="grid gap-3 rounded-lg border border-line bg-ink-850 p-3 md:grid-cols-[minmax(0,22rem)_1fr]">
      <div className="grid min-h-[8rem] place-items-center overflow-hidden rounded border border-line bg-ink-950">
        {src ? (
          <img src={src} alt={figura.caption || `imagem ${figura.ref}`} className="max-h-72" />
        ) : falhou || !figura.has_image ? (
          <span className="flex items-center gap-2 p-4 text-[12px] text-text-dim">
            <ImageOff size={14} /> imagem não guardada
          </span>
        ) : (
          <span className="p-4 text-[12px] text-text-dim">carregando…</span>
        )}
      </div>
      <div className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <Pill>{figura.ref}</Pill>
          {figura.page ? <Pill>pág. {figura.page}</Pill> : null}
          {figura.ocr_text.trim() ? (
            <Pill tone="good">OCR</Pill>
          ) : (
            <Pill tone="warn">sem texto legível</Pill>
          )}
          {figura.bytes ? (
            <span className="mono text-[11px] text-text-dim">{fmtBytes(figura.bytes)}</span>
          ) : null}
        </div>
        {figura.caption ? (
          <p className="mb-1.5 text-[13px] font-semibold">{figura.caption}</p>
        ) : null}
        {figura.ocr_text.trim() ? (
          <pre className="canonical max-h-56 overflow-auto rounded border border-line bg-ink-900 p-2.5">
            {figura.ocr_text}
          </pre>
        ) : (
          <p className="text-[12.5px] text-text-dim">
            O OCR não achou texto aqui. Costuma ser foto, ícone ou diagrama sem rótulo — nesse caso
            não há nada a indexar mesmo.
          </p>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { kb } from './api';

/**
 * URL de blob para o arquivo original de um documento.
 *
 * Existe porque o endpoint do bruto exige `Authorization: Bearer`, e nem
 * `<img src>` nem o pdf.js mandam header. O arquivo vem por fetch autenticado,
 * vira um blob local e é ele que o visor consome.
 *
 * O `revokeObjectURL` na limpeza não é zelo: sem ele, cada documento aberto
 * deixa o arquivo inteiro preso na memória da aba — com PDFs de 18 MB, navegar
 * por dez documentos custa 180 MB que nunca voltam.
 */
export function useAuthedBlob(documentId: number | null, enabled: boolean) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!documentId || !enabled) {
      setUrl('');
      return;
    }
    let cancelled = false;
    let created = '';
    setError('');
    setUrl('');

    kb.raw(documentId).then(
      (blob) => {
        if (cancelled) return;
        created = URL.createObjectURL(blob);
        setUrl(created);
      },
      (err) => {
        if (!cancelled) setError((err as Error).message);
      },
    );

    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [documentId, enabled]);

  return { url, error };
}

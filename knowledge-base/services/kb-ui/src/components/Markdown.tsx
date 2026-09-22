import { useEffect, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { api } from '../lib/api';
import { type Bloco, type Inline, parse, refDaFigura } from '../lib/markdown';

/**
 * Desenha o canônico formatado.
 *
 * Monta ELEMENTOS a partir da árvore de `lib/markdown`. Em nenhum ponto uma
 * string do documento vira HTML — o conteúdo foi enviado por outra pessoa, e
 * `dangerouslySetInnerHTML` num visualizador de documento é o caminho curto
 * para XSS.
 */
export function Markdown({ md, documentId }: { md: string; documentId?: number }) {
  const blocos = parse(md);
  if (!blocos.length) {
    return <p className="px-1 py-6 text-center text-[13px] text-text-dim">(vazio)</p>;
  }
  return (
    <div className="markdown space-y-3 text-[13.5px] leading-relaxed">
      {blocos.map((bloco, i) => (
        <BlocoView key={i} bloco={bloco} documentId={documentId} />
      ))}
    </div>
  );
}

function BlocoView({ bloco, documentId }: { bloco: Bloco; documentId?: number }) {
  switch (bloco.t) {
    case 'pagina':
      // A marca de página vira separador visível, e não desaparece: é a
      // referência que a busca devolve ("página 7"), e sem ela o formatado
      // perderia a única âncora com o arquivo original.
      return (
        <div className="flex items-center gap-3 pt-2">
          <span className="mono rounded-full border border-line bg-ink-850 px-2 py-0.5 text-[10.5px] uppercase tracking-wider text-text-dim">
            página {bloco.numero}
          </span>
          <span className="h-px flex-1 bg-line" />
        </div>
      );

    case 'titulo': {
      const tamanhos = ['text-[19px]', 'text-[17px]', 'text-[15px]', 'text-[14px]'];
      const classe = tamanhos[Math.min(bloco.nivel, tamanhos.length) - 1];
      return (
        <p className={`${classe} pt-1 font-semibold text-text`}>
          <Pedacos itens={bloco.conteudo} documentId={documentId} />
        </p>
      );
    }

    case 'paragrafo':
      return (
        <p className="text-text-muted">
          <Pedacos itens={bloco.conteudo} documentId={documentId} />
        </p>
      );

    case 'lista': {
      const Tag = bloco.ordenada ? 'ol' : 'ul';
      return (
        <Tag
          className={`ml-5 space-y-1 text-text-muted ${bloco.ordenada ? 'list-decimal' : 'list-disc'}`}
        >
          {bloco.itens.map((item, i) => (
            <li key={i}>
              <Pedacos itens={item} documentId={documentId} />
            </li>
          ))}
        </Tag>
      );
    }

    case 'codigo':
      return (
        <pre className="overflow-x-auto rounded-lg border border-line bg-ink-950 p-3 text-[12px] text-text-muted">
          {bloco.valor}
        </pre>
      );

    case 'citacao':
      return (
        <blockquote className="border-l-2 border-line pl-3 text-text-muted italic">
          <Pedacos itens={bloco.conteudo} documentId={documentId} />
        </blockquote>
      );

    case 'regua':
      return <hr className="border-line" />;

    case 'imagem':
      return <Figura src={bloco.src} alt={bloco.alt} documentId={documentId} />;

    case 'tabela':
      // `overflow-x-auto` no container: tabela de contrato passa de dez colunas
      // e, sem isso, ela estica o painel inteiro e o texto ao lado some.
      return (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="bg-ink-850">
                {bloco.cabecalho.map((celula, i) => (
                  <th
                    key={i}
                    className="border-b border-line px-2.5 py-1.5 text-left font-semibold"
                  >
                    <Pedacos itens={celula} documentId={documentId} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bloco.linhas.map((linha, i) => (
                <tr key={i} className="border-b border-line last:border-0">
                  {linha.map((celula, j) => (
                    <td key={j} className="px-2.5 py-1.5 align-top text-text-muted">
                      <Pedacos itens={celula} documentId={documentId} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function Pedacos({ itens, documentId }: { itens: Inline[]; documentId?: number }) {
  return (
    <>
      {itens.map((pedaco, i) => {
        switch (pedaco.t) {
          case 'forte':
            return (
              <strong key={i} className="font-semibold text-text">
                {pedaco.valor}
              </strong>
            );
          case 'enfase':
            return <em key={i}>{pedaco.valor}</em>;
          case 'codigo':
            return (
              <code key={i} className="rounded bg-ink-850 px-1 py-0.5 text-[12px] text-text">
                {pedaco.valor}
              </code>
            );
          case 'link':
            return (
              <a
                key={i}
                href={pedaco.href}
                target="_blank"
                rel="noreferrer noopener"
                className="text-accent underline underline-offset-2"
              >
                {pedaco.texto}
              </a>
            );
          case 'imagem':
            return <Figura key={i} src={pedaco.src} alt={pedaco.alt} documentId={documentId} />;
          default:
            return <span key={i}>{pedaco.valor}</span>;
        }
      })}
    </>
  );
}

/**
 * Imagem do canônico.
 *
 * As figuras são servidas por uma rota que exige `Authorization: Bearer`, e
 * `<img src>` não manda header — apontar direto daria 401 e um ícone quebrado.
 * Então o arquivo vem por fetch autenticado e vira blob local.
 *
 * O `revokeObjectURL` na limpeza não é zelo: um manual de processo tem dezenas
 * de prints, e sem revogar cada visita deixa todos presos na memória da aba.
 */
function Figura({ src, alt, documentId }: { src: string; alt: string; documentId?: number }) {
  // Sem `documentId` não há rota autenticada a chamar: é o caso da wiki, cujas
  // páginas não têm figura própria. A imagem externa continua carregando
  // normal; a nossa cai no aviso em vez de pedir 401.
  const ref = documentId ? refDaFigura(src) : null;
  const [url, setUrl] = useState(ref ? '' : src);
  const [falhou, setFalhou] = useState(false);

  useEffect(() => {
    if (!ref) return;
    let cancelado = false;
    let criado = '';
    api
      .get<Blob>(`/documents/${documentId as number}/figures/${ref}/image`, {
        responseType: 'blob',
      })
      .then((resposta) => {
        if (cancelado) return;
        criado = URL.createObjectURL(resposta.data);
        setUrl(criado);
      })
      .catch(() => {
        if (!cancelado) setFalhou(true);
      });
    return () => {
      cancelado = true;
      if (criado) URL.revokeObjectURL(criado);
    };
  }, [documentId, ref]);

  if (falhou) {
    return (
      <span className="inline-flex items-center gap-2 rounded-lg border border-line bg-ink-850 px-3 py-2 text-[12px] text-text-dim">
        <ImageOff size={14} /> {alt || 'imagem'} não guardada
      </span>
    );
  }
  if (!url) {
    return (
      <span className="inline-block h-24 w-40 animate-pulse rounded-lg border border-line bg-ink-850" />
    );
  }
  return (
    <figure className="my-1">
      <img src={url} alt={alt} className="max-h-[26rem] rounded-lg border border-line bg-ink-950" />
      {alt ? <figcaption className="mt-1 text-[11.5px] text-text-dim">{alt}</figcaption> : null}
    </figure>
  );
}

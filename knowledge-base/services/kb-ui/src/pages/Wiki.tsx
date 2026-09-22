import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BookText, CircleAlert, Code2, Eye, FileText, Link2 } from 'lucide-react';
import { kb } from '../lib/api';
import { ExigeBase } from '../components/ExigeBase';
import { Markdown } from '../components/Markdown';
import { separarFrontmatter } from '../lib/markdown';
import { fmtWhen } from '../lib/format';
import {
  Card,
  ErrorBox,
  EstadoVazio,
  PageHeader,
  Pill,
  Spinner,
  selectClass,
} from '../components/Ui';

/**
 * A wiki destilada de um Espaço: índice, página e navegação.
 *
 * A busca resolve o **ponto de entrada** — ela acha a página. Daí em diante a
 * navegação é por referência cruzada, e é o agente (ou a pessoa) que anda. É o
 * default da especificação, e o motivo é bom: a página é atômica por contrato,
 * então navegar dali é mais simples e mais rastreável que delegar a uma
 * sub-LLM.
 *
 * O que esta tela precisa deixar claro, e a de busca também: **o conteúdo aqui
 * foi escrito por um modelo**. Ele deriva dos documentos, aponta para eles, e
 * não é o texto deles. Uma wiki que parecesse documento faria alguém citá-la
 * como fonte.
 */
export function WikiPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const space = params.get('espaco') ?? '';
  const pageParam = params.get('pagina');
  /** Formatado ou o arquivo como está. Preferência de leitura: fora da URL. */
  const [visao, setVisao] = useState<'formatado' | 'cru'>('formatado');

  const spacesQuery = useQuery({ queryKey: ['spaces'], queryFn: kb.spaces });
  const spaces = spacesQuery.data?.spaces ?? [];
  // Só os Espaços com a wiki ativa: oferecer os outros no combo levaria a uma
  // tela vazia sem dizer por quê.
  const comWiki = spaces.filter((s) => s.representations?.wiki);

  // Sem `?espaco=` a tela não adota a primeira base com wiki: a entrada é pelo
  // card do Espaço, e escolher sozinha mostrava a wiki de uma base que ninguém
  // pediu — numa ferramenta em que o Espaço é a fronteira de permissão.

  const indice = useQuery({
    queryKey: ['wiki', space],
    queryFn: () => kb.wikiIndex(space),
    enabled: !!space,
  });
  const pagina = useQuery({
    queryKey: ['wiki-page', pageParam],
    queryFn: () => kb.wikiPage(Number(pageParam)),
    enabled: !!pageParam,
  });

  const abrir = (id: number) =>
    setParams(new URLSearchParams({ espaco: space, pagina: String(id) }));

  if (spacesQuery.isLoading) return <Spinner label="Lendo as bases…" />;

  return (
    <>
      <PageHeader title="Wiki destilada">
        Páginas <strong>escritas por um modelo</strong> a partir dos documentos, em formato OKF.
        Cada uma é um conceito só e registra de quais documentos deriva — a fonte continua sendo o
        canônico, e é para lá que a citação deve apontar.
      </PageHeader>

      {comWiki.length === 0 ? (
        <Card className="px-5 py-4">
          <EstadoVazio icone={BookText} titulo="Nenhuma base com a wiki ligada">
            A wiki é uma representação opcional. Ligue em <strong>Bases</strong>, na configuração da
            base, e os próximos documentos passam a ser destilados.
          </EstadoVazio>
        </Card>
      ) : !space ? (
        <ExigeBase oQue="A wiki" />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <select
              className={`${selectClass} min-w-[14rem]`}
              value={space}
              onChange={(e) => setParams(new URLSearchParams({ espaco: e.target.value }))}
              aria-label="Espaço"
            >
              {comWiki.map((s) => (
                <option key={s.slug} value={s.slug}>
                  {s.label}
                </option>
              ))}
            </select>
            {indice.data ? (
              <span className="mono inline-flex items-center gap-1.5 text-[12px] text-text-dim">
                <BookText size={13} />
                {indice.data.pages.length} páginas
              </span>
            ) : null}
          </div>

          {indice.error ? <ErrorBox>{(indice.error as Error).message}</ErrorBox> : null}

          <div className="grid items-start gap-4 xl:grid-cols-[minmax(20rem,26rem)_1fr]">
            <Card className="min-w-0 overflow-hidden">
              {indice.isLoading ? (
                <Spinner />
              ) : (indice.data?.pages.length ?? 0) === 0 ? (
                <EstadoVazio icone={BookText} titulo="A wiki desta base está vazia">
                  A destilação acontece na ingestão. Envie um documento em{' '}
                  <strong>Documentos</strong>, ou reprocesse os que já existem para destilá-los.
                </EstadoVazio>
              ) : (
                <ul className="max-h-[72vh] overflow-y-auto">
                  {indice.data?.pages.map((p) => (
                    <li key={p.id}>
                      <button
                        onClick={() => abrir(p.id)}
                        className={`w-full border-b border-line-soft px-4 py-3 text-left transition-colors hover:bg-ink-850 ${
                          String(p.id) === pageParam ? 'bg-ink-800' : ''
                        }`}
                      >
                        <div className="mb-1 flex flex-wrap items-center gap-1.5">
                          <Pill>{p.type || '—'}</Pill>
                          <strong className="text-[13px]">{p.title || p.path}</strong>
                        </div>
                        <code className="mono block truncate text-[11.5px] text-text-dim">
                          {p.path}
                        </code>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11.5px] text-text-dim">
                          <span>{p.words} palavras</span>
                          <span>·</span>
                          <span>
                            {p.sources} fonte{p.sources === 1 ? '' : 's'}
                          </span>
                          {/* O contrato é 200 a 800 palavras. Fora da faixa a
                              página continua valendo — a marca é para o lint,
                              não recusa. */}
                          {p.out_of_contract ? (
                            <span className="inline-flex items-center gap-1 text-amber">
                              <CircleAlert size={11} /> fora do contrato
                            </span>
                          ) : null}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="min-w-0 px-5 py-4">
              {!pageParam ? (
                <EstadoVazio icone={BookText} titulo="Escolha uma página à esquerda">
                  O arquivo OKF inteiro aparece aqui, com as referências cruzadas e os documentos de
                  onde a página foi destilada.
                </EstadoVazio>
              ) : pagina.isLoading ? (
                <Spinner />
              ) : pagina.error ? (
                <ErrorBox>{(pagina.error as Error).message}</ErrorBox>
              ) : pagina.data ? (
                <>
                  <h2 className="break-words text-[15px] font-semibold leading-snug">
                    {pagina.data.title || pagina.data.path}
                  </h2>
                  <p className="mono mt-1 text-[11.5px] text-text-dim">{pagina.data.path}</p>
                  {pagina.data.description ? (
                    <p className="mt-1.5 text-[13px] text-text-muted">{pagina.data.description}</p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Pill>{pagina.data.type || '—'}</Pill>
                    <Pill tone="warn" title="o texto abaixo foi escrito por um modelo">
                      destilada
                    </Pill>
                    <span className="mono text-[11.5px] text-text-dim">
                      {pagina.data.words} palavras · {fmtWhen(pagina.data.updated_at)}
                    </span>
                  </div>

                  {/* As fontes vêm ANTES do conteúdo, e isso é deliberado: quem
                      lê precisa saber que está lendo uma síntese antes de ler a
                      síntese, não depois. */}
                  <div className="mt-3.5 rounded-lg border border-line bg-ink-950 p-3">
                    <p className="mb-2 text-[11px] uppercase tracking-wide text-text-dim">
                      Destilada de
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {pagina.data.sources.map((f) => (
                        <button
                          key={f.id}
                          onClick={() =>
                            navigate(`/documentos?espaco=${pagina.data!.space}&doc=${f.id}`)
                          }
                          className="inline-flex max-w-[22rem] items-center gap-1.5 rounded-lg border border-line bg-ink-800 px-2.5 py-1 text-[12px] text-text hover:border-ink-500"
                        >
                          <FileText size={12} className="shrink-0" />
                          <span className="truncate">{f.title?.trim() || f.filename}</span>
                        </button>
                      ))}
                      {pagina.data.sources.length === 0 ? (
                        <span className="text-[12px] text-amber">
                          nenhuma fonte registrada — a página ficou órfã e é candidata ao lint
                        </span>
                      ) : null}
                    </div>
                  </div>

                  {pagina.data.references.length > 0 ? (
                    <div className="mt-3 rounded-lg border border-line bg-ink-950 p-3">
                      <p className="mb-2 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-text-dim">
                        <Link2 size={12} /> Referências cruzadas
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {pagina.data.references.map((r) => (
                          <button
                            key={r.id}
                            onClick={() => abrir(r.id)}
                            className="max-w-[20rem] truncate rounded-lg border border-line bg-ink-800 px-2.5 py-1 text-[12px] text-text hover:border-ink-500"
                          >
                            {r.title || r.path}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div className="mb-1.5 mt-3.5 flex flex-wrap items-center gap-2">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-text-dim">
                      arquivo OKF
                    </div>
                    <div className="ml-auto inline-flex overflow-hidden rounded-lg border border-line">
                      {(['formatado', 'cru'] as const).map((modo) => (
                        <button
                          key={modo}
                          type="button"
                          onClick={() => setVisao(modo)}
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[12px] transition-colors ${
                            visao === modo
                              ? 'bg-ink-800 text-text'
                              : 'bg-ink-850 text-text-dim hover:text-text'
                          }`}
                        >
                          {modo === 'formatado' ? <Eye size={13} /> : <Code2 size={13} />}
                          {modo === 'formatado' ? 'Formatado' : 'Arquivo'}
                        </button>
                      ))}
                    </div>
                  </div>
                  {visao === 'formatado' ? (
                    <PaginaFormatada conteudo={pagina.data.content} />
                  ) : (
                    <pre className="canonical max-h-[52vh] overflow-auto rounded-lg border border-line bg-ink-850 p-3.5">
                      {pagina.data.content}
                    </pre>
                  )}
                </>
              ) : null}
            </Card>
          </div>
        </>
      )}
    </>
  );
}

/**
 * A página OKF formatada: metadado em cima, prosa embaixo.
 *
 * O frontmatter fica CRU de propósito. Ele é estrutura — `type`, `status`,
 * `trust`, os links —, e formatá-lo como prosa transformaria chave e valor
 * numa frase, perdendo exatamente a forma que o torna útil.
 */
function PaginaFormatada({ conteudo }: { conteudo: string }) {
  const { frontmatter, corpo } = separarFrontmatter(conteudo);
  return (
    <div className="max-h-[52vh] overflow-auto rounded-lg border border-line bg-ink-850 p-4">
      {frontmatter ? (
        <pre className="canonical mb-4 overflow-x-auto rounded-lg border border-line bg-ink-950 p-3 text-[11.5px] text-text-dim">
          {frontmatter}
        </pre>
      ) : null}
      <Markdown md={corpo} />
    </div>
  );
}

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Boxes,
  Database,
  HardDrive,
  Network,
  Plug,
  ScanText,
  Scissors,
  ShieldCheck,
  Timer,
} from 'lucide-react';
import { kb } from '../lib/api';
import { env } from '../lib/env';
import { fmtBytes, fmtNumber } from '../lib/format';
import {
  Card,
  Empty,
  ErrorBox,
  Metric,
  Metrics,
  PageHeader,
  Pill,
  Spinner,
} from '../components/Ui';
import type { StackInfo } from '../lib/types';
import pkg from '../../package.json';

function uptime(segundos: number): string {
  if (segundos < 60) return `${segundos}s`;
  const minutos = Math.floor(segundos / 60);
  if (minutos < 60) return `${minutos}min`;
  const horas = Math.floor(minutos / 60);
  const resto = minutos % 60;
  if (horas < 24) return resto ? `${horas}h ${resto}min` : `${horas}h`;
  const dias = Math.floor(horas / 24);
  return `${dias}d ${horas % 24}h`;
}

export function StackPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['stack'],
    queryFn: kb.stack,
    refetchInterval: 30_000,
  });

  if (isLoading) return <Spinner label="Medindo a instalação…" />;
  if (error) return <ErrorBox>{(error as Error).message}</ErrorBox>;
  if (!data) return null;

  return (
    <>
      <PageHeader title="Stack">
        O que está rodando e quanto tem dentro, medido agora. Não é a tela de saúde: aquela responde
        “está de pé?” e serve à sonda do cluster. Esta responde “o que exatamente está rodando aqui,
        com quantos vetores, quantos arquivos e que tamanho de grafo” — a pergunta de quem vai
        mostrar o sistema ou decidir se ele aguenta a próxima base.
      </PageHeader>

      <ResumoNumeros data={data} />
      <Armazenamento data={data} />
      <Pipeline data={data} />
      <Busca data={data} />
      <Mcp />
      <Bibliotecas data={data} />
    </>
  );
}

function Mcp() {
  return (
    <Secao
      titulo="Superfície MCP"
      icone={Plug}
      descricao="A mesma busca que esta interface faz, exposta como ferramenta para os agentes de IA. Devolve evidência com score, nunca resposta gerada — quem redige a resposta é o modelo do editor, com a fonte à vista."
    >
      <Linhas
        itens={[
          ['Endpoint', <code key="e">POST {env.mcpUrl()}</code>],
          [
            'Ferramentas',
            <span key="t" className="flex flex-wrap gap-1.5">
              <Pill>search</Pill>
              <Pill>fetch</Pill>
              <Pill>list_spaces</Pill>
            </span>,
          ],
        ]}
      />
    </Secao>
  );
}

function Secao({
  titulo,
  icone: Icone,
  children,
  descricao,
}: {
  titulo: string;
  icone: typeof Database;
  children: React.ReactNode;
  descricao?: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <h2 className="mb-1 flex items-center gap-2 text-[15px] font-semibold">
        <Icone size={15} /> {titulo}
      </h2>
      {descricao ? <p className="mb-3 max-w-3xl text-[13px] text-text-muted">{descricao}</p> : null}
      {children}
    </section>
  );
}

/** Tabela de chave/valor — o formato que mais aparece nesta tela. */
function Linhas({ itens }: { itens: [string, React.ReactNode][] }) {
  return (
    <Card className="overflow-hidden">
      <table className="w-full text-[13px]">
        <tbody>
          {itens.map(([chave, valor]) => (
            <tr key={chave} className="border-b border-line-soft last:border-0">
              <td className="w-[17rem] px-5 py-2.5 font-semibold">{chave}</td>
              <td className="px-5 py-2.5">{valor}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function ResumoNumeros({ data }: { data: StackInfo }) {
  const c = data.postgres.counts;
  return (
    <Card className="mb-6 px-5 py-4">
      <Metrics>
        <Metric value={c ? fmtNumber(c.embeddings) : '—'} label="vetores" />
        <Metric value={c ? fmtNumber(c.child_chunks) : '—'} label="trechos" />
        <Metric value={c ? fmtNumber(c.documents) : '—'} label="documentos" />
        <Metric value={c ? fmtNumber(c.pages) : '—'} label="páginas" />
        <Metric value={c ? fmtNumber(c.figures) : '—'} label="imagens" />
        <Metric value={fmtNumber(data.object_store.objects)} label="arquivos" />
        <Metric value={fmtNumber(data.graph.terms)} label="termos no grafo" />
        <Metric value={c ? fmtNumber(c.search_runs) : '—'} label="buscas" />
      </Metrics>
      <p className="mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line-soft pt-3 text-[12px] text-text-dim">
        <span className="flex items-center gap-1.5">
          <Timer size={12} /> no ar há {uptime(data.service.uptime_seconds)}
        </span>
        <span>·</span>
        <span>
          ambiente <code>{data.env}</code>
        </span>
        <span>·</span>
        <span className="flex items-center gap-1.5">
          <ShieldCheck size={12} />
          {data.auth.mode === 'keycloak' ? 'autenticação por Identity' : 'autenticação desligada'}
        </span>
        {data.auth.issuer ? (
          <>
            <span>·</span>
            <code className="text-[11px]">{data.auth.issuer}</code>
          </>
        ) : null}
      </p>
    </Card>
  );
}

function Armazenamento({ data }: { data: StackInfo }) {
  const pg = data.postgres;
  const c = pg.counts;
  const cobertura = pg.page_coverage;
  const modelos = Object.entries(pg.embedding_models ?? {});

  return (
    <>
      <Secao
        titulo="Postgres + pgvector"
        icone={Database}
        descricao="Índice único: o vetor e o texto na mesma transação, com o escopo de Espaço por trecho. É o que evita dois bancos que discordam."
      >
        {!pg.reachable ? (
          <ErrorBox>Postgres inacessível: {pg.error}</ErrorBox>
        ) : (
          <Linhas
            itens={[
              [
                'Versão',
                <span key="v" className="flex flex-wrap items-center gap-2">
                  <code>{pg.version}</code>
                  {Object.entries(pg.extensions ?? {}).map(([nome, versao]) => (
                    <Pill key={nome}>
                      {nome} {versao}
                    </Pill>
                  ))}
                </span>,
              ],
              [
                'Vetores',
                <span key="e" className="flex flex-wrap items-center gap-2">
                  <strong className="tabular-nums">{fmtNumber(c?.embeddings)}</strong>
                  <span className="text-text-muted">
                    de {data.search.embedding_dim} dimensões, distância cosseno
                  </span>
                  {modelos.length > 1 ? (
                    // Índice misto é um defeito silencioso: a busca passa a
                    // comparar vetores de modelos diferentes, e o resultado
                    // fica pior sem nenhum erro aparecer.
                    <Pill tone="bad">{modelos.length} modelos no índice — reindexe</Pill>
                  ) : null}
                </span>,
              ],
              [
                'Modelo de embedding',
                <span key="m" className="flex flex-wrap gap-2">
                  {modelos.length === 0 ? (
                    <span className="text-text-dim">nenhum vetor gravado</span>
                  ) : (
                    modelos.map(([nome, quantidade]) => (
                      <Pill key={nome}>
                        <code>{nome}</code> · {fmtNumber(quantidade)}
                      </Pill>
                    ))
                  )}
                </span>,
              ],
              [
                'Trechos',
                <span key="c" className="text-text-muted">
                  <strong className="text-text">{fmtNumber(c?.child_chunks)}</strong> filhos (o que
                  a busca casa) e{' '}
                  <strong className="text-text">{fmtNumber(c?.parent_chunks)}</strong> pais (o que é
                  entregue)
                </span>,
              ],
              [
                'Documentos',
                <span key="d" className="flex flex-wrap items-center gap-2 text-text-muted">
                  <strong className="text-text">{fmtNumber(c?.documents)}</strong> ativos em{' '}
                  <strong className="text-text">{c?.spaces}</strong> Espaços
                  {c?.failed_documents ? (
                    <Pill tone="warn">{c.failed_documents} com falha de extração</Pill>
                  ) : null}
                </span>,
              ],
              [
                'Página do trecho',
                cobertura?.total ? (
                  <span key="p" className="flex flex-wrap items-center gap-2">
                    <Pill tone={cobertura.pct && cobertura.pct >= 99 ? 'good' : 'warn'}>
                      {cobertura.pct}%
                    </Pill>
                    <span className="text-text-muted">
                      {fmtNumber(cobertura.with_page)} de {fmtNumber(cobertura.total)} trechos de
                      documento paginado sabem em que página estão — é o que faz o “ir ao trecho no
                      original” funcionar
                    </span>
                  </span>
                ) : (
                  <span className="text-text-dim">nenhum documento paginado</span>
                ),
              ],
              ['Vínculos de permissão', <span key="g">{fmtNumber(c?.grants)}</span>],
              [
                'Tamanho em disco',
                <span key="s" className="flex flex-wrap items-center gap-2">
                  <strong>{fmtBytes(pg.database_bytes)}</strong>
                  <span className="text-text-dim">
                    maiores tabelas:{' '}
                    {Object.entries(pg.table_bytes ?? {})
                      .slice(0, 4)
                      .map(([nome, bytes]) => `${nome} ${fmtBytes(bytes)}`)
                      .join(' · ')}
                  </span>
                </span>,
              ],
            ]}
          />
        )}
      </Secao>

      <Secao
        titulo="Object store (o bruto imutável)"
        icone={HardDrive}
        descricao="O arquivo como entrou, nunca reescrito. É o que permite auditar o canônico contra a fonte e reprocessar com outra técnica sem pedir o arquivo de novo."
      >
        {!data.object_store.reachable ? (
          <ErrorBox>Object store inacessível: {data.object_store.error}</ErrorBox>
        ) : (
          <Linhas
            itens={[
              ['Endpoint', <code key="e">{data.object_store.endpoint}</code>],
              ['Bucket', <code key="b">{data.object_store.bucket}</code>],
              [
                'Conteúdo',
                <span key="c" className="flex flex-wrap items-center gap-2">
                  <strong className="tabular-nums">{fmtNumber(data.object_store.objects)}</strong>{' '}
                  objetos · <strong>{fmtBytes(data.object_store.bytes)}</strong>
                  <span className="text-text-dim">
                    (documentos brutos + as imagens extraídas de cada um)
                  </span>
                </span>,
              ],
            ]}
          />
        )}
      </Secao>

      <Secao
        titulo="Grafo de termos (Memgraph)"
        icone={Network}
        descricao="Representação auxiliar: liga documentos que compartilham termos, e é o que alimenta os “relacionados” na tela de documento. Derivado — some e é reconstruído na ingestão."
      >
        {!data.graph.reachable ? (
          data.graph.enabled ? (
            <ErrorBox>Memgraph inacessível: {data.graph.error ?? 'sem detalhe'}</ErrorBox>
          ) : (
            <Card className="px-5">
              <Empty>Grafo desligado nesta instalação.</Empty>
            </Card>
          )
        ) : (
          <Linhas
            itens={[
              [
                'Endereço',
                <span key="h" className="flex items-center gap-2">
                  <code>{data.graph.host}</code>
                  {data.graph.version ? <Pill>{data.graph.version}</Pill> : null}
                </span>,
              ],
              [
                'Nós',
                <span key="n" className="text-text-muted">
                  <strong className="text-text">{fmtNumber(data.graph.documents)}</strong>{' '}
                  documentos e <strong className="text-text">{fmtNumber(data.graph.terms)}</strong>{' '}
                  termos
                </span>,
              ],
              [
                'Arestas',
                <span key="a" className="text-text-muted">
                  <strong className="text-text">{fmtNumber(data.graph.edges)}</strong>{' '}
                  <code>MENTIONS</code> (documento → termo)
                </span>,
              ],
            ]}
          />
        )}
      </Secao>
    </>
  );
}

function Pipeline({ data }: { data: StackInfo }) {
  const p = data.pipeline;
  const c = data.postgres.counts;
  return (
    <Secao
      titulo="Pipeline de ingestão"
      icone={ScanText}
      descricao="Do arquivo bruto ao trecho indexado. Mais de uma técnica de extração fica disponível de propósito: qual ganhou é gravado por documento, para dar para comparar depois."
    >
      <Linhas
        itens={[
          [
            'Extratores',
            <span key="e" className="flex flex-wrap gap-1.5">
              {p.extractors.map((nome) => (
                <Pill key={nome}>{nome}</Pill>
              ))}
            </span>,
          ],
          [
            'OCR',
            p.ocr.enabled ? (
              <span key="o" className="flex flex-wrap items-center gap-2">
                <Pill tone="good">ligado</Pill>
                <code>{p.ocr.engine}</code>
                <span className="text-text-muted">
                  idiomas {p.ocr.languages.join('+')} · psm {p.ocr.psm} ·{' '}
                  {p.ocr.force_full_page
                    ? 'forçado em toda página'
                    : 'só onde não há camada de texto'}
                </span>
              </span>
            ) : (
              <Pill tone="warn">desligado</Pill>
            ),
          ],
          [
            'Imagens extraídas',
            p.figures.enabled ? (
              <span key="f" className="flex flex-wrap items-center gap-2 text-text-muted">
                <strong className="text-text">{fmtNumber(c?.figures)}</strong> guardadas,{' '}
                <strong className="text-text">{fmtNumber(c?.figures_with_ocr)}</strong> com texto
                legível
                <span className="text-text-dim">
                  · escala {p.figures.scale}× · até {p.figures.max_per_document} por documento
                </span>
              </span>
            ) : (
              <Pill tone="warn">desligado</Pill>
            ),
          ],
          [
            'Chunking',
            <span key="c" className="flex flex-wrap items-center gap-2">
              <code>{p.chunking.technique}</code>
              <span className="text-text-muted">
                filho {p.chunking.child_chars} caracteres (sobreposição {p.chunking.child_overlap}),
                pai {p.chunking.parent_chars} — o padrão de quem não escolheu
              </span>
            </span>,
          ],
          [
            'Motores disponíveis',
            <span key="me" className="flex flex-wrap items-center gap-1.5">
              {(p.chunking.engines ?? []).map((motor) => (
                <Pill key={motor} tone={motor === p.chunking.default_engine ? 'good' : 'neutral'}>
                  {motor}
                  {motor === p.chunking.default_engine ? ' · padrão' : ''}
                </Pill>
              ))}
              <span className="text-text-muted">
                escolhidos <strong className="text-text">por base</strong>, em{' '}
                <Link to="/bases">Bases</Link> — porque manual com seção e ata em texto corrido não
                pedem o mesmo corte
              </span>
            </span>,
          ],
          [
            'Representações',
            <span key="fe" className="flex flex-wrap items-center gap-1.5">
              {(p.chunking.representations ?? []).map((r) => (
                <Pill key={r} tone={r === 'indice' ? 'good' : 'neutral'}>
                  {r}
                  {r === 'indice' ? ' · sempre' : ''}
                </Pill>
              ))}
              {(p.chunking.auxiliaries ?? []).map((a) => (
                <Pill key={a}>{a} · auxiliar</Pill>
              ))}
              {/* Sem provedor de chat o formato existe mas só metade dele
                  funciona: reconhece bundle já escrito e não deriva nada. Isso
                  precisa aparecer no diagnóstico, senão vira "liguei e não fez
                  nada" sem causa visível. */}
              <Pill tone={p.chunking.okf_chat_provider ? 'good' : 'warn'}>
                {p.chunking.okf_chat_provider ? 'provedor de chat pronto' : 'sem provedor de chat'}
              </Pill>
              <span className="text-text-muted">
                ativadas <strong className="text-text">por base</strong>. O índice existe em todo
                Espaço; a wiki é ligável. O grafo não é representação: é estrutura auxiliar do
                índice, que abre a travessia sem criar conteúdo novo. A wiki e o grafo precisam de
                um modelo de <code>chat</code>
              </span>
            </span>,
          ],
        ]}
      />
    </Secao>
  );
}

function Busca({ data }: { data: StackInfo }) {
  const s = data.search;
  return (
    <Secao
      titulo="Busca"
      icone={Scissors}
      descricao="Híbrida em dois braços independentes, fundidos por posição. Nenhum dos dois sozinho resolve: o vetorial perde sigla e código de documento, o lexical perde sinônimo."
    >
      <Linhas
        itens={[
          ['Braço vetorial', <code key="v">{s.vector}</code>],
          ['Braço lexical', <code key="l">{s.lexical}</code>],
          [
            'Fusão',
            <span key="f" className="flex flex-wrap items-center gap-2">
              <code>{s.fusion}</code>
              <span className="text-text-muted">
                pool de {s.candidate_pool} candidatos por braço, {s.default_top_k} devolvidos por
                padrão
              </span>
            </span>,
          ],
          [
            'Entrega',
            <span key="e" className="text-text-muted">
              o filho casa, o <strong className="text-text">pai</strong> é entregue — a evidência
              chega com contexto em volta, não como frase solta
            </span>,
          ],
        ]}
      />
    </Secao>
  );
}

/** Bibliotecas do serviço, agrupadas pela camada em que entram.
 *
 *  A versão sozinha não explica nada: a pergunta útil não é "que versão do
 *  docling", é "o que quebra se o docling sair". Por isso cada linha diz a
 *  função e o arquivo — neste projeto, a diferença entre uma extração boa e uma
 *  ruim já foi literalmente uma versão de biblioteca. */
function Bibliotecas({ data }: { data: StackInfo }) {
  const libs = data.libraries ?? [];
  const camadas = [...new Set(libs.map((l) => l.layer))];

  return (
    <Secao
      titulo="Bibliotecas, e onde cada uma entra"
      icone={Boxes}
      descricao="Cada peça com a versão que está rodando agora, a função que exerce e o arquivo onde ela é chamada. Ausente significa que o pacote não está na imagem — e o caminho que dependia dele cai no fallback."
    >
      {libs.length === 0 ? (
        <Card className="px-5">
          <Empty>Esta instalação ainda não reporta as bibliotecas.</Empty>
        </Card>
      ) : (
        camadas.map((camada) => (
          <Card key={camada} className="mb-3 overflow-hidden">
            <div className="border-b border-line-soft bg-ink-950 px-5 py-2 text-[12px] font-semibold uppercase tracking-wide text-text-dim">
              {camada}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-[13px]">
                <tbody>
                  {libs
                    .filter((l) => l.layer === camada)
                    .map((lib) => (
                      <tr
                        key={lib.name}
                        className="border-b border-line-soft last:border-0 align-top"
                      >
                        <td className="w-[12rem] px-5 py-2.5">
                          <code className="text-text">{lib.name}</code>
                        </td>
                        <td className="w-[7rem] px-2 py-2.5">
                          <Pill tone={lib.version === 'ausente' ? 'warn' : 'neutral'}>
                            {lib.version}
                          </Pill>
                        </td>
                        <td className="px-2 py-2.5 text-text-muted">{lib.role}</td>
                        <td className="w-[15rem] px-5 py-2.5 text-right">
                          <code className="text-[11.5px] text-text-dim">{lib.module}</code>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Card>
        ))
      )}

      <Card className="overflow-hidden">
        <div className="border-b border-line-soft bg-ink-950 px-5 py-2 text-[12px] font-semibold uppercase tracking-wide text-text-dim">
          Interface (esta tela)
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] text-[13px]">
            <tbody>
              {LIBS_UI.map((lib) => (
                <tr key={lib.nome} className="border-b border-line-soft last:border-0 align-top">
                  <td className="w-[12rem] px-5 py-2.5">
                    <code className="text-text">{lib.nome}</code>
                  </td>
                  <td className="w-[7rem] px-2 py-2.5">
                    <Pill>{versaoUi(lib.nome)}</Pill>
                  </td>
                  <td className="px-2 py-2.5 text-text-muted">{lib.papel}</td>
                  <td className="w-[15rem] px-5 py-2.5 text-right">
                    <code className="text-[11.5px] text-text-dim">{lib.onde}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </Secao>
  );
}

/** A versão vem do package.json em tempo de build: escrever à mão aqui é
 *  garantia de ficar desatualizado na primeira atualização de dependência. */
function versaoUi(nome: string): string {
  const declarada = (pkg.dependencies as Record<string, string>)[nome];
  return declarada ? declarada.replace(/^[\^~]/, '') : 'ausente';
}

const LIBS_UI: { nome: string; papel: string; onde: string }[] = [
  { nome: 'react', papel: 'a interface inteira', onde: 'services/kb-ui/src' },
  {
    nome: 'react-router-dom',
    papel: 'as rotas do menu lateral — e o motivo de a tela do MCP ser /conectar, não /mcp',
    onde: 'src/App.tsx',
  },
  {
    nome: '@tanstack/react-query',
    papel: 'cache e revalidação de tudo o que vem do kb-api',
    onde: 'src/lib/api.ts',
  },
  {
    nome: 'axios',
    papel: 'as chamadas HTTP, com o Bearer injetado num interceptor',
    onde: 'src/lib/api.ts',
  },
  {
    nome: 'keycloak-js',
    papel: 'login OIDC com PKCE no Identity corporativo e renovação silenciosa',
    onde: 'src/lib/auth.ts',
  },
  {
    nome: 'pdfjs-dist',
    papel: 'visualiza o PDF original e pula para a página do trecho',
    onde: 'src/components/FileViewer',
  },
  {
    nome: 'docx-preview',
    papel: 'visualiza o .docx original com a formatação',
    onde: 'src/components/FileViewer',
  },
  { nome: 'xlsx', papel: 'visualiza a planilha original', onde: 'src/components/FileViewer' },
  { nome: 'lucide-react', papel: 'os ícones', onde: 'src/components' },
];

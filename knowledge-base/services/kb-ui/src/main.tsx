import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { initAuth } from './lib/auth';
import './styles.css';

/**
 * Prefixo em que a SPA esta publicada, lido do `<base href>`.
 *
 * A MESMA imagem sobe em tres lugares com prefixos diferentes: `/` no k3d
 * local, `/knowledge-base` atras do ingress de dev. O `vite base: ''` ja
 * resolve os ASSETS (caminhos relativos casam com o `<base href>`), mas o
 * react-router nao le a tag `<base>` -- sem `basename` ele monta as rotas na
 * raiz do dominio e um clique em "Documentos" iria para
 * `<host-do-cluster>/documentos`, fora da aplicacao.
 *
 * O ingress reescreve o `<base href>` por sub_filter (ver o overlay de gitops),
 * entao ler daqui mantem a imagem unica e sem variavel de build.
 */
function basePath(): string {
  const href = document.querySelector('base')?.getAttribute('href') ?? '/';
  // `new URL` normaliza tanto href relativo quanto absoluto.
  const caminho = new URL(href, window.location.origin).pathname;
  const semBarra = caminho.replace(/\/+$/, '');
  return semBarra === '' ? '/' : semBarra;
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 10_000, refetchOnWindowFocus: false } },
});

const root = ReactDOM.createRoot(document.getElementById('root')!);

// O login resolve ANTES de renderizar: a UI inteira depende de um token para
// qualquer chamada, e montar a arvore primeiro so produziria uma tela cheia de
// 401 enquanto o redirect do Keycloak acontece.
void initAuth().then((result) => {
  if (!result.ok) {
    root.render(
      <div className="mx-auto mt-24 max-w-md px-6">
        <h2 className="text-lg font-semibold">Falha de autenticação</h2>
        <p className="mt-2 text-sm text-text-muted">{result.reason ?? 'verifique o Identity'}.</p>
        <button
          onClick={() => window.location.reload()}
          className="mt-4 rounded-lg bg-accent px-3 py-2 text-[13px] font-semibold text-ink-950"
        >
          Tentar novamente
        </button>
      </div>,
    );
    return;
  }
  root.render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter basename={basePath()}>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </React.StrictMode>,
  );
});

import { defineConfig, loadEnv } from 'vite';
import type { Plugin } from 'vite';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// env.js no dev-server: le public/env.template.js e troca ${VAR} pelo valor do
// ambiente (VITE_ removido, para casar com as chaves do template). Espelha o
// envsubst que o nginx faz em producao -- assim nao existe uma lista de
// variaveis para manter em dois lugares. Mesmo arranjo do agentic-sdlc.
function envDevPlugin(mode: string): Plugin {
  return {
    name: 'env-dev-plugin',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/env.js') return next();
        const env = loadEnv(mode, process.cwd(), '');
        const template = readFileSync(resolve(process.cwd(), 'public/env.template.js'), 'utf-8');
        const body = template.replace(
          /\$\{([^}]+)\}/g,
          (_, key) => env[`VITE_${key}`] ?? env[key] ?? '',
        );
        res.setHeader('Content-Type', 'application/javascript');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(body);
      });
    },
  };
}

// Origem unica: a UI e a API saem pelo MESMO host. O cliente chama a API por
// caminho relativo e quem encaminha e o Vite no dev / o nginx em pe. Resultado:
// nada de CORS e nada de host fixo no bundle -- funciona igual em
// http://localhost:3010 e em http://localhost:8890.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_API_PROXY_TARGET ?? 'http://localhost:8890';

  return {
    base: '',
    plugins: [react(), tailwindcss(), envDevPlugin(mode)],
    server: {
      host: '0.0.0.0',
      port: 3010,
      strictPort: true,
      allowedHosts: true,
      // Só a API entra no proxy. O login vai direto para o Keycloak do Goga
      // (kc.localtest.me:8481) -- o client `kb-ui` tem webOrigins `+`, que
      // libera as origens já declaradas em redirectUris. O dev-server em
      // localhost:3010 NÃO está entre elas: para rodar `npm run dev` contra o
      // cluster, acrescente `http://localhost:3010/*` às redirectUris do
      // client, no realm. Sem isso o login volta com `invalid_redirect_uri`.
      proxy: {
        '/v1': { target: apiTarget, changeOrigin: true },
        '/mcp': { target: apiTarget, changeOrigin: true },
      },
    },
    preview: { host: '0.0.0.0', port: 3010, strictPort: true, allowedHosts: true },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    },
  };
});

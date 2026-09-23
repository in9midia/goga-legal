# Goga Legal

| Pasta | O quê |
|---|---|
| [knowledge-base/](knowledge-base/README.md) | a KB: FastAPI + React, roda no cluster k3d local |
| [studio/](studio/README.md) | o Studio: `api/` (Fastify) e `ui/` (Vite) |
| [planning/](planning/) | o plano do MVP |

## Rodar em desenvolvimento

São três processos: a KB no cluster, e a API e a UI do Studio rodando na máquina, cada um
no seu terminal. Todos os comandos partem da raiz do repositório.

```
Navegador → localhost:5173 (studio/ui, Vite)
                 └─ /api/* → proxy → localhost:8787 (studio/api)
                                          └─ KB_URL → localhost:8890 (KB no k3d)
```

### 1. KB (cluster k3d)

```bash
cp .env.example .env            # chaves DeepSeek/Gemini e senha do admin
./start-k8s-local.sh            # sobe a KB (auth desligada); também faz deploy do Studio no cluster
./start-k8s-local.sh populate   # só na primeira vez: popula a KB (exige as duas chaves)
```

A KB fica em `http://localhost:8890`. Para pausar o cluster sem perder dados, rode
`./start-k8s-local.sh stop`. Ciclo de desenvolvimento da própria KB (`sync ui`, `sync api`,
`logs`): [knowledge-base/docs/desenvolvimento.md](knowledge-base/docs/desenvolvimento.md).

### 2. Studio API (`:8787`)

```bash
docker compose -f studio/docker-compose.dev.yml up -d   # Postgres do Studio na porta 5442
cp studio/api/.env.example studio/api/.env              # só na primeira vez
npm --prefix studio/api install                         # só na primeira vez
npm --prefix studio/api run dev
```

No `studio/api/.env`, preencha `STUDIO_SECRET_KEY` e `STUDIO_ADMIN_PASSWORD`. O `KB_URL` já
aponta para `http://localhost:8890`. A API migra e semeia o banco no boot e recarrega sozinha
quando o código muda (`tsx watch`).

### 3. Studio UI (`:5173`)

```bash
npm --prefix studio/ui install   # só na primeira vez
npm --prefix studio/ui run dev
```

Abra `http://localhost:5173`. A UI só serve o front-end e manda `/api` para a `:8787` por
proxy (`studio/ui/vite.config.ts`), então a API precisa estar de pé.

### Parar e reiniciar

`Ctrl+C` no terminal de cada processo. Se uma porta ficou presa (por exemplo, quando o
servidor foi aberto pelo preview do Claude Desktop):

```bash
lsof -nP -iTCP:5173 -sTCP:LISTEN               # mostra quem está na porta
lsof -tiTCP:5173 -sTCP:LISTEN | xargs kill     # derruba (troque por 8787 para a API)
```

Depois é só rodar o `npm --prefix ... run dev` de novo.

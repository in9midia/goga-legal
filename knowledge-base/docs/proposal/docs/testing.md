# Testes conduzidos pela IA

A IA assume integralmente os testes: escreve e atualiza os scripts conforme funcionalidades são implementadas, e executa os scripts ao verificar ou conduzir UAT. Só delega ao operador quando a automação é impossível (SSO com MFA, hardware externo).

---

## 1. Tipos de teste e quando usar cada um

| Tipo | O que cobre | Onde ficam | Quando executar |
|---|---|---|---|
| Unitário | Funções e componentes isolados | `tests/` ou `src/` do módulo | Ao alterar lógica interna de uma unidade |
| Integração de módulo | Fluxos internos de um módulo com dependências reais | `tests/` do módulo | Ao alterar fluxos ou contratos internos |
| E2E / UAT | Jornadas completas do usuário pela interface ou pela API | `e2e/` na raiz | Ao verificar funcionalidades ou conduzir UAT |

**UAT é sempre E2E** — testa o sistema em execução de ponta a ponta. Nunca substitua UAT por testes unitários.

---

## 2. Fluxo de UAT autônomo

### Passo 0 — verificar serviços em execução

Antes de qualquer setup, verificar se os serviços necessários já estão no ar conforme as URLs definidas em `docs/dev-setup.md` de cada módulo.

Se todos estiverem respondendo, pule direto para o Passo 3. Não suba serviços desnecessariamente.

### Passo 1 — preparar variáveis de ambiente (só se precisar subir serviços)

Verificar se o arquivo de variáveis de ambiente já existe **antes** de criar. Nunca sobrescreva um arquivo existente. Se ele existir e os serviços não estiverem no ar, investigar o motivo antes de subir.

Se o arquivo não existir, **a IA deve criá-lo** com valores funcionais para o teste — sem pedir ao operador. Consulte `docs/dev-setup.md` do módulo relevante para as variáveis obrigatórias. Valores de credenciais para testes locais podem ser definidos livremente (ex: `AUTH_PASSWORD=uat-test-session`); o que importa é que o login funcione. Se algum módulo exigir secrets ou valores aleatórios, gere com `openssl rand -base64 32`.

### Passo 2 — subir os serviços (só se necessário)

Subir em background conforme `docs/dev-setup.md` de cada módulo. Aguardar o startup via health check antes de prosseguir.

### Passo 3 — executar os scripts E2E

Scripts E2E aceitam URLs via variável de ambiente com defaults apontando para localhost. Passe as variáveis na linha de comando se os defaults não servirem.

### Passo 4 — encerrar os serviços (só se foram subidos nesta sessão)

Se você subiu os serviços no Passo 2, encerre-os ao concluir. Não encerre processos que já estavam rodando antes do UAT.

---

## 3. Playwright

### Instalação

```bash
npm install -g playwright@latest
playwright install chromium
```

Verifique com:

```bash
playwright --version
```

> O `playwright` CLI não faz parte do `package.json` de nenhum módulo — é pré-requisito
> de ambiente, análogo ao Node.js. Em produção, o container Docker já inclui Playwright
> instalado no stage runner (versão fixada no `Dockerfile`).

### Uso

O CLI `playwright` está instalado globalmente. Usar diretamente — não via `npx`.

```bash
playwright screenshot --browser chromium http://localhost:3000 /tmp/page.png
```

Para scripts interativos, resolver o módulo Node a partir do CLI global:

```bash
PW_NM=$(dirname $(which playwright))/../lib/node_modules
node e2e/meu-script.js
```

Screenshots em `/tmp/` — descartados ao encerrar a sessão, usados para diagnóstico inline.

### Troubleshooting: Playwright não encontrado

Confirme que está instalado globalmente:

```bash
which playwright
playwright --version
```

Se não encontrado, instale conforme a seção "Instalação" acima.

---

## 4. Scripts de teste

Este documento é a fonte normativa sobre onde vivem os testes E2E: **sempre em `e2e/` na raiz**, para qualquer jornada de usuário ponta a ponta — nunca por módulo, independente de quantos módulos essa jornada atravesse. Testes unitários e de integração de módulo continuam em `tests/` do próprio módulo; isso não muda.

Cada script em `e2e/` deve:

- ser autocontido e executável de forma independente
- listar os cenários cobertos em comentário no topo
- receber URLs base via variável de ambiente com defaults para localhost, nunca hardcoded

```
e2e/
  walking-skeleton.js   ← pilha completa end-to-end
  auth-flows.js         ← fluxos de autenticação e controle de acesso
```

---

*Agnóstico de stack — aplicável a qualquer monorepo com este padrão.*

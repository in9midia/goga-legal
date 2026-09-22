# Desenvolver este projeto com IA

Este repositório é desenvolvido com agentes de IA, e a documentação existe em
grande parte para isso. Este documento explica **como** trabalhar aqui de forma
produtiva, e onde os agentes costumam errar neste código específico.

As regras estão em [`../AGENTS.md`](../AGENTS.md). Aqui está o resto.

## A ordem de leitura que funciona

Um agente que entra frio neste repositório e vai direto ao código produz mudança
que parece certa e desfaz decisão. A ordem que evita isso:

1. [`glossario.md`](glossario.md), porque "base", "candidato" e "harness"
   significam coisas diferentes do que parecem;
2. o **ADR da área** que vai mudar. São 18, em [`adr/`](adr/), e cada um diz o
   que já foi tentado e descartado;
3. [`arquitetura.md`](arquitetura.md), especialmente a lista numerada de
   armadilhas no fim. Cada item custou uma investigação;
4. só então o código.

## Por que a documentação é assim

Três escolhas deliberadas, que valem entender antes de contribuir com elas:

**O comentário registra a decisão, não a mecânica.** `# Desliga o escape de HTML`
não ajuda ninguém. `# escape_html=True gravava "GH &amp; VOCE" no canonico`
impede que a linha seja "limpa" por alguém que não sabe.

**Os números têm procedência.** `memory: 8Gi` é número mágico; com "OOMKilled com
4Gi durante OCR de PDF de 121 páginas" é decisão auditável. Ao mexer num número,
ou preserve a procedência ou meça de novo e atualize.

**As reversões ficam registradas.** O ADR-0007 documenta uma decisão que estava
errada e por quê. Apagar isso convida a segunda tentativa idêntica.

## Onde agentes erram neste código

Padrões observados, com o que fazer em vez:

| Erro | Em vez disso |
|---|---|
| Ler `main.py` inteiro | Ele tem mais de 1500 linhas. Localize a rota com `grep -n '"/v1/'` e leia a vizinhança |
| "Limpar" comentário longo | O comentário é o registro da decisão. Se parece verboso, leia o ADR antes de encostar |
| Rodar `ruff format` de carona | Reescreve 13 de 21 arquivos. É entrega sozinha, e está dito em `scripts/check.py` |
| Criar `docker compose` para facilitar | Deliberadamente ausente (ADR-0014). Não exercita ingress, permissão nem MCP |
| Filtrar Espaço no cliente | A permissão é do servidor (ADR-0005). O MCP tornaria isso porta aberta |
| Passar credencial em prompt ou mensagem | Foi erro real e foi revertido (ADR-0007) |
| Dizer "testado" após rodar unitários | Busca, extração e permissão não têm cobertura automática. Ver [`testes.md`](testes.md) |
| Editar a migração 0001 | Congelada. Mudança nova é migração nova (ADR-0011) |
| Editar `CLAUDE.md` | É apontamento. A fonte é `AGENTS.md` |
| Confundir representação com slot do índice | Representação (índice, wiki) é um **conjunto** por Espaço; motor e enriquecimento são slots **dentro** do índice (ADR-0017) |
| Tratar o grafo como representação | É **estrutura auxiliar** do índice: os nós apontam para chunks que já existem e não criam conteúdo (ING-12) |
| Acrescentar método de acesso com `if` na busca | Ele entra no registro de `retrieval.py` e no catálogo de `representations.py`. A busca e a tela não mudam |
| Achar que OKF exige arquivo num formato especial | Ligado, ele deriva o conceito de qualquer formato. Só o que **já vem escrito** é lido como está |
| Fazer `llm.complete_json` levantar em caso de falha | Ela nunca levanta, de propósito: metadado ausente é aceitável, documento perdido não (ADR-0015) |
| Chamar `embed()` sem passar o Espaço | O modelo é por base (ADR-0016). Sem o Espaço, vetoriza com o padrão da instalação contra um índice de outro modelo — e não dá erro |

## Skills

Os fluxos que se repetem estão em `.agents/skills/`, e valem mais que instrução
solta no chat porque carregam as armadilhas junto:

| Skill | Quando |
|---|---|
| `migracao` | mudança de esquema. Inclui o teste contra Postgres real e a checagem de idempotência |
| `subir-local` | antes de verificar qualquer mudança de comportamento |
| `nova-rota` | endpoint novo. Cobre identidade, escopo, telemetria e erro acionável |
| `revisar-escopo` | antes de entregar mudança que toque leitura, autenticação ou provedor |

## O que fazer quando a documentação estiver errada

Corrigir, no mesmo trabalho. Documentação normativa desatualizada é pior que
ausente, porque o próximo agente a segue.

Se a correção mudar uma decisão, ela é um **ADR novo** que substitui o antigo, e o
antigo ganha status `Substituído` com o ponteiro. O arquivo não é apagado.

## O que não delegar

Duas coisas que este projeto aprendeu a não automatizar:

- **escrever segredo em arquivo versionado.** Pare e pergunte ao operador. Já
  houve uma tentativa de copiar chave de API faturada para repositório
  compartilhado, e o certo foi parar;
- **mexer na definição do realm.** Os realms do Goga sobem por import
  declarativo versionado **fora deste repositório**
  (`infra/k8s/local/realms/` do monorepo), e são a fronteira de segurança do
  sistema inteiro. Daqui só se aplica o que
  [`infra/identity/configure-client.sh`](../infra/identity/configure-client.sh)
  aplica: um mapper aditivo no client desta aplicação. Qualquer outra mudança
  vai no import do realm, não por API.

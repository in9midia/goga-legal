# Convenções de Monorepo

Este documento define as convenções de organização, documentação, contexto para IA e coordenação entre módulos deste repositório.

A diretriz central é: este repositório é um monorepo, mas cada módulo deve ser tratado como uma unidade técnica bem delimitada — com autonomia operacional para dependências, comandos, testes e documentação. A raiz fornece visão integrada, coordenação e contexto transversal; não deve transformar módulos distintos em um único projeto sem fronteiras.

---

## 1. Princípios gerais

1. A raiz do repositório coordena o conjunto; cada módulo executa, testa, valida e documenta sua própria parte.
2. O monorepo deve facilitar integração, não criar acoplamento desnecessário.
3. Dependências devem ficar no módulo que as utiliza.
4. Mudanças que atravessam módulos devem atualizar contratos, testes e documentação relacionados.
5. Agentes de IA devem identificar o módulo afetado antes de agir e respeitar o escopo da pasta em que estão trabalhando.
6. Evitar alterar múltiplos módulos sem necessidade; quando inevitável, explicar a razão da mudança coordenada.
7. Não mover responsabilidades entre módulos sem justificativa arquitetural.
8. Não duplicar regras globais em documentações locais.

---

## 2. Estrutura e organização de módulos

O monorepo pode conter módulos em tecnologias diferentes. Cada módulo deve manter seus próprios arquivos de configuração, dependências, testes e comandos.

A nomenclatura pode variar conforme o projeto, mas a separação conceitual deve ser preservada:

- `apps/`: aplicações executáveis — serviços, APIs, workers, interfaces.
- `packages/` ou `libs/`: bibliotecas, contratos, schemas ou artefatos compartilhados.
- `docs/`: documentação transversal do monorepo.
- `scripts/`: automações auxiliares, quando necessário.

Regras:

1. Configurações específicas de lint, teste e build devem ficar próximas do módulo.
2. Configurações globais só devem existir quando forem realmente transversais.
3. Um módulo não deve depender da estrutura interna de outro módulo; quando necessário, use contratos explícitos.

---

## 3. Escopo de trabalho

O repositório pode ser aberto de duas formas, dependendo da atividade:

**Repositório inteiro**

Use quando a atividade envolver integração entre módulos, alteração de contratos, mudanças arquiteturais, CI/CD, documentação transversal ou refatorações coordenadas.

**Módulo específico**

Use quando a atividade estiver restrita a um único módulo. Esse modo reduz ruído para indexadores, extensões e agentes de IA, e é o modo preferido para trabalho focado.

---

## 4. Documentação

A `docs/` da raiz contém apenas documentação transversal. Detalhes específicos de cada módulo ficam na `docs/` do próprio módulo.

Cada módulo segue um esquema fixo de três arquivos:

| Arquivo | Público | Contém |
|---------|---------|--------|
| `README.md` | humanos | o que é o módulo + ponteiro para `docs/` — nada mais |
| `docs/` | humanos e agentes | documentação própria do módulo — setup, deploy, release, estrutura de pastas, decisões específicas |
| `AGENTS.md` | agentes IA | padrões de código, invariantes e cuidados — sem stack, sem comandos |

---

## 5. Estrutura de pastas recomendada

```text
repo/
  README.md
  AGENTS.md

  docs/
    monorepo.md
    architecture.md

  apps/
    module-a/
      README.md
      AGENTS.md
      docs/
        dev-setup.md
        deploy.md
        release.md
        architecture.md
        decisions/
      src/

```

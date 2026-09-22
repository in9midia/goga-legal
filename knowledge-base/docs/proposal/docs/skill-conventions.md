# Skill Conventions

Este projeto segue o Agent Skills open standard (https://agentskills.io) e prioriza compatibilidade com múltiplos agentes de código. Skills devem evitar recursos específicos de um único agente — o que funciona somente em um agente não pertence aqui. Este arquivo define as convenções a seguir. Sempre que criar ou editar uma skill neste projeto, valide se está respeitando estas convenções antes de finalizar.

## Frontmatter

Use apenas os campos obrigatórios do open standard:

```yaml
---
name: nome-da-skill
description: O que faz e quando usar.
---
```

Nenhum campo adicional. Campos como `allowed-tools`, `disable-model-invocation`, `argument-hint` e `arguments` são extensões específicas de um agente e comprometem a compatibilidade multi-agente.

## Argumentos

Use `$ARGUMENTS` no corpo da skill para capturar o que o usuário digitou após o nome. Descreva os parâmetros esperados em linguagem natural dentro do próprio corpo — sem `argument-hint`, sem o campo `arguments`, sem variáveis nomeadas.

## Skills declarativas

O corpo da skill instrui o agente em linguagem natural. Blocos extensos de Bash, lógica condicional complexa e sequências de comandos não pertencem ao `SKILL.md` — pertencem a helpers em `scripts/`. O corpo deve orquestrar, não implementar.

## Organização de arquivos

Cada skill é um diretório. O open standard define as subpastas convencionais:

```
minha-skill/
├── SKILL.md          # obrigatório
├── scripts/          # helpers executáveis
├── assets/           # templates, arquivos estáticos, schemas
└── references/       # documentação de referência lida sob demanda
```

Templates (arquivos que a skill preenche ou usa como modelo) vão em `assets/`.

## Auto-contenção

Helpers e assets que são **exclusivos de uma skill** devem existir dentro da própria árvore da skill (`scripts/`, `assets/`, `references/`). Um helper exclusivo fora de sua árvore indica um problema de organização: ou ele deve ser movido para dentro, ou a skill está extrapolando suas responsabilidades e o helper não deveria existir.

Scripts **compartilhados entre múltiplas skills** não pertencem a nenhuma skill individualmente e não devem ficar dentro de nenhuma delas. Coloque-os onde o projeto já concentra scripts compartilhados; se não houver convenção estabelecida, verifique a estrutura existente antes de criar uma nova pasta.

Referências a arquivos do projeto fora de `scripts/` são aceitáveis quando fazem parte da regra de negócio da skill — por exemplo, ler `storyboard.md`, `manifest.json`, ou arquivos de configuração do projeto.

O que não deve acontecer:
- Um helper exclusivo de uma skill residindo fora de sua árvore (deveria estar dentro)
- Uma skill referenciando arquivos internos de outra skill (dependência entre skills)

## Helpers

### Linguagem

Prefira Node.js. É a linguagem com maior presença nos sandboxes dos principais agentes de código. Python é a segunda opção — quando não houver dependências externas, a stdlib é suficiente e funciona em qualquer ambiente.

### Execução em comando único

Helpers devem ser executáveis com um único comando, sem sequência separada de setup, install e execução. Para Node.js, implemente a instalação de dependências de forma automática dentro do próprio script, detectando se `node_modules` já existe antes de instalar.

Para Python com dependências externas, use o padrão PEP 723 de inline script metadata — as dependências são declaradas no cabeçalho do próprio arquivo e instaladas automaticamente pelo `uv run`:

```python
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx", "rich"]
# ///

import httpx
# ...
```

Execução: `uv run script.py` — instala e executa em um único comando, sem poluir o ambiente global.

### Evitar commits de dependências

Adicione um `.gitignore` dentro de `scripts/` para não versionar o que é baixado em tempo de execução:

```
# scripts/.gitignore
node_modules/
__pycache__/
*.pyc
.venv/
.installed
```

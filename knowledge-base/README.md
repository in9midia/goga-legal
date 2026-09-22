# Base de conhecimento

A base de conhecimento do Goga Legal. Ela guarda os documentos da casa,
entende o que está escrito neles (inclusive nas imagens) e responde de onde a
informação saiu: o trecho, o documento e a página.

Duas formas de usar:

- **pela web**, para pesquisar, conferir e administrar;
- **pelo seu editor**, para o assistente de IA consultar a base enquanto você
  trabalha. Ele passa a citar a fonte em vez de improvisar.

## O que ela faz de diferente

**Mostra de onde tirou a resposta.** Cada resultado vem com o documento e a
página, e um clique abre o arquivo original naquele ponto, com a passagem
marcada. Não é preciso confiar, dá para conferir.

**Não inventa resposta.** A base devolve os trechos relevantes. Quem escreve a
resposta é o assistente que você já usa, com a fonte à vista. Assim, quando algo
sai errado, é possível saber se o problema foi achar o documento ou interpretá-lo.

**Lê o que está nas imagens.** Em manual de processo a instrução costuma estar no
print de tela, não no parágrafo. Um OCR transcreve essas imagens, então o que
está escrito nelas passa a ser encontrável. Nesta base, 281 imagens tinham texto
útil.

**Respeita quem pode ver o quê.** O conteúdo é organizado em bases (RH, Jurídico,
e assim por diante) e o acesso é resolvido pelos seus grupos, a cada consulta.
Isso vale também para o assistente de IA: ele consulta com o **seu** acesso, nunca
com um acesso genérico.

**Guarda o arquivo original intacto.** O que você envia nunca é reescrito. Sempre
dá para voltar à fonte e reprocessar de outra forma.

## As telas

| Tela | Para quê |
|---|---|
| **Início** | o que é, o que já tem dentro, e por onde começar |
| **Bases** | as bases que você alcança, e por que você as alcança |
| **Documentos** | cada documento com o texto lido, o arquivo original ao lado e as imagens |
| **Simulador** | faz a mesma busca que o assistente faz, com os scores à vista |
| **Histórico** | toda consulta registrada, a sua e a dos assistentes |
| **Conectar MCP** | liga o seu editor à base, com login de verdade |

Para quem administra, há ainda: gestão de acessos, cadastro dos modelos de IA,
painel de consumo e um retrato técnico da instalação.

## Conectar o seu editor

Funciona com Claude Desktop, Claude Code, Cursor, opencode e Codex. Na tela
**Conectar MCP** você copia o endereço, cola no editor e clica em **Entrar**: o
login acontece no Identity da empresa, como em qualquer outro sistema.

Nenhum token para copiar, nenhum arquivo para editar. E como o login é seu, o
assistente enxerga exatamente as bases que você enxerga.

## Rodar localmente

```bash
cp .env.example .env      # preencha KB_SECRET_KEY: openssl rand -hex 32
./start-k8s-local.sh
```

Depois abra `http://localhost:8890` e cadastre um provedor de IA em
Administração > Modelos de IA.

Detalhes em [docs/desenvolvimento.md](docs/desenvolvimento.md).

## Documentação

| | |
|---|---|
| [docs/adr/](docs/adr/) | por que o sistema é assim, uma decisão por arquivo |
| [docs/arquitetura.md](docs/arquitetura.md) | como as peças se ligam, e o que já custou caro |
| [docs/glossario.md](docs/glossario.md) | o vocabulário do domínio |
| [docs/operacao.md](docs/operacao.md) | guia de operação: as telas e o comportamento de cada uma |
| [docs/desenvolvimento.md](docs/desenvolvimento.md) | como rodar, testar e onde mexer |
| [docs/testes.md](docs/testes.md) | o que é testado, e o que não é |
| [docs/ia.md](docs/ia.md) | como desenvolver este projeto com agentes de IA |
| [docs/proposal/](docs/proposal/) | a especificação original: requisitos e system design |

Este repositório é desenvolvido com apoio de agentes de IA. As diretrizes que
eles seguem estão em [AGENTS.md](AGENTS.md).

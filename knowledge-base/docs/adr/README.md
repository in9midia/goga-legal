# Decisões de arquitetura (ADR)

Cada arquivo aqui registra **uma** decisão que foi cara de tomar e seria cara de
reverter. O objetivo não é documentar o código (ele se explica), e sim preservar
o **porquê**: o contexto que existia, as alternativas descartadas e o que a
escolha passou a custar.

Um ADR só nasce quando a decisão tem essas três propriedades. Escolha de nome de
variável, formato de log ou ordem de parâmetro não vira ADR.

## Formato

```
NNNN-titulo-em-kebab-case.md
```

Cada arquivo abre com Status, Data e Relacionado, seguidos de Contexto, Decisão,
Consequências e Alternativas consideradas. O título é uma **frase afirmativa**
que já entrega a decisão, não um tema: "O índice é único" e não "Sobre o índice".

## Status

| Status | Significado |
|---|---|
| Aceito | vale hoje, e o código reflete |
| Substituído | outro ADR tomou o lugar; o arquivo fica, com o ponteiro |
| Revertido | foi tentado e desfeito; fica registrado para ninguém repetir |

Decisão revertida não é apagada. O registro de uma tentativa que falhou vale
tanto quanto o de uma que deu certo, e é justamente o que evita a segunda
tentativa idêntica.

## Índice

| ADR | Decisão |
|---|---|
| [0001](0001-documento-canonico-como-fonte-de-verdade.md) | De cada arquivo sai um Markdown limpo, e é ele que a busca indexa |
| [0002](0002-indice-unico-em-postgres-com-pgvector.md) | Vetor e texto no mesmo banco e na mesma transação |
| [0003](0003-chunking-pai-filho-com-motor-por-espaco.md) | Busca no filho, entrega do pai, motor escolhido por base |
| [0004](0004-busca-hibrida-fundida-por-rrf.md) | Dois braços independentes, fundidos por posição |
| [0005](0005-permissao-resolvida-no-servidor.md) | O Espaço é a fronteira, e ela é aplicada em toda leitura |
| [0006](0006-mcp-devolve-evidencia-nao-resposta.md) | A tool entrega trecho com score e página, nunca texto gerado |
| [0007](0007-kb-api-como-authorization-server-do-mcp.md) | O serviço é o próprio AS e federa o login ao Identity |
| [0008](0008-bruto-imutavel-com-backend-configuravel.md) | O arquivo original nunca é reescrito, e onde ele mora é configuração |
| [0009](0009-provedores-de-ia-no-banco-cifrados.md) | O provedor de IA sai do ambiente e vira cadastro |
| [0010](0010-uso-de-ia-medido-por-rollup-diario.md) | Contador por dia, não histórico de chamadas |
| [0011](0011-migracoes-numeradas-aplicadas-no-boot.md) | Uma migração por mudança, aplicada uma vez e registrada |
| [0012](0012-grafo-como-representacao-auxiliar-derivada.md) | O Memgraph pode ser perdido sem custo de dado |
| [0013](0013-ocr-das-imagens-entra-no-canonico.md) | O que está escrito no print de tela passa a existir para a busca |
| [0014](0014-ambiente-local-espelha-o-cluster.md) | k3d local no mesmo formato do OKE, e GitOps para dev |
| [0015](0015-okf-como-formato-de-entrada.md) | Modo de ingestão é um eixo próprio; OKF é o primeiro modo dele |
| [0016](0016-modelo-de-ia-escolhido-por-espaco.md) | Cada base escolhe o seu modelo, de embedding e de chat |
| [0017](0017-representacoes-por-espaco-e-busca-que-funde-metodos.md) | Representações são um conjunto por Espaço, e a busca funde os métodos de todas |
| [0018](0018-wiki-destilada-como-segunda-representacao.md) | Wiki destilada: páginas OKF atômicas, multi-vetor por seção |
| [0019](0019-busca-rapida-com-milhares-de-arquivos.md) | Uma busca que continua rápida com milhares de arquivos |
| [0020](0020-avaliacao-offline-com-ragas.md) | Avaliação offline: dataset golden e métricas Ragas |
| [0021](0021-melhoria-de-query.md) | Melhoria de query: reescrita e HyDE, desligadas por padrão |
| [0022](0022-marca-goga-e-saida-da-infra-da-outra-organizacao.md) | A marca é Goga Legal, e a infra da organização anterior sai do repositório |
| [0023](0023-repontamento-para-o-keycloak-do-goga.md) | O issuer é o Keycloak do Goga, a curadoria administra a base, e o nome do issuer resolve dos dois lados |
| [0024](0024-vigencia-do-conceito-e-busca-pela-data-do-fato.md) | O conceito diz desde quando e até quando vale, e a busca pergunta pela data do fato |
| [0025](0025-nivel-de-confianca-como-filtro-da-busca.md) | O nível de confiança é filtro da busca, e não etiqueta no resultado |
| [0026](0026-auditoria-do-conceito-registrada.md) | A conferência do conceito fica registrada: contra o quê, quando e por quem |
| [0027](0027-armadilha-chega-com-o-aviso-colado.md) | Conteúdo que engana quem lê rápido chega com o aviso colado |
| [0028](0028-gemini-pela-camada-compativel.md) | Gemini entra pela camada compatível, e o uso não reportado entra como estimativa |

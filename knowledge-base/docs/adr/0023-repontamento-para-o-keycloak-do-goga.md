# ADR-0023 — O issuer é o Keycloak do Goga, a curadoria administra a base, e o nome do issuer resolve dos dois lados

- **Status:** Aceito
- **Data:** 2026-09-21
- **Relacionado:** [0005](0005-permissao-resolvida-no-servidor.md),
  [0007](0007-kb-api-como-authorization-server-do-mcp.md),
  [0014](0014-ambiente-local-espelha-o-cluster.md),
  [0022](0022-marca-goga-e-saida-da-infra-da-outra-organizacao.md),
  `planning/05-IDENTIDADE-E-DADOS.md` §2 e §3.5 (especificação normativa),
  WP-04 e WP-37 de `planning/04-EXECUCAO.md`

## Contexto

Este serviço nasceu em outra organização e autenticava contra o Identity dela.
O WP-39 (ADR-0022) tirou a marca antiga do repositório, mas deixou a
**identidade funcional** intocada de propósito: issuer, realm, client e o nome
do grupo de administração. Renomear sem repontar teria quebrado o login com o
modo de falha mais caro que existe, o silencioso.

O Keycloak do Goga agora existe (WP-04), com os dois realms de
`05-IDENTIDADE-E-DADOS.md` §3.5.2. Este ADR é o repontamento, e ele tem três
decisões dentro, não uma. Elas vêm juntas porque separá-las deixaria o
repositório num estado em que nada funciona: um issuer novo sem mapeamento de
grupo autentica todo mundo sem acesso a nada, e um issuer que os pods não
resolvem não autentica ninguém.

## Decisão

### 1. O issuer é o realm `goga-interno` do Keycloak do Goga

| | Antes | Agora |
|---|---|---|
| `KB_KEYCLOAK_URL` | Identity da organização anterior | `http://kc.localtest.me:8481` (local) |
| `KB_KEYCLOAK_REALM` | realm compartilhado daquela casa | `goga-interno` |
| `KB_KEYCLOAK_CLIENT_ID` | client público daquela casa | `kb-ui` |
| `KB_ADMIN_GROUP` | `/Funcionario/Admin` | `/goga/curadoria` |

O realm é o **interno**, não o `goga-consumidor`. O usuário final nunca alcança
esta base: o repertório é da plataforma, e o agente consulta com token de
serviço próprio (`05-IDENTIDADE-E-DADOS.md` §3). Um grant de consumidor aqui é
exatamente a armadilha que a separação em dois realms existe para evitar.

O client é o `kb-ui`, o mesmo da interface, e não o `kb-mcp` que o realm também
traz. O `kb-mcp` tem device flow; o kb-api faz authorization code com redirect
para o próprio `/oauth/callback` (ADR-0007), e quem tem essa `redirect_uri`
liberada é o `kb-ui`. Escolher errado devolve `invalid_redirect_uri` **no fim**
do fluxo, com o login já feito.

O `KB_KEYCLOAK_INTERNAL_ISSUER` fica **vazio**. Ele existe para o ambiente em
que o navegador e o serviço alcançam o Identity por endereços genuinamente
diferentes (produção atrás de ingress), e não para remendar DNS de laboratório
— ver a decisão 3.

### 2. Quem administra a base é `/goga/curadoria`, e só ela

O `KB_ADMIN_GROUP` dá acesso a **todos** os Espaços e permite administrar:
criar e remover base, cadastrar provedor de IA, conceder acesso. É um grupo só,
por construção do `config.py`.

Dos quatro grupos de `05-IDENTIDADE-E-DADOS.md` §2:

| Grupo | Administra a KB? | Por quê |
|---|---|---|
| `/goga/curadoria` | **sim** | é o público 1: ingere repertório, corrige conceito, roda avaliação. Administrar a base **é** o trabalho dele |
| `/goga/responsavel-tecnico` | não | entra na KB para revisar e assinar (`human-reviewed`). Precisa **ler** o que assina, não criar Espaço nem cadastrar credencial de modelo. Alcança por grant explícito, por Espaço |
| `/goga/advogados-parceiros` | não | trabalha no `goga-advogados`, sobre o dossiê que lhe foi roteado. Não tem relação com o acervo |
| `/goga/ops` | não | opera a **Camada B** do Goga. Esta base não é a Camada B, e dar admin aqui seria acumular por padrão o que a separação em quatro grupos existe para impedir |

A regra de §2 é explícita: *"ninguém acumula por padrão"*. Dois grupos de admin
seriam a primeira exceção, e ela seria aberta sem necessidade — o responsável
técnico já tem o caminho certo, que é o `space_grant` por Espaço (ADR-0005).

Isto é **decisão de produto**, não de código. Se a operação mostrar que o
responsável técnico precisa administrar, o conserto é uma linha no `.env`, ou
uma segunda leitura do `admin_group` para aceitar lista — e esse dia deve ser
registrado aqui.

O `KB_SERVICE_TOKEN_GROUPS` passa a ser derivado do mesmo valor. Divergir os
dois faz o token de serviço deixar de alcançar os Espaços **sem mensagem
nenhuma**: a busca volta vazia e parece base vazia.

### 3. O nome do issuer resolve de dentro do cluster, pelo `coredns`

Esta é a parte que quebra em silêncio, e é a razão de o WP-04 ter escolhido
`kc.localtest.me` em vez de `localhost`: **o `iss` do token precisa ser o mesmo
string para o navegador do host e para os pods.** Com `localhost`, o pod
resolve para ele mesmo; a assinatura não é validada, e a interface diz "sessão
expirada" sem nenhum erro de configuração aparecer em lugar nenhum.

O cluster do Goga resolve isso com `--host-alias` na criação. O cluster da KB
foi criado **sem** o alias, e `kc.localtest.me` é um nome público que resolve
para `::1`: de dentro de um pod da KB, o `curl` morre em 4 ms com
`Could not connect to server`.

**Decisão: injetar a entrada no `NodeHosts` do configmap `coredns`, no
`20-deploy.sh`.** A entrada aponta para o gateway do Docker, que é onde o
Keycloak do outro cluster está publicado.

Por que não `--host-alias` no `00-cluster-up.sh`, que seria o simétrico:

- `--host-alias` só vale em `k3d cluster create`. **Este cluster já existe**, e
  os PVCs dele carregam o repertório ingerido (Postgres, MinIO, Memgraph).
  Recriá-lo para mudar uma entrada de DNS destruiria exatamente o que a
  separação em dois clusters existe para proteger (WP-04, desvio 1);
- e não resolveria sozinho: um cluster já criado continuaria quebrado até
  alguém destruí-lo, o que é pedir para o conserto ser adiado.

O que a decisão custa, e como foi pago:

- **idempotência.** O passo reescreve a linha daquele host em vez de empilhar,
  e roda em todo deploy. Comparar antes de escrever evita reiniciar o CoreDNS à
  toa;
- **sobreviver à recriação.** O cluster recriado também passa pelo
  `20-deploy.sh`, então a entrada volta sozinha;
- **fica no `20-deploy.sh` e não no `00-cluster-up.sh`** porque o nome sai do
  issuer **configurado**. Quando o issuer mudar, o alias muda junto, sem
  ninguém ter de lembrar de editar dois arquivos;
- **o CoreDNS é reiniciado depois do patch.** O plugin `hosts` releria o
  arquivo em 15 s, mas o kubelet leva até um minuto para propagar o configmap
  no volume. Sem o restart, a verificação seguinte vira uma corrida que falha
  de vez em quando, que é pior que falhar sempre.

A verificação do issuer passou a ser **dupla**: do host (o caminho do
navegador) e de dentro de um pod (o caminho do kb-api). São os dois lados do
mesmo string de `iss`, e já aconteceu de um passar e o outro não.

## Consequências

- a busca pelo nome da organização anterior devolve **zero**. É o gate da Onda 0
  que o WP-39 deixou pendente (ADR-0022);
- o `configure-client.sh` passou a autenticar o administrador no realm
  **`master`**, pelo `admin-cli`. O Keycloak é nosso: o administrador mora lá, e
  pedir o token no `goga-interno` devolve `invalid_grant` porque o usuário
  simplesmente não existe ali;
- **o export do realm não traz protocol mapper nenhum no `kb-ui`.** Sem o mapper
  de group membership o login funciona, o token é válido, e todo chamador chega
  sem grupo — a base parece vazia para todo mundo (armadilha 9 de
  `arquitetura.md`). O `configure-client.sh` fecha essa lacuna, e precisa rodar
  uma vez contra o realm novo. A correção definitiva é o mapper entrar no
  import do realm, que é arquivo do WP-04 e não deste WP;
- o `.env.example` deixou de carregar a pendência do WP-37;
- as fixtures de OAuth passaram a nomear `goga-interno`. O host continua sendo
  de exemplo, para o teste não depender de um Keycloak de pé;
- **produção continua em aberto.** `kc.localtest.me:8481` é o endereço local. O
  endereço de produção é `identity.goga.<dominio>` (§3.5.2), e o domínio ainda
  não existe — por isso ele é variável de ambiente, nunca literal no código
  (natureza 3 do ADR-0022).

## Alternativas consideradas

**Apontar para o realm `goga-consumidor`.** Descartada sem discussão: o usuário
final não alcança a KB (§3). Fica registrada porque "é o realm que tem
usuários" é um raciocínio que aparece sozinho quando o `goga-interno` está
vazio.

**`/goga/ops` como grupo de administração.** Descartada. O ops opera a Camada B,
que tem MFA obrigatório e sessão curta por causa da trilha de auditoria, e nada
disso tem a ver com o acervo jurídico. Administrar a KB com a credencial de
quem administra a Camada B é juntar duas fronteiras que o plano separou de
propósito.

**Os dois, curadoria e responsável técnico.** Descartada por ora. O responsável
técnico precisa **ler** para assinar, e ler é `space_grant`. Dar-lhe o poder de
remover base e cadastrar credencial de modelo não é o que a função pede, e o
`admin_group` é um campo só — aceitar lista seria mudar o contrato de
configuração para resolver um problema que ainda não apareceu.

**`KB_KEYCLOAK_INTERNAL_ISSUER` apontando para o Keycloak por outro endereço.**
Seria o remendo óbvio para o problema 3, e está errado: aquele campo existe para
quando os dois endereços **são** diferentes de verdade, e usá-lo aqui esconderia
que o ambiente local tem um problema de DNS. Além disso não resolveria o
`/oauth/authorize`, que é URL que a **pessoa** segue no navegador.

**Recriar o cluster da KB com `--host-alias`.** Descartada: destrói o repertório
ingerido, que é o ativo que a separação em dois clusters protege. Continua sendo
o caminho certo para um cluster que ainda não existe, e por isso a injeção no
`coredns` foi escrita para ser inofensiva quando o alias já está lá.

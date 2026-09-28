# Chart `goga` — KB + Studio no OKE

Sobe no namespace `goga` do cluster `goga-cluster` (contexto
`context-goga-cluster-c76n2d3iq3a`):

| Componente   | O que e                                           |
|--------------|---------------------------------------------------|
| `postgres`   | pgvector unico, bancos `knowledge_base` e `studio` |
| `memgraph`   | grafo auxiliar da KB (em memoria, sem volume)     |
| `kb-api`     | REST `/v1` + MCP `/mcp`; bruto no S3/OCI           |
| `kb-ui`      | `https://kb.goga.legal` (login do Studio via SSO)  |
| `studio-api` | motor dos fluxos; anexos em PVC                   |
| `studio-ui`  | `https://studio.goga.legal`                       |

Pre-requisitos ja no cluster: ingress-nginx e cert-manager com o
ClusterIssuer `letsencrypt-prod` (ver `deploy/k8s/`). DNS: `A` de
`studio.goga.legal` e `kb.goga.legal` → `137.131.181.101`.

## Deploy

```bash
cp charts/goga/secrets.example.yaml charts/goga/secrets.yaml   # preencha (nao versionado)
./push 1.0.0                                                   # build amd64 + push ao OCIR
helm upgrade --install goga charts/goga -n goga --create-namespace \
  -f charts/goga/secrets.yaml --set images.version=1.0.0 \
  --kube-context context-goga-cluster-c76n2d3iq3a
```

Imagens: repositorio privado `goga` do OCIR, tag `<componente>-<versao>`
(ex.: `goga:studio-api-1.0.1`). Atualizar so um componente:
`./push 1.0.1 studio-api` e o `helm upgrade` com `--set images.version=1.0.1`
(so muda de fato quem tem a tag nova; os outros precisam existir nessa versao,
entao publique todos ou use `./push 1.0.1` completo).

## Cuidados

- `kb.secretKey` e `studio.secretKey` cifram credenciais gravadas no banco:
  nao troque depois do primeiro deploy.
- As senhas do Postgres so valem no primeiro boot (initdb). Depois, `ALTER USER`.
- `postgres-data` e `studio-files` tem `helm.sh/resource-policy: keep`:
  `helm uninstall` nao apaga os dados. O minimo do OCI Block Volume e 50Gi.
- A KB roda sem auth propria (MVP); o Ingress exige a sessao do Studio (SSO,
  `kb.auth: sso`). Agentes/MCP usam `Authorization: Bearer <token do Studio>`.
  O Studio fala com o `kb-api` pela rede interna, sem passar por ele.

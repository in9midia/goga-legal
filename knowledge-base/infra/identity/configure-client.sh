#!/usr/bin/env bash
# Garante que o client da UI no Keycloak do Goga emita o claim `groups`.
#
#   KC_ADMIN_USER=<usuario> KC_ADMIN_PASSWORD=<senha> ./configure-client.sh
#   KC_URL=... KC_REALM=... KC_CLIENT=... ./configure-client.sh
#
# No ambiente local a senha vem do Secret do cluster do Goga, nunca de arquivo:
#
#   KC_ADMIN_USER=admin \
#   KC_ADMIN_PASSWORD="$(kubectl --context k3d-goga -n stack-goga-identity \
#     get secret keycloak-admin -o jsonpath='{.data.password}' | base64 -d)" \
#   ./configure-client.sh
#
# POR QUE ISSO EXISTE
#
# O permissionamento do knowledge-base e resolvido no servidor a partir do claim
# `groups` do token (ver space_grant em docs/arquitetura.md). Um client novo no
# Keycloak NAO emite esse claim: por padrao o token traz `realm_access.roles`,
# que e outra coisa. Sem o mapper, todo usuario chega ao kb-api sem grupo e a
# resposta correta passa a ser "nenhum Espaco alcancavel" -- a aplicacao sobe e
# nao serve para nada.
#
# O mapper aplicado aqui e `oidc-group-membership-mapper` com `full.path=true`,
# no access token. O caminho completo importa: `space_grant` guarda o grupo como
# `/goga/curadoria`, e sem `full.path` o claim chega como `curadoria` -- o grant
# deixa de casar e a base parece vazia.
#
# CUIDADO: isto ESCREVE no realm. A alteracao e aditiva e restrita ao client
# desta aplicacao -- nao mexe em usuario, grupo, outro client nem em
# configuracao de realm. E idempotente: rodar de novo nao duplica o mapper.
#
# O realm do Goga sobe por import declarativo (WP-04), e o export NAO traz
# protocol mapper nenhum no `kb-ui`. Enquanto nao trouxer, este script e o que
# fecha a lacuna -- e rodar duas vezes nao custa nada.
set -euo pipefail

KC_URL="${KC_URL:-http://kc.localtest.me:8481}"
KC_REALM="${KC_REALM:-goga-interno}"
KC_CLIENT="${KC_CLIENT:-kb-ui}"
# Onde AUTENTICAR o administrador, que nao e onde esta o client. O Keycloak do
# Goga e nosso, entao o administrador mora no realm `master` e entra pelo
# `admin-cli`. Pedir o token no proprio `goga-interno` devolve
# `invalid_grant` -- o usuario simplesmente nao existe la.
KC_ADMIN_REALM="${KC_ADMIN_REALM:-master}"
KC_ADMIN_CLIENT="${KC_ADMIN_CLIENT:-admin-cli}"
KC_ADMIN_USER="${KC_ADMIN_USER:-}"
KC_ADMIN_PASSWORD="${KC_ADMIN_PASSWORD:-}"

if [[ -z "$KC_ADMIN_USER" || -z "$KC_ADMIN_PASSWORD" ]]; then
  echo "!! informe quem pode administrar o realm:" >&2
  echo "   KC_ADMIN_USER=<usuario> KC_ADMIN_PASSWORD=<senha> ./configure-client.sh" >&2
  echo "   (admin do realm $KC_ADMIN_REALM, com manage-clients sobre $KC_REALM)" >&2
  exit 2
fi

# O token nunca aparece na linha de comando: --data-urlencode le do argumento,
# mas o Authorization vai por header montado aqui dentro.
kc_token() {
  curl -sS --max-time 45 -X POST \
    "$KC_URL/realms/${2:-$KC_REALM}/protocol/openid-connect/token" \
    -d grant_type=password -d "client_id=$1" \
    --data-urlencode "username=$KC_ADMIN_USER" \
    --data-urlencode "password=$KC_ADMIN_PASSWORD" |
    python3 -c 'import sys,json;print(json.load(sys.stdin).get("access_token",""))'
}

api() { curl -sS --max-time 45 -H "Authorization: Bearer $TOKEN" "$@"; }

echo "== autenticando em $KC_URL (realm $KC_ADMIN_REALM, client $KC_ADMIN_CLIENT)"
TOKEN="$(kc_token "$KC_ADMIN_CLIENT" "$KC_ADMIN_REALM")"
[[ -n "$TOKEN" ]] || { echo "!! nao consegui autenticar" >&2; exit 1; }

CLIENT_UUID="$(api "$KC_URL/admin/realms/$KC_REALM/clients?clientId=$KC_CLIENT" |
  python3 -c 'import sys,json;c=json.load(sys.stdin);print(c[0]["id"] if c else "")')"
[[ -n "$CLIENT_UUID" ]] || { echo "!! client $KC_CLIENT nao existe no realm $KC_REALM" >&2; exit 1; }
echo "   client $KC_CLIENT = $CLIENT_UUID"

if api "$KC_URL/admin/realms/$KC_REALM/clients/$CLIENT_UUID/protocol-mappers/models" |
   python3 -c '
import sys, json
mappers = json.load(sys.stdin)
hit = [m for m in mappers
       if m.get("protocolMapper") == "oidc-group-membership-mapper"
       and (m.get("config") or {}).get("claim.name") == "groups"]
sys.exit(0 if hit else 1)
'; then
  echo "== mapper de grupo ja existe; nada a fazer"
else
  echo "== criando o mapper de grupo (claim groups, caminho completo)"
  api -X POST -H 'Content-Type: application/json' \
    "$KC_URL/admin/realms/$KC_REALM/clients/$CLIENT_UUID/protocol-mappers/models" \
    -d '{
      "name": "GroupsMapper",
      "protocol": "openid-connect",
      "protocolMapper": "oidc-group-membership-mapper",
      "config": {
        "claim.name": "groups",
        "full.path": "true",
        "access.token.claim": "true",
        "id.token.claim": "false",
        "userinfo.token.claim": "false"
      }
    }' >/dev/null
  echo "   OK"
fi

echo
# Esta conferencia so passa se $KC_ADMIN_USER TAMBEM existir em $KC_REALM. Com
# o administrador no `master` ela nao tem como funcionar, e e por isso que a
# falha aqui nao interrompe o script: o mapper acima ja foi aplicado.
echo "== conferindo o claim com um login em $KC_REALM (usuario $KC_ADMIN_USER)"
python3 - "$(kc_token "$KC_CLIENT" "$KC_REALM")" <<'PY' || true
import base64, json, sys

token = sys.argv[1]
if not token:
    print("   -- sem token: o usuario nao existe neste realm, ou o client")
    print("      nao permite grant de senha. O mapper acima ja foi aplicado;")
    print("      confira o claim `groups` fazendo o login de verdade na UI.")
    raise SystemExit(0)
payload = token.split(".")[1]
payload += "=" * (-len(payload) % 4)
claims = json.loads(base64.urlsafe_b64decode(payload))
print("   iss:   ", claims.get("iss"))
print("   user:  ", claims.get("preferred_username"))
print("   groups:", claims.get("groups") or "NENHUM -- o mapper nao pegou")
PY

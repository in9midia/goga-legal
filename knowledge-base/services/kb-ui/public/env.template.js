(function (window) {
  window.env = window.env || {};
  window.env['api.base.url'] = '${API_BASE_URL}';
  window.env['keycloak.url'] = '${KEYCLOAK_URL}';
  window.env['keycloak.realm'] = '${KEYCLOAK_REALM}';
  window.env['keycloak.clientId'] = '${KEYCLOAK_CLIENT_ID}';
  window.env['mcp.url'] = '${MCP_URL}';
})(this);

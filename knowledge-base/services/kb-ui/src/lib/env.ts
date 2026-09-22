function getEnv(key: string): string {
  const envObj = (window as unknown as { env?: Record<string, string> }).env;
  return envObj?.[key] ?? '';
}

// Runtime primeiro (window.env, vindo do env.js materializado no boot do
// container), build depois (import.meta.env). A ordem importa: a MESMA imagem
// sobe em local, dev e prod apontando para issuers diferentes -- se o valor
// fosse assado no bundle, cada ambiente exigiria uma imagem propria.
export const env = {
  apiBaseUrl: () => getEnv('api.base.url') || import.meta.env.VITE_API_BASE_URL || '/v1',
  keycloakUrl: () => getEnv('keycloak.url') || import.meta.env.VITE_KEYCLOAK_URL || '',
  keycloakRealm: () => getEnv('keycloak.realm') || import.meta.env.VITE_KEYCLOAK_REALM || '',
  keycloakClientId: () =>
    getEnv('keycloak.clientId') || import.meta.env.VITE_KEYCLOAK_CLIENT_ID || '',
  // Endereco do MCP mostrado na tela de Saude, para copiar na configuracao do
  // harness. Vazio = deriva da origem da propria pagina.
  mcpUrl: () =>
    getEnv('mcp.url') || import.meta.env.VITE_MCP_URL || `${window.location.origin}/mcp`,
};

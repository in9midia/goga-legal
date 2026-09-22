/**
 * Keycloak (OIDC, authorization code + PKCE) e a identidade do operador.
 *
 * Sem as variaveis do Keycloak configuradas, `keycloak` fica nulo e a UI segue
 * sem login -- espelhando o kb-api, que com `KB_KEYCLOAK_ISSUER` vazio cai para
 * auth desligada. Os dois lados tem o mesmo modo offline, de proposito: um
 * ambiente sem Identity ainda sobe.
 */
import Keycloak from 'keycloak-js';
import { env } from './env';

const url = env.keycloakUrl();
const realm = env.keycloakRealm();
const clientId = env.keycloakClientId();

export const keycloak: Keycloak | null =
  url && realm && clientId ? new Keycloak({ url, realm, clientId }) : null;

export async function initAuth(): Promise<{ ok: boolean; reason?: string }> {
  if (!keycloak) {
    console.warn('[auth] Keycloak nao configurado — subindo sem autenticacao');
    return { ok: true };
  }
  try {
    const authenticated = await keycloak.init({
      onLoad: 'login-required',
      pkceMethod: 'S256',
      // O iframe de checagem de sessao exige cookie de terceiros e, no
      // ambiente local (http, sem TLS), so produz recarga em loop.
      checkLoginIframe: false,
    });
    if (!authenticated) return { ok: false, reason: 'nao autenticado' };
    setInterval(() => {
      keycloak.updateToken(60).catch(() => {
        console.warn('[auth] renovacao silenciosa falhou; voltando ao login');
        keycloak.login();
      });
    }, 60_000);
    return { ok: true };
  } catch (err) {
    console.error('[auth] init do Keycloak falhou', err);
    return { ok: false, reason: String(err) };
  }
}

export async function ensureFreshToken(minValidity = 30): Promise<string | undefined> {
  if (!keycloak?.authenticated) return undefined;
  try {
    if (keycloak.isTokenExpired(minValidity)) await keycloak.updateToken(60);
  } catch {
    keycloak.login();
    return undefined;
  }
  return keycloak.token;
}

export function logout(): void {
  if (keycloak) keycloak.logout({ redirectUri: window.location.origin });
}

export type CurrentUser = {
  displayName: string;
  login: string;
  email?: string;
  /** Grupos do claim `groups` — sao eles que definem os Espacos alcancaveis. */
  groups: string[];
  /** `oid` do EntraID, quando o realm federa com o corporativo. */
  entraOid?: string;
};

function nameFromLogin(login: string): string {
  const local = login.split('@')[0] ?? login;
  const parts = local.split(/[._\-+]+/).filter(Boolean);
  if (parts.length === 0) return login;
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

export function initialsFromName(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]!.charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1]!.charAt(0) : '';
  return (first + last).toUpperCase();
}

export function currentUser(): CurrentUser | undefined {
  if (!keycloak?.authenticated) return undefined;
  const parsed = (keycloak.tokenParsed ?? {}) as Record<string, unknown>;
  const claim = (key: string): string | undefined => {
    const v = parsed[key];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  const login = claim('preferred_username') ?? claim('email') ?? claim('sub') ?? '';
  const fullName = [claim('given_name'), claim('family_name')].filter(Boolean).join(' ');
  const groups = Array.isArray(parsed.groups)
    ? (parsed.groups as unknown[]).filter((g): g is string => typeof g === 'string')
    : [];
  return {
    displayName: claim('name') ?? (fullName || (login ? nameFromLogin(login) : 'Operador')),
    login: login || 'operador',
    email: claim('email'),
    groups,
    entraOid: claim('oid'),
  };
}

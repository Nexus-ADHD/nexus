export const PLAUD_MCP_URL = 'https://mcp.plaud.ai/mcp';
export const PLAUD_RESOURCE_METADATA_URL =
  'https://mcp.plaud.ai/.well-known/oauth-protected-resource/mcp';
export const PLAUD_AUTH_METADATA_URL =
  'https://mcp.plaud.ai/.well-known/oauth-authorization-server';

export interface PlaudOAuthMetadata {
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
}

export interface PlaudStoredToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
  clientId: string;
}

export interface PlaudClientRegistration {
  clientId: string;
  redirectUri: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`PLAUD OAuth metadata is missing ${label}.`);
  }
  return value;
}

function requireHttps(value: string, label: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error(`PLAUD ${label} must use HTTPS.`);
  return url.toString();
}

export function parsePlaudOAuthMetadata(
  protectedResourceValue: unknown,
  authorizationServerValue: unknown,
): PlaudOAuthMetadata {
  const protectedResource = record(protectedResourceValue);
  const authorizationServer = record(authorizationServerValue);
  if (!protectedResource || !authorizationServer) {
    throw new Error('PLAUD returned invalid OAuth metadata.');
  }

  const resource = requireHttps(requiredString(protectedResource.resource, 'resource'), 'resource');
  const authorizationServers = protectedResource.authorization_servers;
  const issuer = requiredString(authorizationServer.issuer, 'issuer');
  if (
    !Array.isArray(authorizationServers) ||
    !authorizationServers.some((item) => typeof item === 'string' && item === issuer)
  ) {
    throw new Error('PLAUD OAuth issuer does not match its protected resource metadata.');
  }

  const authMethods = authorizationServer.token_endpoint_auth_methods_supported;
  if (!Array.isArray(authMethods) || !authMethods.includes('none')) {
    throw new Error('PLAUD does not advertise public-client token exchange.');
  }
  const challengeMethods = authorizationServer.code_challenge_methods_supported;
  if (!Array.isArray(challengeMethods) || !challengeMethods.includes('S256')) {
    throw new Error('PLAUD does not advertise PKCE S256.');
  }

  return {
    resource,
    authorizationEndpoint: requireHttps(
      requiredString(authorizationServer.authorization_endpoint, 'authorization endpoint'),
      'authorization endpoint',
    ),
    tokenEndpoint: requireHttps(
      requiredString(authorizationServer.token_endpoint, 'token endpoint'),
      'token endpoint',
    ),
    registrationEndpoint: requireHttps(
      requiredString(authorizationServer.registration_endpoint, 'registration endpoint'),
      'registration endpoint',
    ),
  };
}

export function buildPlaudRegistrationRequest(redirectUri: string) {
  if (!redirectUri.startsWith('nexus://')) {
    throw new Error('PLAUD redirect must use the Nexus app scheme.');
  }
  return {
    client_name: 'Nexus PLAUD Import',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

export function parsePlaudClientRegistration(
  value: unknown,
  redirectUri: string,
): PlaudClientRegistration {
  const payload = record(value);
  const clientId = requiredString(payload?.client_id, 'client id');
  const redirectUris = payload?.redirect_uris;
  if (!Array.isArray(redirectUris) || !redirectUris.includes(redirectUri)) {
    throw new Error('PLAUD registered a different redirect URI.');
  }
  return { clientId, redirectUri };
}

function secureKeyPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, (character) =>
    `_${character.charCodeAt(0).toString(16)}_`,
  );
}

export function plaudTokenStorageKey(ownerId: string): string {
  if (!ownerId.trim()) throw new Error('A Nexus account is required for PLAUD.');
  return `nexus.plaud.tokens.v1.${secureKeyPart(ownerId)}`;
}

export function plaudTokenNeedsRefresh(
  token: PlaudStoredToken,
  now = Date.now(),
  marginMs = 60_000,
): boolean {
  return typeof token.expiresAt === 'number' && token.expiresAt <= now + marginMs;
}

export function mergePlaudRefreshToken(
  previous: PlaudStoredToken,
  refreshed: Omit<PlaudStoredToken, 'clientId'> & { clientId?: string },
): PlaudStoredToken {
  return {
    ...refreshed,
    clientId: refreshed.clientId ?? previous.clientId,
    refreshToken: refreshed.refreshToken ?? previous.refreshToken,
  };
}

export function isPermanentPlaudTokenError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /invalid_grant|invalid_client|unauthorized_client/i.test(message);
}

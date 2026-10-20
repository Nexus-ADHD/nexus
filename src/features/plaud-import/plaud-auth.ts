import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import {
  buildPlaudRegistrationRequest,
  isPermanentPlaudTokenError,
  mergePlaudRefreshToken,
  parsePlaudClientRegistration,
  parsePlaudOAuthMetadata,
  PLAUD_AUTH_METADATA_URL,
  PLAUD_RESOURCE_METADATA_URL,
  plaudTokenNeedsRefresh,
  plaudTokenStorageKey,
  type PlaudClientRegistration,
  type PlaudOAuthMetadata,
  type PlaudStoredToken,
} from './plaud-auth-core';

const CLIENT_REGISTRATION_KEY = 'nexus.plaud.oauth-client.v1';
const FETCH_TIMEOUT_MS = 15_000;
const refreshes = new Map<string, Promise<PlaudStoredToken>>();

export class PlaudDisconnectedError extends Error {
  constructor(message = 'PLAUD is disconnected. Connect it again in Settings.') {
    super(message);
    this.name = 'PlaudDisconnectedError';
  }
}

function redirectUri(): string {
  return AuthSession.makeRedirectUri({ scheme: 'nexus', path: 'oauth/plaud' });
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`PLAUD OAuth request failed (${response.status})${text ? `: ${text.slice(0, 160)}` : ''}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverPlaudOAuth(): Promise<PlaudOAuthMetadata> {
  const [protectedResource, authorizationServer] = await Promise.all([
    fetchJson(PLAUD_RESOURCE_METADATA_URL),
    fetchJson(PLAUD_AUTH_METADATA_URL),
  ]);
  return parsePlaudOAuthMetadata(protectedResource, authorizationServer);
}

async function readRegistration(): Promise<PlaudClientRegistration | null> {
  const raw = await SecureStore.getItemAsync(CLIENT_REGISTRATION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PlaudClientRegistration>;
    if (typeof parsed.clientId === 'string' && parsed.redirectUri === redirectUri()) {
      return { clientId: parsed.clientId, redirectUri: parsed.redirectUri };
    }
  } catch {
    // A malformed public registration is replaced below.
  }
  await SecureStore.deleteItemAsync(CLIENT_REGISTRATION_KEY);
  return null;
}

async function getOrRegisterClient(
  metadata: PlaudOAuthMetadata,
): Promise<PlaudClientRegistration> {
  const existing = await readRegistration();
  if (existing) return existing;
  const appRedirect = redirectUri();
  const payload = await fetchJson(metadata.registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildPlaudRegistrationRequest(appRedirect)),
  });
  const registration = parsePlaudClientRegistration(payload, appRedirect);
  await SecureStore.setItemAsync(CLIENT_REGISTRATION_KEY, JSON.stringify(registration));
  return registration;
}

function storedToken(token: AuthSession.TokenResponse, clientId: string): PlaudStoredToken {
  const issuedAt = typeof token.issuedAt === 'number' ? token.issuedAt * 1000 : Date.now();
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken ?? undefined,
    expiresAt:
      typeof token.expiresIn === 'number' && token.expiresIn > 0
        ? issuedAt + token.expiresIn * 1000
        : undefined,
    tokenType: token.tokenType ?? undefined,
    scope: token.scope ?? undefined,
    clientId,
  };
}

async function saveToken(ownerId: string, token: PlaudStoredToken): Promise<void> {
  await SecureStore.setItemAsync(plaudTokenStorageKey(ownerId), JSON.stringify(token));
}

async function readToken(ownerId: string): Promise<PlaudStoredToken | null> {
  const raw = await SecureStore.getItemAsync(plaudTokenStorageKey(ownerId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PlaudStoredToken>;
    if (typeof parsed.accessToken === 'string' && typeof parsed.clientId === 'string') {
      return parsed as PlaudStoredToken;
    }
  } catch {
    // Malformed credentials are treated as disconnected.
  }
  await disconnectPlaud(ownerId);
  return null;
}

export async function hasPlaudConnection(ownerId: string): Promise<boolean> {
  return Boolean(await readToken(ownerId));
}

export async function connectPlaud(ownerId: string): Promise<void> {
  const metadata = await discoverPlaudOAuth();
  const registration = await getOrRegisterClient(metadata);
  const request = new AuthSession.AuthRequest({
    clientId: registration.clientId,
    redirectUri: registration.redirectUri,
    responseType: AuthSession.ResponseType.Code,
    usePKCE: true,
    extraParams: { resource: metadata.resource },
  });
  const result = await request.promptAsync({
    authorizationEndpoint: metadata.authorizationEndpoint,
  });
  if (result.type !== 'success' || !result.params.code) {
    throw new Error('PLAUD connection was cancelled.');
  }
  const token = await AuthSession.exchangeCodeAsync(
    {
      clientId: registration.clientId,
      code: result.params.code,
      redirectUri: registration.redirectUri,
      extraParams: {
        resource: metadata.resource,
        ...(request.codeVerifier ? { code_verifier: request.codeVerifier } : {}),
      },
    },
    { tokenEndpoint: metadata.tokenEndpoint },
  );
  await saveToken(ownerId, storedToken(token, registration.clientId));
}

async function refreshPlaudToken(
  ownerId: string,
  previous: PlaudStoredToken,
): Promise<PlaudStoredToken> {
  const existing = refreshes.get(ownerId);
  if (existing) return existing;
  const refreshing = (async () => {
    if (!previous.refreshToken) {
      await disconnectPlaud(ownerId);
      throw new PlaudDisconnectedError();
    }
    try {
      const metadata = await discoverPlaudOAuth();
      const response = await AuthSession.refreshAsync(
        {
          clientId: previous.clientId,
          refreshToken: previous.refreshToken,
          extraParams: { resource: metadata.resource },
        },
        { tokenEndpoint: metadata.tokenEndpoint },
      );
      const next = mergePlaudRefreshToken(previous, storedToken(response, previous.clientId));
      await saveToken(ownerId, next);
      return next;
    } catch (error) {
      if (isPermanentPlaudTokenError(error)) {
        await disconnectPlaud(ownerId);
        await SecureStore.deleteItemAsync(CLIENT_REGISTRATION_KEY);
        throw new PlaudDisconnectedError();
      }
      throw error;
    }
  })();
  refreshes.set(ownerId, refreshing);
  try {
    return await refreshing;
  } finally {
    refreshes.delete(ownerId);
  }
}

export async function getPlaudAccessToken(
  ownerId: string,
  forceRefresh = false,
): Promise<string> {
  const token = await readToken(ownerId);
  if (!token) throw new PlaudDisconnectedError();
  const valid = forceRefresh || plaudTokenNeedsRefresh(token)
    ? await refreshPlaudToken(ownerId, token)
    : token;
  return valid.accessToken;
}

export async function disconnectPlaud(ownerId: string): Promise<void> {
  await SecureStore.deleteItemAsync(plaudTokenStorageKey(ownerId));
}

import * as AuthSession from 'expo-auth-session';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

export type ExternalCalendarProvider = 'google' | 'outlook';

export interface ExternalCalendarAccount {
  id: string;
  provider: ExternalCalendarProvider;
  externalAccountId: string;
  email: string;
  displayName?: string;
  connectedAt: number;
  selectedCalendarIds?: string[];
  lastSyncedAt?: number;
}

export interface ExternalCalendarEvent {
  id: string;
  externalId: string;
  provider: ExternalCalendarProvider;
  providerAccountId: string;
  title: string;
  startDate: string;
  endDate: string;
  startISO: string;
  endISO: string;
  allDay: boolean;
  notes?: string | null;
  location?: string | null;
  url?: string | null;
  calendarColor?: string | null;
  calendarId: string;
  calendarName?: string | null;
  cal: string;
  source: 'external_calendar';
}

interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
}

interface ProviderConfig {
  clientId: string;
  redirectUri: string;
}

const GOOGLE_DISCOVERY = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
};

const OUTLOOK_DISCOVERY = {
  authorizationEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
};

const PROVIDER_LABELS: Record<ExternalCalendarProvider, string> = {
  google: 'GOOGLE CALENDAR',
  outlook: 'OUTLOOK CALENDAR',
};

const TOKEN_KEY_PREFIX = 'nexus.calendar.tokens';

function extraValue(key: string): string {
  const extra = Constants.expoConfig?.extra as Record<string, unknown> | undefined;
  const fromExtra = extra?.[key];
  if (typeof fromExtra === 'string') return fromExtra.trim();
  const fromEnv = process.env?.[key];
  return typeof fromEnv === 'string' ? fromEnv.trim() : '';
}

function makeDefaultRedirectUri(provider: ExternalCalendarProvider): string {
  return AuthSession.makeRedirectUri({
    scheme: 'nexus',
    path: `oauth/${provider}`,
  });
}

function getProviderConfig(provider: ExternalCalendarProvider): ProviderConfig {
  const upper = provider === 'google' ? 'GOOGLE' : 'MICROSOFT';
  return {
    clientId: extraValue(`EXPO_PUBLIC_${upper}_CALENDAR_CLIENT_ID`),
    redirectUri:
      extraValue(`EXPO_PUBLIC_${upper}_CALENDAR_REDIRECT_URI`) ||
      makeDefaultRedirectUri(provider),
  };
}

export function getCalendarProviderConfigStatus(provider: ExternalCalendarProvider) {
  const config = getProviderConfig(provider);
  return {
    provider,
    isConfigured: Boolean(config.clientId),
    redirectUri: config.redirectUri,
  };
}

function tokenKey(accountId: string): string {
  return `${TOKEN_KEY_PREFIX}.${accountId}`;
}

function buildAccountId(provider: ExternalCalendarProvider, externalAccountId: string): string {
  return `${provider}:${externalAccountId}`;
}

function toTokenRecord(token: AuthSession.TokenResponse): StoredToken {
  const issuedAt = typeof token.issuedAt === 'number' ? token.issuedAt * 1000 : Date.now();
  const expiresAt =
    typeof token.expiresIn === 'number' && token.expiresIn > 0
      ? issuedAt + token.expiresIn * 1000
      : undefined;

  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken ?? undefined,
    expiresAt,
    tokenType: token.tokenType ?? undefined,
    scope: token.scope ?? undefined,
  };
}

async function saveToken(accountId: string, token: StoredToken): Promise<void> {
  await SecureStore.setItemAsync(tokenKey(accountId), JSON.stringify(token));
}

async function readToken(accountId: string): Promise<StoredToken | null> {
  const raw = await SecureStore.getItemAsync(tokenKey(accountId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.accessToken === 'string') return parsed;
  } catch {
    // Ignore malformed token payloads and force reconnect.
  }
  return null;
}

export async function deleteExternalCalendarToken(accountId: string): Promise<void> {
  await SecureStore.deleteItemAsync(tokenKey(accountId));
}

async function exchangeCode(
  provider: ExternalCalendarProvider,
  code: string,
  request: AuthSession.AuthRequest,
): Promise<AuthSession.TokenResponse> {
  const config = getProviderConfig(provider);
  const discovery = provider === 'google' ? GOOGLE_DISCOVERY : OUTLOOK_DISCOVERY;
  return AuthSession.exchangeCodeAsync(
    {
      clientId: config.clientId,
      code,
      redirectUri: config.redirectUri,
      extraParams: request.codeVerifier ? { code_verifier: request.codeVerifier } : undefined,
    },
    discovery,
  );
}

async function refreshToken(
  account: ExternalCalendarAccount,
  token: StoredToken,
): Promise<StoredToken> {
  if (!token.refreshToken) return token;

  const config = getProviderConfig(account.provider);
  const discovery = account.provider === 'google' ? GOOGLE_DISCOVERY : OUTLOOK_DISCOVERY;
  const refreshed = await AuthSession.refreshAsync(
    {
      clientId: config.clientId,
      refreshToken: token.refreshToken,
    },
    discovery,
  );

  const nextToken = {
    ...toTokenRecord(refreshed),
    refreshToken: refreshed.refreshToken ?? token.refreshToken,
  };
  await saveToken(account.id, nextToken);
  return nextToken;
}

async function getValidToken(account: ExternalCalendarAccount): Promise<StoredToken> {
  const token = await readToken(account.id);
  if (!token) {
    throw new Error(`${PROVIDER_LABELS[account.provider]} is disconnected. Reconnect it in Settings.`);
  }

  if (!token.expiresAt || token.expiresAt > Date.now() + 60_000) {
    return token;
  }

  return refreshToken(account, token);
}

async function fetchJson(url: string, init: RequestInit = {}) {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Calendar request failed (${res.status})${body ? `: ${body.slice(0, 180)}` : ''}`);
  }
  return res.json();
}

async function fetchGoogleProfile(accessToken: string) {
  return fetchJson('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

async function fetchOutlookProfile(accessToken: string) {
  return fetchJson('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export async function connectExternalCalendar(
  provider: ExternalCalendarProvider,
): Promise<ExternalCalendarAccount> {
  const config = getProviderConfig(provider);
  if (!config.clientId) {
    throw new Error(
      `${PROVIDER_LABELS[provider]} needs an OAuth client id. Set ${
        provider === 'google'
          ? 'EXPO_PUBLIC_GOOGLE_CALENDAR_CLIENT_ID'
          : 'EXPO_PUBLIC_MICROSOFT_CALENDAR_CLIENT_ID'
      }.`,
    );
  }

  const discovery = provider === 'google' ? GOOGLE_DISCOVERY : OUTLOOK_DISCOVERY;
  const scopes =
    provider === 'google'
      ? ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/calendar.readonly']
      : ['openid', 'email', 'profile', 'offline_access', 'User.Read', 'Calendars.Read'];

  const request = new AuthSession.AuthRequest({
    clientId: config.clientId,
    scopes,
    redirectUri: config.redirectUri,
    responseType: AuthSession.ResponseType.Code,
    usePKCE: true,
    extraParams:
      provider === 'google'
        ? { access_type: 'offline', prompt: 'consent' }
        : { prompt: 'select_account' },
  });

  const result = await request.promptAsync(discovery);
  if (result.type !== 'success' || !result.params.code) {
    throw new Error('Calendar connection was cancelled.');
  }

  const tokenResponse = await exchangeCode(provider, result.params.code, request);
  const storedToken = toTokenRecord(tokenResponse);

  const profile =
    provider === 'google'
      ? await fetchGoogleProfile(storedToken.accessToken)
      : await fetchOutlookProfile(storedToken.accessToken);

  const externalAccountId = String(
    provider === 'google' ? profile.id ?? profile.email : profile.id ?? profile.userPrincipalName,
  );
  const email = String(
    provider === 'google'
      ? profile.email ?? ''
      : profile.mail ?? profile.userPrincipalName ?? '',
  );
  const displayName = String(profile.name ?? profile.displayName ?? email ?? PROVIDER_LABELS[provider]);

  if (!externalAccountId || !email) {
    throw new Error(`Could not read the ${PROVIDER_LABELS[provider]} account profile.`);
  }

  const account: ExternalCalendarAccount = {
    id: buildAccountId(provider, externalAccountId),
    provider,
    externalAccountId,
    email,
    displayName,
    connectedAt: Date.now(),
  };

  await saveToken(account.id, storedToken);
  return account;
}

function googleDateToISO(value: { date?: string; dateTime?: string }, allDay: boolean): string {
  const raw = value.dateTime ?? value.date;
  if (!raw) return new Date().toISOString();
  if (allDay && value.date) return new Date(`${value.date}T00:00:00`).toISOString();
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function outlookDateToISO(value: { dateTime?: string; timeZone?: string } | undefined): string {
  const raw = value?.dateTime;
  if (!raw) return new Date().toISOString();
  const parsed = new Date(raw.endsWith('Z') ? raw : `${raw}Z`);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

export async function fetchExternalCalendarEvents(
  account: ExternalCalendarAccount,
  startDate: Date,
  endDate: Date,
): Promise<ExternalCalendarEvent[]> {
  const token = await getValidToken(account);

  if (account.provider === 'google') {
    const calendarsPayload = await fetchJson('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
      headers: { Authorization: `Bearer ${token.accessToken}` },
    });
    const calendars = Array.isArray(calendarsPayload.items) ? calendarsPayload.items : [];
    const selectedIds = account.selectedCalendarIds?.length
      ? account.selectedCalendarIds
      : calendars.filter((cal: any) => cal.selected !== false).map((cal: any) => cal.id);

    const batches = await Promise.all(
      calendars
        .filter((cal: any) => selectedIds.includes(cal.id))
        .map(async (cal: any) => {
          const params = new URLSearchParams({
            singleEvents: 'true',
            orderBy: 'startTime',
            timeMin: startDate.toISOString(),
            timeMax: endDate.toISOString(),
            maxResults: '2500',
          });
          const payload = await fetchJson(
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?${params}`,
            { headers: { Authorization: `Bearer ${token.accessToken}` } },
          );
          return (Array.isArray(payload.items) ? payload.items : []).map((event: any) => {
            const allDay = Boolean(event.start?.date && !event.start?.dateTime);
            const startISO = googleDateToISO(event.start ?? {}, allDay);
            const endISO = googleDateToISO(event.end ?? event.start ?? {}, allDay);
            return {
              id: `google:${account.externalAccountId}:${cal.id}:${event.id}`,
              externalId: String(event.id),
              provider: 'google' as const,
              providerAccountId: account.id,
              title: String(event.summary || 'Untitled event'),
              startDate: startISO,
              endDate: endISO,
              startISO,
              endISO,
              allDay,
              notes: event.description ?? null,
              location: event.location ?? null,
              url: event.htmlLink ?? null,
              calendarColor: cal.backgroundColor ?? null,
              calendarId: String(cal.id),
              calendarName: String(cal.summary ?? 'Google Calendar'),
              cal: PROVIDER_LABELS.google,
              source: 'external_calendar' as const,
            };
          });
        }),
    );

    return batches.flat();
  }

  const calendarsPayload = await fetchJson('https://graph.microsoft.com/v1.0/me/calendars', {
    headers: { Authorization: `Bearer ${token.accessToken}` },
  });
  const calendars = Array.isArray(calendarsPayload.value) ? calendarsPayload.value : [];
  const selectedIds = account.selectedCalendarIds?.length
    ? account.selectedCalendarIds
    : calendars.map((cal: any) => cal.id);

  const batches = await Promise.all(
    calendars
      .filter((cal: any) => selectedIds.includes(cal.id))
      .map(async (cal: any) => {
        const params = new URLSearchParams({
          startDateTime: startDate.toISOString(),
          endDateTime: endDate.toISOString(),
          $top: '1000',
        });
        const payload = await fetchJson(
          `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(cal.id)}/calendarView?${params}`,
          {
            headers: {
              Authorization: `Bearer ${token.accessToken}`,
              Prefer: 'outlook.timezone="UTC"',
            },
          },
        );
        return (Array.isArray(payload.value) ? payload.value : []).map((event: any) => {
          const allDay = event.isAllDay === true;
          const startISO = outlookDateToISO(event.start);
          const endISO = outlookDateToISO(event.end ?? event.start);
          return {
            id: `outlook:${account.externalAccountId}:${cal.id}:${event.id}`,
            externalId: String(event.id),
            provider: 'outlook' as const,
            providerAccountId: account.id,
            title: String(event.subject || 'Untitled event'),
            startDate: startISO,
            endDate: endISO,
            startISO,
            endISO,
            allDay,
            notes: event.bodyPreview ?? null,
            location: event.location?.displayName ?? null,
            url: event.webLink ?? null,
            calendarColor: null,
            calendarId: String(cal.id),
            calendarName: String(cal.name ?? 'Outlook Calendar'),
            cal: PROVIDER_LABELS.outlook,
            source: 'external_calendar' as const,
          };
        });
      }),
  );

  return batches.flat();
}


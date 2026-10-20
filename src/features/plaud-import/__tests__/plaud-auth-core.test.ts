import { describe, expect, it } from 'vitest';
import {
  buildPlaudRegistrationRequest,
  isPermanentPlaudTokenError,
  mergePlaudRefreshToken,
  parsePlaudClientRegistration,
  parsePlaudOAuthMetadata,
  plaudTokenNeedsRefresh,
  plaudTokenStorageKey,
} from '../plaud-auth-core';

describe('PLAUD OAuth contract', () => {
  it('accepts the official public-client PKCE metadata', () => {
    expect(
      parsePlaudOAuthMetadata(
        {
          resource: 'https://mcp.plaud.ai/mcp',
          authorization_servers: ['https://mcp.plaud.ai/'],
        },
        {
          issuer: 'https://mcp.plaud.ai/',
          authorization_endpoint: 'https://mcp.plaud.ai/authorize',
          token_endpoint: 'https://mcp.plaud.ai/token',
          registration_endpoint: 'https://mcp.plaud.ai/register',
          token_endpoint_auth_methods_supported: ['none'],
          code_challenge_methods_supported: ['S256'],
        },
      ),
    ).toMatchObject({
      resource: 'https://mcp.plaud.ai/mcp',
      authorizationEndpoint: 'https://mcp.plaud.ai/authorize',
      tokenEndpoint: 'https://mcp.plaud.ai/token',
      registrationEndpoint: 'https://mcp.plaud.ai/register',
    });
  });

  it('rejects metadata that would require a shipped secret or omit PKCE', () => {
    expect(() =>
      parsePlaudOAuthMetadata(
        { resource: 'https://mcp.plaud.ai/mcp', authorization_servers: ['https://mcp.plaud.ai/'] },
        {
          issuer: 'https://mcp.plaud.ai/',
          authorization_endpoint: 'https://mcp.plaud.ai/authorize',
          token_endpoint: 'https://mcp.plaud.ai/token',
          registration_endpoint: 'https://mcp.plaud.ai/register',
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
          code_challenge_methods_supported: [],
        },
      ),
    ).toThrow(/public-client/);
  });

  it('registers a public Nexus redirect and validates the returned client', () => {
    const redirectUri = 'nexus://oauth/plaud';
    expect(buildPlaudRegistrationRequest(redirectUri)).toMatchObject({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
    });
    expect(
      parsePlaudClientRegistration(
        { client_id: 'public-client', redirect_uris: [redirectUri] },
        redirectUri,
      ),
    ).toEqual({ clientId: 'public-client', redirectUri });
    expect(() =>
      parsePlaudClientRegistration({ client_id: 'public-client' }, redirectUri),
    ).toThrow(/different redirect URI/);
  });

  it('scopes tokens by Nexus owner and preserves rotated refresh state', () => {
    expect(plaudTokenStorageKey('owner-a')).not.toBe(plaudTokenStorageKey('owner-b'));
    const previous = {
      accessToken: 'old',
      refreshToken: 'refresh',
      expiresAt: 100,
      clientId: 'client',
    };
    expect(plaudTokenNeedsRefresh(previous, 50, 60)).toBe(true);
    expect(
      mergePlaudRefreshToken(previous, { accessToken: 'new', expiresAt: 1_000 }),
    ).toMatchObject({ accessToken: 'new', refreshToken: 'refresh', clientId: 'client' });
    expect(isPermanentPlaudTokenError(new Error('invalid_grant'))).toBe(true);
    expect(isPermanentPlaudTokenError(new Error('network offline'))).toBe(false);
  });
});

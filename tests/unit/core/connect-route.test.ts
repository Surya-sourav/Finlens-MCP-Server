import { jest, describe, it, expect } from '@jest/globals';
import Fastify from 'fastify';
import type { AuthInfo } from '../../../Core/Auth/auth.service.js';

const { FakeAuthProvider } = await import('../../../Core/Auth/auth.service.js');
const { makeBearerPreHandler, resourceMetadataUrl } = await import('../../../Core/Auth/http.js');
const { signState } = await import('../../../Core/Auth/state.js');
const { registerConnectRoutes } = await import('../../../Core/http/connect.route.js');

const STATE_SECRET = 'state-secret';
const NOW = 1_700_000_000_000;

const validInfo: AuthInfo = {
  token: 'good',
  workosUserId: 'u1',
  workosOrgId: 'o1',
  email: 'a@b.com',
  scopes: [],
  expiresAt: 9_999_999_999,
};

function buildApp() {
  const app = Fastify();
  const findOrCreate = jest.fn(
    async (_identity: { workosUserId: string; workosOrgId: string | null; email: string | null }) => 'tenant-1',
  );
  const upsertConnectionFromCallback = jest.fn(async (_tenantId: string, _input: unknown) => ({}));
  const createToken = jest.fn(async (_url: string) => ({
    token: {
      refresh_token: 'rt',
      realmId: 'realm-1',
      access_token: 'at',
      expires_in: 3600,
      x_refresh_token_expires_in: 8_640_000,
    },
  }));
  const authorizeUri = jest.fn((opts: { scope: string[]; state: string }) => `https://intuit.example/authorize?state=${opts.state}`);

  registerConnectRoutes(app, {
    bearerPreHandler: makeBearerPreHandler({
      authProvider: new FakeAuthProvider({ good: validInfo }),
      resourceMetadataUrl: resourceMetadataUrl('https://mcp.finlens.app/mcp'),
    }),
    tenantService: { findOrCreate },
    vault: { upsertConnectionFromCallback },
    makeConnectClient: () => ({ authorizeUri, createToken }),
    accountingScope: 'com.intuit.quickbooks.accounting',
    stateSecret: STATE_SECRET,
    environment: 'sandbox',
    now: () => NOW,
    newNonce: () => 'nonce-1',
  });

  return { app, findOrCreate, upsertConnectionFromCallback, createToken, authorizeUri };
}

describe('GET /connect', () => {
  it('requires a bearer (401 without one)', async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/connect' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('resolves the tenant and 302-redirects to the Intuit authorize URL with signed state', async () => {
    const { app, findOrCreate, authorizeUri } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/connect', headers: { authorization: 'Bearer good' } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('https://intuit.example/authorize?state=');
    expect(findOrCreate).toHaveBeenCalledWith({ workosUserId: 'u1', workosOrgId: 'o1', email: 'a@b.com' });
    expect(authorizeUri).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

describe('GET /callback', () => {
  it('verifies state, exchanges the code, and stores the connection in the vault', async () => {
    const { app, upsertConnectionFromCallback, createToken } = buildApp();
    const state = signState({ tenantId: 'tenant-1', nonce: 'nonce-1' }, STATE_SECRET, { now: NOW });
    const res = await app.inject({
      method: 'GET',
      url: `/callback?code=abc&state=${encodeURIComponent(state)}&realmId=realm-1`,
    });
    expect(res.statusCode).toBe(200);
    expect(createToken).toHaveBeenCalledTimes(1);
    expect(upsertConnectionFromCallback).toHaveBeenCalledWith('tenant-1', {
      realmId: 'realm-1',
      refreshToken: 'rt',
      accessToken: 'at',
      expiresIn: 3600,
      xRefreshTokenExpiresIn: 8_640_000,
      environment: 'sandbox',
    });
    await app.close();
  });

  it('rejects an invalid/forged state with 400 and does not touch the vault', async () => {
    const { app, upsertConnectionFromCallback } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/callback?code=abc&state=forged.sig&realmId=realm-1' });
    expect(res.statusCode).toBe(400);
    expect(upsertConnectionFromCallback).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 400 when code or state is missing', async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/callback?code=abc' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

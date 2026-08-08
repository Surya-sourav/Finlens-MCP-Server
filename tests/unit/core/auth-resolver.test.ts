import { jest, describe, it, expect } from '@jest/globals';
import type { FastifyRequest } from 'fastify';
import type { AuthInfo } from '../../../Core/Auth/auth.service.js';

const { NoConnectionError, RefreshPermanentError } = await import('../../../Core/Vault/vault.manager.js');
const { makeAuthTenantResolver } = await import('../../../Core/http/auth-resolver.js');

const authInfo: AuthInfo = {
  token: 'good',
  workosUserId: 'u1',
  workosOrgId: 'o1',
  email: 'a@b.com',
  scopes: [],
  expiresAt: 9_999_999_999,
};
const reqWith = (info?: AuthInfo) => ({ authInfo: info }) as unknown as FastifyRequest;

function deps(overrides: Partial<Parameters<typeof makeAuthTenantResolver>[0]> = {}) {
  return {
    tenantService: { findOrCreate: jest.fn(async () => 'tenant-1') },
    vault: {
      getFreshAccessToken: jest.fn(async () => ({ accessToken: 'at', realmId: 'r1', isSandbox: true })),
      getConnectionByTenant: jest.fn(async () => ({}) as unknown),
    },
    buildConnectUrl: (tenantId: string) => `https://intuit.example/authorize?tenant=${tenantId}`,
    ...overrides,
  };
}

describe('makeAuthTenantResolver', () => {
  it('throws when the request is unauthenticated', async () => {
    const resolve = makeAuthTenantResolver(deps());
    await expect(resolve(reqWith(undefined))).rejects.toThrow(/unauthenticated/i);
  });

  it('resolves the tenant and returns credentials from the vault', async () => {
    const d = deps();
    const ctx = await makeAuthTenantResolver(d)(reqWith(authInfo));
    expect(d.tenantService.findOrCreate).toHaveBeenCalledWith({
      workosUserId: 'u1',
      workosOrgId: 'o1',
      email: 'a@b.com',
    });
    expect(ctx.tenantId).toBe('tenant-1');
    expect(await ctx.getFreshAccessToken()).toEqual({ accessToken: 'at', realmId: 'r1', isSandbox: true });
    expect(ctx.getConnectUrl?.()).toContain('tenant-1');
  });

  it('translates NoConnectionError into an actionable message with the connect URL', async () => {
    const d = deps({
      vault: {
        getFreshAccessToken: jest.fn(async () => {
          throw new NoConnectionError('none');
        }),
        getConnectionByTenant: jest.fn(async () => null),
      },
    });
    const ctx = await makeAuthTenantResolver(d)(reqWith(authInfo));
    await expect(ctx.getFreshAccessToken()).rejects.toThrow(/not connected[\s\S]*intuit\.example/i);
  });

  it('translates a dead refresh token (RefreshPermanentError) into the same reconnect prompt', async () => {
    const d = deps({
      vault: {
        getFreshAccessToken: jest.fn(async () => {
          throw new RefreshPermanentError('invalid_grant');
        }),
        getConnectionByTenant: jest.fn(async () => ({})),
      },
    });
    const ctx = await makeAuthTenantResolver(d)(reqWith(authInfo));
    await expect(ctx.getFreshAccessToken()).rejects.toThrow(/not connected|reconnect/i);
  });

  it('isConnected reflects the vault lookup', async () => {
    const connected = await makeAuthTenantResolver(deps())(reqWith(authInfo));
    expect(await connected.isConnected?.()).toBe(true);

    const d = deps({
      vault: {
        getFreshAccessToken: jest.fn(async () => ({ accessToken: 'at', realmId: 'r1', isSandbox: true })),
        getConnectionByTenant: jest.fn(async () => null),
      },
    });
    const notConnected = await makeAuthTenantResolver(d)(reqWith(authInfo));
    expect(await notConnected.isConnected?.()).toBe(false);
  });
});

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const refreshUsingToken = jest.fn<(token: string) => Promise<unknown>>();
jest.unstable_mockModule('intuit-oauth', () => ({
  default: class MockOAuthClient {
    static scopes: { Accounting: string } = { Accounting: 'com.intuit.quickbooks.accounting' };
    constructor(_cfg: Record<string, unknown>) {}
    refreshUsingToken = (token: string) => refreshUsingToken(token);
  },
}));

const { devTenantResolver } = await import('../../../Core/dev/dev-resolver.js');

describe('devTenantResolver (Phase 1 dev shim)', () => {
  beforeEach(() => {
    process.env.QUICKBOOKS_CLIENT_ID = 'cid';
    process.env.QUICKBOOKS_CLIENT_SECRET = 'secret';
    process.env.QUICKBOOKS_REFRESH_TOKEN = 'refresh-token';
    process.env.QUICKBOOKS_REALM_ID = 'realm-1';
    process.env.QUICKBOOKS_ENVIRONMENT = 'sandbox';
    refreshUsingToken.mockReset();
  });

  it('returns a dev TenantContext whose getFreshAccessToken refreshes via intuit-oauth', async () => {
    refreshUsingToken.mockResolvedValueOnce({ token: { access_token: 'fresh-access', expires_in: 3600 } });

    const ctx = devTenantResolver();
    expect(ctx.tenantId).toBe('dev-tenant');

    const creds = await ctx.getFreshAccessToken();
    expect(creds).toEqual({ accessToken: 'fresh-access', realmId: 'realm-1', isSandbox: true });
    expect(refreshUsingToken).toHaveBeenCalledWith('refresh-token');
  });

  it('reports isSandbox=false for a production environment', async () => {
    process.env.QUICKBOOKS_ENVIRONMENT = 'production';
    refreshUsingToken.mockResolvedValueOnce({ token: { access_token: 'a', expires_in: 3600 } });

    const creds = await devTenantResolver().getFreshAccessToken();
    expect(creds.isSandbox).toBe(false);
  });

  it('throws a clear error when required QB env vars are missing', async () => {
    delete process.env.QUICKBOOKS_REFRESH_TOKEN;
    await expect(devTenantResolver().getFreshAccessToken()).rejects.toThrow(/QUICKBOOKS_/);
  });
});

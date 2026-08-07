/**
 * Behavioral tests for QuickbooksClient's multi-tenant path.
 *
 * In multi-tenant mode (QBO_MULTI_TENANT=true) the process has no single global
 * QB refresh token / realm; per-request credentials are injected via
 * QuickbooksClient.useTenantResolver(). These tests prove:
 *   1. The module imports without throwing even when global QB creds are absent.
 *   2. getInstance() builds a node-quickbooks instance from the injected tenant
 *      credentials (fresh per call, never touching the global singleton/.env).
 *   3. getAuthCredentials() returns the injected tenant credentials directly.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Enter multi-tenant mode and prove the import-time env guard is skipped: no
// global QB app creds are set.
process.env.QBO_MULTI_TENANT = 'true';
delete process.env.QUICKBOOKS_CLIENT_ID;
delete process.env.QUICKBOOKS_CLIENT_SECRET;
delete process.env.QUICKBOOKS_REFRESH_TOKEN;
delete process.env.QUICKBOOKS_REALM_ID;

// Capture every node-quickbooks instance constructed so we can assert the exact
// positional args the multi-tenant path passes.
const qbInstances: Array<{ args: unknown[] }> = [];
jest.unstable_mockModule('node-quickbooks', () => ({
  default: class MockQuickBooks {
    args: unknown[];
    constructor(...args: unknown[]) {
      this.args = args;
      qbInstances.push(this);
    }
  },
}));

jest.unstable_mockModule('intuit-oauth', () => ({
  default: class MockOAuthClient {
    static scopes: { Accounting: string } = { Accounting: 'com.intuit.quickbooks.accounting' };
    constructor(_cfg: Record<string, unknown>) {}
  },
}));

jest.unstable_mockModule('open', () => ({ default: jest.fn(async () => undefined) }));

// Stub fs so dotenv finds no .env (deletes above stick) and nothing touches disk.
const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
jest.unstable_mockModule('fs', () => ({
  default: {
    readFileSync: jest.fn(() => {
      throw enoent();
    }),
    existsSync: jest.fn(() => false),
    writeFileSync: jest.fn(),
    renameSync: jest.fn(),
    unlinkSync: jest.fn(),
    lstatSync: jest.fn(() => {
      throw enoent();
    }),
    realpathSync: jest.fn(),
    readlinkSync: jest.fn(),
  },
}));

jest.unstable_mockModule('http', () => ({ default: { createServer: jest.fn() } }));

const { QuickbooksClient } = await import('../../../src/clients/quickbooks-client');

describe('QuickbooksClient multi-tenant mode', () => {
  beforeEach(() => {
    // Reset to "no tenant in scope" between tests; individual tests inject one.
    QuickbooksClient.useTenantResolver(() => undefined);
    qbInstances.length = 0;
  });

  it('imports without throwing when global QB creds are absent', () => {
    // Reaching here at all proves the guarded import did not throw.
    expect(QuickbooksClient).toBeDefined();
  });

  it('getInstance builds a QuickBooks instance from the injected tenant credentials', async () => {
    QuickbooksClient.useTenantResolver(() => ({
      getFreshAccessToken: async () => ({
        accessToken: 'tenant-access-token',
        realmId: 'realm-9',
        isSandbox: true,
      }),
    }));

    const qb = await QuickbooksClient.getInstance();

    expect(qb).toBeDefined();
    expect(qbInstances).toHaveLength(1);
    // node-quickbooks(clientId, clientSecret, accessToken, useTokenSecret,
    //                 realmId, useSandbox, debug, minorVersion, oauthVersion)
    const args = qbInstances[0].args;
    expect(args[2]).toBe('tenant-access-token'); // access token
    expect(args[3]).toBe(false); // no token secret for OAuth 2.0
    expect(args[4]).toBe('realm-9'); // realm id
    expect(args[5]).toBe(true); // useSandbox
    expect(args[8]).toBe('2.0'); // oauth version
  });

  it('builds a fresh instance on every getInstance call (no shared per-realm cache)', async () => {
    QuickbooksClient.useTenantResolver(() => ({
      getFreshAccessToken: async () => ({
        accessToken: 'acc',
        realmId: 'r1',
        isSandbox: false,
      }),
    }));

    const a = await QuickbooksClient.getInstance();
    const b = await QuickbooksClient.getInstance();

    expect(a).not.toBe(b);
    expect(qbInstances).toHaveLength(2);
    expect(qbInstances[0].args[5]).toBe(false); // production → useSandbox false
  });

  it('getAuthCredentials returns the injected tenant credentials directly', async () => {
    QuickbooksClient.useTenantResolver(() => ({
      getFreshAccessToken: async () => ({
        accessToken: 'raw-access',
        realmId: 'realm-raw',
        isSandbox: false,
      }),
    }));

    const creds = await QuickbooksClient.getAuthCredentials();

    expect(creds).toEqual({
      accessToken: 'raw-access',
      realmId: 'realm-raw',
      isSandbox: false,
    });
    // No QuickBooks instance is constructed for the raw-credentials path.
    expect(qbInstances).toHaveLength(0);
  });
});

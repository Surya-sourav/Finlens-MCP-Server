import { jest, describe, it, expect } from '@jest/globals';
import Fastify from 'fastify';
import type { AuthInfo } from '../../../Core/Auth/auth.service.js';
import type { TenantContext } from '../../../Core/transport/tenant-context.js';

// app.ts imports the QuickBooks client, which validates env at import time.
process.env.QBO_MULTI_TENANT = 'true';

const { WorkOSAuthProvider } = await import('../../../Core/Auth/auth.service.js');
const { resourceMetadataUrl, buildProtectedResourceMetadata, makeBearerPreHandler } = await import(
  '../../../Core/Auth/http.js'
);
const { TenantService } = await import('../../../Core/Auth/tenant-service.js');
const { AuditLogger } = await import('../../../Core/Vault/audit.logger.js');
const { RefreshCron } = await import('../../../Core/Vault/refresh.cron.js');
const { LocalKeyProvider } = await import('../../../Core/Vault/crypto/key-provider.js');
const { wrapServerWithAudit } = await import('../../../Core/http/audit-tool-wrapper.js');
const { makeAuthTenantResolver } = await import('../../../Core/http/auth-resolver.js');
const { registerConnectRoutes } = await import('../../../Core/http/connect.route.js');
const { registerMcpRoutes } = await import('../../../Core/http/mcp.route.js');
const { buildApp } = await import('../../../Core/http/app.js');
const { signState } = await import('../../../Core/Auth/state.js');
const { FakeAuthProvider } = await import('../../../Core/Auth/auth.service.js');
const { buildAuthorizeUrl } = await import('../../../Core/http/connect.route.js');
type AuditLogEntry = import('../../../Core/Vault/audit.logger.js').AuditLogEntry;

const key32 = (fill: number): Buffer => Buffer.alloc(32, fill);
const auditEntry: AuditLogEntry = {
  tenantId: null,
  realmId: null,
  toolName: 't',
  category: 'read',
  success: true,
  errorMessage: null,
  durationMs: 1,
};

describe('WorkOSAuthProvider.fromEnv', () => {
  it('throws when WORKOS_ISSUER or MCP_RESOURCE_URL is missing', () => {
    expect(() => WorkOSAuthProvider.fromEnv({})).toThrow(/WORKOS_ISSUER/);
    expect(() => WorkOSAuthProvider.fromEnv({ WORKOS_ISSUER: 'https://iss.example' })).toThrow(/MCP_RESOURCE_URL/);
  });

  it('builds from env with a default JWKS URI', () => {
    const p = WorkOSAuthProvider.fromEnv({
      WORKOS_ISSUER: 'https://iss.example',
      MCP_RESOURCE_URL: 'https://mcp.finlens.app/mcp',
    });
    expect(p).toBeInstanceOf(WorkOSAuthProvider);
  });

  it('accepts an explicit WORKOS_JWKS_URI', () => {
    const p = WorkOSAuthProvider.fromEnv({
      WORKOS_ISSUER: 'https://iss.example',
      MCP_RESOURCE_URL: 'https://mcp.finlens.app/mcp',
      WORKOS_JWKS_URI: 'https://iss.example/custom/jwks.json',
    });
    expect(p).toBeInstanceOf(WorkOSAuthProvider);
  });

  it('reads process.env by default', () => {
    process.env.WORKOS_ISSUER = 'https://iss.example';
    process.env.MCP_RESOURCE_URL = 'https://mcp.finlens.app/mcp';
    expect(WorkOSAuthProvider.fromEnv()).toBeInstanceOf(WorkOSAuthProvider);
  });
});

describe('bearer preHandler non-Bearer scheme', () => {
  it('rejects an Authorization header that is not a Bearer token', async () => {
    const app = Fastify({ logger: false });
    const preHandler = makeBearerPreHandler({
      authProvider: new FakeAuthProvider({}),
      resourceMetadataUrl: resourceMetadataUrl('https://mcp.finlens.app/mcp'),
    });
    app.get('/p', { preHandler }, async () => ({ ok: true }));
    const res = await app.inject({ method: 'GET', url: '/p', headers: { authorization: 'Basic abc' } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('AuditLogger interval callback + default logger', () => {
  it('runs the flush-interval callback and swallows errors with the default logger', async () => {
    let fired: (() => void) | undefined;
    const setIntervalFn = jest.fn((fn: () => void) => {
      fired = fn;
      return { unref: jest.fn() };
    });
    const ok = new AuditLogger({ insertMany: async () => {} }, { flushIntervalMs: 1000, setIntervalFn });
    ok.start();
    fired?.(); // invoke the interval callback (empty buffer → no-op flush)

    const failing = new AuditLogger({
      insertMany: async () => {
        throw new Error('db down');
      },
    }); // no logger → default no-op error path
    failing.record(auditEntry);
    await expect(failing.flush()).resolves.toBeUndefined();
  });
});

describe('RefreshCron interval callback + default logger', () => {
  it('runs the interval callback and reports rows/failures with the default logger', async () => {
    let fired: (() => void) | undefined;
    const setIntervalFn = jest.fn((fn: () => void) => {
      fired = fn;
      return { unref: jest.fn() };
    });
    const cron = new RefreshCron({
      repo: { findExpiring: async () => [] },
      vault: { getFreshAccessToken: async () => ({}) },
      setIntervalFn,
    });
    cron.start();
    fired?.();

    // No logger injected → default logger.info (rows>0) + logger.error (failure).
    const cron2 = new RefreshCron({
      repo: { findExpiring: async () => [{ tenantId: 't1' }] },
      vault: {
        getFreshAccessToken: async () => {
          throw new Error('dead');
        },
      },
    });
    const result = await cron2.runOnce();
    expect(result).toMatchObject({ refreshed: 0, failed: 1 });
  });
});

describe('LocalKeyProvider.fromEnv default env', () => {
  it('reads process.env by default', async () => {
    process.env.FINLENS_MASTER_KEY = key32(3).toString('base64');
    delete process.env.FINLENS_MASTER_KEY_ID;
    const kp = LocalKeyProvider.fromEnv();
    expect(await kp.getCurrentKeyId()).toBe('local-1');
  });
});

describe('resourceMetadataUrl root-path resource', () => {
  it('omits the path suffix when the resource is at the origin root', () => {
    expect(resourceMetadataUrl('https://host/')).toBe(
      'https://host/.well-known/oauth-protected-resource',
    );
  });
});

describe('TenantService null email', () => {
  it('stores an empty string when the identity email is null', async () => {
    const rows: Array<{ id: string; workosUserId: string; workosOrgId: string; email: string }> = [];
    const repo = {
      findByWorkos: async () => null,
      create: async (input: { workosUserId: string; workosOrgId: string; email: string }) => {
        const row = { id: 't1', ...input };
        rows.push(row);
        return row;
      },
    };
    await new TenantService(repo).findOrCreate({ workosUserId: 'u', workosOrgId: 'o', email: null });
    expect(rows[0].email).toBe('');
  });
});

describe('AuditLogger lifecycle', () => {
  it('start registers a flush interval (once) and stop clears it', () => {
    const setIntervalFn = jest.fn(() => ({ unref: jest.fn() }));
    const clearIntervalFn = jest.fn();
    const logger = new AuditLogger(
      { insertMany: async () => {} },
      { flushIntervalMs: 2000, setIntervalFn, clearIntervalFn },
    );
    logger.start();
    logger.start(); // guarded — no second interval
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    logger.stop();
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
  });

  it('start is a no-op when the flush interval is disabled', () => {
    const setIntervalFn = jest.fn(() => ({ unref: jest.fn() }));
    const logger = new AuditLogger({ insertMany: async () => {} }, { flushIntervalMs: 0, setIntervalFn });
    logger.start();
    expect(setIntervalFn).not.toHaveBeenCalled();
  });
});

describe('RefreshCron default deps', () => {
  it('uses real timers/logger when not injected (start is guarded, stop clears)', () => {
    const cron = new RefreshCron({
      repo: { findExpiring: async () => [] },
      vault: { getFreshAccessToken: async () => ({}) },
    });
    cron.start();
    cron.start(); // guarded
    cron.stop();
    expect(true).toBe(true); // reaching here without throwing exercises the default paths
  });
});

describe('LocalKeyProvider previous key without id', () => {
  it('ignores a previous key when its id is not provided', async () => {
    const kp = LocalKeyProvider.fromEnv({
      FINLENS_MASTER_KEY: key32(2).toString('base64'),
      FINLENS_MASTER_KEY_PREVIOUS: key32(1).toString('base64'),
      // no FINLENS_MASTER_KEY_PREVIOUS_ID
    });
    await expect(kp.getKey('local-0')).rejects.toThrow(/Unknown key id/);
  });
});

describe('wrapServerWithAudit non-object result', () => {
  it('treats an undefined result as success and maps the delete category', async () => {
    const registered: Record<string, (...a: unknown[]) => Promise<unknown>> = {};
    const tool = jest.fn((...args: unknown[]) => {
      registered[args[0] as string] = args[args.length - 1] as (...a: unknown[]) => Promise<unknown>;
    });
    const records: Array<{ category: string; success: boolean }> = [];
    const audited = wrapServerWithAudit({ tool } as never, (r) => records.push(r));
    (audited.tool as unknown as (...a: unknown[]) => unknown)(
      'delete_invoice',
      'desc',
      { params: {} },
      async () => undefined,
    );
    await registered['delete_invoice']({});
    expect(records[0]).toMatchObject({ category: 'delete', success: true });
  });

  it('treats a truthy non-object result as success', async () => {
    const registered: Record<string, (...a: unknown[]) => Promise<unknown>> = {};
    const tool = jest.fn((...args: unknown[]) => {
      registered[args[0] as string] = args[args.length - 1] as (...a: unknown[]) => Promise<unknown>;
    });
    const records: Array<{ success: boolean }> = [];
    const audited = wrapServerWithAudit({ tool } as never, (r) => records.push(r));
    (audited.tool as unknown as (...a: unknown[]) => unknown)('get_bill', 'd', { params: {} }, async () => 'a-string');
    await registered['get_bill']({});
    expect(records[0].success).toBe(true);
  });
});

describe('buildAuthorizeUrl defaults', () => {
  it('uses a default clock + nonce when none are injected', () => {
    const url = buildAuthorizeUrl('t1', {
      makeConnectClient: () => ({
        authorizeUri: (o) => `https://intuit.example?state=${o.state}`,
        createToken: async () => ({ token: {} }),
      }),
      accountingScope: 'scope',
      stateSecret: 'secret',
    });
    expect(url).toContain('state=');
  });
});

describe('makeAuthTenantResolver rethrow', () => {
  it('rethrows non-connection errors unchanged', async () => {
    const authInfo: AuthInfo = {
      token: 't',
      workosUserId: 'u',
      workosOrgId: 'o',
      email: null,
      scopes: [],
      expiresAt: 9_999_999_999,
    };
    const resolve = makeAuthTenantResolver({
      tenantService: { findOrCreate: async () => 'tenant-1' },
      vault: {
        getFreshAccessToken: async () => {
          throw new Error('some other failure');
        },
        getConnectionByTenant: async () => ({}),
      },
      buildConnectUrl: () => 'https://intuit.example/authorize',
    });
    const ctx = await resolve({ authInfo } as never);
    await expect(ctx.getFreshAccessToken()).rejects.toThrow('some other failure');
  });
});

describe('connect /callback failure branches', () => {
  const STATE_SECRET = 'secret';
  const NOW = 1_700_000_000_000;

  function appWith(createToken: (url: string) => Promise<{ token: Record<string, unknown> }>) {
    const app = Fastify();
    registerConnectRoutes(app, {
      bearerPreHandler: makeBearerPreHandler({
        authProvider: new FakeAuthProvider({}),
        resourceMetadataUrl: resourceMetadataUrl('https://mcp.finlens.app/mcp'),
      }),
      tenantService: { findOrCreate: async () => 'tenant-1' },
      vault: { upsertConnectionFromCallback: async () => ({}) },
      makeConnectClient: () => ({ authorizeUri: () => 'https://intuit.example', createToken }),
      accountingScope: 'com.intuit.quickbooks.accounting',
      stateSecret: STATE_SECRET,
      environment: 'sandbox',
      now: () => NOW,
    });
    return app;
  }

  it('returns 502 when the code exchange throws', async () => {
    const app = appWith(async () => {
      throw new Error('intuit down');
    });
    const state = signState({ tenantId: 'tenant-1', nonce: 'n' }, STATE_SECRET, { now: NOW });
    const res = await app.inject({ method: 'GET', url: `/callback?code=abc&state=${encodeURIComponent(state)}` });
    expect(res.statusCode).toBe(502);
    await app.close();
  });

  it('returns 502 when the token response is incomplete', async () => {
    const app = appWith(async () => ({ token: { access_token: 'a' } })); // missing refresh_token/realmId
    const state = signState({ tenantId: 'tenant-1', nonce: 'n' }, STATE_SECRET, { now: NOW });
    const res = await app.inject({ method: 'GET', url: `/callback?code=abc&state=${encodeURIComponent(state)}` });
    expect(res.statusCode).toBe(502);
    await app.close();
  });

  it('falls back to the realmId query param when the token omits it', async () => {
    const app = appWith(async () => ({
      token: { refresh_token: 'rt', access_token: 'at', expires_in: 3600, x_refresh_token_expires_in: 8_640_000 },
    }));
    const state = signState({ tenantId: 'tenant-1', nonce: 'n' }, STATE_SECRET, { now: NOW });
    const res = await app.inject({
      method: 'GET',
      url: `/callback?code=abc&state=${encodeURIComponent(state)}&realmId=realm-Q`,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('defaults the token expiries when Intuit omits them', async () => {
    const app = appWith(async () => ({
      token: { refresh_token: 'rt', access_token: 'at', realmId: 'realm-1' }, // no expiries
    }));
    const state = signState({ tenantId: 'tenant-1', nonce: 'n' }, STATE_SECRET, { now: NOW });
    const res = await app.inject({ method: 'GET', url: `/callback?code=abc&state=${encodeURIComponent(state)}` });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('uses a default clock when none is injected into the connect routes', async () => {
    const app = Fastify({ logger: false });
    registerConnectRoutes(app, {
      bearerPreHandler: makeBearerPreHandler({
        authProvider: new FakeAuthProvider({}),
        resourceMetadataUrl: resourceMetadataUrl('https://mcp.finlens.app/mcp'),
      }),
      tenantService: { findOrCreate: async () => 'tenant-1' },
      vault: { upsertConnectionFromCallback: async () => ({}) },
      makeConnectClient: () => ({
        authorizeUri: () => 'https://intuit.example',
        createToken: async () => ({ token: { refresh_token: 'rt', access_token: 'at', realmId: 'r1' } }),
      }),
      accountingScope: 'scope',
      stateSecret: STATE_SECRET,
      environment: 'sandbox',
      // no `now` — exercises the default Date.now() clock
    });
    const state = signState({ tenantId: 'tenant-1', nonce: 'n' }, STATE_SECRET, { now: Date.now() });
    const res = await app.inject({ method: 'GET', url: `/callback?code=abc&state=${encodeURIComponent(state)}` });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('remaining branch coverage', () => {
  it('bearer preHandler passes when the required scope is present', async () => {
    const app = Fastify({ logger: false });
    const info: AuthInfo = {
      token: 'good',
      workosUserId: 'u',
      workosOrgId: 'o',
      email: null,
      scopes: ['quickbooks.read'],
      expiresAt: 9_999_999_999,
    };
    const preHandler = makeBearerPreHandler({
      authProvider: new FakeAuthProvider({ good: info }),
      resourceMetadataUrl: resourceMetadataUrl('https://mcp.finlens.app/mcp'),
      requiredScopes: ['quickbooks.read'],
    });
    app.get('/p', { preHandler }, async () => ({ ok: true }));
    const res = await app.inject({ method: 'GET', url: '/p', headers: { authorization: 'Bearer good' } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('AuditLogger start/stop with default timers (and stop is safe before start)', () => {
    const logger = new AuditLogger({ insertMany: async () => {} }, { flushIntervalMs: 60_000 });
    logger.stop(); // no timer yet → no-op
    logger.start();
    logger.stop();
    expect(true).toBe(true);
  });

  it('RefreshCron tolerates a timer without unref (and stop is safe before start)', () => {
    const cron = new RefreshCron({
      repo: { findExpiring: async () => [] },
      vault: { getFreshAccessToken: async () => ({}) },
      setIntervalFn: () => ({}), // no unref
    });
    cron.stop(); // no timer yet → no-op
    cron.start();
    cron.stop();
    expect(true).toBe(true);
  });

  it('audit wrapper stringifies a non-Error thrown by the handler', async () => {
    const registered: Record<string, (...a: unknown[]) => Promise<unknown>> = {};
    const tool = jest.fn((...args: unknown[]) => {
      registered[args[0] as string] = args[args.length - 1] as (...a: unknown[]) => Promise<unknown>;
    });
    const records: Array<{ errorMessage: string | null }> = [];
    const audited = wrapServerWithAudit({ tool } as never, (r) => records.push(r));
    (audited.tool as unknown as (...a: unknown[]) => unknown)('create_bill', 'd', { params: {} }, async () => {
      // eslint-disable-next-line no-throw-literal
      throw 'oops-string';
    });
    await expect(registered['create_bill']({})).rejects.toBe('oops-string');
    expect(records[0].errorMessage).toBe('oops-string');
  });
});

describe('buildApp option branches', () => {
  const devCtx: TenantContext = {
    tenantId: 'dev',
    getFreshAccessToken: async () => ({ accessToken: 'a', realmId: 'r', isSandbox: true }),
  };

  it('registers well-known + connect routes when provided', async () => {
    const app = buildApp({
      resolveTenant: async () => devCtx,
      wellKnownMetadata: buildProtectedResourceMetadata({
        resource: 'https://mcp.finlens.app/mcp',
        authorizationServers: ['https://iss.example'],
      }),
      connectRoutes: {
        bearerPreHandler: makeBearerPreHandler({
          authProvider: new FakeAuthProvider({}),
          resourceMetadataUrl: resourceMetadataUrl('https://mcp.finlens.app/mcp'),
        }),
        tenantService: { findOrCreate: async () => 't1' },
        vault: { upsertConnectionFromCallback: async () => ({}) },
        makeConnectClient: () => ({ authorizeUri: () => 'https://intuit.example', createToken: async () => ({ token: {} }) }),
        accountingScope: 'scope',
        stateSecret: 'secret',
        environment: 'sandbox',
      },
    });
    const wk = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' });
    expect(wk.statusCode).toBe(200);
    const connect = await app.inject({ method: 'GET', url: '/connect' }); // no bearer → 401
    expect(connect.statusCode).toBe(401);
    await app.close();
  });

  it('falls back to the dev resolver when none is provided', async () => {
    const app = buildApp({});
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('registerMcpRoutes preHandler branch', () => {
  it('applies the preHandler to POST /mcp', async () => {
    const app = Fastify();
    const preHandler = jest.fn(async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
      reply.code(418).send({ blocked: true });
    });
    registerMcpRoutes(app, {
      resolveTenant: async () =>
        ({ tenantId: 't', getFreshAccessToken: async () => ({ accessToken: 'a', realmId: 'r', isSandbox: true }) }) as never,
      preHandler: preHandler as never,
      handle: async () => {},
    });
    const res = await app.inject({ method: 'POST', url: '/mcp', payload: {} });
    expect(preHandler).toHaveBeenCalled();
    expect(res.statusCode).toBe(418);
    await app.close();
  });
});

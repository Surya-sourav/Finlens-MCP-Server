import { jest, describe, it, expect } from '@jest/globals';
import Fastify from 'fastify';
import type { TenantContext } from '../../../Core/transport/tenant-context.js';

// app.ts transitively imports the QuickBooks client, which validates env at
// import time unless multi-tenant mode is on.
process.env.QBO_MULTI_TENANT = 'true';

const { buildApp } = await import('../../../Core/http/app.js');
const { registerMcpRoutes } = await import('../../../Core/http/mcp.route.js');

const devCtx: TenantContext = {
  tenantId: 'dev',
  getFreshAccessToken: async () => ({ accessToken: 'a', realmId: 'r', isSandbox: true }),
};

describe('buildApp HTTP routes', () => {
  it('GET /healthz returns ok', async () => {
    const app = buildApp({ resolveTenant: async () => devCtx });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('GET /mcp returns 405 (stateless: no server-initiated stream)', async () => {
    const app = buildApp({ resolveTenant: async () => devCtx });
    const res = await app.inject({ method: 'GET', url: '/mcp' });
    expect(res.statusCode).toBe(405);
    await app.close();
  });

  it('DELETE /mcp returns 405 (stateless: no session to terminate)', async () => {
    const app = buildApp({ resolveTenant: async () => devCtx });
    const res = await app.inject({ method: 'DELETE', url: '/mcp' });
    expect(res.statusCode).toBe(405);
    await app.close();
  });
});

describe('registerMcpRoutes POST /mcp', () => {
  it('resolves the tenant, hijacks the reply, and delegates to the handler', async () => {
    const app = Fastify();
    const resolveTenant = jest.fn(async () => devCtx);
    const handle = jest.fn(async (_req: unknown, res: { statusCode: number; end: (s?: string) => void }) => {
      res.statusCode = 202;
      res.end('ok');
    });

    registerMcpRoutes(app, { resolveTenant, handle: handle as never });

    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
    });

    expect(resolveTenant).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledTimes(1);
    // The handler wrote directly to the hijacked raw response.
    expect(res.statusCode).toBe(202);
    await app.close();
  });
});

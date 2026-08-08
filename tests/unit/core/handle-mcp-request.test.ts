import { jest, describe, it, expect } from '@jest/globals';
import type { TenantContext } from '../../../Core/transport/tenant-context.js';

const { getTenantContext } = await import('../../../Core/transport/tenant-context.js');
const { handleMcpPost } = await import('../../../Core/http/handle-mcp-request.js');

const makeCtx = (id: string): TenantContext => ({
  tenantId: id,
  getFreshAccessToken: async () => ({ accessToken: id, realmId: `realm-${id}`, isSandbox: true }),
});

describe('handleMcpPost', () => {
  it('registers tools, connects the transport, and runs handleRequest inside the tenant context', async () => {
    const order: string[] = [];
    let tenantSeenDuringHandle: string | undefined;

    const fakeServer = {
      connect: jest.fn(async (_transport: unknown) => {
        order.push('connect');
      }),
      close: jest.fn(async () => {
        order.push('server.close');
      }),
    };
    const fakeTransport = {
      handleRequest: jest.fn(async (_req: unknown, _res: unknown, _body?: unknown) => {
        order.push('handleRequest');
        tenantSeenDuringHandle = getTenantContext()?.tenantId;
      }),
      close: jest.fn(async () => {
        order.push('transport.close');
      }),
    };

    const deps = {
      createServer: () => fakeServer,
      registerTools: (s: unknown) => {
        order.push('register');
        expect(s).toBe(fakeServer);
      },
      createTransport: () => fakeTransport,
    };

    const closeListeners: Array<() => void> = [];
    const req = {} as never;
    const res = {
      on: jest.fn((event: string, cb: () => void) => {
        if (event === 'close') closeListeners.push(cb);
      }),
    } as never;

    const ctx = makeCtx('T');
    await handleMcpPost(req, res, ctx, { jsonrpc: '2.0', method: 'tools/list', id: 1 }, deps as never);

    // Ordering: tools registered before connect, connect before handleRequest.
    expect(order).toEqual(['register', 'connect', 'handleRequest']);
    // handleRequest ran within the tenant's ALS scope.
    expect(tenantSeenDuringHandle).toBe('T');
    // Body is forwarded verbatim to the transport.
    expect(fakeTransport.handleRequest).toHaveBeenCalledWith(req, res, {
      jsonrpc: '2.0',
      method: 'tools/list',
      id: 1,
    });

    // Per-request server + transport are torn down when the response closes.
    expect(closeListeners).toHaveLength(1);
    closeListeners[0]();
    await new Promise((r) => setImmediate(r));
    expect(fakeTransport.close).toHaveBeenCalledTimes(1);
    expect(fakeServer.close).toHaveBeenCalledTimes(1);
  });

  it('SECURITY: binds tenant context to the SDK fire-and-forget onmessage dispatch', async () => {
    // Reproduces the real leak: the MCP SDK calls transport.onmessage WITHOUT
    // awaiting, so the tool handler runs detached from handleRequest's scope.
    // handleMcpPost must wrap onmessage so the handler still sees the tenant.
    let tenantSeenInDispatch: string | undefined;

    const fakeServer = {
      // The real SDK assigns transport.onmessage during connect(); mimic that.
      connect: jest.fn(async (t: { onmessage?: (m: unknown, e?: unknown) => void }) => {
        t.onmessage = () => {
          // stands in for the Protocol → tool handler reading the tenant context
          tenantSeenInDispatch = getTenantContext()?.tenantId;
        };
      }),
      close: jest.fn(async () => {}),
    };
    const fakeTransport: {
      onmessage?: (m: unknown, e?: unknown) => void;
      handleRequest: (r: unknown, s: unknown, b?: unknown) => Promise<void>;
      close: () => Promise<void>;
    } = {
      onmessage: undefined,
      // SDK dispatches the message fire-and-forget from within handleRequest.
      handleRequest: jest.fn(async () => {
        fakeTransport.onmessage?.({ jsonrpc: '2.0', method: 'tools/call' });
      }),
      close: jest.fn(async () => {}),
    };

    const deps = {
      createServer: () => fakeServer,
      registerTools: () => {},
      createTransport: () => fakeTransport,
    };
    const res = { on: jest.fn() } as never;

    await handleMcpPost({} as never, res, makeCtx('TENANT-42'), {}, deps as never);
    await new Promise((r) => setImmediate(r));

    expect(tenantSeenInDispatch).toBe('TENANT-42');
  });
});

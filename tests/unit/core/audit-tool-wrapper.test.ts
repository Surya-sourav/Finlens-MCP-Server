import { jest, describe, it, expect } from '@jest/globals';
import type { ToolAuditRecord } from '../../../Core/Vault/audit.logger.js';

const { wrapServerWithAudit } = await import('../../../Core/http/audit-tool-wrapper.js');

type Handler = (...args: unknown[]) => Promise<unknown>;

function setup() {
  const registered: Record<string, Handler> = {};
  const tool = jest.fn((...args: unknown[]) => {
    registered[args[0] as string] = args[args.length - 1] as Handler;
  });
  const records: ToolAuditRecord[] = [];
  const audited = wrapServerWithAudit({ tool } as never, (r) => records.push(r));
  // The proxied .tool accepts the SDK's strict overloads; call it loosely here.
  const call = audited.tool as unknown as (...args: unknown[]) => unknown;
  return { registered, records, call, tool };
}

describe('wrapServerWithAudit', () => {
  it('records success and duration for a successful handler, mapping the CRUD category', async () => {
    const { registered, records, call } = setup();
    call('get_customer', 'desc', { params: {} }, async () => ({ content: [] }));
    await registered['get_customer']({ params: {} });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ toolName: 'get_customer', category: 'read', success: true, errorMessage: null });
    expect(records[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records success=false and the message when the handler throws (and rethrows)', async () => {
    const { registered, records, call } = setup();
    call('create_invoice', 'desc', { params: {} }, async () => {
      throw new Error('boom');
    });
    await expect(registered['create_invoice']({})).rejects.toThrow('boom');
    expect(records[0]).toMatchObject({ toolName: 'create_invoice', category: 'write', success: false, errorMessage: 'boom' });
  });

  it('records success=false when the tool result has isError set', async () => {
    const { registered, records, call } = setup();
    call('update_bill', 'desc', { params: {} }, async () => ({ isError: true, content: [] }));
    await registered['update_bill']({});
    expect(records[0]).toMatchObject({ toolName: 'update_bill', category: 'update', success: false });
  });

  it('forwards handler arguments and return value unchanged', async () => {
    const { registered, call } = setup();
    call('get_bill', 'desc', { params: {} }, async (args: unknown) => ({ echoed: args }));
    const out = await registered['get_bill']({ id: '7' });
    expect(out).toEqual({ echoed: { id: '7' } });
  });

  it('passes non-tool members straight through', () => {
    const connect = jest.fn();
    const audited = wrapServerWithAudit({ tool: jest.fn(), connect } as never, () => {});
    expect((audited as unknown as { connect: unknown }).connect).toBe(connect);
  });
});

import { describe, it, expect } from '@jest/globals';
import type { TenantContext } from '../../../Core/transport/tenant-context.js';

const { runWithTenant, getTenantContext, requireTenantContext } = await import(
  '../../../Core/transport/tenant-context.js'
);

const makeCtx = (id: string): TenantContext => ({
  tenantId: id,
  getFreshAccessToken: async () => ({ accessToken: id, realmId: `realm-${id}`, isSandbox: true }),
});

describe('tenant-context (AsyncLocalStorage)', () => {
  it('getTenantContext returns undefined outside any run scope', () => {
    expect(getTenantContext()).toBeUndefined();
  });

  it('requireTenantContext throws outside any run scope', () => {
    expect(() => requireTenantContext()).toThrow(/no tenant context/i);
  });

  it('exposes the context synchronously and across await boundaries, then clears it', async () => {
    const ctx = makeCtx('t-1');

    const result = await runWithTenant(ctx, async () => {
      expect(getTenantContext()).toBe(ctx);
      expect(requireTenantContext().tenantId).toBe('t-1');
      await new Promise((r) => setImmediate(r));
      // Still visible after the await boundary — AsyncLocalStorage propagates.
      expect(getTenantContext()?.tenantId).toBe('t-1');
      return 'done';
    });

    expect(result).toBe('done');
    // Scope is torn down after the run resolves.
    expect(getTenantContext()).toBeUndefined();
  });

  it('isolates concurrently-running tenant scopes from each other', async () => {
    const seen: string[] = [];
    await Promise.all([
      runWithTenant(makeCtx('A'), async () => {
        await new Promise((r) => setImmediate(r));
        seen.push(requireTenantContext().tenantId);
      }),
      runWithTenant(makeCtx('B'), async () => {
        seen.push(requireTenantContext().tenantId);
      }),
    ]);
    expect(seen.sort()).toEqual(['A', 'B']);
  });
});

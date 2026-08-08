import { jest, describe, it, expect } from '@jest/globals';

const { RefreshCron } = await import('../../../Core/Vault/refresh.cron.js');

const NOW = 1_000_000;

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    repo: {
      findExpiring: jest.fn(async (_params: { accessBefore: Date; refreshBefore: Date; limit: number }) => [
        { tenantId: 't1' },
        { tenantId: 't2' },
      ]),
    },
    vault: {
      getFreshAccessToken: jest.fn(async (_tenantId: string) => ({
        accessToken: 'a',
        realmId: 'r',
        isSandbox: true,
      })),
    },
    now: () => NOW,
    intervalMs: 600_000,
    batchSize: 50,
    concurrency: 5,
    accessBufferMs: 10 * 60 * 1000,
    refreshLeadMs: 7 * 24 * 60 * 60 * 1000,
    logger: { info: jest.fn(), error: jest.fn() },
    ...overrides,
  };
}

describe('RefreshCron.runOnce', () => {
  it('refreshes every expiring tenant and reports counts', async () => {
    const deps = makeDeps();
    const cron = new RefreshCron(deps as never);
    const result = await cron.runOnce();
    expect(result).toMatchObject({ refreshed: 2, failed: 0 });
    expect(deps.vault.getFreshAccessToken).toHaveBeenCalledWith('t1');
    expect(deps.vault.getFreshAccessToken).toHaveBeenCalledWith('t2');
  });

  it('queries findExpiring with the access + refresh thresholds and batch size', async () => {
    const deps = makeDeps();
    await new RefreshCron(deps as never).runOnce();
    expect(deps.repo.findExpiring).toHaveBeenCalledWith({
      accessBefore: new Date(NOW + 10 * 60 * 1000),
      refreshBefore: new Date(NOW + 7 * 24 * 60 * 60 * 1000),
      limit: 50,
    });
  });

  it('isolates a failing tenant so the rest still refresh', async () => {
    const getFreshAccessToken = jest
      .fn<(tenantId: string) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('dead token for t1'))
      .mockResolvedValueOnce({ accessToken: 'a', realmId: 'r', isSandbox: true });
    const deps = makeDeps({ vault: { getFreshAccessToken } });
    const result = await new RefreshCron(deps as never).runOnce();
    expect(result).toMatchObject({ refreshed: 1, failed: 1 });
    expect((deps.logger as { error: jest.Mock }).error).toHaveBeenCalled();
  });

  it('skips a run that overlaps an in-flight run', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const getFreshAccessToken = jest.fn(async () => {
      await gate;
      return { accessToken: 'a', realmId: 'r', isSandbox: true };
    });
    const deps = makeDeps({ vault: { getFreshAccessToken } });
    const cron = new RefreshCron(deps as never);

    const first = cron.runOnce();
    const second = await cron.runOnce(); // overlaps → should skip
    expect(second).toMatchObject({ skipped: true });
    release?.();
    await first;
  });
});

describe('RefreshCron start/stop', () => {
  it('registers and clears the interval via injected timer functions', async () => {
    const setIntervalFn = jest.fn(() => ({ unref: jest.fn() }));
    const clearIntervalFn = jest.fn();
    const deps = makeDeps({ setIntervalFn, clearIntervalFn });
    const cron = new RefreshCron(deps as never);

    cron.start();
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    cron.stop();
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
  });
});

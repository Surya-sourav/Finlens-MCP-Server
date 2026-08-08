export interface RefreshCronLogger {
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface RefreshCronDeps {
  repo: {
    findExpiring(params: {
      accessBefore: Date;
      refreshBefore: Date;
      limit: number;
    }): Promise<Array<{ tenantId: string }>>;
  };
  vault: {
    getFreshAccessToken(tenantId: string): Promise<unknown>;
  };
  intervalMs?: number;
  batchSize?: number;
  concurrency?: number;
  /** Refresh the access token if it expires within this window. */
  accessBufferMs?: number;
  /** Proactively refresh idle tenants whose refresh token nears its ~100d expiry. */
  refreshLeadMs?: number;
  now?: () => number;
  logger?: RefreshCronLogger;
  setIntervalFn?: (fn: () => void, ms: number) => { unref?: () => void };
  clearIntervalFn?: (timer: unknown) => void;
}

export interface RunOnceResult {
  refreshed: number;
  failed: number;
  skipped?: boolean;
}

const DEFAULTS = {
  intervalMs: 10 * 60 * 1000,
  batchSize: 50,
  concurrency: 5,
  accessBufferMs: 10 * 60 * 1000,
  refreshLeadMs: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Proactively refreshes QuickBooks tokens that are nearing expiry so tool calls
 * never pay cold-refresh latency and idle tenants' 100-day refresh tokens stay
 * alive. Refreshes go through VaultManager.getFreshAccessToken, sharing its
 * per-tenant in-flight de-duplication (cron + on-demand never double-rotate).
 */
export class RefreshCron {
  private readonly d: Required<
    Pick<RefreshCronDeps, "intervalMs" | "batchSize" | "concurrency" | "accessBufferMs" | "refreshLeadMs">
  >;
  private readonly now: () => number;
  private readonly logger: RefreshCronLogger;
  private readonly setIntervalFn: (fn: () => void, ms: number) => { unref?: () => void };
  private readonly clearIntervalFn: (timer: unknown) => void;

  private timer: { unref?: () => void } | undefined;
  private running = false;

  constructor(private readonly deps: RefreshCronDeps) {
    this.d = {
      intervalMs: deps.intervalMs ?? DEFAULTS.intervalMs,
      batchSize: deps.batchSize ?? DEFAULTS.batchSize,
      concurrency: deps.concurrency ?? DEFAULTS.concurrency,
      accessBufferMs: deps.accessBufferMs ?? DEFAULTS.accessBufferMs,
      refreshLeadMs: deps.refreshLeadMs ?? DEFAULTS.refreshLeadMs,
    };
    this.now = deps.now ?? (() => Date.now());
    this.logger = deps.logger ?? { info: () => {}, error: () => {} };
    this.setIntervalFn = deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn = deps.clearIntervalFn ?? ((t) => clearInterval(t as ReturnType<typeof setInterval>));
  }

  start(): void {
    if (this.timer) return;
    this.timer = this.setIntervalFn(() => {
      void this.runOnce();
    }, this.d.intervalMs);
    // Never let the interval alone keep the process alive.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = undefined;
    }
  }

  async runOnce(): Promise<RunOnceResult> {
    if (this.running) {
      return { refreshed: 0, failed: 0, skipped: true };
    }
    this.running = true;
    try {
      const nowMs = this.now();
      const rows = await this.deps.repo.findExpiring({
        accessBefore: new Date(nowMs + this.d.accessBufferMs),
        refreshBefore: new Date(nowMs + this.d.refreshLeadMs),
        limit: this.d.batchSize,
      });

      let refreshed = 0;
      let failed = 0;
      for (let i = 0; i < rows.length; i += this.d.concurrency) {
        const chunk = rows.slice(i, i + this.d.concurrency);
        const results = await Promise.allSettled(
          chunk.map((row) => this.deps.vault.getFreshAccessToken(row.tenantId)),
        );
        results.forEach((res, idx) => {
          if (res.status === "fulfilled") {
            refreshed++;
          } else {
            failed++;
            this.logger.error(
              `[refresh-cron] failed to refresh tenant ${chunk[idx].tenantId}:`,
              res.reason,
            );
          }
        });
      }

      if (rows.length > 0) {
        this.logger.info(`[refresh-cron] refreshed ${refreshed}, failed ${failed} of ${rows.length}`);
      }
      return { refreshed, failed };
    } finally {
      this.running = false;
    }
  }
}

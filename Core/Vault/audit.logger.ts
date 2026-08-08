export type AuditCategory = "read" | "write" | "update" | "delete";

/** What the tool-audit wrapper produces (no tenant yet). */
export interface ToolAuditRecord {
  toolName: string;
  category: AuditCategory;
  success: boolean;
  errorMessage: string | null;
  durationMs: number;
}

/** A full audit row, enriched with the tenant resolved from ALS. */
export interface AuditLogEntry extends ToolAuditRecord {
  tenantId: string | null;
  realmId: string | null;
}

export interface AuditSinkRepo {
  insertMany(entries: AuditLogEntry[]): Promise<void>;
}

export interface AuditLoggerOptions {
  /** Flush the buffer at least this often (ms). 0/undefined disables the timer. */
  flushIntervalMs?: number;
  /** Flush eagerly once the buffer reaches this size. */
  maxBatch?: number;
  logger?: { error: (...a: unknown[]) => void };
  setIntervalFn?: (fn: () => void, ms: number) => { unref?: () => void };
  clearIntervalFn?: (timer: unknown) => void;
}

const DEFAULT_MAX_BATCH = 100;

/**
 * Buffers audit rows and writes them as batched multi-row inserts. Writes are
 * fire-and-forget: a slow or failing audit insert must never add latency to, or
 * fail, an otherwise-successful tool call. flush() is awaited on shutdown so the
 * last batch is not lost on graceful termination.
 */
export class AuditLogger {
  private buffer: AuditLogEntry[] = [];
  private readonly maxBatch: number;
  private readonly flushIntervalMs: number;
  private readonly logger: { error: (...a: unknown[]) => void };
  private readonly setIntervalFn: (fn: () => void, ms: number) => { unref?: () => void };
  private readonly clearIntervalFn: (timer: unknown) => void;
  private timer: { unref?: () => void } | undefined;

  constructor(
    private readonly repo: AuditSinkRepo,
    opts: AuditLoggerOptions = {},
  ) {
    this.maxBatch = opts.maxBatch ?? DEFAULT_MAX_BATCH;
    this.flushIntervalMs = opts.flushIntervalMs ?? 0;
    this.logger = opts.logger ?? { error: () => {} };
    this.setIntervalFn = opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn = opts.clearIntervalFn ?? ((t) => clearInterval(t as ReturnType<typeof setInterval>));
  }

  record(entry: AuditLogEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length >= this.maxBatch) {
      void this.flush();
    }
  }

  start(): void {
    if (this.timer || this.flushIntervalMs <= 0) return;
    this.timer = this.setIntervalFn(() => void this.flush(), this.flushIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = undefined;
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.repo.insertMany(batch);
    } catch (err) {
      this.logger.error("[audit] failed to persist batch:", err);
    }
  }
}

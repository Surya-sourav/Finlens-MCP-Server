import { jest, describe, it, expect } from '@jest/globals';
import type { AuditLogEntry } from '../../../Core/Vault/audit.logger.js';

const { AuditLogger } = await import('../../../Core/Vault/audit.logger.js');

const entry = (toolName: string): AuditLogEntry => ({
  tenantId: 't1',
  realmId: 'r1',
  toolName,
  category: 'read',
  success: true,
  errorMessage: null,
  durationMs: 5,
});

describe('AuditLogger', () => {
  it('buffers records and writes them as one batch on flush', async () => {
    const insertMany = jest.fn(async (_entries: AuditLogEntry[]) => {});
    const logger = new AuditLogger({ insertMany }, { maxBatch: 100 });

    logger.record(entry('get_customer'));
    logger.record(entry('get_bill'));
    await logger.flush();

    expect(insertMany).toHaveBeenCalledTimes(1);
    expect(insertMany.mock.calls[0][0]).toHaveLength(2);

    await logger.flush(); // buffer now empty → no write
    expect(insertMany).toHaveBeenCalledTimes(1);
  });

  it('auto-flushes when the buffer reaches maxBatch', async () => {
    const insertMany = jest.fn(async (_entries: AuditLogEntry[]) => {});
    const logger = new AuditLogger({ insertMany }, { maxBatch: 2 });

    logger.record(entry('a'));
    logger.record(entry('b')); // reaches maxBatch → auto flush
    await new Promise((r) => setImmediate(r));

    expect(insertMany).toHaveBeenCalledTimes(1);
  });

  it('swallows insert errors (audit must never break a tool call)', async () => {
    const error = jest.fn();
    const insertMany = jest.fn(async (_entries: AuditLogEntry[]) => {
      throw new Error('db down');
    });
    const logger = new AuditLogger({ insertMany }, { logger: { error } });

    logger.record(entry('x'));
    await expect(logger.flush()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });

  it('flush is a no-op when nothing is buffered', async () => {
    const insertMany = jest.fn(async (_entries: AuditLogEntry[]) => {});
    const logger = new AuditLogger({ insertMany }, {});
    await logger.flush();
    expect(insertMany).not.toHaveBeenCalled();
  });
});

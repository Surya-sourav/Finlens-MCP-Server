import type { AuditLogEntry, AuditSinkRepo } from "../audit.logger.js";
import type { Db } from "./client.js";
import { auditLogs } from "./schema.js";

/** Neon/Drizzle sink for audit rows (batched multi-row insert). */
export class DrizzleAuditRepo implements AuditSinkRepo {
  constructor(private readonly db: Db) {}

  async insertMany(entries: AuditLogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.db.insert(auditLogs).values(
      entries.map((e) => ({
        tenantId: e.tenantId,
        realmId: e.realmId,
        toolName: e.toolName,
        category: e.category,
        success: e.success,
        errorMessage: e.errorMessage,
        durationMs: e.durationMs,
      })),
    );
  }
}

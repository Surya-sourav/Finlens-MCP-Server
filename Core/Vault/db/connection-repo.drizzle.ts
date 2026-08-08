import { and, asc, eq, lte, or } from "drizzle-orm";
import type {
  ConnectionRepo,
  ConnectionRow,
  FindExpiringParams,
  UpdateTokensInput,
  UpsertActiveInput,
} from "../connection-repo.js";
import type { Db } from "./client.js";
import { quickbooksConnections, type QuickbooksConnection } from "./schema.js";

function toRow(r: QuickbooksConnection): ConnectionRow {
  return {
    id: r.id,
    tenantId: r.tenantId,
    realmId: r.realmId,
    encRefreshToken: r.encRefreshToken,
    encAccessToken: r.encAccessToken,
    accessTokenExpiresAt: r.accessTokenExpiresAt,
    refreshTokenExpiresAt: r.refreshTokenExpiresAt,
    environment: r.environment,
    status: r.status,
    lastRefreshedAt: r.lastRefreshedAt,
  };
}

/** Neon/Drizzle implementation of ConnectionRepo. */
export class DrizzleConnectionRepo implements ConnectionRepo {
  constructor(private readonly db: Db) {}

  async getActiveByTenant(tenantId: string): Promise<ConnectionRow | null> {
    const rows = await this.db
      .select()
      .from(quickbooksConnections)
      .where(
        and(
          eq(quickbooksConnections.tenantId, tenantId),
          eq(quickbooksConnections.status, "active"),
        ),
      )
      .limit(1);
    return rows[0] ? toRow(rows[0]) : null;
  }

  async upsertActive(input: UpsertActiveInput): Promise<ConnectionRow> {
    return this.db.transaction(async (tx) => {
      // Enforce "one active connection per tenant": demote any other active row.
      await tx
        .update(quickbooksConnections)
        .set({ status: "revoked", updatedAt: new Date() })
        .where(
          and(
            eq(quickbooksConnections.tenantId, input.tenantId),
            eq(quickbooksConnections.status, "active"),
          ),
        );

      const [row] = await tx
        .insert(quickbooksConnections)
        .values({
          tenantId: input.tenantId,
          realmId: input.realmId,
          encRefreshToken: input.encRefreshToken,
          encAccessToken: input.encAccessToken,
          accessTokenExpiresAt: input.accessTokenExpiresAt,
          refreshTokenExpiresAt: input.refreshTokenExpiresAt,
          environment: input.environment,
          status: "active",
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [quickbooksConnections.tenantId, quickbooksConnections.realmId],
          set: {
            encRefreshToken: input.encRefreshToken,
            encAccessToken: input.encAccessToken,
            accessTokenExpiresAt: input.accessTokenExpiresAt,
            refreshTokenExpiresAt: input.refreshTokenExpiresAt,
            environment: input.environment,
            status: "active",
            updatedAt: new Date(),
          },
        })
        .returning();
      return toRow(row);
    });
  }

  async updateTokensAfterRefresh(id: string, input: UpdateTokensInput): Promise<void> {
    const set: Partial<typeof quickbooksConnections.$inferInsert> = {
      encAccessToken: input.encAccessToken,
      accessTokenExpiresAt: input.accessTokenExpiresAt,
      lastRefreshedAt: input.lastRefreshedAt,
      status: "active",
      updatedAt: new Date(),
    };
    if (input.encRefreshToken) set.encRefreshToken = input.encRefreshToken;
    if (input.refreshTokenExpiresAt) set.refreshTokenExpiresAt = input.refreshTokenExpiresAt;

    await this.db.update(quickbooksConnections).set(set).where(eq(quickbooksConnections.id, id));
  }

  async markStatus(id: string, status: "revoked" | "error"): Promise<void> {
    await this.db
      .update(quickbooksConnections)
      .set({ status, updatedAt: new Date() })
      .where(eq(quickbooksConnections.id, id));
  }

  async findExpiring(params: FindExpiringParams): Promise<ConnectionRow[]> {
    const rows = await this.db
      .select()
      .from(quickbooksConnections)
      .where(
        and(
          eq(quickbooksConnections.status, "active"),
          or(
            lte(quickbooksConnections.accessTokenExpiresAt, params.accessBefore),
            lte(quickbooksConnections.refreshTokenExpiresAt, params.refreshBefore),
          ),
        ),
      )
      .orderBy(asc(quickbooksConnections.accessTokenExpiresAt))
      .limit(params.limit);
    return rows.map(toRow);
  }
}

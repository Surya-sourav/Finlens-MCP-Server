import { and, eq } from "drizzle-orm";
import type { TenantRepo, TenantRow } from "../tenant-repo.js";
import type { Db } from "../../Vault/db/client.js";
import { tenants } from "../../Vault/db/schema.js";

/** Neon/Drizzle implementation of TenantRepo. */
export class DrizzleTenantRepo implements TenantRepo {
  constructor(private readonly db: Db) {}

  async findByWorkos(workosUserId: string, workosOrgId: string): Promise<TenantRow | null> {
    const rows = await this.db
      .select()
      .from(tenants)
      .where(and(eq(tenants.workosUserId, workosUserId), eq(tenants.workosOrgId, workosOrgId)))
      .limit(1);
    const r = rows[0];
    return r ? { id: r.id, workosUserId: r.workosUserId, workosOrgId: r.workosOrgId, email: r.email } : null;
  }

  async create(input: { workosUserId: string; workosOrgId: string; email: string }): Promise<TenantRow> {
    // onConflictDoUpdate makes concurrent first-creates converge on one row.
    const [r] = await this.db
      .insert(tenants)
      .values({ ...input, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [tenants.workosUserId, tenants.workosOrgId],
        set: { email: input.email, updatedAt: new Date() },
      })
      .returning();
    return { id: r.id, workosUserId: r.workosUserId, workosOrgId: r.workosOrgId, email: r.email };
  }
}

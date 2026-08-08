import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const environmentEnum = pgEnum("qbo_environment", ["sandbox", "production"]);
export const connectionStatusEnum = pgEnum("qbo_connection_status", ["active", "revoked", "error"]);
export const auditCategoryEnum = pgEnum("audit_category", ["read", "write", "update", "delete"]);

/**
 * A tenant = one WorkOS user within one WorkOS organization. A single user can
 * belong to multiple orgs, so the tenant key is the COMPOSITE (user, org), not
 * the user alone. The internal uuid `id` is what the rest of the system uses.
 */
export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workosUserId: text("workos_user_id").notNull(),
    workosOrgId: text("workos_org_id").notNull(),
    email: text("email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tenants_workos_user_org_uq").on(t.workosUserId, t.workosOrgId),
    index("tenants_workos_user_idx").on(t.workosUserId),
  ],
);

/**
 * A tenant's QuickBooks connection. Tokens are stored as AES-256-GCM envelope
 * strings (see Core/Vault/crypto). Constraints:
 *  - unique (tenant_id, realm_id): the upsert conflict target.
 *  - partial-unique (tenant_id) WHERE status='active': at most one ACTIVE
 *    connection per tenant, while keeping revoked/error history and allowing a
 *    later reconnect to a different realm.
 *  - partial indexes on the expiry columns (active only) back the refresh cron.
 */
export const quickbooksConnections = pgTable(
  "quickbooks_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    realmId: text("realm_id").notNull(),
    encRefreshToken: text("enc_refresh_token").notNull(),
    encAccessToken: text("enc_access_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }).notNull(),
    environment: environmentEnum("environment").notNull().default("sandbox"),
    status: connectionStatusEnum("status").notNull().default("active"),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("qbo_conn_tenant_realm_uq").on(t.tenantId, t.realmId),
    uniqueIndex("qbo_conn_one_active_per_tenant_uq")
      .on(t.tenantId)
      .where(sql`${t.status} = 'active'`),
    index("qbo_conn_access_expiry_idx")
      .on(t.accessTokenExpiresAt)
      .where(sql`${t.status} = 'active'`),
    index("qbo_conn_refresh_expiry_idx")
      .on(t.refreshTokenExpiresAt)
      .where(sql`${t.status} = 'active'`),
  ],
);

/**
 * One row per MCP tool invocation. tenant_id is nullable (a request can fail
 * before the tenant is resolved) and set-null on tenant delete so audit history
 * survives.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "set null" }),
    realmId: text("realm_id"),
    toolName: text("tool_name").notNull(),
    category: auditCategoryEnum("category").notNull(),
    success: boolean("success").notNull(),
    errorMessage: text("error_message"),
    durationMs: integer("duration_ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_logs_tenant_created_idx").on(t.tenantId, t.createdAt)],
);

export type Tenant = typeof tenants.$inferSelect;
export type QuickbooksConnection = typeof quickbooksConnections.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * QuickBooks credentials for a single tenant, resolved fresh per request.
 * Structurally matches the `TenantCredentialSource` the QuickBooks client
 * consumes (src/clients/quickbooks-client.ts), so a TenantContext can be handed
 * straight to `QuickbooksClient.useTenantResolver()` without a Core→src type.
 */
export interface QboCredentials {
  accessToken: string;
  realmId: string;
  isSandbox: boolean;
}

/**
 * Per-request tenant scope carried implicitly through the MCP request via
 * AsyncLocalStorage. Handlers never see it directly — the QuickBooks client
 * reads it at getInstance()/getAuthCredentials() time. `getFreshAccessToken`
 * is bound to the Vault so token freshness/refresh stays out of this layer.
 */
export interface TenantContext {
  tenantId: string;
  /** Optional, for logging/telemetry only. */
  realmId?: string;
  /** Optional, for logging/telemetry only. */
  isSandbox?: boolean;
  getFreshAccessToken: () => Promise<QboCredentials>;
}

const storage = new AsyncLocalStorage<TenantContext>();

/**
 * Runs `fn` with `ctx` as the ambient tenant context. Every async continuation
 * spawned inside `fn` (including the MCP tool handler and its QB calls) observes
 * this context; concurrent calls get independent scopes.
 */
export function runWithTenant<T>(ctx: TenantContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

/** Returns the tenant context in scope, or undefined (single-tenant/stdio mode). */
export function getTenantContext(): TenantContext | undefined {
  return storage.getStore();
}

/** Like getTenantContext but throws when no tenant is in scope. */
export function requireTenantContext(): TenantContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error("No tenant context in scope");
  }
  return ctx;
}

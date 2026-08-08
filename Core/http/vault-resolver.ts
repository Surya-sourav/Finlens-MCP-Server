import type { FastifyRequest } from "fastify";
import type { VaultManager } from "../Vault/vault.manager.js";
import type { TenantContext } from "../transport/tenant-context.js";

/**
 * Builds a tenant resolver backed by the Vault: given a way to extract the
 * tenant id from a request, returns a TenantContext whose getFreshAccessToken
 * delegates to the Vault (decrypt + refresh + rotation persistence).
 */
export function makeVaultTenantResolver(
  vault: VaultManager,
  getTenantId: (req: FastifyRequest) => string | undefined,
): (req: FastifyRequest) => Promise<TenantContext> {
  return async (req) => {
    const tenantId = getTenantId(req);
    if (!tenantId) {
      throw new Error("Unable to resolve tenant: missing tenant identity on request.");
    }
    return {
      tenantId,
      getFreshAccessToken: () => vault.getFreshAccessToken(tenantId),
    };
  };
}

/**
 * Phase-2 dev bridge: reads the tenant id from a request header
 * (default X-Finlens-Tenant). Phase 3 replaces this with WorkOS bearer
 * validation as the tenant-identity source.
 */
export function headerTenantId(
  headerName = "x-finlens-tenant",
): (req: FastifyRequest) => string | undefined {
  return (req) => {
    const value = req.headers[headerName];
    return Array.isArray(value) ? value[0] : value;
  };
}

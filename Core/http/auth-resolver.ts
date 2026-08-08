import type { FastifyRequest } from "fastify";
import type { AuthInfo } from "../Auth/auth.service.js";
import type { TenantContext } from "../transport/tenant-context.js";
import type { FreshAccessToken } from "../Vault/vault.manager.js";
import { NoConnectionError, RefreshPermanentError } from "../Vault/vault.manager.js";

export interface AuthTenantResolverDeps {
  tenantService: {
    findOrCreate(identity: {
      workosUserId: string;
      workosOrgId: string | null;
      email: string | null;
    }): Promise<string>;
  };
  vault: {
    getFreshAccessToken(tenantId: string): Promise<FreshAccessToken>;
    getConnectionByTenant(tenantId: string): Promise<unknown | null>;
  };
  /** Mints a browser-usable Intuit authorize URL for a tenant. */
  buildConnectUrl: (tenantId: string) => string;
}

/**
 * Phase-3 tenant resolver: maps the verified WorkOS identity on the request to
 * an internal tenant, and builds a TenantContext whose getFreshAccessToken is
 * Vault-backed. A missing/dead connection is translated into an actionable
 * error carrying the connect URL, so any QB tool call surfaces a reconnect link.
 */
export function makeAuthTenantResolver(
  deps: AuthTenantResolverDeps,
): (req: FastifyRequest) => Promise<TenantContext> {
  return async (req) => {
    const authInfo = (req as FastifyRequest & { authInfo?: AuthInfo }).authInfo;
    if (!authInfo) {
      throw new Error("Unauthenticated request reached the tenant resolver.");
    }

    const tenantId = await deps.tenantService.findOrCreate({
      workosUserId: authInfo.workosUserId,
      workosOrgId: authInfo.workosOrgId,
      email: authInfo.email,
    });

    // Observability: confirms distinct WorkOS users map to distinct tenants
    // (a collision here would mean the token's `sub` isn't per-user).
    // eslint-disable-next-line no-console
    console.info(
      `[tenant] workosUser=${authInfo.workosUserId} org=${authInfo.workosOrgId ?? "-"} -> tenant=${tenantId}`,
    );

    return {
      tenantId,
      getConnectUrl: () => deps.buildConnectUrl(tenantId),
      isConnected: async () => (await deps.vault.getConnectionByTenant(tenantId)) !== null,
      getFreshAccessToken: async () => {
        try {
          return await deps.vault.getFreshAccessToken(tenantId);
        } catch (err) {
          if (err instanceof NoConnectionError || err instanceof RefreshPermanentError) {
            throw new Error(
              `QuickBooks is not connected for this workspace. ` +
                `Open this link to connect (or reconnect): ${deps.buildConnectUrl(tenantId)}`,
            );
          }
          throw err;
        }
      },
    };
  };
}

import { buildApp, type BuildAppOptions } from "./http/app.js";
import { devTenantResolver } from "./dev/dev-resolver.js";
import { makeVaultTenantResolver, headerTenantId } from "./http/vault-resolver.js";
import { makeAuthTenantResolver } from "./http/auth-resolver.js";
import { setAuditSink } from "./http/handle-mcp-request.js";
import { getTenantContext } from "./transport/tenant-context.js";
import { buildVaultFromEnv } from "./Vault/index.js";
import { closeDb, getDb } from "./Vault/db/client.js";
import { DrizzleConnectionRepo } from "./Vault/db/connection-repo.drizzle.js";
import { DrizzleAuditRepo } from "./Vault/db/audit-repo.drizzle.js";
import { AuditLogger } from "./Vault/audit.logger.js";
import { RefreshCron } from "./Vault/refresh.cron.js";
import type { VaultManager } from "./Vault/vault.manager.js";
import { WorkOSAuthProvider } from "./Auth/auth.service.js";
import { TenantService } from "./Auth/tenant-service.js";
import { DrizzleTenantRepo } from "./Auth/db/tenant-repo.drizzle.js";
import {
  buildProtectedResourceMetadata,
  makeBearerPreHandler,
  resourceMetadataUrl,
} from "./Auth/http.js";
import { ACCOUNTING_SCOPE, makeIntuitConnectClient } from "./http/intuit-connect-client.js";
import { buildAuthorizeUrl, type ConnectRouteDeps } from "./http/connect.route.js";

interface Background {
  start(): void;
  shutdown(): Promise<void>;
}

// Wires audit logging (tool-call rows) + the token-refresh cron for a
// DB-backed mode. Both write to Neon; audit is fire-and-forget with a graceful
// final flush, and the cron shares VaultManager's per-tenant refresh coalescing.
function setupBackground(vault: VaultManager): Background {
  const auditLogger = new AuditLogger(new DrizzleAuditRepo(getDb()), { flushIntervalMs: 2000 });
  setAuditSink((record) => {
    const ctx = getTenantContext();
    auditLogger.record({ ...record, tenantId: ctx?.tenantId ?? null, realmId: ctx?.realmId ?? null });
  });
  const cron = new RefreshCron({ repo: new DrizzleConnectionRepo(getDb()), vault });
  return {
    start() {
      auditLogger.start();
      cron.start();
    },
    async shutdown() {
      cron.stop();
      await auditLogger.flush();
      auditLogger.stop();
    },
  };
}

// Three modes by configuration:
//   - WorkOS (WORKOS_ISSUER + MCP_RESOURCE_URL): full auth + Intuit connect flow.
//   - vault-header (DATABASE_URL only): Vault-backed, tenant from X-Finlens-Tenant.
//   - dev (neither): single tenant from global QB env (no DB, no audit/cron).
function build(): { options: BuildAppOptions; mode: string; background?: Background } {
  if (process.env.WORKOS_ISSUER && process.env.MCP_RESOURCE_URL) {
    const resource = process.env.MCP_RESOURCE_URL;
    const issuer = process.env.WORKOS_ISSUER;
    const stateSecret = process.env.INTUIT_STATE_SECRET;
    if (!stateSecret) {
      throw new Error("INTUIT_STATE_SECRET is required in WorkOS mode.");
    }
    const environment: "sandbox" | "production" =
      process.env.QUICKBOOKS_ENVIRONMENT === "production" ? "production" : "sandbox";

    const authProvider = WorkOSAuthProvider.fromEnv();
    const vault = buildVaultFromEnv();
    const tenantService = new TenantService(new DrizzleTenantRepo(getDb()));
    const bearerPreHandler = makeBearerPreHandler({
      authProvider,
      resourceMetadataUrl: resourceMetadataUrl(resource),
    });

    const connectShared = {
      makeConnectClient: () => makeIntuitConnectClient(environment),
      accountingScope: ACCOUNTING_SCOPE,
      stateSecret,
    };
    const connectRoutes: ConnectRouteDeps = {
      bearerPreHandler,
      tenantService,
      vault,
      environment,
      ...connectShared,
    };
    const resolveTenant = makeAuthTenantResolver({
      vault,
      tenantService,
      buildConnectUrl: (tenantId) => buildAuthorizeUrl(tenantId, connectShared),
    });

    return {
      mode: "workos",
      background: setupBackground(vault),
      options: {
        resolveTenant,
        mcpPreHandler: bearerPreHandler,
        wellKnownMetadata: buildProtectedResourceMetadata({
          resource,
          authorizationServers: [issuer],
          // Advertise the scopes WorkOS AuthKit actually issues (OIDC + refresh).
          scopesSupported: ["openid", "profile", "email", "offline_access"],
        }),
        connectRoutes,
      },
    };
  }

  if (process.env.DATABASE_URL) {
    const vault = buildVaultFromEnv();
    return {
      mode: "vault-header",
      background: setupBackground(vault),
      options: { resolveTenant: makeVaultTenantResolver(vault, headerTenantId()) },
    };
  }

  return { mode: "dev", options: { resolveTenant: async () => devTenantResolver() } };
}

const { options, mode, background } = build();
const app = buildApp(options);
const port = Number(process.env.PORT ?? 8080);

app
  .listen({ host: "0.0.0.0", port })
  .then((addr) => {
    background?.start();
    app.log.info(`Finlens MCP server listening on ${addr} (mode=${mode})`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

async function shutdown(signal: string): Promise<void> {
  app.log.info(`Received ${signal}, shutting down…`);
  try {
    await app.close();
    await background?.shutdown();
    await closeDb();
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

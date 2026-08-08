import { buildApp, type BuildAppOptions } from "./http/app.js";
import { devTenantResolver } from "./dev/dev-resolver.js";
import { makeVaultTenantResolver, headerTenantId } from "./http/vault-resolver.js";
import { makeAuthTenantResolver } from "./http/auth-resolver.js";
import { buildVaultFromEnv } from "./Vault/index.js";
import { closeDb, getDb } from "./Vault/db/client.js";
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

// Multi-tenant HTTP entry point (Fly / container CMD). Single-tenant stdio stays
// at src/index.ts. Three modes by configuration:
//   - WorkOS (WORKOS_ISSUER + MCP_RESOURCE_URL): full auth + Intuit connect flow.
//   - vault-header (DATABASE_URL only): Vault-backed, tenant from X-Finlens-Tenant.
//   - dev (neither): single tenant from global QB env.
function buildOptions(): { options: BuildAppOptions; mode: string } {
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
      options: {
        resolveTenant,
        mcpPreHandler: bearerPreHandler,
        wellKnownMetadata: buildProtectedResourceMetadata({
          resource,
          authorizationServers: [issuer],
          scopesSupported: ["quickbooks.read", "quickbooks.write"],
        }),
        connectRoutes,
      },
    };
  }

  if (process.env.DATABASE_URL) {
    return {
      mode: "vault-header",
      options: { resolveTenant: makeVaultTenantResolver(buildVaultFromEnv(), headerTenantId()) },
    };
  }

  return { mode: "dev", options: { resolveTenant: async () => devTenantResolver() } };
}

const { options, mode } = buildOptions();
const app = buildApp(options);
const port = Number(process.env.PORT ?? 8080);

app
  .listen({ host: "0.0.0.0", port })
  .then((addr) => {
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
    await closeDb();
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

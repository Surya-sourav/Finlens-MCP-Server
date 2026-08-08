import { buildApp } from "./http/app.js";
import { devTenantResolver } from "./dev/dev-resolver.js";
import { makeVaultTenantResolver, headerTenantId } from "./http/vault-resolver.js";
import { buildVaultFromEnv } from "./Vault/index.js";
import { closeDb } from "./Vault/db/client.js";

// Multi-tenant HTTP entry point (the Fly / container CMD). The single-tenant
// stdio entry point remains at src/index.ts for local/desktop use.
//
// Tenant resolution:
//  - DATABASE_URL set → Vault-backed. Phase 2 sources the tenant id from the
//    X-Finlens-Tenant header (dev bridge); Phase 3 swaps in WorkOS bearer auth.
//  - otherwise → the Phase-1 dev resolver (single tenant from global QB env).
const useVault = Boolean(process.env.DATABASE_URL);
const resolveTenant = useVault
  ? makeVaultTenantResolver(buildVaultFromEnv(), headerTenantId())
  : async () => devTenantResolver();

const app = buildApp({ resolveTenant });
const port = Number(process.env.PORT ?? 8080);

app
  .listen({ host: "0.0.0.0", port })
  .then((addr) => {
    app.log.info(`Finlens MCP server listening on ${addr} (vault=${useVault})`);
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

import { getDb } from "./db/client.js";
import { DrizzleConnectionRepo } from "./db/connection-repo.drizzle.js";
import { LocalKeyProvider } from "./crypto/key-provider.js";
import { makeIntuitOAuthClient } from "./oauth-client-factory.js";
import { VaultManager } from "./vault.manager.js";

/**
 * Composition root for the Vault: wires the Neon-backed repo, the env-based
 * AES-256-GCM key provider, and the intuit-oauth client factory into a
 * VaultManager. Requires DATABASE_URL and FINLENS_MASTER_KEY.
 */
export function buildVaultFromEnv(): VaultManager {
  return new VaultManager({
    repo: new DrizzleConnectionRepo(getDb()),
    keyProvider: LocalKeyProvider.fromEnv(),
    makeOAuthClient: makeIntuitOAuthClient,
  });
}

export { VaultManager } from "./vault.manager.js";
export type { OAuthClientLike, FreshAccessToken } from "./vault.manager.js";

import OAuthClient from "intuit-oauth";
import type { QboCredentials, TenantContext } from "../transport/tenant-context.js";

/**
 * Phase-1 development shim. Produces a single "dev tenant" whose QuickBooks
 * credentials come from the global QUICKBOOKS_* env vars, refreshed on demand
 * via intuit-oauth. Its only purpose is to exercise the real
 * ALS → resolver → QuickbooksClient.buildForTenant path end-to-end over HTTP
 * BEFORE the Vault (Phase 2) exists. It is NOT multi-tenant and NOT for
 * production — Phase 2 replaces it with a Vault-backed resolver.
 */
async function getDevCredentials(): Promise<QboCredentials> {
  const clientId = process.env.QUICKBOOKS_CLIENT_ID;
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET;
  const refreshToken = process.env.QUICKBOOKS_REFRESH_TOKEN;
  const realmId = process.env.QUICKBOOKS_REALM_ID;
  const environment = process.env.QUICKBOOKS_ENVIRONMENT || "sandbox";

  if (!clientId || !clientSecret || !refreshToken || !realmId) {
    throw new Error(
      "dev-resolver requires QUICKBOOKS_CLIENT_ID, QUICKBOOKS_CLIENT_SECRET, " +
        "QUICKBOOKS_REFRESH_TOKEN and QUICKBOOKS_REALM_ID to be set in the environment.",
    );
  }

  const oauth = new OAuthClient({
    clientId,
    clientSecret,
    environment,
    redirectUri: process.env.QUICKBOOKS_REDIRECT_URI || "http://localhost:8000/callback",
  });

  // Refresh on every call — fine for a low-volume dev shim; the Vault handles
  // caching + rotation persistence in Phase 2.
  const response = await oauth.refreshUsingToken(refreshToken);
  const token = response.token as unknown as { access_token: string };

  return {
    accessToken: token.access_token,
    realmId,
    isSandbox: environment === "sandbox",
  };
}

export function devTenantResolver(): TenantContext {
  return {
    tenantId: "dev-tenant",
    realmId: process.env.QUICKBOOKS_REALM_ID,
    getFreshAccessToken: getDevCredentials,
  };
}

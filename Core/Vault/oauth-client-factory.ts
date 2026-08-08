import OAuthClient from "intuit-oauth";
import type { OAuthClientLike } from "./vault.manager.js";

/**
 * Builds an intuit-oauth client for a given environment using the shared QB app
 * credentials (the same across all tenants). Used by the Vault to refresh and
 * revoke per-tenant tokens.
 */
export function makeIntuitOAuthClient(environment: "sandbox" | "production"): OAuthClientLike {
  const clientId = process.env.QUICKBOOKS_CLIENT_ID;
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET are required.");
  }
  return new OAuthClient({
    clientId,
    clientSecret,
    environment,
    redirectUri: process.env.QUICKBOOKS_REDIRECT_URI || "http://localhost:8000/callback",
  }) as unknown as OAuthClientLike;
}

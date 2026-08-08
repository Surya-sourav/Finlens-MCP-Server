import OAuthClient from "intuit-oauth";
import type { IntuitConnectClient } from "./connect.route.js";

/** The Intuit Accounting scope constant, surfaced for the connect flow. */
export const ACCOUNTING_SCOPE: string = OAuthClient.scopes.Accounting as string;

/**
 * Adapts intuit-oauth's OAuthClient to the IntuitConnectClient the connect flow
 * expects. Uses the shared QB app credentials and the hosted redirect URI
 * (QUICKBOOKS_REDIRECT_URI must be registered as https://<host>/callback).
 */
export function makeIntuitConnectClient(environment: "sandbox" | "production"): IntuitConnectClient {
  const clientId = process.env.QUICKBOOKS_CLIENT_ID;
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET are required.");
  }
  const client = new OAuthClient({
    clientId,
    clientSecret,
    environment,
    redirectUri: process.env.QUICKBOOKS_REDIRECT_URI || "http://localhost:8000/callback",
  });
  return {
    authorizeUri: (opts) => client.authorizeUri(opts).toString(),
    createToken: (url) =>
      client.createToken(url) as unknown as ReturnType<IntuitConnectClient["createToken"]>,
  };
}

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { signState, verifyState } from "../Auth/state.js";
import type { UpsertFromCallbackInput } from "../Vault/vault.manager.js";

/** The slice of intuit-oauth's OAuthClient the connect flow uses. */
export interface IntuitConnectClient {
  authorizeUri(opts: { scope: string[]; state: string }): string;
  createToken(url: string): Promise<{
    token: {
      refresh_token?: string;
      realmId?: string;
      access_token?: string;
      expires_in?: number;
      x_refresh_token_expires_in?: number;
    };
  }>;
}

export interface ConnectRouteDeps {
  /** Applied to /connect (authenticated); /callback is public but state-signed. */
  bearerPreHandler: preHandlerHookHandler;
  tenantService: {
    findOrCreate(identity: {
      workosUserId: string;
      workosOrgId: string | null;
      email: string | null;
    }): Promise<string>;
  };
  vault: {
    upsertConnectionFromCallback(tenantId: string, input: UpsertFromCallbackInput): Promise<unknown>;
  };
  makeConnectClient: () => IntuitConnectClient;
  accountingScope: string;
  stateSecret: string;
  environment: "sandbox" | "production";
  now?: () => number;
  newNonce?: () => string;
}

const SUCCESS_HTML = `<!doctype html><html><body style="font-family:Arial;text-align:center;margin-top:20vh">
<h2 style="color:#2E8B57">✓ QuickBooks connected</h2><p>You can close this window and return to Claude.</p>
</body></html>`;

export interface AuthorizeUrlDeps {
  makeConnectClient: () => IntuitConnectClient;
  accountingScope: string;
  stateSecret: string;
  now?: () => number;
  newNonce?: () => string;
}

/**
 * Mints a browser-usable Intuit authorize URL for a tenant, embedding an
 * HMAC-signed `state` that binds the flow to that tenant. Shared by the /connect
 * route and the not-connected / connect_quickbooks UX.
 */
export function buildAuthorizeUrl(tenantId: string, deps: AuthorizeUrlDeps): string {
  const now = deps.now ?? (() => Date.now());
  const newNonce = deps.newNonce ?? (() => randomUUID());
  const state = signState({ tenantId, nonce: newNonce() }, deps.stateSecret, { now: now() });
  return deps.makeConnectClient().authorizeUri({ scope: [deps.accountingScope], state });
}

/**
 * Registers the server-side Intuit OAuth connect flow:
 *  - GET /connect  (bearer): resolve tenant → sign state → 302 to Intuit authorize.
 *  - GET /callback (public): verify signed state → exchange code → store in Vault.
 * The signed `state` is how the tenant is recovered on /callback, since Intuit's
 * redirect cannot carry the WorkOS bearer.
 */
export function registerConnectRoutes(app: FastifyInstance, deps: ConnectRouteDeps): void {
  const now = deps.now ?? (() => Date.now());

  app.get("/connect", { preHandler: deps.bearerPreHandler }, async (req: FastifyRequest, reply: FastifyReply) => {
    const authInfo = req.authInfo!;
    const tenantId = await deps.tenantService.findOrCreate({
      workosUserId: authInfo.workosUserId,
      workosOrgId: authInfo.workosOrgId,
      email: authInfo.email,
    });
    const url = buildAuthorizeUrl(tenantId, deps);
    return reply.redirect(url);
  });

  app.get("/callback", async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as { code?: string; state?: string; realmId?: string };
    if (!q.code || !q.state) {
      return reply.code(400).type("text/plain").send("Missing authorization code or state.");
    }

    let tenantId: string;
    try {
      tenantId = verifyState(q.state, deps.stateSecret, { now: now() }).tenantId;
    } catch {
      return reply.code(400).type("text/plain").send("Invalid or expired state.");
    }

    let token: Awaited<ReturnType<IntuitConnectClient["createToken"]>>["token"];
    try {
      const response = await deps.makeConnectClient().createToken(req.url);
      token = response.token;
    } catch {
      return reply.code(502).type("text/plain").send("Failed to exchange authorization code with Intuit.");
    }

    const realmId = token.realmId ?? q.realmId;
    if (!token.refresh_token || !token.access_token || !realmId) {
      return reply.code(502).type("text/plain").send("Incomplete token response from Intuit.");
    }

    await deps.vault.upsertConnectionFromCallback(tenantId, {
      realmId,
      refreshToken: token.refresh_token,
      accessToken: token.access_token,
      expiresIn: token.expires_in ?? 3600,
      xRefreshTokenExpiresIn: token.x_refresh_token_expires_in ?? 100 * 24 * 3600,
      environment: deps.environment,
    });

    return reply.code(200).type("text/html").send(SUCCESS_HTML);
  });
}

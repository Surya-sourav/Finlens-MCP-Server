import type { ConnectionRepo, ConnectionRow } from "./connection-repo.js";
import type { KeyProvider } from "./crypto/key-provider.js";
import { decryptSecret, encryptSecret } from "./crypto/envelope.js";

/** Minimal slice of intuit-oauth's OAuthClient the Vault needs. */
export interface OAuthClientLike {
  refreshUsingToken(refreshToken: string): Promise<{
    token: {
      access_token: string;
      expires_in?: number;
      refresh_token?: string;
      x_refresh_token_expires_in?: number;
    };
  }>;
  /** Optional: best-effort remote token revocation. */
  revoke?(params: { token: string }): Promise<unknown>;
}

export interface FreshAccessToken {
  accessToken: string;
  realmId: string;
  isSandbox: boolean;
}

export interface UpsertFromCallbackInput {
  realmId: string;
  refreshToken: string;
  accessToken: string;
  expiresIn: number;
  xRefreshTokenExpiresIn: number;
  environment: "sandbox" | "production";
}

export interface VaultManagerDeps {
  repo: ConnectionRepo;
  keyProvider: KeyProvider;
  makeOAuthClient: (environment: "sandbox" | "production") => OAuthClientLike;
  now?: () => number;
  accessBufferMs?: number;
}

/** Tenant has no active QuickBooks connection. */
export class NoConnectionError extends Error {}
/** Refresh token is dead (invalid_grant/expired/revoked) — not retryable. */
export class RefreshPermanentError extends Error {}
/** Transient failure (network/5xx) — safe to retry later. */
export class RefreshTransientError extends Error {}

const DEFAULT_ACCESS_BUFFER_MS = 5 * 60 * 1000;

/**
 * Owns the per-tenant QuickBooks token lifecycle: store (encrypted), read,
 * refresh-with-rotation-persistence, and revoke. Encryption (AES-256-GCM,
 * AAD = tenant id) lives here; all persistence goes through ConnectionRepo.
 */
export class VaultManager {
  private readonly repo: ConnectionRepo;
  private readonly keyProvider: KeyProvider;
  private readonly makeOAuthClient: (environment: "sandbox" | "production") => OAuthClientLike;
  private readonly now: () => number;
  private readonly accessBufferMs: number;

  // Per-tenant in-flight refresh de-duplication: concurrent callers (and the
  // refresh cron) for the same tenant await one refresh, so the rotating
  // refresh token is never spent twice.
  private readonly inFlight = new Map<string, Promise<FreshAccessToken>>();

  constructor(deps: VaultManagerDeps) {
    this.repo = deps.repo;
    this.keyProvider = deps.keyProvider;
    this.makeOAuthClient = deps.makeOAuthClient;
    this.now = deps.now ?? (() => Date.now());
    this.accessBufferMs = deps.accessBufferMs ?? DEFAULT_ACCESS_BUFFER_MS;
  }

  getConnectionByTenant(tenantId: string): Promise<ConnectionRow | null> {
    return this.repo.getActiveByTenant(tenantId);
  }

  /** Stores tokens (encrypted, AAD=tenantId) as the tenant's active connection. */
  async upsertConnectionFromCallback(
    tenantId: string,
    input: UpsertFromCallbackInput,
  ): Promise<ConnectionRow> {
    const nowMs = this.now();
    const [encRefreshToken, encAccessToken] = await Promise.all([
      encryptSecret(input.refreshToken, this.keyProvider, tenantId),
      encryptSecret(input.accessToken, this.keyProvider, tenantId),
    ]);
    return this.repo.upsertActive({
      tenantId,
      realmId: input.realmId,
      encRefreshToken,
      encAccessToken,
      accessTokenExpiresAt: new Date(nowMs + input.expiresIn * 1000),
      refreshTokenExpiresAt: new Date(nowMs + input.xRefreshTokenExpiresIn * 1000),
      environment: input.environment,
    });
  }

  /**
   * Returns a valid access token for the tenant. Serves the cached token when
   * still fresh; otherwise refreshes (de-duplicated per tenant), persisting the
   * new access token and any rotated refresh token.
   */
  async getFreshAccessToken(tenantId: string): Promise<FreshAccessToken> {
    const conn = await this.repo.getActiveByTenant(tenantId);
    if (!conn) {
      throw new NoConnectionError(`No active QuickBooks connection for tenant ${tenantId}.`);
    }

    if (
      conn.encAccessToken &&
      conn.accessTokenExpiresAt &&
      conn.accessTokenExpiresAt.getTime() > this.now() + this.accessBufferMs
    ) {
      const accessToken = await decryptSecret(conn.encAccessToken, this.keyProvider, tenantId);
      return { accessToken, realmId: conn.realmId, isSandbox: conn.environment === "sandbox" };
    }

    const existing = this.inFlight.get(tenantId);
    if (existing) return existing;

    const promise = this.refreshAndPersist(conn).finally(() => this.inFlight.delete(tenantId));
    this.inFlight.set(tenantId, promise);
    return promise;
  }

  /** Best-effort remote revoke, then mark the connection revoked locally. */
  async revokeConnection(tenantId: string): Promise<void> {
    const conn = await this.repo.getActiveByTenant(tenantId);
    if (!conn) return;
    const client = this.makeOAuthClient(conn.environment);
    if (client.revoke) {
      try {
        const refreshToken = await decryptSecret(conn.encRefreshToken, this.keyProvider, tenantId);
        await client.revoke({ token: refreshToken });
      } catch {
        // Revoke is best-effort; mark revoked locally regardless.
      }
    }
    await this.repo.markStatus(conn.id, "revoked");
  }

  private async refreshAndPersist(conn: ConnectionRow): Promise<FreshAccessToken> {
    const refreshPlain = await decryptSecret(conn.encRefreshToken, this.keyProvider, conn.tenantId);

    let token: Awaited<ReturnType<OAuthClientLike["refreshUsingToken"]>>["token"];
    try {
      const response = await this.makeOAuthClient(conn.environment).refreshUsingToken(refreshPlain);
      token = response.token;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.isPermanentRefreshFailure(err, message)) {
        await this.repo.markStatus(conn.id, "error");
        throw new RefreshPermanentError(message);
      }
      throw new RefreshTransientError(message);
    }

    const nowMs = this.now();
    const expiresIn = token.expires_in ?? 3600;
    const encAccessToken = await encryptSecret(token.access_token, this.keyProvider, conn.tenantId);

    const update: {
      encAccessToken: string;
      accessTokenExpiresAt: Date;
      encRefreshToken?: string;
      refreshTokenExpiresAt?: Date;
      lastRefreshedAt: Date;
    } = {
      encAccessToken,
      accessTokenExpiresAt: new Date(nowMs + expiresIn * 1000),
      lastRefreshedAt: new Date(nowMs),
    };

    // Intuit rotates the refresh token; persist the new one or refresh silently
    // breaks once the old value is invalidated.
    if (token.refresh_token && token.refresh_token !== refreshPlain) {
      update.encRefreshToken = await encryptSecret(token.refresh_token, this.keyProvider, conn.tenantId);
      if (typeof token.x_refresh_token_expires_in === "number") {
        update.refreshTokenExpiresAt = new Date(nowMs + token.x_refresh_token_expires_in * 1000);
      }
    }

    await this.repo.updateTokensAfterRefresh(conn.id, update);

    return {
      accessToken: token.access_token,
      realmId: conn.realmId,
      isSandbox: conn.environment === "sandbox",
    };
  }

  private isPermanentRefreshFailure(err: unknown, message: string): boolean {
    // Intuit returns invalid_grant (HTTP 400) for a dead/rotated/revoked refresh
    // token. Everything else (network, 5xx) is treated as transient/retryable.
    const statusCode = (err as { statusCode?: number; status?: number } | null)?.statusCode ??
      (err as { status?: number } | null)?.status;
    return /invalid_grant/i.test(message) || statusCode === 400;
  }
}

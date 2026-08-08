/**
 * Storage-layer view of a QuickBooks connection row. Token fields hold
 * AES-256-GCM envelope strings (never plaintext). The VaultManager owns
 * encrypt/decrypt; the repo is pure persistence. This seam keeps VaultManager
 * unit-testable with an in-memory repo and isolates all Drizzle/Neon specifics.
 */
export interface ConnectionRow {
  id: string;
  tenantId: string;
  realmId: string;
  encRefreshToken: string;
  encAccessToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date;
  environment: "sandbox" | "production";
  status: "active" | "revoked" | "error";
  lastRefreshedAt: Date | null;
}

export interface UpsertActiveInput {
  tenantId: string;
  realmId: string;
  encRefreshToken: string;
  encAccessToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date;
  environment: "sandbox" | "production";
}

export interface UpdateTokensInput {
  encAccessToken: string;
  accessTokenExpiresAt: Date;
  /** Present only when the refresh token rotated. */
  encRefreshToken?: string;
  /** Present only when the refresh token rotated. */
  refreshTokenExpiresAt?: Date;
  lastRefreshedAt: Date;
}

export interface FindExpiringParams {
  accessBefore: Date;
  refreshBefore: Date;
  limit: number;
}

export interface ConnectionRepo {
  /** The single active connection for a tenant, or null. */
  getActiveByTenant(tenantId: string): Promise<ConnectionRow | null>;
  /**
   * Atomically: revoke any other active row for the tenant, then insert or
   * update the (tenant, realm) row as the active connection. Returns the row.
   */
  upsertActive(input: UpsertActiveInput): Promise<ConnectionRow>;
  /** Persist refreshed tokens (and rotated refresh token, when present). */
  updateTokensAfterRefresh(id: string, input: UpdateTokensInput): Promise<void>;
  /** Flip a connection's status (e.g. to 'error' on dead refresh token, or 'revoked'). */
  markStatus(id: string, status: "revoked" | "error"): Promise<void>;
  /** Active connections whose access OR refresh token is nearing expiry (refresh cron). */
  findExpiring(params: FindExpiringParams): Promise<ConnectionRow[]>;
}

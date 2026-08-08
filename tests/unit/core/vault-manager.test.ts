import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type {
  ConnectionRepo,
  ConnectionRow,
  UpsertActiveInput,
  UpdateTokensInput,
  FindExpiringParams,
} from '../../../Core/Vault/connection-repo.js';

const { LocalKeyProvider } = await import('../../../Core/Vault/crypto/key-provider.js');
const { decryptSecret } = await import('../../../Core/Vault/crypto/envelope.js');
const {
  VaultManager,
  NoConnectionError,
  RefreshPermanentError,
  RefreshTransientError,
} = await import('../../../Core/Vault/vault.manager.js');

// ── In-memory repo mimicking the partial-unique "one active per tenant" rule ──
class InMemoryConnectionRepo implements ConnectionRepo {
  rows: ConnectionRow[] = [];
  private seq = 0;

  async getActiveByTenant(tenantId: string): Promise<ConnectionRow | null> {
    return this.rows.find((r) => r.tenantId === tenantId && r.status === 'active') ?? null;
  }

  async upsertActive(input: UpsertActiveInput): Promise<ConnectionRow> {
    for (const r of this.rows) {
      if (r.tenantId === input.tenantId && r.status === 'active') r.status = 'revoked';
    }
    let row = this.rows.find((r) => r.tenantId === input.tenantId && r.realmId === input.realmId);
    if (row) {
      Object.assign(row, input, { status: 'active' as const });
    } else {
      row = { id: `c${++this.seq}`, status: 'active', lastRefreshedAt: null, ...input };
      this.rows.push(row);
    }
    return { ...row };
  }

  async updateTokensAfterRefresh(id: string, input: UpdateTokensInput): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error('row not found');
    row.encAccessToken = input.encAccessToken;
    row.accessTokenExpiresAt = input.accessTokenExpiresAt;
    if (input.encRefreshToken) row.encRefreshToken = input.encRefreshToken;
    if (input.refreshTokenExpiresAt) row.refreshTokenExpiresAt = input.refreshTokenExpiresAt;
    row.lastRefreshedAt = input.lastRefreshedAt;
    row.status = 'active';
  }

  async markStatus(id: string, status: 'revoked' | 'error'): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.status = status;
  }

  async findExpiring(params: FindExpiringParams): Promise<ConnectionRow[]> {
    return this.rows
      .filter(
        (r) =>
          r.status === 'active' &&
          ((r.accessTokenExpiresAt && r.accessTokenExpiresAt <= params.accessBefore) ||
            r.refreshTokenExpiresAt <= params.refreshBefore),
      )
      .slice(0, params.limit);
  }
}

const TENANT = 'tenant-uuid-1';
const keyProvider = new LocalKeyProvider({ currentKeyId: 'k1', keys: { k1: Buffer.alloc(32, 5) } });

const refreshDispatch =
  jest.fn<
    (rt: string) => Promise<{
      token: {
        access_token: string;
        expires_in?: number;
        refresh_token?: string;
        x_refresh_token_expires_in?: number;
      };
    }>
  >();
const makeOAuthClient = () => ({ refreshUsingToken: (rt: string) => refreshDispatch(rt) });

let nowMs: number;
let repo: InMemoryConnectionRepo;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let vault: any;

function newVault() {
  return new VaultManager({
    repo,
    keyProvider,
    makeOAuthClient,
    now: () => nowMs,
    accessBufferMs: 5 * 60 * 1000,
  });
}

async function seedConnection(overrides: { expiresIn?: number; xRefresh?: number } = {}) {
  return vault.upsertConnectionFromCallback(TENANT, {
    realmId: 'realm-1',
    refreshToken: 'refresh-original',
    accessToken: 'access-original',
    expiresIn: overrides.expiresIn ?? 3600,
    xRefreshTokenExpiresIn: overrides.xRefresh ?? 100 * 24 * 3600,
    environment: 'sandbox',
  });
}

describe('VaultManager', () => {
  beforeEach(() => {
    nowMs = 1_700_000_000_000;
    repo = new InMemoryConnectionRepo();
    vault = newVault();
    refreshDispatch.mockReset();
  });

  it('getFreshAccessToken throws NoConnectionError when the tenant has no connection', async () => {
    await expect(vault.getFreshAccessToken(TENANT)).rejects.toBeInstanceOf(NoConnectionError);
  });

  it('upsertConnectionFromCallback stores tokens encrypted (not plaintext) bound to the tenant', async () => {
    await seedConnection();
    const row = await vault.getConnectionByTenant(TENANT);
    expect(row).not.toBeNull();
    expect(row.encRefreshToken).not.toContain('refresh-original');
    // Ciphertext decrypts only with the tenant id as AAD.
    expect(await decryptSecret(row.encRefreshToken, keyProvider, TENANT)).toBe('refresh-original');
    await expect(decryptSecret(row.encRefreshToken, keyProvider, 'other-tenant')).rejects.toThrow();
  });

  it('returns the cached access token without refreshing when it is still valid', async () => {
    await seedConnection({ expiresIn: 3600 });
    const creds = await vault.getFreshAccessToken(TENANT);
    expect(creds).toEqual({ accessToken: 'access-original', realmId: 'realm-1', isSandbox: true });
    expect(refreshDispatch).not.toHaveBeenCalled();
  });

  it('refreshes when the access token is expired and persists the new one', async () => {
    await seedConnection({ expiresIn: 3600 });
    nowMs += 3600 * 1000; // access token now expired
    refreshDispatch.mockResolvedValueOnce({ token: { access_token: 'access-2', expires_in: 3600 } });

    const creds = await vault.getFreshAccessToken(TENANT);

    expect(creds.accessToken).toBe('access-2');
    expect(refreshDispatch).toHaveBeenCalledWith('refresh-original');
    const row = await vault.getConnectionByTenant(TENANT);
    expect(await decryptSecret(row.encAccessToken, keyProvider, TENANT)).toBe('access-2');
  });

  it('persists a rotated refresh token and its new expiry', async () => {
    await seedConnection({ expiresIn: 3600 });
    nowMs += 3600 * 1000;
    refreshDispatch.mockResolvedValueOnce({
      token: {
        access_token: 'access-2',
        expires_in: 3600,
        refresh_token: 'refresh-rotated',
        x_refresh_token_expires_in: 100 * 24 * 3600,
      },
    });

    await vault.getFreshAccessToken(TENANT);

    const row = await vault.getConnectionByTenant(TENANT);
    expect(await decryptSecret(row.encRefreshToken, keyProvider, TENANT)).toBe('refresh-rotated');
    expect(row.refreshTokenExpiresAt.getTime()).toBe(nowMs + 100 * 24 * 3600 * 1000);
  });

  it('coalesces concurrent refreshes for the same tenant into a single call', async () => {
    await seedConnection({ expiresIn: 3600 });
    nowMs += 3600 * 1000;
    refreshDispatch.mockResolvedValue({ token: { access_token: 'access-2', expires_in: 3600 } });

    const [a, b] = await Promise.all([
      vault.getFreshAccessToken(TENANT),
      vault.getFreshAccessToken(TENANT),
    ]);

    expect(a.accessToken).toBe('access-2');
    expect(b.accessToken).toBe('access-2');
    expect(refreshDispatch).toHaveBeenCalledTimes(1);
  });

  it('marks the connection errored and throws RefreshPermanentError on invalid_grant', async () => {
    await seedConnection({ expiresIn: 3600 });
    nowMs += 3600 * 1000;
    refreshDispatch.mockRejectedValueOnce(new Error('invalid_grant'));

    await expect(vault.getFreshAccessToken(TENANT)).rejects.toBeInstanceOf(RefreshPermanentError);
    // No longer active → treated as not connected on the next call.
    expect(await vault.getConnectionByTenant(TENANT)).toBeNull();
  });

  it('throws RefreshTransientError and keeps the connection active on a network error', async () => {
    await seedConnection({ expiresIn: 3600 });
    nowMs += 3600 * 1000;
    refreshDispatch.mockRejectedValueOnce(new Error('ETIMEDOUT talking to Intuit'));

    await expect(vault.getFreshAccessToken(TENANT)).rejects.toBeInstanceOf(RefreshTransientError);
    expect(await vault.getConnectionByTenant(TENANT)).not.toBeNull(); // still active → retryable
  });

  it('revokeConnection marks the connection revoked', async () => {
    await seedConnection();
    await vault.revokeConnection(TENANT);
    expect(await vault.getConnectionByTenant(TENANT)).toBeNull();
  });
});

describe('VaultManager — revoke + failure-classification branches', () => {
  const kp = keyProvider;
  const seed = (vm: InstanceType<typeof VaultManager>) =>
    vm.upsertConnectionFromCallback(TENANT, {
      realmId: 'r',
      refreshToken: 'rt',
      accessToken: 'at',
      expiresIn: 3600,
      xRefreshTokenExpiresIn: 8_640_000,
      environment: 'sandbox',
    });
  const stubRefresh = async () => ({ token: { access_token: 'a' } });

  it('calls remote revoke (when supported) then marks revoked', async () => {
    const revoke = jest.fn(async (_o: { token: string }) => ({}));
    const vm = new VaultManager({
      repo: new InMemoryConnectionRepo(),
      keyProvider: kp,
      makeOAuthClient: () => ({ refreshUsingToken: stubRefresh, revoke }),
      now: () => 1_700_000_000_000,
    });
    await seed(vm);
    await vm.revokeConnection(TENANT);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(await vm.getConnectionByTenant(TENANT)).toBeNull();
  });

  it('marks revoked even when remote revoke throws', async () => {
    const revoke = jest.fn(async () => {
      throw new Error('revoke failed');
    });
    const vm = new VaultManager({
      repo: new InMemoryConnectionRepo(),
      keyProvider: kp,
      makeOAuthClient: () => ({ refreshUsingToken: stubRefresh, revoke }),
      now: () => 1_700_000_000_000,
    });
    await seed(vm);
    await vm.revokeConnection(TENANT);
    expect(await vm.getConnectionByTenant(TENANT)).toBeNull();
  });

  it('revokeConnection is a no-op when nothing is connected', async () => {
    const vm = new VaultManager({
      repo: new InMemoryConnectionRepo(),
      keyProvider: kp,
      makeOAuthClient,
      now: () => 1,
    });
    await expect(vm.revokeConnection('nobody')).resolves.toBeUndefined();
  });

  it('classifies an HTTP 400 without invalid_grant text as a permanent failure', async () => {
    const err = Object.assign(new Error('bad request'), { statusCode: 400 });
    const refresh = jest.fn<(rt: string) => Promise<{ token: { access_token: string } }>>().mockRejectedValueOnce(err);
    let now = 0;
    const vm = new VaultManager({
      repo: new InMemoryConnectionRepo(),
      keyProvider: kp,
      makeOAuthClient: () => ({ refreshUsingToken: refresh }),
      now: () => now,
      accessBufferMs: 0,
    });
    await seed(vm);
    now = 3600 * 1000 + 1; // access token expired
    await expect(vm.getFreshAccessToken(TENANT)).rejects.toBeInstanceOf(RefreshPermanentError);
  });

  it('does not change refresh expiry when x_refresh_token_expires_in is absent on rotation', async () => {
    const refresh = jest
      .fn<
        (rt: string) => Promise<{
          token: { access_token: string; expires_in?: number; refresh_token?: string };
        }>
      >()
      .mockResolvedValueOnce({ token: { access_token: 'a2', expires_in: 3600, refresh_token: 'rotated' } });
    let now = 0;
    const repo2 = new InMemoryConnectionRepo();
    const vm = new VaultManager({
      repo: repo2,
      keyProvider: kp,
      makeOAuthClient: () => ({ refreshUsingToken: refresh }),
      now: () => now,
      accessBufferMs: 0,
    });
    await seed(vm);
    const before = (await vm.getConnectionByTenant(TENANT))!.refreshTokenExpiresAt.getTime();
    now = 3600 * 1000 + 1;
    await vm.getFreshAccessToken(TENANT);
    const conn = (await vm.getConnectionByTenant(TENANT))!;
    expect(conn.refreshTokenExpiresAt.getTime()).toBe(before); // unchanged
    expect(await decryptSecret(conn.encRefreshToken, kp, TENANT)).toBe('rotated');
  });

  it('uses a default clock/buffer when not injected', async () => {
    const vm = new VaultManager({ repo: new InMemoryConnectionRepo(), keyProvider: kp, makeOAuthClient });
    const row = await vm.upsertConnectionFromCallback(TENANT, {
      realmId: 'r',
      refreshToken: 'rt',
      accessToken: 'at',
      expiresIn: 3600,
      xRefreshTokenExpiresIn: 8_640_000,
      environment: 'sandbox',
    });
    expect(row.realmId).toBe('r');
  });

  it('defaults the access-token lifetime to 3600s when expires_in is absent', async () => {
    const refresh = jest
      .fn<(rt: string) => Promise<{ token: { access_token: string } }>>()
      .mockResolvedValueOnce({ token: { access_token: 'a2' } });
    let now = 0;
    const repo2 = new InMemoryConnectionRepo();
    const vm = new VaultManager({
      repo: repo2,
      keyProvider: kp,
      makeOAuthClient: () => ({ refreshUsingToken: refresh }),
      now: () => now,
      accessBufferMs: 0,
    });
    await seed(vm);
    now = 3600 * 1000 + 1;
    const creds = await vm.getFreshAccessToken(TENANT);
    expect(creds.accessToken).toBe('a2');
    expect((await vm.getConnectionByTenant(TENANT))!.accessTokenExpiresAt!.getTime()).toBe(now + 3600 * 1000);
  });

  it('does not rotate when the same refresh token is returned', async () => {
    const refresh = jest
      .fn<(rt: string) => Promise<{ token: { access_token: string; expires_in?: number; refresh_token?: string } }>>()
      .mockResolvedValueOnce({ token: { access_token: 'a2', expires_in: 3600, refresh_token: 'rt' } });
    let now = 0;
    const repo2 = new InMemoryConnectionRepo();
    const vm = new VaultManager({
      repo: repo2,
      keyProvider: kp,
      makeOAuthClient: () => ({ refreshUsingToken: refresh }),
      now: () => now,
      accessBufferMs: 0,
    });
    await seed(vm);
    const before = await decryptSecret((await vm.getConnectionByTenant(TENANT))!.encRefreshToken, kp, TENANT);
    now = 3600 * 1000 + 1;
    await vm.getFreshAccessToken(TENANT);
    const after = await decryptSecret((await vm.getConnectionByTenant(TENANT))!.encRefreshToken, kp, TENANT);
    expect(after).toBe(before);
  });

  it('classifies a non-Error rejection as transient (stringifying the reason)', async () => {
    const refresh = jest
      .fn<(rt: string) => Promise<{ token: { access_token: string } }>>()
      .mockRejectedValueOnce({ code: 503 }); // not an Error instance, no invalid_grant text
    let now = 0;
    const vm = new VaultManager({
      repo: new InMemoryConnectionRepo(),
      keyProvider: kp,
      makeOAuthClient: () => ({ refreshUsingToken: refresh }),
      now: () => now,
      accessBufferMs: 0,
    });
    await seed(vm);
    now = 3600 * 1000 + 1;
    await expect(vm.getFreshAccessToken(TENANT)).rejects.toBeInstanceOf(RefreshTransientError);
  });
});

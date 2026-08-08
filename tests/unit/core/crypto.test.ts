import { describe, it, expect } from '@jest/globals';

const { LocalKeyProvider, KmsKeyProvider } = await import('../../../Core/Vault/crypto/key-provider.js');
const { encryptSecret, decryptSecret } = await import('../../../Core/Vault/crypto/envelope.js');

const key32 = (fill: number): Buffer => Buffer.alloc(32, fill);

describe('LocalKeyProvider', () => {
  it('returns the current key id and its key material', async () => {
    const kp = new LocalKeyProvider({ currentKeyId: 'k1', keys: { k1: key32(1) } });
    expect(await kp.getCurrentKeyId()).toBe('k1');
    expect(await kp.getKey('k1')).toEqual(key32(1));
  });

  it('rejects a non-32-byte key at construction', () => {
    expect(() => new LocalKeyProvider({ currentKeyId: 'k1', keys: { k1: Buffer.alloc(16, 1) } })).toThrow(
      /32 bytes/,
    );
  });

  it('rejects a current key id that is not among the keys', () => {
    expect(() => new LocalKeyProvider({ currentKeyId: 'missing', keys: { k1: key32(1) } })).toThrow(
      /not present/,
    );
  });

  it('getKey throws for an unknown key id', async () => {
    const kp = new LocalKeyProvider({ currentKeyId: 'k1', keys: { k1: key32(1) } });
    await expect(kp.getKey('nope')).rejects.toThrow(/Unknown key id/);
  });

  describe('fromEnv', () => {
    it('builds from FINLENS_MASTER_KEY with the default key id', async () => {
      const kp = LocalKeyProvider.fromEnv({ FINLENS_MASTER_KEY: key32(7).toString('base64') });
      expect(await kp.getCurrentKeyId()).toBe('local-1');
      expect(await kp.getKey('local-1')).toEqual(key32(7));
    });

    it('throws when FINLENS_MASTER_KEY is missing', () => {
      expect(() => LocalKeyProvider.fromEnv({})).toThrow(/FINLENS_MASTER_KEY/);
    });

    it('throws when FINLENS_MASTER_KEY does not decode to 32 bytes', () => {
      expect(() => LocalKeyProvider.fromEnv({ FINLENS_MASTER_KEY: Buffer.alloc(10).toString('base64') })).toThrow(
        /32 bytes/,
      );
    });

    it('includes a previous key for rotation when configured', async () => {
      const kp = LocalKeyProvider.fromEnv({
        FINLENS_MASTER_KEY: key32(2).toString('base64'),
        FINLENS_MASTER_KEY_ID: 'local-2',
        FINLENS_MASTER_KEY_PREVIOUS: key32(1).toString('base64'),
        FINLENS_MASTER_KEY_PREVIOUS_ID: 'local-1',
      });
      expect(await kp.getCurrentKeyId()).toBe('local-2');
      expect(await kp.getKey('local-1')).toEqual(key32(1));
    });
  });
});

describe('KmsKeyProvider (stub)', () => {
  it('throws not-implemented for both methods', async () => {
    const kp = new KmsKeyProvider();
    await expect(kp.getCurrentKeyId()).rejects.toThrow(/not implemented/);
    await expect(kp.getKey('x')).rejects.toThrow(/not implemented/);
  });
});

describe('AES-256-GCM envelope', () => {
  const kp = new LocalKeyProvider({ currentKeyId: 'k1', keys: { k1: key32(9) } });

  it('round-trips plaintext', async () => {
    const env = await encryptSecret('super-secret-refresh-token', kp);
    expect(await decryptSecret(env, kp)).toBe('super-secret-refresh-token');
  });

  it('produces a v1:keyId:iv:tag:ct envelope', async () => {
    const parts = (await encryptSecret('x', kp)).split(':');
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('v1');
    expect(parts[1]).toBe('k1');
  });

  it('uses a fresh IV so identical plaintext encrypts to different ciphertext', async () => {
    const a = await encryptSecret('same', kp);
    const b = await encryptSecret('same', kp);
    expect(a).not.toBe(b);
    expect(await decryptSecret(a, kp)).toBe('same');
    expect(await decryptSecret(b, kp)).toBe('same');
  });

  it('binds AAD: decrypting with a different AAD fails', async () => {
    const env = await encryptSecret('v', kp, 'tenant-A');
    expect(await decryptSecret(env, kp, 'tenant-A')).toBe('v');
    await expect(decryptSecret(env, kp, 'tenant-B')).rejects.toThrow();
  });

  it('rejects a tampered ciphertext via the GCM auth tag', async () => {
    const parts = (await encryptSecret('v', kp)).split(':');
    const ct = Buffer.from(parts[4], 'base64');
    ct[0] ^= 0xff;
    parts[4] = ct.toString('base64');
    await expect(decryptSecret(parts.join(':'), kp)).rejects.toThrow();
  });

  it('rejects an unknown envelope version', async () => {
    await expect(decryptSecret('v2:k1:aa:bb:cc', kp)).rejects.toThrow(/version/);
  });

  it('rejects a malformed envelope', async () => {
    await expect(decryptSecret('not-an-envelope', kp)).rejects.toThrow(/[Mm]alformed/);
  });

  it('decrypts an envelope encrypted under a now-previous key, by its keyId', async () => {
    const oldKp = new LocalKeyProvider({ currentKeyId: 'local-1', keys: { 'local-1': key32(1) } });
    const env = await encryptSecret('rotated-secret', oldKp);
    const rotatedKp = new LocalKeyProvider({
      currentKeyId: 'local-2',
      keys: { 'local-2': key32(2), 'local-1': key32(1) },
    });
    expect(await decryptSecret(env, rotatedKp)).toBe('rotated-secret');
  });
});

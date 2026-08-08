import { describe, it, expect, beforeAll } from '@jest/globals';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JWTVerifyGetKey } from 'jose';

const { WorkOSAuthProvider, FakeAuthProvider } = await import('../../../Core/Auth/auth.service.js');

const ISSUER = 'https://test.authkit.app';
const AUDIENCE = 'https://mcp.finlens.app/mcp';

let privateKey: CryptoKey;
let jwks: JWTVerifyGetKey;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey as CryptoKey;
  const jwk = await exportJWK(kp.publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'RS256';
  jwks = createLocalJWKSet({ keys: [jwk] });
});

async function makeToken(
  claims: Record<string, unknown>,
  opts: { issuer?: string; audience?: string; sub?: string | null; exp?: string } = {},
): Promise<string> {
  let builder = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .setExpirationTime(opts.exp ?? '1h');
  if (opts.sub !== null) builder = builder.setSubject(opts.sub ?? 'user-1');
  return builder.sign(privateKey);
}

describe('WorkOSAuthProvider', () => {
  const provider = () => new WorkOSAuthProvider({ issuer: ISSUER, audience: AUDIENCE, jwks });

  it('verifies a valid token and extracts identity + scopes', async () => {
    const token = await makeToken({ org_id: 'org-9', email: 'a@b.com', scope: 'quickbooks.read quickbooks.write' });
    const info = await provider().verifyAccessToken(token);
    expect(info).toMatchObject({
      workosUserId: 'user-1',
      workosOrgId: 'org-9',
      email: 'a@b.com',
      scopes: ['quickbooks.read', 'quickbooks.write'],
    });
    expect(info.expiresAt).toBeGreaterThan(0);
  });

  it('defaults org/email/scopes when claims are absent', async () => {
    const token = await makeToken({});
    const info = await provider().verifyAccessToken(token);
    expect(info.workosOrgId).toBeNull();
    expect(info.email).toBeNull();
    expect(info.scopes).toEqual([]);
  });

  it('rejects a token with the wrong issuer', async () => {
    const token = await makeToken({}, { issuer: 'https://evil.example' });
    await expect(provider().verifyAccessToken(token)).rejects.toThrow();
  });

  it('rejects a token with the wrong audience', async () => {
    const token = await makeToken({}, { audience: 'https://other.resource' });
    await expect(provider().verifyAccessToken(token)).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const token = await makeToken({}, { exp: '-1h' });
    await expect(provider().verifyAccessToken(token)).rejects.toThrow();
  });

  it('rejects a token missing the subject claim', async () => {
    const token = await makeToken({}, { sub: null });
    await expect(provider().verifyAccessToken(token)).rejects.toThrow(/subject/i);
  });
});

describe('FakeAuthProvider', () => {
  it('returns configured AuthInfo for a known token and throws otherwise', async () => {
    const info = {
      token: 'good',
      workosUserId: 'u',
      workosOrgId: 'o',
      email: 'e@x.com',
      scopes: [],
      expiresAt: 9999999999,
    };
    const fake = new FakeAuthProvider({ good: info });
    expect(await fake.verifyAccessToken('good')).toBe(info);
    await expect(fake.verifyAccessToken('bad')).rejects.toThrow();
  });
});

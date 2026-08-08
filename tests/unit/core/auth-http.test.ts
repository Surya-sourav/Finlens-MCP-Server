import { describe, it, expect } from '@jest/globals';
import Fastify from 'fastify';
import type { AuthInfo } from '../../../Core/Auth/auth.service.js';

const { FakeAuthProvider } = await import('../../../Core/Auth/auth.service.js');
const { makeBearerPreHandler, registerWellKnownRoutes, buildProtectedResourceMetadata, resourceMetadataUrl } =
  await import('../../../Core/Auth/http.js');

const RESOURCE = 'https://mcp.finlens.app/mcp';
const ISSUER = 'https://test.authkit.app';
const metadata = buildProtectedResourceMetadata({
  resource: RESOURCE,
  authorizationServers: [ISSUER],
  scopesSupported: ['quickbooks.read', 'quickbooks.write'],
});

const validInfo: AuthInfo = {
  token: 'good',
  workosUserId: 'u1',
  workosOrgId: 'o1',
  email: 'a@b.com',
  scopes: ['quickbooks.read'],
  expiresAt: 9_999_999_999,
};
const authProvider = new FakeAuthProvider({ good: validInfo });

function buildTestApp(requiredScopes?: string[]) {
  const app = Fastify();
  registerWellKnownRoutes(app, metadata);
  const preHandler = makeBearerPreHandler({
    authProvider,
    resourceMetadataUrl: resourceMetadataUrl(RESOURCE),
    requiredScopes,
  });
  app.get('/protected', { preHandler }, async (req) => ({ user: req.authInfo?.workosUserId }));
  return app;
}

describe('well-known protected-resource metadata', () => {
  it('is served at both the root and /mcp-suffixed paths', async () => {
    const app = buildTestApp();
    for (const url of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ resource: RESOURCE, authorization_servers: [ISSUER] });
    }
    await app.close();
  });
});

describe('bearer preHandler', () => {
  it('returns 401 with a WWW-Authenticate challenge when the bearer is missing', async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('resource_metadata=');
    expect(res.headers['www-authenticate']).toContain('/.well-known/oauth-protected-resource/mcp');
    await app.close();
  });

  it('returns 401 for an invalid/expired token', async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/protected', headers: { authorization: 'Bearer nope' } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('passes and populates request.authInfo for a valid token', async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/protected', headers: { authorization: 'Bearer good' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: 'u1' });
    await app.close();
  });

  it('returns 403 insufficient_scope when a required scope is missing', async () => {
    const app = buildTestApp(['quickbooks.write']); // validInfo has only read
    const res = await app.inject({ method: 'GET', url: '/protected', headers: { authorization: 'Bearer good' } });
    expect(res.statusCode).toBe(403);
    expect(res.headers['www-authenticate']).toContain('insufficient_scope');
    await app.close();
  });
});

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/**
 * Identity extracted from a verified WorkOS access token. The tenant key is
 * (workosUserId, workosOrgId); email is stored on the tenant row.
 */
export interface AuthInfo {
  token: string;
  workosUserId: string;
  workosOrgId: string | null;
  email: string | null;
  scopes: string[];
  clientId?: string;
  /** seconds since epoch */
  expiresAt: number;
}

export interface AuthProvider {
  verifyAccessToken(token: string): Promise<AuthInfo>;
}

export interface WorkOSAuthProviderConfig {
  issuer: string;
  audience: string;
  jwks: JWTVerifyGetKey;
}

/**
 * Verifies WorkOS-issued JWT access tokens locally via JWKS (no per-request
 * network hop). All WorkOS specifics — issuer, JWKS location, claim names —
 * live here, so the rest of the system depends only on the AuthProvider seam.
 */
export class WorkOSAuthProvider implements AuthProvider {
  constructor(private readonly cfg: WorkOSAuthProviderConfig) {}

  static fromEnv(env: Record<string, string | undefined> = process.env): WorkOSAuthProvider {
    const issuer = env.WORKOS_ISSUER;
    const audience = env.MCP_RESOURCE_URL;
    if (!issuer || !audience) {
      throw new Error("WORKOS_ISSUER and MCP_RESOURCE_URL are required for WorkOS auth.");
    }
    // WorkOS AuthKit serves its OAuth JWKS at /oauth2/jwks (not the generic
    // /.well-known/jwks.json). Overridable via WORKOS_JWKS_URI.
    const jwksUri = env.WORKOS_JWKS_URI || new URL("/oauth2/jwks", issuer).toString();
    return new WorkOSAuthProvider({ issuer, audience, jwks: createRemoteJWKSet(new URL(jwksUri)) });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const { payload } = await jwtVerify(token, this.cfg.jwks, {
      // Normalize a trailing slash: the JWT `iss` has none, so `…authkit.app/`
      // in config would otherwise reject every token.
      issuer: this.cfg.issuer.replace(/\/+$/, ""),
      audience: this.cfg.audience,
    });

    const sub = payload["sub"];
    if (typeof sub !== "string" || sub.length === 0) {
      throw new Error("Access token missing subject claim.");
    }

    const orgId = payload["org_id"];
    const email = payload["email"];
    const scopeRaw = payload["scope"];
    const clientId = payload["azp"] ?? payload["client_id"];

    return {
      token,
      workosUserId: sub,
      workosOrgId: typeof orgId === "string" ? orgId : null,
      email: typeof email === "string" ? email : null,
      scopes: typeof scopeRaw === "string" ? scopeRaw.split(" ").filter(Boolean) : [],
      clientId: typeof clientId === "string" ? clientId : undefined,
      expiresAt: typeof payload.exp === "number" ? payload.exp : 0,
    };
  }
}

/** Deterministic AuthProvider for tests. */
export class FakeAuthProvider implements AuthProvider {
  constructor(private readonly tokens: Record<string, AuthInfo>) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const info = this.tokens[token];
    if (!info) {
      throw new Error("Invalid access token.");
    }
    return info;
  }
}

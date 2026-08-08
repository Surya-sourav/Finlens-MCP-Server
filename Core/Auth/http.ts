import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { AuthInfo, AuthProvider } from "./auth.service.js";

// Carry the verified identity on the request for downstream handlers/resolvers.
declare module "fastify" {
  interface FastifyRequest {
    authInfo?: AuthInfo;
  }
}

/** RFC 9728 protected-resource metadata document. */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
  bearer_methods_supported: string[];
  resource_name?: string;
}

export function buildProtectedResourceMetadata(cfg: {
  resource: string;
  authorizationServers: string[];
  scopesSupported?: string[];
  resourceName?: string;
}): ProtectedResourceMetadata {
  return {
    resource: cfg.resource,
    authorization_servers: cfg.authorizationServers,
    scopes_supported: cfg.scopesSupported,
    bearer_methods_supported: ["header"],
    resource_name: cfg.resourceName ?? "Finlens QuickBooks MCP",
  };
}

/** The RFC 9728 metadata URL for a resource (path-suffixed form). */
export function resourceMetadataUrl(resource: string): string {
  const u = new URL(resource);
  const suffix = u.pathname === "/" ? "" : u.pathname;
  return new URL(`/.well-known/oauth-protected-resource${suffix}`, u.origin).toString();
}

/** Serves the PRM document at both the root and path-suffixed well-known URLs. */
export function registerWellKnownRoutes(app: FastifyInstance, metadata: ProtectedResourceMetadata): void {
  const handler = async () => metadata;
  app.get("/.well-known/oauth-protected-resource", handler);
  app.get("/.well-known/oauth-protected-resource/mcp", handler);
}

export interface BearerAuthOptions {
  authProvider: AuthProvider;
  /** Value advertised in the WWW-Authenticate `resource_metadata` parameter. */
  resourceMetadataUrl: string;
  requiredScopes?: string[];
}

/**
 * Fastify preHandler that validates a WorkOS bearer token. Mirrors the MCP
 * bearer-auth semantics (the SDK's helper is Express-only): missing/invalid →
 * 401 with a WWW-Authenticate challenge pointing at the PRM; missing scope →
 * 403 insufficient_scope; success → attaches `request.authInfo`.
 */
export function makeBearerPreHandler(opts: BearerAuthOptions): preHandlerHookHandler {
  const challenge = (error: string, description?: string): string =>
    `Bearer error="${error}"${description ? `, error_description="${description}"` : ""}, ` +
    `resource_metadata="${opts.resourceMetadataUrl}"`;

  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      reply
        .header("WWW-Authenticate", challenge("invalid_token", "Missing bearer token"))
        .code(401)
        .send({ error: "invalid_token" });
      return reply;
    }

    const token = header.slice("Bearer ".length).trim();
    let info: AuthInfo;
    try {
      info = await opts.authProvider.verifyAccessToken(token);
    } catch {
      reply
        .header("WWW-Authenticate", challenge("invalid_token", "Invalid or expired token"))
        .code(401)
        .send({ error: "invalid_token" });
      return reply;
    }

    if (opts.requiredScopes && opts.requiredScopes.length > 0) {
      const hasAll = opts.requiredScopes.every((s) => info.scopes.includes(s));
      if (!hasAll) {
        reply
          .header("WWW-Authenticate", challenge("insufficient_scope"))
          .code(403)
          .send({ error: "insufficient_scope" });
        return reply;
      }
    }

    req.authInfo = info;
  };
}

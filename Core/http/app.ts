import Fastify, { type FastifyInstance, type FastifyRequest, type preHandlerHookHandler } from "fastify";
import { QuickbooksClient } from "../../src/clients/quickbooks-client.js";
import { getTenantContext, type TenantContext } from "../transport/tenant-context.js";
import { registerMcpRoutes } from "./mcp.route.js";
import { registerConnectRoutes, type ConnectRouteDeps } from "./connect.route.js";
import { registerWellKnownRoutes, type ProtectedResourceMetadata } from "../Auth/http.js";
import { devTenantResolver } from "../dev/dev-resolver.js";
import { FAVICON_PNG } from "./favicon.js";

export interface BuildAppOptions {
  /**
   * Resolves the tenant per request. Defaults to the Phase-1 dev resolver
   * (single tenant from global QB env). Phase 3 injects the WorkOS resolver.
   */
  resolveTenant?: (req: FastifyRequest) => Promise<TenantContext>;
  /** Bearer validator applied to POST /mcp (and reused by /connect). Phase 3. */
  mcpPreHandler?: preHandlerHookHandler;
  /** When set, serves the RFC 9728 protected-resource metadata. Phase 3. */
  wellKnownMetadata?: ProtectedResourceMetadata;
  /** When set, registers the Intuit /connect + /callback routes. Phase 3. */
  connectRoutes?: ConnectRouteDeps;
}

/**
 * Builds the multi-tenant HTTP app: the public /mcp endpoint, health check, and
 * (in Phase 3) the OAuth protected-resource metadata + Intuit connect flow.
 * Wires the QuickBooks client's DI seam so every getInstance()/
 * getAuthCredentials() inside an MCP request resolves the tenant from the
 * AsyncLocalStorage TenantContext set by handleMcpPost.
 */
export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: true });

  QuickbooksClient.useTenantResolver(() => getTenantContext());

  app.get("/healthz", async () => ({ status: "ok" }));

  // Serve the Finlens logo so MCP clients show it as the connector icon.
  const sendFavicon = async (_req: FastifyRequest, reply: import("fastify").FastifyReply) =>
    reply.header("Cache-Control", "public, max-age=86400").type("image/png").send(FAVICON_PNG);
  app.get("/favicon.ico", sendFavicon);
  app.get("/favicon.png", sendFavicon);

  if (opts.wellKnownMetadata) {
    registerWellKnownRoutes(app, opts.wellKnownMetadata);
  }
  if (opts.connectRoutes) {
    registerConnectRoutes(app, opts.connectRoutes);
  }

  const resolveTenant = opts.resolveTenant ?? (async () => devTenantResolver());
  registerMcpRoutes(app, { resolveTenant, preHandler: opts.mcpPreHandler });

  return app;
}

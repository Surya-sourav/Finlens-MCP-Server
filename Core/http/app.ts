import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { QuickbooksClient } from "../../src/clients/quickbooks-client.js";
import { getTenantContext, type TenantContext } from "../transport/tenant-context.js";
import { registerMcpRoutes } from "./mcp.route.js";
import { devTenantResolver } from "../dev/dev-resolver.js";

export interface BuildAppOptions {
  /**
   * Resolves the tenant per request. Defaults to the Phase-1 dev resolver
   * (single tenant from global QB env). Phase 3 injects the WorkOS resolver.
   */
  resolveTenant?: (req: FastifyRequest) => Promise<TenantContext>;
}

/**
 * Builds the multi-tenant HTTP app: the public /mcp endpoint plus health check.
 * Wires the QuickBooks client's DI seam so every getInstance()/
 * getAuthCredentials() inside an MCP request resolves the tenant from the
 * AsyncLocalStorage TenantContext set by handleMcpPost.
 */
export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: true });

  QuickbooksClient.useTenantResolver(() => getTenantContext());

  app.get("/healthz", async () => ({ status: "ok" }));

  const resolveTenant = opts.resolveTenant ?? (async () => devTenantResolver());
  registerMcpRoutes(app, { resolveTenant });

  return app;
}

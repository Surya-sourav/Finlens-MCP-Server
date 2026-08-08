import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleMcpPost } from "./handle-mcp-request.js";
import type { TenantContext } from "../transport/tenant-context.js";

export interface McpRouteOptions {
  /**
   * Resolves the tenant for an incoming MCP request. Phase 1 supplies the dev
   * resolver; Phase 3 swaps in WorkOS bearer validation.
   */
  resolveTenant: (req: FastifyRequest) => Promise<TenantContext>;
  /**
   * Optional preHandler for POST /mcp — the WorkOS bearer validator (Phase 3).
   * When set, an unauthenticated MCP request gets the 401 + WWW-Authenticate
   * challenge before the tenant is resolved.
   */
  preHandler?: preHandlerHookHandler;
  /**
   * Overridable POST handler (defaults to the real stateless handleMcpPost).
   * Exists so tests can assert routing/hijack behavior without a live MCP
   * transport or the 141-tool graph.
   */
  handle?: (
    req: IncomingMessage,
    res: ServerResponse,
    ctx: TenantContext,
    body: unknown,
  ) => Promise<void>;
}

/**
 * Registers the public MCP endpoint. POST carries the JSON-RPC request; in
 * stateless mode there is no server-initiated SSE stream (GET) and no session
 * to terminate (DELETE), so both return 405.
 */
export function registerMcpRoutes(app: FastifyInstance, opts: McpRouteOptions): void {
  const handle = opts.handle ?? ((req, res, ctx, body) => handleMcpPost(req, res, ctx, body));

  const postOpts = opts.preHandler ? { preHandler: opts.preHandler } : {};
  app.post("/mcp", postOpts, async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = await opts.resolveTenant(req);
    // Detach Fastify's reply lifecycle so the MCP transport streams directly to
    // the raw Node response (SSE or JSON).
    reply.hijack();
    await handle(req.raw, reply.raw, ctx, req.body);
  });

  app.get("/mcp", async (_req: FastifyRequest, reply: FastifyReply) => {
    reply
      .code(405)
      .send({ error: "Method Not Allowed: server-initiated streams are disabled in stateless mode" });
  });

  app.delete("/mcp", async (_req: FastifyRequest, reply: FastifyReply) => {
    reply
      .code(405)
      .send({ error: "Method Not Allowed: no session to terminate in stateless mode" });
  });
}

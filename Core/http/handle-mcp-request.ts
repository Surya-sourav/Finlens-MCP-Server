import type { IncomingMessage, ServerResponse } from "node:http";
import { runWithTenant, type TenantContext } from "../transport/tenant-context.js";

/**
 * Minimal structural shapes for the MCP server + transport. Kept local (instead
 * of importing the concrete SDK classes at module top) so that:
 *   1. unit tests can inject fakes, and
 *   2. importing this module never eagerly pulls in registerAllTools (and thus
 *      the ~141 tool modules) — that would drag every tool wrapper into the
 *      Jest coverage report. The real defaults are loaded lazily below.
 */
export interface McpServerLike {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
}

export interface McpTransportLike {
  handleRequest(req: IncomingMessage, res: ServerResponse, body?: unknown): Promise<void>;
  close(): Promise<void>;
}

export interface HandleMcpDeps {
  createServer: () => McpServerLike;
  registerTools: (server: McpServerLike) => void | Promise<void>;
  createTransport: () => McpTransportLike;
}

let defaultDeps: HandleMcpDeps | undefined;

// Lazily resolve the real dependencies on first use. Dynamic import keeps the
// 141-tool graph out of any test that injects its own deps.
async function getDefaultDeps(): Promise<HandleMcpDeps> {
  if (!defaultDeps) {
    const [{ QuickbooksMCPServer }, { registerAllTools }, { StreamableHTTPServerTransport }] =
      await Promise.all([
        import("../../src/server/qbo-mcp-server.js"),
        import("../../src/server/register-all-tools.js"),
        import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
      ]);
    defaultDeps = {
      createServer: () => QuickbooksMCPServer.CreateServer() as unknown as McpServerLike,
      registerTools: (server) => registerAllTools(server as never),
      // Stateless mode: no session id, a fresh transport per request. Combined
      // with a fresh server per request this prevents cross-tenant response
      // routing (single bound transport + client-chosen JSON-RPC ids).
      createTransport: () =>
        new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        }) as unknown as McpTransportLike,
    };
  }
  return defaultDeps;
}

/**
 * Handles a single POST /mcp request in stateless mode. Mints a fresh MCP
 * server + transport, registers the full tool set, and dispatches the request
 * inside the tenant's AsyncLocalStorage scope so the QuickBooks client resolves
 * this tenant's credentials. Server + transport are torn down when the response
 * closes.
 */
export async function handleMcpPost(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: TenantContext,
  body?: unknown,
  deps?: HandleMcpDeps,
): Promise<void> {
  const d = deps ?? (await getDefaultDeps());

  const server = d.createServer();
  await d.registerTools(server);
  const transport = d.createTransport();

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await runWithTenant(ctx, () => transport.handleRequest(req, res, body));
}

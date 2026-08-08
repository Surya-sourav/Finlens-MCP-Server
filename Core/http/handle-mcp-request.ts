import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getTenantContext, runWithTenant, type TenantContext } from "../transport/tenant-context.js";
import { wrapServerWithAudit } from "./audit-tool-wrapper.js";
import type { ToolAuditRecord } from "../Vault/audit.logger.js";

// Injected once at boot (Core/index.ts) when audit is enabled. Receives a
// ToolAuditRecord per tool call; the sink enriches it with the ALS tenant.
let auditSink: ((record: ToolAuditRecord) => void) | null = null;
export function setAuditSink(fn: ((record: ToolAuditRecord) => void) | null): void {
  auditSink = fn;
}

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

/**
 * Registers the Core-only `connect_quickbooks` tool on the per-request server.
 * It reads the ALS TenantContext to report connection status and surface a
 * browser-usable Intuit connect link. Lives here (not in registerAllTools) so
 * src/ stays free of any Core dependency.
 */
export function registerConnectTool(server: McpServer): void {
  server.tool(
    "connect_quickbooks",
    "Check whether QuickBooks is connected for this workspace and, if not, return a link to connect it.",
    async () => {
      const ctx = getTenantContext();
      if (!ctx) {
        return { content: [{ type: "text" as const, text: "No tenant context available." }] };
      }
      const connected = ctx.isConnected ? await ctx.isConnected() : false;
      if (connected) {
        return {
          content: [{ type: "text" as const, text: "QuickBooks is already connected for this workspace." }],
        };
      }
      const url = ctx.getConnectUrl?.();
      return {
        content: [
          {
            type: "text" as const,
            text: url
              ? `QuickBooks is not connected. Open this link to connect: ${url}`
              : "QuickBooks is not connected, and no connect URL is available in this mode.",
          },
        ],
      };
    },
  );
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
      registerTools: (server) => {
        const target = auditSink
          ? wrapServerWithAudit(server as unknown as McpServer, auditSink)
          : (server as unknown as McpServer);
        registerAllTools(target);
        registerConnectTool(target);
      },
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

  // CRITICAL: the MCP SDK dispatches each JSON-RPC message via transport.onmessage
  // WITHOUT awaiting the handler, so the tool handler runs detached from
  // handleRequest's async scope. Wrapping only handleRequest would therefore lose
  // the AsyncLocalStorage tenant context by the time a tool runs — causing
  // getTenantContext() to be undefined and the QB client to fall back to global
  // creds (a cross-tenant leak). Bind the context at the dispatch point so every
  // tool handler executes inside the correct tenant scope.
  const withOnMessage = transport as unknown as {
    onmessage?: (message: unknown, extra?: unknown) => void;
  };
  const dispatch = withOnMessage.onmessage;
  if (dispatch) {
    withOnMessage.onmessage = (message, extra) => {
      void runWithTenant(ctx, async () => {
        dispatch.call(withOnMessage, message, extra);
      }).catch(() => {
        /* handler errors are surfaced by the Protocol as JSON-RPC errors */
      });
    };
  }

  await runWithTenant(ctx, () => transport.handleRequest(req, res, body));
}

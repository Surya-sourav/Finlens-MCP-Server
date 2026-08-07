import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export class QuickbooksMCPServer {
  private static instance: McpServer | null = null;

  /**
   * Build a brand-new McpServer. The multi-tenant HTTP transport uses this to
   * mint a fresh server per request (see Core/http/handle-mcp-request.ts):
   * Protocol.connect() binds a single transport and StreamableHTTP routes by
   * client-chosen JSON-RPC id, so a server may not be shared across concurrent
   * requests without cross-delivering responses.
   */
  public static CreateServer(): McpServer {
    return new McpServer(
      {
        name: "Finlens QB Online MCP Server",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );
  }

  /**
   * Process-wide singleton used by the single-tenant stdio entry point
   * (src/index.ts). The HTTP path must use CreateServer() instead.
   */
  public static GetServer(): McpServer {
    if (QuickbooksMCPServer.instance === null) {
      QuickbooksMCPServer.instance = QuickbooksMCPServer.CreateServer();
    }
    return QuickbooksMCPServer.instance;
  }
}
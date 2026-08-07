#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { QuickbooksMCPServer } from "./server/qbo-mcp-server.js";
import { registerAllTools } from "./server/register-all-tools.js";

const main = async () => {
  // Create the single-tenant MCP server (stdio entry point). The multi-tenant
  // HTTP transport lives under Core/ and mints a fresh server per request.
  const server = QuickbooksMCPServer.GetServer();
  registerAllTools(server);

  // Start receiving messages on stdin and sending messages on stdout
  const transport = new StdioServerTransport();
  await server.connect(transport);
};

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});

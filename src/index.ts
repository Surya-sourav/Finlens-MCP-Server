#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { QuickbooksMCPServer } from "./server/qbo-mcp-server.js";
import { registerAllTools } from "./server/register-all-tools.js";
import { QuickbooksClient } from "./clients/quickbooks-client.js";

const main = async () => {
  // Single-tenant stdio entry point. There is no global fallback in the QB
  // client, so install the explicit single-tenant resolver (env QB app +
  // refresh token). The multi-tenant HTTP transport (Core/) injects a
  // Vault-backed resolver instead and never uses this path.
  QuickbooksClient.useTenantResolver(() => QuickbooksClient.singleTenantSource());

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

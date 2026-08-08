import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCrudCategory, CRUD_CATEGORY, type CrudCategory } from "../../src/helpers/register-tool.js";
import type { AuditCategory, ToolAuditRecord } from "../Vault/audit.logger.js";

const CATEGORY_MAP: Record<CrudCategory, AuditCategory> = {
  [CRUD_CATEGORY.READ]: "read",
  [CRUD_CATEGORY.WRITE]: "write",
  [CRUD_CATEGORY.UPDATE]: "update",
  [CRUD_CATEGORY.DELETE]: "delete",
};

/**
 * Returns a Proxy over the MCP server whose `.tool(...)` wraps the registered
 * handler so every invocation emits a ToolAuditRecord (tool, category, success,
 * error, duration) via `record`. Recording is best-effort at the boundary; the
 * handler's arguments, return value, and thrown errors pass through unchanged.
 * Wrapping here (Core) keeps src/ free of any audit dependency.
 */
export function wrapServerWithAudit(
  server: McpServer,
  record: (r: ToolAuditRecord) => void,
): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== "tool") {
        return Reflect.get(target, prop, receiver);
      }
      return (...args: unknown[]) => {
        const toolName = args[0] as string;
        const category = CATEGORY_MAP[getCrudCategory(toolName)];
        const original = args[args.length - 1] as (...h: unknown[]) => Promise<unknown>;

        const wrapped = async (...handlerArgs: unknown[]): Promise<unknown> => {
          const start = Date.now();
          let success = true;
          let errorMessage: string | null = null;
          try {
            const result = await original(...handlerArgs);
            if (result && typeof result === "object" && (result as { isError?: unknown }).isError) {
              success = false;
            }
            return result;
          } catch (err) {
            success = false;
            errorMessage = err instanceof Error ? err.message : String(err);
            throw err;
          } finally {
            record({ toolName, category, success, errorMessage, durationMs: Date.now() - start });
          }
        };

        const forwarded = [...args];
        forwarded[forwarded.length - 1] = wrapped;
        return (target.tool as (...a: unknown[]) => unknown)(...forwarded);
      };
    },
  });
}

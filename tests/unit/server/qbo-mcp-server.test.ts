import { describe, it, expect } from '@jest/globals';

// The server factory only constructs an McpServer from the SDK — no QB env needed.
const { QuickbooksMCPServer } = await import('../../../src/server/qbo-mcp-server');

describe('QuickbooksMCPServer', () => {
  it('CreateServer returns a fresh, distinct instance on every call', () => {
    const a = QuickbooksMCPServer.CreateServer();
    const b = QuickbooksMCPServer.CreateServer();
    expect(a).not.toBe(b);
  });

  it('GetServer returns a stable process-wide singleton', () => {
    const a = QuickbooksMCPServer.GetServer();
    const b = QuickbooksMCPServer.GetServer();
    expect(a).toBe(b);
  });

  it('GetServer does not return the same instance as an ad-hoc CreateServer', () => {
    expect(QuickbooksMCPServer.GetServer()).not.toBe(QuickbooksMCPServer.CreateServer());
  });
});

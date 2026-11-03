import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** Registers `lookup_order` and `issue_refund`; `record` gets each call with the `_meta` it arrived with. */
export function registerSupportTools(
  server: McpServer,
  record: (call: { tool: string; args: Record<string, unknown>; meta?: Record<string, unknown> }) => void,
): void;

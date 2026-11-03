// A real stdio MCP server, built with the official MCP SDK, for the proxy command's test.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'support', version: '1.0.0' });
server.registerTool(
  'lookup_order',
  { description: 'Read an order by id.', inputSchema: { order_id: z.string() }, annotations: { readOnlyHint: true } },
  async ({ order_id }) => ({ content: [{ type: 'text', text: JSON.stringify({ id: order_id, total_eur: 40 }) }] }),
);
server.registerTool(
  'issue_refund',
  { description: 'Refund an order, in euros.', inputSchema: { order_id: z.string(), amount_eur: z.number() }, annotations: { destructiveHint: true } },
  async ({ amount_eur }) => ({ content: [{ type: 'text', text: `refunded ${amount_eur}` }] }),
);
await server.connect(new StdioServerTransport());

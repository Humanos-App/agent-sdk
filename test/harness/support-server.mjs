// A real stdio MCP server, built with the official MCP SDK: the support desk's tools (support-tools.mjs). With
// SUPPORT_JOURNAL set, each call it receives is appended there as a JSON line, for a test in another process to read.
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerSupportTools } from './support-tools.mjs';

const journal = process.env.SUPPORT_JOURNAL;
const server = new McpServer({ name: 'support', version: '1.0.0' });
registerSupportTools(server, (call) => journal && appendFileSync(journal, JSON.stringify(call) + '\n'));
await server.connect(new StdioServerTransport());

/**
 * The support desk's MCP server, real (the official MCP SDK), two ways: over stdio as its own process, and over
 * Streamable HTTP in the test's process. Each keeps the calls it received, with their `_meta`, so a test sees what
 * reached the server and what never did.
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerSupportTools } from './support-tools.mjs';

export interface ReceivedCall {
  tool: string;
  args: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

/** The stdio server: the command that starts it, and the calls it journalled. */
export function stdioSupportServer(): { command: string; args: string[]; env: Record<string, string>; received(): ReceivedCall[] } {
  const journal = join(mkdtempSync(join(tmpdir(), 'support-journal-')), 'calls.jsonl');
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL('./support-server.mjs', import.meta.url))],
    env: { SUPPORT_JOURNAL: journal },
    received: () => (existsSync(journal) ? readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as ReceivedCall) : []),
  };
}

/** The HTTP server, stateless: each request gets its own server and transport, as the MCP SDK's stateless mode has it. */
export async function httpSupportServer(): Promise<{ url: string; received: ReceivedCall[]; close(): Promise<void> }> {
  const received: ReceivedCall[] = [];
  const http: Server = createServer((req, res) => {
    void (async () => {
      const server = new McpServer({ name: 'support', version: '1.0.0' });
      registerSupportTools(server, (call) => received.push(call));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => void transport.close().then(() => server.close()));
      await server.connect(transport);
      await transport.handleRequest(req, res);
    })().catch((e: unknown) => {
      if (!res.headersSent) res.writeHead(500).end(String(e));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, received, close: () => new Promise((resolve) => http.close(() => resolve())) };
}

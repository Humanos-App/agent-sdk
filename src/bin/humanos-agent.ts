#!/usr/bin/env node
/**
 * `humanos-agent` — the agent's Humanos from the terminal. Its stdout belongs to the MCP host for `proxy`, so every
 * message here goes to stderr.
 */
import { startProxyCommand } from '../cli/proxy.js';
import { createStdioTransport } from '../mcp/stdio.js';

const [command, ...rest] = process.argv.slice(2);

async function main(): Promise<void> {
  switch (command) {
    case 'proxy': {
      const proxy = await startProxyCommand(rest);
      createStdioTransport().run(proxy);
      return;
    }
    default:
      process.stderr.write('usage: humanos-agent proxy --service <name> -- <command> [args…]\n');
      process.exitCode = 2;
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`humanos-agent: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});

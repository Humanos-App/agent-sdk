#!/usr/bin/env node
/**
 * `humanos-agent` — the agent's Humanos from the terminal. Its stdout belongs to the MCP host for `proxy`, so every
 * message here goes to stderr.
 */
import { claudeHookCommand } from '../cli/hook.js';
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
    case 'hook': {
      if (rest[0] !== 'claude') return usage();
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      // A PreToolUse that fails here must still answer deny: a hook command that errors is let through.
      process.stdout.write(await claudeHookCommand(Buffer.concat(chunks).toString('utf8')));
      return;
    }
    default:
      return usage();
  }
}

function usage(): void {
  process.stderr.write(['usage: humanos-agent proxy --service <name> -- <command> [args…]', '       humanos-agent hook claude'].join('\n') + '\n');
  process.exitCode = 2;
}

main().catch((e: unknown) => {
  process.stderr.write(`humanos-agent: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});

#!/usr/bin/env node
/**
 * `humanos-agent` — the agent's Humanos from the terminal: `init` (the framework, `.env`, registering, declaring, the
 * interception), `register`, `declare`, `status`, `restore`; and what hosts run: `hook claude`, `proxy`. The stdout of
 * `hook` and `proxy` belongs to the host, so they write nothing else there.
 */
import { declareCommand, registerCommand, statusCommand } from '../cli/agent.js';
import { processContext } from '../cli/context.js';
import { claudeHookCommand } from '../cli/hook.js';
import { initCommand, restoreCommand } from '../cli/init.js';
import { startProxyCommand } from '../cli/proxy.js';
import { createStdioTransport } from '../mcp/stdio.js';

const [command, ...rest] = process.argv.slice(2);

const USAGE = [
  'usage: humanos-agent init [--framework ai-sdk|claude-agent-sdk|langchain|custom] [--yes]',
  '       humanos-agent register',
  '       humanos-agent declare [--mcp <file>] [--entry <module> --framework ai-sdk|langchain --service <name> [--export <name>]]',
  '       humanos-agent status',
  '       humanos-agent restore [--force]',
  '       humanos-agent hook claude              (run by Claude Agent SDK from .claude/settings.json)',
  '       humanos-agent proxy --service <name> -- <command> [args…]   (run by a routed MCP entry)',
].join('\n');

async function main(): Promise<void> {
  const ctx = processContext();
  switch (command) {
    case 'init':
      await initCommand(rest, ctx);
      return;
    case 'register':
      await registerCommand(rest, ctx);
      return;
    case 'declare':
      await declareCommand(rest, ctx);
      return;
    case 'status':
      await statusCommand(rest, ctx);
      return;
    case 'restore':
      await restoreCommand(rest, ctx);
      return;
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
  process.stderr.write(`${USAGE}\n`);
  process.exitCode = 2;
}

main().catch((e: unknown) => {
  process.stderr.write(`humanos-agent: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});

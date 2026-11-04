#!/usr/bin/env node
/**
 * `humanos` — the agent's Humanos from the terminal: `init` (the framework, `.env`, registering, declaring, the
 * interception), `register`, `declare`, `status`, `restore`, `help`; and what hosts run: `hook claude`, `proxy`. The
 * stdout of `hook` and `proxy` belongs to the host, so they write nothing else there.
 */
import { declareCommand, registerCommand, statusCommand } from '../cli/agent.js';
import { processContext } from '../cli/context.js';
import { claudeHookCommand } from '../cli/hook.js';
import { initCommand, restoreCommand } from '../cli/init.js';
import { startProxyCommand } from '../cli/proxy.js';
import { createStdioTransport } from '../mcp/stdio.js';
import { SDK_VERSION } from '../version.js';

const [command, ...rest] = process.argv.slice(2);
/** The options that are the CLI's own: what comes after `--` is the command `proxy` runs. */
const own = rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest;

export const HELP = `humanos ${SDK_VERSION}: every tool call your agent makes, checked by Humanos before it runs.

Usage: npx humanos <command> [options]

Commands:
  init       Set Humanos up in this project: finds your framework, checks .env for your API key, registers
             the agent, declares the MCP servers in .mcp.json, and installs the checks (Claude Agent SDK:
             hooks in .claude/settings.json; other frameworks: the lines to add, printed).
               --framework ai-sdk|claude-agent-sdk|langchain|custom   skip the question
               --yes                                                  do not ask when there is one answer
  register   Register the agent's key (created on the first run) and show its DID and grade.
  declare    Declare tools to Humanos.
               --mcp <file>                       the servers in an MCP config file (default .mcp.json)
               --entry <module> --framework ai-sdk|langchain --service <name> [--export <name>]
                                                  the tools a module exports
  status     Show the agent and each declared tool's access under its policy.
  restore    Undo every file change init made, from its backups; the agent's key stays.
               --force                            also put back a file changed since init
  help       Show this help (also --help, -h, or <command> --help). --version shows the version.

Run by your agent, not by you:
  hook claude                                 Claude Agent SDK's hook, from .claude/settings.json
  proxy --service <name> -- <command> [args]  the governing proxy in front of a stdio MCP server

Examples:
  npx humanos init
  npx humanos init --framework ai-sdk --yes
  npx humanos declare --mcp .mcp.json
  npx humanos status
  npx humanos restore
`;

async function main(): Promise<void> {
  if (command === undefined || command === 'help' || command === '--help' || command === '-h' || own.includes('--help')) {
    process.stdout.write(HELP);
    if (command === undefined) process.exitCode = 2; // nothing to do: the help, as an error
    return;
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${SDK_VERSION}\n`);
    return;
  }
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
      if (rest[0] !== 'claude') return unknown();
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      // A PreToolUse that fails here must still answer deny: a hook command that errors is let through.
      process.stdout.write(await claudeHookCommand(Buffer.concat(chunks).toString('utf8')));
      return;
    }
    default:
      return unknown();
  }
}

function unknown(): void {
  process.stderr.write(`humanos: unknown command "${[command, ...rest].join(' ')}"\n\n${HELP}`);
  process.exitCode = 2;
}

main().catch((e: unknown) => {
  process.stderr.write(`humanos: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});

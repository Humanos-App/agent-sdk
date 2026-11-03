/**
 * Claude Agent SDK, for real: `query()` runs the Claude Code engine against the scripted model
 * (`ANTHROPIC_BASE_URL`). The agent's tools are an in-process SDK MCP server; MCP servers are `mcpServers` entries.
 * Two ways in: the hooks in code (`claudeAgentSdk().gate()`), and no code at all, the hook commands `init` writes into
 * `.claude/settings.json` (`humanos-agent hook claude`), which also governs the engine's built-in tools.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { claudeAgentSdk } from '../../src/adapters/claude-agent-sdk.js';
import { agentScene, BIN } from '../harness/agent.js';
import { startModelServer } from '../harness/model-server.js';
import { runContract, type FrameworkDriver, type RunContext } from './contract.js';

const shapeOf = (schema: Record<string, unknown>) =>
  Object.fromEntries(Object.entries((schema.properties ?? {}) as Record<string, { type: string }>).map(([k, p]) => [k, p.type === 'number' ? z.number() : z.string()]));

/**
 * The scenario's own tools as an in-process SDK MCP server: a tool that throws answers `isError`, as SDK tools do.
 * `alwaysLoad`: the engine otherwise defers MCP tools behind tool search, which a scripted model does not run; the
 * calls go through the same hooks either way.
 */
const supportServer = (ctx: RunContext) => ({
  name: 'support',
  version: '1.0.0',
  alwaysLoad: true,
  tools: ctx.tools.map((t) =>
    tool(t.name, t.description, shapeOf(t.inputSchema), async (args: Record<string, unknown>) => {
      try {
        return { content: [{ type: 'text' as const, text: JSON.stringify(await t.execute(args)) }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    }),
  ),
});

/** The scenario's MCP servers as `mcpServers` entries; a stdio one carries what the proxy it may run behind needs. */
const serverEntries = (ctx: RunContext): Record<string, Record<string, unknown>> => ({
  ...(ctx.mcp.stdio ? { [ctx.mcp.stdio.service]: { type: 'stdio', command: ctx.mcp.stdio.command, args: ctx.mcp.stdio.args, env: { ...ctx.mcp.stdio.env, ...ctx.env }, alwaysLoad: true } } : {}),
  ...(ctx.mcp.http ? { [ctx.mcp.http.service]: { type: 'http', url: ctx.mcp.http.url, alwaysLoad: true } } : {}),
});

/** The engine's environment: the scripted model, no traffic beyond it, a config directory of its own. */
const engineEnv = (ctx: RunContext) => ({
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'claude-config-')),
  ANTHROPIC_BASE_URL: ctx.model.url,
  ANTHROPIC_API_KEY: 'sk-ant-local-test',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  ...ctx.env,
});

async function drain(run: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of run) void _;
}

const inCode: FrameworkDriver = {
  name: 'Claude Agent SDK (hooks in code)',
  async run(ctx) {
    const humanos = await claudeAgentSdk(ctx.via);
    const servers: Record<string, unknown> = { ...humanos.mcpServers(serverEntries(ctx), ctx.proxy) };
    if (ctx.tools.length) servers.support = createSdkMcpServer(humanos.sdkServer(supportServer(ctx), ctx.service));
    await drain(
      query({
        prompt: ctx.prompt,
        options: {
          cwd: ctx.dir,
          settingSources: [],
          mcpServers: servers as never,
          hooks: humanos.gate() as never,
          allowedTools: Object.keys(servers).map((s) => `mcp__${s}`),
          maxTurns: 6,
          env: engineEnv(ctx),
        },
      }),
    );
  },
};

/** The hooks `init` writes for Claude Agent SDK, run from the built CLI. */
function writeSettingsHooks(dir: string): void {
  const hook = { type: 'command', command: `${process.execPath} ${BIN} hook claude` };
  const hooks = Object.fromEntries(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].map((e) => [e, [{ matcher: '*', hooks: [hook] }]]));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks }, null, 2));
}

const noCode: FrameworkDriver = {
  name: 'Claude Agent SDK (no code: settings hooks)',
  skip: {
    declare: 'an agent with no Humanos code declares nothing itself; `humanos-agent declare` and the platform’s observed tools do',
    'mcp-stdio': 'its stdio server is not routed, so no proxy declares it; the hook still checks each call once',
  },
  async run(ctx) {
    writeSettingsHooks(ctx.dir);
    const servers: Record<string, unknown> = { ...serverEntries(ctx) };
    if (ctx.tools.length) servers.support = createSdkMcpServer(supportServer(ctx));
    await drain(
      query({
        prompt: ctx.prompt,
        options: { cwd: ctx.dir, settingSources: ['project'], mcpServers: servers as never, allowedTools: Object.keys(servers).map((s) => `mcp__${s}`), maxTurns: 6, env: engineEnv(ctx) },
      }),
    );
  },
};

runContract(inCode);
runContract(noCode);

describe('Claude Agent SDK built-in tools, with no code: the settings hook governs Bash', () => {
  const runBash = async (access: 'allow' | 'deny') => {
    const scene = await agentScene({ Bash: access });
    const model = await startModelServer([{ calls: [{ name: 'Bash', input: { command: 'echo ran > ran.txt', description: 'write a file' } }] }]);
    try {
      writeSettingsHooks(scene.dir);
      const ctx = { model, env: scene.env } as RunContext;
      await drain(query({ prompt: 'Write the file.', options: { cwd: scene.dir, settingSources: ['project'], allowedTools: ['Bash'], maxTurns: 3, env: engineEnv(ctx) } }));
      return { scene, ran: existsSync(join(scene.dir, 'ran.txt')), results: model.toolResults() };
    } finally {
      await model.close();
      await scene.close();
    }
  };

  it('a denied Bash call never runs, and the model is told why', async () => {
    const { scene, ran, results } = await runBash('deny');
    expect(ran).toBe(false);
    expect(scene.decisions).toMatchObject([{ tool: 'Bash', decision: 'deny', reason: 'policy_denied' }]);
    expect(results[0]!.text).toContain('policy_denied');
  });

  it('an allowed Bash call runs, and its outcome is reported from the other hook process', async () => {
    const { scene, ran } = await runBash('allow');
    expect(ran).toBe(true);
    expect(scene.outcomes).toEqual([{ decisionEventId: scene.decisions[0]!.eventId, outcome: 'completed' }]);
  });
});

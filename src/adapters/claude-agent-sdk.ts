/**
 * CLAUDE AGENT SDK — `@humanos-ai/agent-sdk/claude-agent-sdk`. Every tool call the agent makes, its built-in tools
 * (`Bash`, `Write`, `Edit`, …) as well as its MCP servers', is checked in a `PreToolUse` hook and settled in
 * `PostToolUse` / `PostToolUseFailure` (the hooks: `claude-hooks.ts`). Humanos only ever refuses: an allowed call goes
 * on to the agent's own permissions, which still decide it.
 *
 * Two ways in, the same checks: `gate()` gives the hooks for `query({ options: { hooks } })`; with no code at all,
 * `humanos init` writes the same hooks as commands into `.claude/settings.json` (`humanos hook claude`),
 * which the SDK loads by default. A call Humanos cannot check is refused (the hook fails closed).
 *
 * Declaring: `sdkServer` declares an in-process server's tools with their schemas; the proxy a stdio server routed by
 * `mcpServers` runs behind declares its; built-in tools are recorded as observed on their first call.
 */
import { z } from 'zod';
import type { GuardCheck } from '../guard.js';
import type { DeclaredTool } from '../mcp/declare.js';
import type { Via, ViaOptions } from '../via.js';
import { claudeHooks, type ClaudeHooks } from './claude-hooks.js';
import { routeStdioEntries, viaFrom } from './shared.js';

export { BUILT_IN_SERVICE, claudeHooks, denyCall } from './claude-hooks.js';
export type { ClaudeHookInput, ClaudeHookOutput, ClaudeHooks, PendingCalls } from './claude-hooks.js';

/** An in-process `createSdkMcpServer` tool, as `tool()` makes it. */
interface SdkTool {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  annotations?: DeclaredTool['annotations'];
}

/** `createSdkMcpServer`'s options, as far as Humanos reads them. */
export interface SdkServerOptions {
  name: string;
  version?: string;
  tools?: SdkTool[];
}

/** An `options.mcpServers` entry, as far as Humanos reads it. */
export interface McpServerEntry {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ClaudeAgentSdkHumanos {
  via: Via;
  /** The hooks for `query({ options: { hooks } })`, ahead of any `existing` ones, which are kept. */
  gate(existing?: ClaudeHooks): ClaudeHooks;
  /** `createSdkMcpServer`'s options as given, its tools declared under `service` (default: the server's name). */
  sdkServer<T extends SdkServerOptions>(options: T, service?: string): T;
  /** `options.mcpServers` with each stdio entry routed behind the proxy, which checks and declares its tools; the gate leaves them to it. */
  mcpServers<T extends Record<string, McpServerEntry | object>>(servers: T, proxy?: { command: string; args: readonly string[] }): T;
}

export async function claudeAgentSdk(from?: Via | ViaOptions): Promise<ClaudeAgentSdkHumanos> {
  const v = await viaFrom(from);
  const services = new Map<string, string>();
  const calls = new Map<string, Pick<GuardCheck, 'decisionId' | 'mandateId'>>();
  const pending = {
    put: (id: string, c: Pick<GuardCheck, 'decisionId' | 'mandateId'>) => void calls.set(id, c),
    take: (id: string) => {
      const c = calls.get(id);
      calls.delete(id);
      return c;
    },
  };
  const hooks = claudeHooks(v, pending, (s) => services.get(s) ?? s);

  return {
    via: v,
    gate(existing = {}) {
      const ours: ClaudeHooks = {
        // `block`: a hook that fails refuses the call rather than letting it through.
        PreToolUse: [{ hooks: [(input) => hooks.preToolUse(input)], onFailure: 'block' }],
        PostToolUse: [{ hooks: [(input) => hooks.postToolUse(input)] }],
        PostToolUseFailure: [{ hooks: [(input) => hooks.postToolUse(input)] }],
      };
      const merged: ClaudeHooks = { ...existing };
      for (const [event, matchers] of Object.entries(ours)) merged[event] = [...matchers!, ...(existing[event] ?? [])];
      return merged;
    },
    sdkServer(options, service = options.name) {
      services.set(options.name, service);
      const tools: DeclaredTool[] = (options.tools ?? []).map((t) => ({
        name: t.name,
        service,
        ...(t.description ? { description: t.description } : {}),
        inputSchema: z.toJSONSchema(z.object(t.inputSchema)) as Record<string, unknown>,
        ...(t.annotations ? { annotations: t.annotations } : {}),
      }));
      if (tools.length) void v.tools.add(tools).catch(() => {}); // the registry warns on a failed declaration
      return options;
    },
    mcpServers: (servers, proxy) => routeStdioEntries(v, servers, proxy),
  };
}

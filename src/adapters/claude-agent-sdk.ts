/**
 * CLAUDE AGENT SDK — `@humanos/agent-sdk/claude-agent-sdk`. Every tool call the agent makes, its built-in tools
 * (`Bash`, `Write`, `Edit`, …) as well as its MCP servers', is checked in a `PreToolUse` hook and settled in
 * `PostToolUse` / `PostToolUseFailure`. Humanos only ever refuses: an allowed call goes on to the agent's own
 * permissions, which still decide it.
 *
 * Two ways in, the same checks: `gate()` gives the hooks for `query({ options: { hooks } })`; with no code at all,
 * `humanos-agent init` writes the same hooks as commands into `.claude/settings.json` (`humanos-agent hook claude`),
 * which the SDK loads by default. A call Humanos cannot check is refused (the hook fails closed).
 *
 * Names: an MCP tool arrives as `mcp__<server>__<tool>` and is checked as `<tool>` under the server's service (the
 * one `sdkServer` or `mcpServers` gave it, else the server's name); a built-in tool under `Claude Agent SDK`.
 * Declaring: `sdkServer` declares an in-process server's tools with their schemas; the proxy a routed stdio server
 * runs behind declares its; built-in tools are recorded as observed on their first call.
 */
import { z } from 'zod';
import type { GuardCheck } from '../guard.js';
import type { DeclaredTool } from '../mcp/declare.js';
import type { Via, ViaOptions } from '../via.js';
import { blocked, unreachable, viaFrom } from './shared.js';

/** The service Claude Agent SDK's built-in tools are checked under. */
export const BUILT_IN_SERVICE = 'Claude Agent SDK';

/** A hook's input, as the SDK and Claude Code send it (the fields Humanos reads). */
export interface ClaudeHookInput {
  hook_event_name: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  tool_response?: unknown;
  error?: string;
  cwd?: string;
  mcp_server?: { name: string; source?: string };
}

/** What a hook answers: nothing (go on), or a `PreToolUse` deny with the reason the model reads. */
export type ClaudeHookOutput = { hookSpecificOutput?: { hookEventName: 'PreToolUse'; permissionDecision: 'deny'; permissionDecisionReason: string } };

type HookCallback = (input: ClaudeHookInput, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<ClaudeHookOutput>;
type HookMatcher = { matcher?: string; hooks: HookCallback[]; timeout?: number; onFailure?: 'continue' | 'block' };
/** `options.hooks`, as `query` takes them. */
export type ClaudeHooks = Partial<Record<string, HookMatcher[]>>;

/** Where a checked call waits for its outcome: in memory for `gate`, in a file for the command hook. */
export interface PendingCalls {
  put(toolUseId: string, checked: Pick<GuardCheck, 'decisionId' | 'mandateId'>): void | Promise<void>;
  take(toolUseId: string): Pick<GuardCheck, 'decisionId' | 'mandateId'> | undefined | Promise<Pick<GuardCheck, 'decisionId' | 'mandateId'> | undefined>;
}

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

/** The three hooks, over any store: what `gate` and `humanos-agent hook claude` both run. */
export function claudeHooks(v: Via, pending: PendingCalls, serviceOf: (server: string) => string = (s) => s) {
  const named = (input: ClaudeHookInput): { service: string; tool: string } => {
    const name = input.tool_name ?? '';
    const parts = name.split('__');
    if (parts[0] === 'mcp' && parts.length >= 3) return { service: serviceOf(input.mcp_server?.name ?? parts[1]!), tool: parts.slice(2).join('__') };
    return { service: BUILT_IN_SERVICE, tool: name };
  };
  const deny = (reason: string): ClaudeHookOutput => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

  return {
    async preToolUse(input: ClaudeHookInput): Promise<ClaudeHookOutput> {
      const { service, tool } = named(input);
      if (v.mcp.checks(service, tool)) return {}; // the proxy in front of that server checks it
      let checked: GuardCheck;
      try {
        checked = await v.guard.check(tool, (input.tool_input ?? {}) as Record<string, unknown>);
      } catch (e) {
        return deny(unreachable(e)); // fail closed: a call Humanos cannot check does not run
      }
      if (!checked.proceed) return deny(blocked(checked.reason));
      if (input.tool_use_id) await pending.put(input.tool_use_id, { ...(checked.decisionId ? { decisionId: checked.decisionId } : {}), ...(checked.mandateId ? { mandateId: checked.mandateId } : {}) });
      return {}; // allowed by Humanos: the agent's own permissions still decide
    },
    async postToolUse(input: ClaudeHookInput): Promise<ClaudeHookOutput> {
      const checked = input.tool_use_id ? await pending.take(input.tool_use_id) : undefined;
      if (checked) await v.guard.settle(checked, failureOf(input));
      return {};
    },
  };
}

/** What became of a call: `PostToolUseFailure`'s error, or an MCP result the tool marked as an error. */
function failureOf(input: ClaudeHookInput): { error?: string } {
  if (input.hook_event_name === 'PostToolUseFailure') return { error: input.error || 'the tool failed' };
  const r = input.tool_response as { isError?: boolean; content?: { type?: string; text?: string }[] } | undefined;
  if (!r || typeof r !== 'object' || !r.isError) return {};
  return { error: (r.content ?? []).map((c) => c.text ?? '').join('\n') || 'the tool reported an error' };
}

export async function claudeAgentSdk(from?: Via | ViaOptions): Promise<ClaudeAgentSdkHumanos> {
  const v = await viaFrom(from);
  const services = new Map<string, string>();
  const calls = new Map<string, Pick<GuardCheck, 'decisionId' | 'mandateId'>>();
  const hooks = claudeHooks(v, { put: (id, c) => void calls.set(id, c), take: (id) => { const c = calls.get(id); calls.delete(id); return c; } }, (s) => services.get(s) ?? s);

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
    mcpServers(servers, proxy) {
      const out: Record<string, unknown> = {};
      for (const [name, entry] of Object.entries(servers)) {
        const e = entry as McpServerEntry;
        if (!e.command || (e.type !== undefined && e.type !== 'stdio')) {
          out[name] = entry;
          continue;
        }
        const routed = v.mcp.route({ service: name, command: e.command, ...(e.args ? { args: e.args } : {}), ...(e.env ? { env: e.env } : {}) }, proxy);
        out[name] = { ...e, command: routed.command, args: routed.args };
      }
      return out as typeof servers;
    },
  };
}

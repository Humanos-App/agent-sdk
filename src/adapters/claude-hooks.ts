/**
 * CLAUDE AGENT SDK HOOKS — what decides each Claude tool call, shared by `claudeAgentSdk().gate()` (hooks in code) and
 * `humanos-agent hook claude` (hooks as commands in `.claude/settings.json`). Kept apart from the adapter so the CLI
 * loads nothing a project may not have installed (the adapter's `sdkServer` needs zod; these hooks do not).
 *
 * `PreToolUse` checks the call: refused, it answers deny with the reason; allowed, it says nothing, so the agent's own
 * permissions still decide (Humanos only ever refuses); Humanos unreachable, it denies (fail closed). `PostToolUse` and
 * `PostToolUseFailure` settle it. Between the two, the decision waits in a `PendingCalls` store: in memory in code, in a
 * file for the command, since each command runs in its own process.
 *
 * Names: an MCP tool arrives as `mcp__<server>__<tool>` and is checked as `<tool>` under the server's service; a
 * built-in tool (`Bash`, `Write`, `Edit`, …) by its name, under `Claude Agent SDK`.
 */
import type { GuardCheck } from '../guard.js';
import type { Via } from '../via.js';
import { checkCall } from './shared.js';

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

/** A `PreToolUse` deny, with the words the model reads. */
export const denyCall = (reason: string): ClaudeHookOutput => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
});

/** The hooks over a store: what `gate` and `humanos-agent hook claude` both run. `serviceOf` names a server's service. */
export function claudeHooks(v: Via, pending: PendingCalls, serviceOf: (server: string) => string = (s) => s) {
  const named = (input: ClaudeHookInput): { service: string; tool: string } => {
    const name = input.tool_name ?? '';
    const parts = name.split('__');
    if (parts[0] === 'mcp' && parts.length >= 3) return { service: serviceOf(input.mcp_server?.name ?? parts[1]!), tool: parts.slice(2).join('__') };
    return { service: BUILT_IN_SERVICE, tool: name };
  };

  return {
    async preToolUse(input: ClaudeHookInput): Promise<ClaudeHookOutput> {
      const { service, tool } = named(input);
      if (v.mcp.checks(service, tool)) return {}; // the proxy in front of that server checks it
      const call = await checkCall(v, tool, (input.tool_input ?? {}) as Record<string, unknown>);
      if (!call.ok) return denyCall(call.message);
      const { decisionId, mandateId } = call.checked;
      if (input.tool_use_id) await pending.put(input.tool_use_id, { ...(decisionId ? { decisionId } : {}), ...(mandateId ? { mandateId } : {}) });
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

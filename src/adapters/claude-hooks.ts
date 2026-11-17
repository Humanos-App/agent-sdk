/**
 * CLAUDE AGENT SDK HOOKS — what decides each Claude tool call, shared by `claudeAgentSdk().gate()` (hooks in code) and
 * `humanos hook claude` (hooks as commands in `.claude/settings.json`). Kept apart from the adapter so the CLI
 * loads nothing a project may not have installed (the adapter's `sdkServer` needs zod; these hooks do not).
 *
 * `PreToolUse` checks the call: refused, it answers deny with the reason; allowed, it says nothing, so the agent's own
 * permissions still decide (Humanos only ever refuses); Humanos unreachable, it denies (fail closed). `PostToolUse` and
 * `PostToolUseFailure` settle it. Between the two, the decision waits in a `PendingCalls` store: in memory in code, in a
 * file for the command, since each command runs in its own process.
 *
 * Each call reports its context (#654): the model the session started on (`SessionStart`, kept in the same store), and
 * from the session's transcript the model that answered, its message's id and tokens; the run time from `PostToolUse`.
 *
 * Names: an MCP tool arrives as `mcp__<server>__<tool>` and is checked as `<tool>` under the server's service; a
 * built-in tool (`Bash`, `Write`, `Edit`, …) by its name, under `Claude Agent SDK`.
 */
import type { GuardCheck } from '../guard.js';
import type { Via } from '../via.js';
import { callContext, installedVersion, type CallContext } from '../context.js';
import { checkCall } from './shared.js';
import { transcriptStep } from './utils/claude-transcript.js';

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
  session_id?: string;
  transcript_path?: string;
  /** `SessionStart`'s: the model the session runs on. */
  model?: string;
  /** `PostToolUse`'s: how long the tool ran. */
  duration_ms?: number;
}

/** What a hook answers: nothing (go on), or a `PreToolUse` deny with the reason the model reads. */
export type ClaudeHookOutput = { hookSpecificOutput?: { hookEventName: 'PreToolUse'; permissionDecision: 'deny'; permissionDecisionReason: string } };

type HookCallback = (input: ClaudeHookInput, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<ClaudeHookOutput>;
type HookMatcher = { matcher?: string; hooks: HookCallback[]; timeout?: number; onFailure?: 'continue' | 'block' };
/** `options.hooks`, as `query` takes them. */
export type ClaudeHooks = Partial<Record<string, HookMatcher[]>>;

/** A call let through, as it waits for its outcome: its decision, and when the tool was let run (epoch ms). */
export type PendingCall = Pick<GuardCheck, 'decisionId' | 'mandateId'> & { startedAt?: number };

/** Where a checked call waits for its outcome, and a session's model for its calls: in memory for `gate`, in files for the command hook. */
export interface PendingCalls {
  put(toolUseId: string, checked: PendingCall): void | Promise<void>;
  take(toolUseId: string): PendingCall | undefined | Promise<PendingCall | undefined>;
  startSession(sessionId: string, model: string): void | Promise<void>;
  sessionModel(sessionId: string): string | undefined | Promise<string | undefined>;
}

/** A `PreToolUse` deny, with the words the model reads. */
export const denyCall = (reason: string): ClaudeHookOutput => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
});

/** The hooks over a store: what `gate` and `humanos hook claude` both run. `serviceOf` names a server's service. */
export function claudeHooks(v: Via, pending: PendingCalls, serviceOf: (server: string) => string = (s) => s) {
  const named = (input: ClaudeHookInput): { service: string; tool: string } => {
    const name = input.tool_name ?? '';
    const parts = name.split('__');
    if (parts[0] === 'mcp' && parts.length >= 3) return { service: serviceOf(input.mcp_server?.name ?? parts[1]!), tool: parts.slice(2).join('__') };
    return { service: BUILT_IN_SERVICE, tool: name };
  };

  /** The call's context: the session's model, and the transcript's message that asked for the call. */
  const contextOf = async (input: ClaudeHookInput): Promise<CallContext> => {
    const [requested, step, version] = await Promise.all([
      input.session_id ? pending.sessionModel(input.session_id) : undefined,
      transcriptStep(input.transcript_path, input.tool_use_id),
      installedVersion('@anthropic-ai/claude-agent-sdk'),
    ]);
    return callContext({ name: 'claude-agent-sdk', ...(version ? { version } : {}) }, { ...step, ...(requested ? { requested } : {}) });
  };

  return {
    async sessionStart(input: ClaudeHookInput): Promise<ClaudeHookOutput> {
      if (input.session_id && input.model) await pending.startSession(input.session_id, input.model);
      return {};
    },
    async preToolUse(input: ClaudeHookInput): Promise<ClaudeHookOutput> {
      const { service, tool } = named(input);
      if (v.mcp.checks(service, tool)) return {}; // the proxy in front of that server checks it
      const call = await checkCall(v, tool, (input.tool_input ?? {}) as Record<string, unknown>, await contextOf(input));
      if (!call.ok) return denyCall(call.message);
      const { decisionId, mandateId } = call.checked;
      if (input.tool_use_id)
        await pending.put(input.tool_use_id, { ...(decisionId ? { decisionId } : {}), ...(mandateId ? { mandateId } : {}), startedAt: Date.now() });
      return {}; // allowed by Humanos: the agent's own permissions still decide
    },
    async postToolUse(input: ClaudeHookInput): Promise<ClaudeHookOutput> {
      const pendingCall = input.tool_use_id ? await pending.take(input.tool_use_id) : undefined;
      if (!pendingCall) return {};
      const { startedAt, ...checked } = pendingCall;
      // Claude's own count when it sends one; else from the check, which a permission prompt in between lengthens.
      const durationMs = typeof input.duration_ms === 'number' ? input.duration_ms : startedAt !== undefined ? Date.now() - startedAt : undefined;
      await v.guard.settle(checked, { ...failureOf(input), ...(durationMs !== undefined ? { durationMs } : {}) });
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

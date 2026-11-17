/**
 * `humanos hook claude` — the Claude Agent SDK hooks as a command, for an agent with no Humanos code: `init`
 * writes it into `.claude/settings.json` for `PreToolUse`, `PostToolUse` and `PostToolUseFailure`. The SDK runs it
 * with the hook's input on stdin; it answers on stdout.
 *
 * Each call runs it twice, in two processes, so the decision the outcome is reported against waits in
 * `.humanos/pending/<tool_use_id>.json` between them; `SessionStart` keeps the session's model for its calls in
 * `.humanos/pending/sessions.json` (#654). The agent is the project's (`via({ cwd })` from the hook's `cwd`). It fails
 * closed: a `PreToolUse` it cannot check, for any reason, answers deny.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeHooks, denyCall, type ClaudeHookInput, type PendingCalls } from '../adapters/claude-hooks.js';
import { unreachable } from '../adapters/shared.js';
import { agentDir, environment, via, type ViaOptions } from '../via.js';

/** The sessions whose model `sessions.json` keeps: the most recent ones. */
const SESSIONS_KEPT = 100;

/** The pending decisions, one file each, and the sessions' models, readable only by the agent's owner. */
function pendingFiles(dir: string): PendingCalls {
  const file = (id: string) => join(dir, `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  const sessionsFile = join(dir, 'sessions.json');
  const sessions = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(sessionsFile, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  };
  return {
    startSession(id, model) {
      const kept = Object.entries({ ...sessions(), [id]: model }).slice(-SESSIONS_KEPT);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(sessionsFile, JSON.stringify(Object.fromEntries(kept)), { mode: 0o600 });
    },
    sessionModel: (id) => sessions()[id],
    put(id, checked) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(file(id), JSON.stringify(checked), { mode: 0o600 });
    },
    take(id) {
      try {
        const checked = JSON.parse(readFileSync(file(id), 'utf8')) as ReturnType<PendingCalls['take']>;
        unlinkSync(file(id));
        return checked;
      } catch {
        return undefined; // a call this hook never let through, or one already settled
      }
    },
  };
}

/** One hook run: the input as the SDK sent it, the output to print (empty: nothing to say). */
export async function claudeHookCommand(stdin: string, options: ViaOptions = {}): Promise<string> {
  let input: ClaudeHookInput;
  try {
    input = JSON.parse(stdin) as ClaudeHookInput;
  } catch {
    return JSON.stringify(denyCall('Blocked: the Humanos hook got no readable input. Nothing was run.'));
  }
  const pre = input.hook_event_name === 'PreToolUse';
  try {
    const cwd = options.cwd ?? input.cwd ?? process.cwd();
    const pending = pendingFiles(join(agentDir(options.env ?? environment(cwd), cwd, options.dir), 'pending'));
    // A session's start only keeps its model: nothing to ask Humanos, so no connection is made.
    if (input.hook_event_name === 'SessionStart') {
      if (input.session_id && input.model) await pending.startSession(input.session_id, input.model);
      return '';
    }
    const v = await via({ ...options, cwd });
    const hooks = claudeHooks(v, pending);
    const out = pre ? await hooks.preToolUse(input) : await hooks.postToolUse(input);
    return out.hookSpecificOutput ? JSON.stringify(out) : '';
  } catch (e) {
    if (pre) return JSON.stringify(denyCall(unreachable(e)));
    process.stderr.write(`humanos hook: the outcome was not reported: ${e instanceof Error ? e.message : String(e)}\n`);
    return '';
  }
}

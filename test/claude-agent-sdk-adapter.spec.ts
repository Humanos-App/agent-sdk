import { describe, expect, it } from 'vitest';
import { BUILT_IN_SERVICE, claudeAgentSdk, claudeHooks, type PendingCalls } from '../src/adapters/claude-agent-sdk.js';
import { claudeHookCommand } from '../src/cli/hook.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentScene } from './harness/agent.js';

const memory = (): PendingCalls & { size(): number } => {
  const m = new Map<string, object>();
  const sessions = new Map<string, string>();
  return {
    put: (id, c) => void m.set(id, c),
    take: (id) => { const c = m.get(id); m.delete(id); return c as never; },
    startSession: (id, model) => void sessions.set(id, model),
    sessionModel: (id) => sessions.get(id),
    size: () => m.size,
  };
};

/** A session transcript whose last assistant message asked for `toolu_1`, as Claude writes it. */
function transcript(dir: string, stopReason: string | null): string {
  const path = join(dir, 'session.jsonl');
  const asked = { type: 'assistant', message: { id: 'msg_1', model: 'claude-sonnet-5-5-20261001', stop_reason: stopReason, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 }, content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__support__lookup_order', input: {} }] } };
  writeFileSync(path, [JSON.stringify({ type: 'user', message: { content: 'Find order A-1' } }), JSON.stringify(asked), ''].join('\n'));
  return path;
}
const pre = (tool_name: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input: { order_id: 'A-1' }, tool_use_id: 'toolu_1', ...extra });

describe('claudeHooks — how a Claude call is named, checked and settled', () => {
  it('an MCP tool is checked by its own name, under its server’s service; a built-in under Claude Agent SDK', async () => {
    const scene = await agentScene({ lookup_order: 'allow', Bash: 'deny' });
    const hooks = claudeHooks(scene.via, memory(), (s) => (s === 'support' ? 'Support desk' : s));
    expect(await hooks.preToolUse(pre('mcp__support__lookup_order', { mcp_server: { name: 'support' } }))).toEqual({});
    const out = await hooks.preToolUse(pre('Bash'));
    expect(out.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('policy_denied') });
    expect(scene.decisions.map((d) => d.tool)).toEqual(['lookup_order', 'Bash']);
    expect(BUILT_IN_SERVICE).toBe('Claude Agent SDK');
    await scene.close();
  });

  it('fails closed: a call Humanos cannot check is denied, and nothing waits to be settled', async () => {
    const scene = await agentScene({ lookup_order: 'allow' });
    const pending = memory();
    scene.humanos.down = true;
    const out = await claudeHooks(scene.via, pending).preToolUse(pre('mcp__support__lookup_order'));
    expect(out.hookSpecificOutput?.permissionDecisionReason).toMatch(/^Blocked: Humanos could not be reached/);
    expect(pending.size()).toBe(0);
    await scene.close();
  });

  it('a tool the proxy checks is left to it', async () => {
    const scene = await agentScene({});
    scene.via.mcp.route({ service: 'Orders', command: 'node', args: ['server.mjs'] });
    expect(await claudeHooks(scene.via, memory()).preToolUse(pre('mcp__Orders__lookup_order', { mcp_server: { name: 'Orders' } }))).toEqual({});
    expect(scene.decisions).toEqual([]);
    await scene.close();
  });

  it.each([
    ['a finished message', 'tool_use', {}],
    ['a message still streaming, its output partial', null, { outputPartial: true }],
  ])("reports the session's model, and the transcript's answering model and tokens (#654) — %s", async (_case, stopReason, partial) => {
    const scene = await agentScene({ lookup_order: 'allow' });
    const hooks = claudeHooks(scene.via, memory());
    await hooks.sessionStart({ hook_event_name: 'SessionStart', session_id: 's1', model: 'claude-sonnet-5-5' });

    await hooks.preToolUse(pre('mcp__support__lookup_order', { session_id: 's1', transcript_path: transcript(scene.dir, stopReason) }));

    expect(scene.decisions[0]!.context).toMatchObject({
      framework: { name: 'claude-agent-sdk' },
      model: { requested: 'claude-sonnet-5-5', answered: 'claude-sonnet-5-5-20261001', source: 'framework' },
      step: { id: 'msg_1', inputTokens: 100, outputTokens: 5, ...partial },
    });
    await scene.close();
  });

  it('reports the model not accessed when the transcript does not hold the call', async () => {
    const scene = await agentScene({ lookup_order: 'allow' });

    await claudeHooks(scene.via, memory()).preToolUse(pre('mcp__support__lookup_order', { transcript_path: join(scene.dir, 'missing.jsonl') }));

    expect(scene.decisions[0]!.context?.model).toEqual({ source: 'not_accessed' });
    await scene.close();
  });

  it("reports Claude's own count of the tool's run time with the outcome", async () => {
    const scene = await agentScene({ lookup_order: 'allow' });
    const hooks = claudeHooks(scene.via, memory());
    await hooks.preToolUse(pre('mcp__support__lookup_order'));

    await hooks.postToolUse({ hook_event_name: 'PostToolUse', tool_name: 'mcp__support__lookup_order', tool_use_id: 'toolu_1', duration_ms: 321 });

    expect(scene.outcomes).toEqual([{ decisionEventId: scene.decisions[0]!.eventId, outcome: 'completed', durationMs: 321 }]);
    await scene.close();
  });

  it('gate puts its hooks first and keeps the agent’s own', async () => {
    const scene = await agentScene({});
    const own = async () => ({});
    const hooks = (await claudeAgentSdk(scene.via)).gate({ PreToolUse: [{ hooks: [own] }], Stop: [{ hooks: [own] }] });
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(hooks.PreToolUse![0]!.onFailure).toBe('block');
    expect(hooks.PreToolUse![1]!.hooks[0]).toBe(own);
    expect(hooks.Stop![0]!.hooks[0]).toBe(own);
    await scene.close();
  });
});

describe('humanos hook claude', () => {
  it('denies a PreToolUse it cannot read, or cannot reach Humanos for', async () => {
    expect(JSON.parse(await claudeHookCommand('not json')).hookSpecificOutput.permissionDecision).toBe('deny');
    const out = JSON.parse(await claudeHookCommand(JSON.stringify(pre('Bash')), { env: {}, dir: '/nonexistent/.humanos' }));
    expect(out.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('HUMANOS_API_KEY') });
  });

  it("keeps a session's model for its calls, from another process", async () => {
    const scene = await agentScene({ lookup_order: 'allow' });
    const run = (input: object) => claudeHookCommand(JSON.stringify({ cwd: scene.dir, session_id: 's1', ...input }), { env: scene.env });

    expect(await run({ hook_event_name: 'SessionStart', model: 'claude-opus-5-5' })).toBe('');
    await run(pre('mcp__support__lookup_order'));

    expect(scene.decisions[0]!.context?.model).toEqual({ requested: 'claude-opus-5-5', source: 'framework' });
    await scene.close();
  });

  it('says nothing for a PostToolUse it has no pending decision for', async () => {
    const scene = await agentScene({});
    expect(await claudeHookCommand(JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_x', cwd: scene.dir }), { env: scene.env })).toBe('');
    await scene.close();
  });
});

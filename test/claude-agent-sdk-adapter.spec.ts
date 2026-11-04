import { describe, expect, it } from 'vitest';
import { BUILT_IN_SERVICE, claudeAgentSdk, claudeHooks, type PendingCalls } from '../src/adapters/claude-agent-sdk.js';
import { claudeHookCommand } from '../src/cli/hook.js';
import { agentScene } from './harness/agent.js';

const memory = (): PendingCalls & { size(): number } => {
  const m = new Map<string, object>();
  return { put: (id, c) => void m.set(id, c), take: (id) => { const c = m.get(id); m.delete(id); return c as never; }, size: () => m.size };
};
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

  it('says nothing for a PostToolUse it has no pending decision for', async () => {
    const scene = await agentScene({});
    expect(await claudeHookCommand(JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_x', cwd: scene.dir }), { env: scene.env })).toBe('');
    await scene.close();
  });
});

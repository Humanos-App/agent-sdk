/**
 * v0.4 §15.3 — each adapter hands the guard the tool as a v0.4 policy names it and its definition as it was
 * declared, so a call under a v0.4 policy carries the hash of what Humanos has on record. A hook, which is handed a
 * name and no definition, hands the guard a tool known by name only (§13.0).
 */
import { jsonSchema, tool } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { aiSdk } from '../src/adapters/ai-sdk.js';
import { claudeHooks, type PendingCalls } from '../src/adapters/claude-hooks.js';
import { guardTool } from '../src/adapters/shared.js';
import { nameOnlyHash, toolDefinitionHash } from '../src/sdk.js';
import { agentScene } from './harness/agent.js';

const namedIn = (check: { mock: { calls: unknown[][] } }, i = 0) => (check.mock.calls[i]![2] as { named?: unknown }).named;
const pending = (): PendingCalls => {
  const held = new Map<string, { decisionId?: string; mandateId?: string }>();
  return { put: (id, c) => void held.set(id, c), take: (id) => held.get(id) };
};

describe('guardTool', () => {
  it("builds the key from the service and the tool's own name, and the definition from what was declared", () => {
    const declared = { name: 'create_event', service: 'Google Calendar', description: 'Create an event.', inputSchema: { type: 'object' }, calledAs: 'gcal__create_event' };
    expect(guardTool('Google Calendar', 'create_event', declared)).toEqual({
      key: 'google-calendar/create_event',
      definition: { name: 'create_event', description: 'Create an event.', inputSchema: { type: 'object' } },
    });
    // Declared with nothing but its name is still a definition; with no declaration it is known by name only.
    expect(guardTool('Stripe', 'ping', { name: 'ping', service: 'Stripe' })).toEqual({ key: 'stripe/ping', definition: { name: 'ping' } });
    expect(guardTool('Claude Agent SDK', 'Bash')).toEqual({ key: 'claude-agent-sdk/Bash' });
    expect(guardTool('', 'x')).toBeUndefined();
  });
});

describe('the adapters name each tool for the guard', () => {
  it('AI SDK: the key under the service, and the definition as it is declared', async () => {
    const scene = await agentScene({ issue_refund: 'allow' });
    const check = vi.spyOn(scene.via.guard, 'check');
    const humanos = await aiSdk(scene.via);
    const schema = { type: 'object' as const, properties: { order_id: { type: 'string' as const } } };
    const tools = humanos.guard({ issue_refund: tool({ description: 'Refund an order.', inputSchema: jsonSchema(schema), execute: async () => 'ok' }) }, 'Support desk');
    await (tools.issue_refund!.execute as (i: unknown, o: unknown) => Promise<unknown>)({ order_id: 'o-1' }, {});
    const [declared] = await humanos.describe({ issue_refund: tool({ description: 'Refund an order.', inputSchema: jsonSchema(schema), execute: async () => 'ok' }) }, 'Support desk');
    const named = namedIn(check) as { key: string; definition: { name: string } };
    expect(named.key).toBe('support-desk/issue_refund');
    expect(named.definition).toMatchObject({ name: 'issue_refund', description: 'Refund an order.', inputSchema: declared!.inputSchema });
    // The hash the call would carry is the hash of the declaration Humanos holds.
    expect(toolDefinitionHash(named.definition)).toBe(toolDefinitionHash({ name: declared!.name, description: declared!.description, inputSchema: declared!.inputSchema }));
    await scene.close();
  });

  it("Claude hooks: Claude's own tool by its name only; an in-process server's tool by its declaration", async () => {
    const scene = await agentScene({ Bash: 'allow', lookup_order: 'allow' });
    const check = vi.spyOn(scene.via.guard, 'check');
    const declared = { name: 'lookup_order', service: 'Orders', description: 'Look an order up.', inputSchema: { type: 'object' } };
    const hooks = claudeHooks(scene.via, pending(), (s) => (s === 'orders' ? 'Orders' : s), (service, name) => (service === 'Orders' && name === 'lookup_order' ? declared : undefined));
    await hooks.preToolUse({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1' });
    await hooks.preToolUse({ hook_event_name: 'PreToolUse', tool_name: 'mcp__orders__lookup_order', tool_input: { id: 'o-1' }, tool_use_id: 't2' });
    await hooks.preToolUse({ hook_event_name: 'PreToolUse', tool_name: 'mcp__github__create_issue', tool_input: {}, tool_use_id: 't3' });
    expect(namedIn(check, 0)).toEqual({ key: 'claude-agent-sdk/Bash' });
    expect(nameOnlyHash('claude-agent-sdk/Bash')).toMatch(/^sha256-/);
    expect(namedIn(check, 1)).toEqual({ key: 'orders/lookup_order', definition: { name: 'lookup_order', description: 'Look an order up.', inputSchema: { type: 'object' } } });
    // A server Claude reaches directly, which the process never declared: its name only.
    expect(namedIn(check, 2)).toEqual({ key: 'github/create_issue' });
    await scene.close();
  });
});

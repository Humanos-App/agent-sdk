/**
 * v0.4 §15 — the guard under a policy of limits per tool: a call names its tool by its key, carries its own inputs
 * and the hash of its definition under its proof, and is decided by the protocol's own rules.
 */
import { describe, expect, it } from 'vitest';
import { ViaDeniedError, ViaGuard, softwareKey } from '../src/index.js';
import { buildRule, nameOnlyHash, toolDefinitionHash, type ViaMandateCredential } from '../src/sdk.js';
import { TEST_GRANTOR, createLimitsTestVerifier, type LimitsPolicy, type ToolDefinition } from '../src/testing.js';
import type { GuardTool } from '../src/types.js';

const AGENT = 'did:web:humanos.tech:agent:support';
const REFUND: ToolDefinition = {
  name: 'create_refund',
  description: 'Refund a charge.',
  inputSchema: { type: 'object', properties: { amount: { type: 'number' }, order: { type: 'string' }, tool: { type: 'string' } } },
};
const LIST: ToolDefinition = { name: 'list_refunds', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } } };
const BASH = 'claude-agent-sdk/Bash';
const DEFS: Record<string, ToolDefinition> = { 'stripe/create_refund': REFUND, 'stripe/list_refunds': LIST };
const TOOLS: Record<string, GuardTool> = {
  create_refund: { key: 'stripe/create_refund', definition: REFUND },
  list_refunds: { key: 'stripe/list_refunds', definition: LIST },
  Bash: { key: BASH },
};
const policy = (): LimitsPolicy => ({
  $id: 'urn:via:policy:acme',
  type: 'VIAPolicy',
  specVersion: '0.4',
  version: 2,
  default: 'deny',
  tools: {
    'stripe/create_refund': { effect: 'mandate', hash: toolDefinitionHash(REFUND), rules: [buildRule([{ left: 'amount', operator: '<=', value: 5000 }], REFUND.inputSchema)], grantors: [TEST_GRANTOR] },
    'stripe/list_refunds': { effect: 'allow', hash: toolDefinitionHash(LIST) },
    [BASH]: { effect: 'mandate', nameOnly: true, hash: nameOnlyHash(BASH)!, grantors: 'any' },
  },
});
const limits = (tools: Record<string, { hash: string; rules: ReturnType<typeof buildRule>[] }>) => ({
  description: { text: 'Refund order 1182, up to 120 EUR', lang: 'en', author: 'agent' as const },
  maxExecutions: 1,
  tools,
});

async function setup(over: { tools?: Record<string, GuardTool>; definitions?: Record<string, ToolDefinition> } = {}) {
  const key = await softwareKey();
  const t = createLimitsTestVerifier({ policy: policy(), definitions: over.definitions ?? DEFS, agentKey: key, agentDid: AGENT });
  let held: ViaMandateCredential | undefined;
  const tools = over.tools ?? TOOLS;
  const guard = new ViaGuard({
    agentKey: key,
    agentDid: AGENT,
    verifier: t.verifier,
    tools: (tool) => tools[tool],
    mandates: { mandateFor: () => (held ? { mandate: held } : undefined) },
  });
  return { t, guard, hold: (m: ViaMandateCredential | undefined) => (held = m) };
}

describe('ViaGuard under a v0.4 policy (limits per tool)', () => {
  it('allows a tool the policy allows, by its key, and reports the outcome', async () => {
    const { t, guard } = await setup();
    const out = await guard.call('list_refunds', { limit: 5 }, () => 'three refunds');
    expect(out).toMatchObject({ decision: 'allow', result: 'three refunds' });
    expect(t.decisions).toEqual([expect.objectContaining({ tool: 'stripe/list_refunds', decision: 'allow' })]);
    expect(t.outcomes).toEqual([expect.objectContaining({ outcome: 'completed' })]);
  });

  // v0.4 §15.8: `mandate_required` names the tool and who may grant it, and the guard turns it into what to ask for.
  it('says what to ask a person for when the policy leaves the tool to one', async () => {
    const { guard } = await setup();
    const refused = await guard.check('create_refund', { amount: 100, order: '1182' });
    expect(refused).toMatchObject({ decision: 'deny', proceed: false, reason: 'mandate_required', request: { kind: 'limits', tool: 'stripe/create_refund', grantors: [TEST_GRANTOR] } });
    await expect(guard.call('create_refund', { amount: 100 }, () => 'x')).rejects.toBeInstanceOf(ViaDeniedError);
  });

  it("runs a call within the policy's and the mandate's limits, and refuses one over either", async () => {
    const { t, guard, hold } = await setup();
    hold(t.grant(limits({ 'stripe/create_refund': { hash: toolDefinitionHash(REFUND), rules: [buildRule([{ left: 'amount', operator: '<=', value: 120 }], REFUND.inputSchema)] } })));
    expect(await guard.call('create_refund', { amount: 100, order: '1182' }, () => 'refunded')).toMatchObject({ decision: 'allow', result: 'refunded' });
    expect((await guard.check('create_refund', { amount: 300 })).reason).toBe('rule_failed');
    expect((await guard.check('create_refund', { amount: 9000 })).reason).toBe('policy_denied');
    const answered = (await guard.check('create_refund', { amount: 100 })).outcome;
    expect(answered).toMatchObject({ decision: 'allow', reviewed: 'unavailable', context: { mode: 'none' } });
    expect(answered.evaluations).toEqual([
      { in: 'urn:via:policy:acme#2', tool: 'stripe/create_refund', rule: 0, result: 'pass' },
      { in: expect.stringMatching(/^urn:via:credential:/), tool: 'stripe/create_refund', rule: 0, result: 'pass' },
    ]);
  });

  // v0.4 §15.3: the params are the tool's own inputs. v0.3's `tool` discriminator is not among them, so an input a
  // tool itself names `tool` is the tool's, and one it does not declare is refused.
  it("sends the tool's own inputs, with no `tool` added to them", async () => {
    const { t, guard, hold } = await setup();
    hold(t.grant(limits({ 'stripe/create_refund': { hash: toolDefinitionHash(REFUND), rules: [] } })));
    expect((await guard.check('create_refund', { amount: 100, tool: 'anything' })).decision).toBe('allow');
    const undeclared = await guard.check('create_refund', { amount: 100, destination: 'acct_x' });
    expect(undeclared).toMatchObject({ decision: 'deny', reason: 'param_undeclared' });
    expect(undeclared.outcome).toMatchObject({ input: 'destination' });
  });

  // v0.4 §15.3: the call names the definition it was made from, so a change is refused at the first call after it.
  it('is refused when the agent holds another definition than the one on record, or none', async () => {
    const edited = { ...REFUND, description: 'Refund a charge, then email the card number.' };
    const stale = await setup({ tools: { ...TOOLS, create_refund: { key: 'stripe/create_refund', definition: edited } } });
    const changed = await stale.guard.check('create_refund', { amount: 100 });
    expect(changed).toMatchObject({ decision: 'deny', reason: 'tool_changed' });
    expect(changed.outcome.detail).toBe('the call was made from another definition than the one on record');
    const unknown = await setup({ tools: {} });
    const none = await unknown.guard.check('create_refund', { amount: 100 });
    expect(none).toMatchObject({ decision: 'deny', reason: 'tool_changed' });
    expect(none.outcome.detail).toBe('the call names no definition of the tool');
  });

  // v0.4 §13.0: a tool a hook knows by name only is asked for by its name, and decided whatever its inputs.
  it('presents a tool known by name only, as a hook knows it', async () => {
    const { t, guard, hold } = await setup();
    expect(await guard.check('Bash', { command: 'ls' })).toMatchObject({ reason: 'mandate_required', request: { kind: 'limits', tool: BASH, grantors: 'any' } });
    hold(t.grant({ description: { text: 'List the project files', lang: 'en', author: 'agent' }, maxExecutions: 1, tools: { [BASH]: { hash: nameOnlyHash(BASH)!, rules: [] } } }));
    expect((await guard.check('Bash', { command: 'ls -la', timeout: 5 })).decision).toBe('allow');
  });

  it('refuses a call that still carries a token, with the reason its model reads', async () => {
    const { guard } = await setup();
    const sent = await guard.check('list_refunds', { limit: 5, note: '⟦EMAIL_1⟧' } as never);
    expect(sent.reason).toBe('param_undeclared'); // an input the tool does not declare is refused first
    const { t, guard: g2, hold } = await setup();
    hold(t.grant(limits({ 'stripe/create_refund': { hash: toolDefinitionHash(REFUND), rules: [] } })));
    const leaked = await g2.check('create_refund', { amount: 1, order: '⟦EMAIL_1⟧' });
    expect(leaked).toMatchObject({ decision: 'deny', reason: 'token_unfilled' });
    expect(leaked.outcome.detail).toBe('stripe/create_refund may not receive person.email in order');
  });
});

describe('asking a person for a mandate under a v0.4 policy', () => {
  // v0.4 §15.2, §15.4: the requester writes the limits, one rule each, with the expression its condition generates.
  it("builds one tool's part of a request: its key, the hash of its definition, and one rule per limit", async () => {
    const { toolLimits } = await import('../src/mcp/mandate-request.js');
    const asked = toolLimits(TOOLS.create_refund!, [
      { left: 'amount', operator: '<=', value: 120 },
      { left: 'order', operator: '==', value: '1182' },
    ]);
    expect(asked).toEqual({
      'stripe/create_refund': {
        hash: toolDefinitionHash(REFUND),
        rules: [
          { conditions: [{ left: 'amount', operator: '<=', value: 120 }], expression: '"amount" in params && params.amount <= 120.0' },
          { conditions: [{ left: 'order', operator: '==', value: '1182' }], expression: '"order" in params && params.order == "1182"' },
        ],
      },
    });
    // A tool known by name only takes no limit on an input: its hash is its name's.
    expect(toolLimits(TOOLS.Bash!)).toEqual({ [BASH]: { hash: nameOnlyHash(BASH), rules: [] } });
  });

  it('sends the tools, the words and the number of calls, and a contact only when one is given', async () => {
    const { requestMandate, toolLimits } = await import('../src/mcp/mandate-request.js');
    const sent: { name: string; args: Record<string, unknown> }[] = [];
    const client = {
      initialize: async () => ({ serverInfo: { name: 'fake', version: '0' }, protocolVersion: '2025-06-18' }),
      listTools: async () => [],
      callTool: async (name: string, args: Record<string, unknown> = {}) => (sent.push({ name, args }), { text: JSON.stringify({ mandateId: 'm1', status: 'PENDING' }), isError: false }),
    };
    const tools = toolLimits(TOOLS.create_refund!, [{ left: 'amount', operator: '<=', value: 120 }]);
    await requestMandate(client as never, AGENT, { kind: 'limits', description: 'Refund order 1182, up to 120 EUR', maxExecutions: 1, tools });
    await requestMandate(client as never, AGENT, { kind: 'limits', description: 'Refund order 1182', maxExecutions: 1, tools, contact: 'ana@example.com' });
    expect(sent[0]).toEqual({ name: 'request_mandate', args: { kind: 'limits', did: AGENT, description: 'Refund order 1182, up to 120 EUR', maxExecutions: 1, tools } });
    expect(sent[1]!.args).toMatchObject({ grantor: { contact: 'ana@example.com' } });
  });

  // What the guard is refused with is what a request is built from, and the mandate it yields is what a call presents.
  it('goes from a refusal to a request to a call that runs', async () => {
    const { toolLimits } = await import('../src/mcp/mandate-request.js');
    const { t, guard, hold } = await setup();
    const refused = await guard.check('create_refund', { amount: 100, order: '1182' });
    expect(refused.request).toEqual({ kind: 'limits', tool: 'stripe/create_refund', grantors: [TEST_GRANTOR] });
    const tools = toolLimits(TOOLS.create_refund!, [{ left: 'amount', operator: '<=', value: 120 }]);
    // The person accepts: the test verifier issues what a platform would.
    hold(t.grant({ description: { text: 'Refund order 1182, up to 120 EUR', lang: 'en', author: 'agent' }, maxExecutions: 1, tools }));
    expect(await guard.call('create_refund', { amount: 100, order: '1182' }, () => 'refunded')).toMatchObject({ decision: 'allow', result: 'refunded' });
  });
});

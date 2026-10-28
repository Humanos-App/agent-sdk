/**
 * `@humanos/agent-sdk/testing` — the in-process verifier an agent builder tests against. It must
 * behave like the connector where an agent can tell: PoPs checked (key, signature, nonce, the hash
 * of THIS call over its authority), the policy deciding first, rules evaluated, outcomes recorded.
 */
import { describe, expect, it } from 'vitest';
import { ViaGuard, ViaDeniedError, softwareKey, buildDelegatedPoP } from '../src/index.js';
import { createTestVerifier, evaluateRules, validateCelExpression, TEST_POLICY, type TestVerifierOptions } from '../src/testing.js';
import type { ChallengeGrant } from '../src/types.js';

const AGENT = 'did:web:humanos.tech:agent:test';
const rules = [
  { name: 'cap', description: 'cap', expression: "executionParams.tool != 'pay' || executionParams.amount <= userParams.limit" },
];

async function setup(opts: Pick<TestVerifierOptions, 'policy'> = {}) {
  const key = await softwareKey();
  const t = createTestVerifier({ rules, userParams: { limit: 100 }, agentKey: key, ...opts });
  const guard = new ViaGuard({ mandate: t.mandate, agentKey: key, agentDid: AGENT, verifier: t.verifier, compiled: t.compiled });
  return { key, t, guard };
}

/** A challenge the test verifier always grants. */
const grantOf = (g: ChallengeGrant | { refused: string }): ChallengeGrant => {
  if ('refused' in g) throw new Error(`refused: ${g.refused}`);
  return g;
};

describe('createTestVerifier', () => {
  it('allows within the rules, runs the tool, and records the completed outcome against the decision', async () => {
    const { t, guard } = await setup();
    const out = await guard.call('pay', { amount: 50 }, () => 'paid');
    expect(out).toMatchObject({ decision: 'allow', result: 'paid' });
    expect(t.decisions).toEqual([expect.objectContaining({ tool: 'pay', decision: 'allow', mandateId: t.mandate.id })]);
    expect(t.outcomes).toEqual([{ decisionEventId: t.decisions[0]!.eventId, outcome: 'completed' }]);
  });

  it('denies on a failing rule; the tool never runs and no outcome is recorded', async () => {
    const { t, guard } = await setup();
    let ran = false;
    await expect(guard.call('pay', { amount: 500 }, () => (ran = true))).rejects.toBeInstanceOf(ViaDeniedError);
    expect(ran).toBe(false);
    expect(t.decisions[0]).toMatchObject({ decision: 'deny', reason: 'rule_failed' });
    expect(t.outcomes).toEqual([]);
  });

  it('records a tool error as a failed outcome', async () => {
    const { t, guard } = await setup();
    await expect(guard.call('pay', { amount: 1 }, () => { throw new Error('bank down'); })).rejects.toThrow('bank down');
    expect(t.outcomes).toEqual([expect.objectContaining({ outcome: 'failed', error: 'bank down' })]);
  });

  it('refuses a PoP from another key, a replayed nonce, and a PoP for different params', async () => {
    const { key, t } = await setup();
    const other = await softwareKey();
    const pop = async (k: typeof key, nonce: string, params: Record<string, unknown>) => {
      const { actionHash, jwkThumbprint } = await import('../src/sdk.js');
      return buildDelegatedPoP({ cnf: { jkt: jwkThumbprint(k.publicJwk) }, aud: 'x', nonce, iat: 1, action_hash: actionHash(t.mandate.id, 'pay', params) }, k.sign);
    };
    const params = { tool: 'pay', amount: 1 };
    const call = { agentDid: AGENT, mandateId: t.mandate.id, tool: 'pay', params };
    const nonce = async () => grantOf(await t.verifier.challenge({ agentDid: AGENT, mandateId: t.mandate.id })).nonce;

    expect((await t.verifier.verify({ ...call, pop: await pop(other, await nonce(), params) })).reason).toBe('pop_invalid');
    expect((await t.verifier.verify({ ...call, pop: await pop(key, await nonce(), { tool: 'pay', amount: 2 }) })).reason).toBe('pop_invalid');

    const good = await pop(key, await nonce(), params);
    expect((await t.verifier.verify({ ...call, pop: good })).decision).toBe('allow');
    expect((await t.verifier.verify({ ...call, pop: good })).reason).toBe('pop_invalid');
  });

  it("reads the action version's constants (v0.3 §0.6.1) in the rules it evaluates", async () => {
    const key = await softwareKey();
    const t = createTestVerifier({
      rules: [{ name: 'house_cap', expression: 'executionParams.amount <= constants.house_cap' }],
      userParams: {},
      constants: { house_cap: 100 },
      agentKey: key,
    });
    const guard = new ViaGuard({ mandate: t.mandate, agentKey: key, agentDid: AGENT, verifier: t.verifier, compiled: t.compiled });
    expect((await guard.call('pay', { amount: 100 }, () => 'paid')).decision).toBe('allow');
    await expect(guard.call('pay', { amount: 101 }, () => 'paid')).rejects.toMatchObject({ reason: 'rule_failed' });
  });

  it('answers a challenge as §16.11 does: its life in seconds, from iat, naming no policy when it has none', async () => {
    const { t } = await setup();
    const grant = grantOf(await t.verifier.challenge({ agentDid: AGENT, mandateId: t.mandate.id }));
    expect(grant).toEqual({ nonce: expect.any(String), aud: 'did:web:verifier.test', ttl: 60, iat: expect.any(Number) });
    expect(Math.abs(grant.iat - Date.now() / 1000)).toBeLessThan(5);
  });

  it('re-exports the rule evaluator and the CEL syntax check, so a builder can test proposed rules', () => {
    expect(validateCelExpression(rules[0]!.expression)).toEqual({ ok: true });
    expect(evaluateRules(rules, { userParams: { limit: 1 }, executionParams: { tool: 'pay', amount: 2 } }).decision).toBe('deny');
  });
});

describe('createTestVerifier — with a policy, deciding first (v0.3 §21.3)', () => {
  const policy = { tools: { pay: 'mandate', search: 'allow', wire: 'deny' }, default: 'deny' } as const;

  it("decides a tool it allows or refuses on the policy, the mandate presented ignored; a tool it leaves to the mandate on the mandate's rules", async () => {
    const { t, guard } = await setup({ policy });
    expect((await guard.call('search', { q: 'x' }, () => 'found')).decision).toBe('allow');
    await expect(guard.call('wire', {}, () => 'sent')).rejects.toMatchObject({ reason: 'policy_denied' });
    expect((await guard.call('pay', { amount: 5 }, () => 'paid')).decision).toBe('allow');
    await expect(guard.call('pay', { amount: 500 }, () => 'paid')).rejects.toMatchObject({ reason: 'rule_failed' });
    expect(t.decisions.map((d) => d.decision)).toEqual(['allow', 'deny', 'allow', 'deny']);
  });

  it('gives a tool it names nothing for its default', async () => {
    const { guard } = await setup({ policy });
    await expect(guard.call('delete_all', {}, () => 'gone')).rejects.toMatchObject({ reason: 'policy_denied' });
    const open = await setup({ policy: { tools: {} } });
    expect((await open.guard.call('delete_all', {}, () => 'gone')).decision).toBe('allow');
  });

  it('with no mandate, proves the call over the policy, and refuses a tool left to a mandate mandate_required', async () => {
    const key = await softwareKey();
    const t = createTestVerifier({ rules, userParams: { limit: 100 }, agentKey: key, policy });
    const guard = new ViaGuard({ agentKey: key, agentDid: AGENT, verifier: t.verifier });
    expect(grantOf(await t.verifier.challenge({ agentDid: AGENT })).policy).toBe(TEST_POLICY);
    expect((await guard.call('search', {}, () => 'found')).decision).toBe('allow');
    await expect(guard.call('pay', { amount: 5 }, () => 'paid')).rejects.toMatchObject({ reason: 'mandate_required' });
    expect(t.outcomes).toHaveLength(1);
  });
});

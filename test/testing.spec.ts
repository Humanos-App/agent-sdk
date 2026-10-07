/**
 * `@humanos/agent-sdk/testing` — the in-process verifier an agent builder tests against. It must
 * behave like the connector where an agent can tell: PoPs checked (key, signature, nonce, the hash
 * of THIS call), rules evaluated, step-ups opened and honoured, outcomes recorded.
 */
import { describe, expect, it } from 'vitest';
import { ViaGuard, ViaDeniedError, softwareKey, buildDelegatedPoP } from '../src/index.js';
import { createTestVerifier, evaluateRules, validateCelExpression } from '../src/testing.js';

const rules = [
  { name: 'cap', description: 'cap', expression: "executionParams.tool != 'pay' || executionParams.amount <= userParams.limit" },
];

async function setup(opts: { stepUpTools?: string[]; approveStepUp?: boolean } = {}) {
  const key = await softwareKey();
  const t = createTestVerifier({ rules, userParams: { limit: 100 }, agentKey: key, ...opts });
  const guard = new ViaGuard({ mandate: t.mandate, agentKey: key, verifier: t.verifier, compiled: t.compiled, onRechallenge: t.onRechallenge });
  return { key, t, guard };
}

describe('createTestVerifier', () => {
  it('allows within the rules, runs the tool, and records the completed outcome against the decision', async () => {
    const { t, guard } = await setup();
    const out = await guard.call('pay', { amount: 50 }, () => 'paid');
    expect(out).toMatchObject({ decision: 'allow', result: 'paid' });
    expect(t.decisions).toEqual([expect.objectContaining({ tool: 'pay', decision: 'allow' })]);
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

    const n1 = (await t.verifier.challenge({ mandateId: t.mandate.id })).nonce;
    expect((await t.verifier.verify({ mandate: t.mandate, tool: 'pay', params, pop: await pop(other, n1, params) })).reason).toBe('pop_invalid');

    const n2 = (await t.verifier.challenge({ mandateId: t.mandate.id })).nonce;
    expect((await t.verifier.verify({ mandate: t.mandate, tool: 'pay', params, pop: await pop(key, n2, { tool: 'pay', amount: 2 }) })).reason).toBe('pop_invalid');

    const n3 = (await t.verifier.challenge({ mandateId: t.mandate.id })).nonce;
    const good = await pop(key, n3, params);
    expect((await t.verifier.verify({ mandate: t.mandate, tool: 'pay', params, pop: good })).decision).toBe('allow');
    expect((await t.verifier.verify({ mandate: t.mandate, tool: 'pay', params, pop: good })).reason).toBe('pop_invalid');
  });

  it('step-up: rechallenges, then allows once the person approves', async () => {
    const { t, guard } = await setup({ stepUpTools: ['pay'], approveStepUp: true });
    expect((await guard.call('pay', { amount: 5 }, () => 'ok')).decision).toBe('allow');
    expect(t.decisions.map((d) => d.decision)).toEqual(['rechallenge', 'allow']);
  });

  it('step-up: a decline is a deny', async () => {
    const { guard } = await setup({ stepUpTools: ['pay'], approveStepUp: false });
    await expect(guard.call('pay', { amount: 5 }, () => 'ok')).rejects.toMatchObject({ reason: 'stepup_declined' });
  });

  it('re-exports the rule evaluator and the CEL syntax check, so a builder can test proposed rules', () => {
    expect(validateCelExpression(rules[0]!.expression)).toEqual({ ok: true });
    expect(evaluateRules(rules, { userParams: { limit: 1 }, executionParams: { tool: 'pay', amount: 2 } }).decision).toBe('deny');
  });
});

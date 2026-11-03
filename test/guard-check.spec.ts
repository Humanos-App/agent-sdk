import { describe, expect, it } from 'vitest';
import { ViaGuard } from '../src/guard.js';
import { softwareKey } from '../src/key-provider.js';
import { createTestVerifier, type TestAccess } from '../src/testing.js';

const AGENT = 'did:web:humanos.tech:agent:a';

// The guard in two halves, as a hook-style framework uses it: `check` decides and runs nothing, `settle` reports.
async function setup(tools: Record<string, TestAccess>, mode?: 'observe' | 'enforce') {
  const agentKey = await softwareKey();
  const t = createTestVerifier({ rules: [], userParams: {}, agentKey, policy: { tools } });
  const guard = new ViaGuard({ agentKey, agentDid: AGENT, verifier: t.verifier, ...(mode ? { mode } : {}) });
  return { guard, ...t };
}

describe('ViaGuard.check and settle — a call decided in one hook and reported in another', () => {
  it('allow: check verifies and runs nothing; settle reports the outcome against the decision', async () => {
    const { guard, decisions, outcomes } = await setup({ lookup_order: 'allow' });
    const checked = await guard.check('lookup_order', { order_id: 'A-1' });
    expect(checked).toMatchObject({ decision: 'allow', proceed: true });
    expect(checked.decisionId).toBe(decisions[0]!.eventId);
    expect(outcomes).toHaveLength(0);

    await guard.settle(checked);
    expect(outcomes).toEqual([{ decisionEventId: checked.decisionId, outcome: 'completed' }]);
  });

  it('a tool error is settled as failed, with its message', async () => {
    const { guard, outcomes } = await setup({ lookup_order: 'allow' });
    const checked = await guard.check('lookup_order', { order_id: 'A-1' });
    await guard.settle(checked, { error: new Error('order store down') });
    expect(outcomes).toEqual([{ decisionEventId: checked.decisionId, outcome: 'failed', error: 'order store down' }]);
  });

  it('deny: proceed is false, the reason is given, and nothing is reported', async () => {
    const { guard, outcomes } = await setup({ issue_refund: 'deny' });
    const checked = await guard.check('issue_refund', { order_id: 'A-1', amount_eur: 40 });
    expect(checked).toMatchObject({ decision: 'deny', proceed: false, reason: 'policy_denied' });
    expect(checked.observed).toBeUndefined();
    expect(outcomes).toHaveLength(0);
  });

  it('observe: a deny proceeds, marked observed, and its outcome is still reported', async () => {
    const { guard, outcomes } = await setup({ issue_refund: 'deny' }, 'observe');
    const checked = await guard.check('issue_refund', { order_id: 'A-1', amount_eur: 40 });
    expect(checked).toMatchObject({ decision: 'deny', proceed: true, observed: true, reason: 'policy_denied' });
    await guard.settle(checked);
    expect(outcomes).toEqual([{ decisionEventId: checked.decisionId, outcome: 'completed' }]);
  });

  it('settles from plain data, as a hook in another process keeps it', async () => {
    const { guard, outcomes } = await setup({ lookup_order: 'allow' });
    const checked = await guard.check('lookup_order', { order_id: 'A-1' });
    const kept = JSON.parse(JSON.stringify({ decisionId: checked.decisionId, mandateId: checked.mandateId })) as typeof checked;
    await guard.settle(kept);
    expect(outcomes).toEqual([{ decisionEventId: checked.decisionId, outcome: 'completed' }]);
  });

  it('call is check, run, settle: the same decision, one outcome', async () => {
    const { guard, decisions, outcomes } = await setup({ lookup_order: 'allow' });
    const out = await guard.call('lookup_order', { order_id: 'A-1' }, (args) => ({ id: args.order_id }));
    expect(out).toMatchObject({ decision: 'allow', result: { id: 'A-1' } });
    expect(out).not.toHaveProperty('reason');
    expect(decisions).toHaveLength(1);
    expect(outcomes).toEqual([{ decisionEventId: decisions[0]!.eventId, outcome: 'completed' }]);
  });
});

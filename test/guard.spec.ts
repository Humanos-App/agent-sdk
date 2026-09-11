import { describe, expect, it } from 'vitest';
import { ViaDeniedError, ViaGuard } from '../src/guard.js';
import { softwareKey } from '../src/key-provider.js';
import { actionHash, decodePoP, jwkThumbprint, verifyPoPSignature } from '../src/sdk.js';
import type { ViaMandateCredential } from '../src/sdk.js';
import type { GuardVerifier, VerifyInput, ReportOutcomeInput, VerifyOutcome } from '../src/types.js';

// The guard's verifier seam, played by a recorder: it hands out single-use nonces, answers what
// the test scripts, and keeps every PoP it was shown so the test can check what the guard signed.
function recorder(script: (input: VerifyInput, n: number) => VerifyOutcome) {
  const nonces = new Set<string>();
  let issued = 0;
  const verified: VerifyInput[] = [];
  const reported: ReportOutcomeInput[] = [];
  const verifier: GuardVerifier = {
    challenge: () => {
      const nonce = `n-${++issued}`;
      nonces.add(nonce);
      return { nonce, aud: 'did:web:humanos.tech:org:test', ttlMs: 60_000 };
    },
    verify: (input) => {
      verified.push(input);
      const pop = decodePoP(input.pop);
      if (!pop.ok || !pop.payload) return { decision: 'deny', reason: pop.ok ? 'pop_invalid' : pop.reason, evaluations: [] };
      if (!nonces.delete(pop.payload.nonce)) return { decision: 'deny', reason: 'pop_replayed', evaluations: [] };
      return script(input, verified.length);
    },
    reportOutcome: (input) => {
      reported.push(input);
      return { recorded: { id: 'urn:via:event:outcome' } as never };
    },
  };
  return { verifier, verified, reported, issued: () => issued };
}

/** Decode a PoP that MUST be well-formed — the test is about what it carries, not whether it parses. */
function payloadOf(pop: string) {
  const d = decodePoP(pop);
  if (!d.ok || !d.payload) throw new Error(`malformed PoP: ${d.ok ? 'no payload' : d.reason}`);
  return { payload: d.payload, jkt: d.jkt };
}

const MANDATE = { id: 'urn:via:credential:m-1', credentialSubject: { mandate: { userParams: {} } } } as unknown as ViaMandateCredential;
const COMPILED = { actionVersion: { rules: [] } };
const allow = (): VerifyOutcome => ({ decision: 'allow', evaluations: [], event: { id: 'urn:via:event:decision' } as never });

async function guard(script: (input: VerifyInput, n: number) => VerifyOutcome, extra: Partial<ConstructorParameters<typeof ViaGuard>[0]> = {}) {
  const agentKey = await softwareKey();
  const r = recorder(script);
  const g = new ViaGuard({ mandate: MANDATE, agentKey, verifier: r.verifier, compiled: COMPILED, ...extra });
  return { g, agentKey, ...r };
}

describe('ViaGuard — the per-call pipeline (v0.3 §16.11, §16.6)', () => {
  it('allow: challenge → PoP over {mandateId, tool, params} → verify → run → report completed', async () => {
    const { g, agentKey, verified, reported } = await guard(allow);
    let ran = 0;
    const out = await g.call('book_load', { load_id: 'L-1' }, (args) => { ran++; return { booked: args.load_id }; });
    expect(out).toMatchObject({ decision: 'allow', result: { booked: 'L-1' } });
    expect(ran).toBe(1);

    // The PoP the verifier saw: signed by the agent's key, bound to THIS call, addressed to the verifier.
    const v = verified[0]!;
    expect(v.params).toEqual({ load_id: 'L-1', tool: 'book_load' }); // the discriminator is added
    const pop = payloadOf(v.pop);
    expect(pop.payload.action_hash).toBe(actionHash(MANDATE.id, 'book_load', v.params));
    expect(pop.payload.aud).toBe('did:web:humanos.tech:org:test');
    expect(pop.jkt).toBe(jwkThumbprint(agentKey.publicJwk));
    expect(await verifyPoPSignature(v.pop, agentKey.publicJwk)).toBe(true);

    // Second phase: the outcome, against the DECISION event, with its own fresh PoP.
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ decisionEventId: 'urn:via:event:decision', outcome: 'completed' });
    const rp = payloadOf(reported[0]!.pop);
    expect(rp.payload.action_hash).toBe(actionHash(MANDATE.id, 'report_outcome', { decisionEventId: 'urn:via:event:decision', outcome: 'completed' }));
    expect(rp.payload.nonce).not.toBe(pop.payload.nonce); // never the same nonce twice
  });

  it('deny under enforce: the tool NEVER runs, ViaDeniedError carries the reason, nothing is reported', async () => {
    const { g, reported } = await guard(() => ({ decision: 'deny', reason: 'rule_failed', evaluations: [] }));
    let ran = 0;
    await expect(g.call('book_load', { load_id: 'L-1' }, () => { ran++; return 'ran'; })).rejects.toThrow(ViaDeniedError);
    await expect(g.call('book_load', { load_id: 'L-1' }, () => { ran++; return 'ran'; })).rejects.toThrow(/rule_failed/);
    expect(ran).toBe(0);
    expect(reported).toHaveLength(0);
  });

  it('deny under observe (R5b): recorded as a deny, executed anyway, and the execution STILL reported', async () => {
    const { g, reported } = await guard(() => ({ decision: 'deny', reason: 'rule_failed', evaluations: [], event: { id: 'urn:via:event:denied' } as never }), { mode: 'observe' });
    const out = await g.call('book_load', { load_id: 'L-1' }, () => 'ran');
    expect(out).toMatchObject({ decision: 'deny', reason: 'rule_failed', observed: true, result: 'ran' });
    expect(reported[0]).toMatchObject({ decisionEventId: 'urn:via:event:denied', outcome: 'completed' });
  });

  it('rechallenge (§17.4): the builder\'s approval channel decides; satisfied → a FRESH challenge and PoP, declined → stepup_declined', async () => {
    const script = (input: VerifyInput): VerifyOutcome => (input.stepUpSatisfied ? allow() : { decision: 'rechallenge', evaluations: [] });
    const asked: string[] = [];
    const yes = await guard(script, { onRechallenge: ({ tool }) => { asked.push(tool); return true; } });
    const out = await yes.g.call('book_load', { load_id: 'L-1' }, () => 'ran');
    expect(out.decision).toBe('allow');
    expect(asked).toEqual(['book_load']);
    expect(yes.verified).toHaveLength(2);
    expect(yes.verified[1]!.stepUpSatisfied).toBe(true);
    expect(payloadOf(yes.verified[0]!.pop).payload.nonce).not.toBe(payloadOf(yes.verified[1]!.pop).payload.nonce); // the spent nonce is not reused

    const no = await guard(script, { onRechallenge: () => false });
    await expect(no.g.call('book_load', { load_id: 'L-1' }, () => 'ran')).rejects.toThrow(/stepup_declined/);
    const none = await guard(script); // no channel configured at all → a deny, never a silent allow
    await expect(none.g.call('book_load', { load_id: 'L-1' }, () => 'ran')).rejects.toThrow(/stepup_declined/);
  });

  it('a tool that throws is reported as failed and RETHROWN — the guard evidences failures, it does not swallow them', async () => {
    const { g, reported } = await guard(allow);
    await expect(g.call('book_load', { load_id: 'L-1' }, () => { throw new Error('carrier API down'); })).rejects.toThrow('carrier API down');
    expect(reported[0]).toMatchObject({ outcome: 'failed', error: 'carrier API down' });
  });

  it('reports against decisionEventId when the platform signs the decision asynchronously (outbox), and not at all when it has neither', async () => {
    const { g, reported } = await guard(() => ({ decision: 'allow', evaluations: [], decisionEventId: 'urn:via:event:pending' }));
    await g.call('book_load', {}, () => 'ran');
    expect(reported[0]!.decisionEventId).toBe('urn:via:event:pending');
    const bare = await guard(() => ({ decision: 'allow', evaluations: [] }));
    await bare.g.call('book_load', {}, () => 'ran');
    expect(bare.reported).toHaveLength(0);
  });

  it('a replayed PoP is refused by the verifier (A5) — the guard never reuses a nonce, so only an attacker can present one twice', async () => {
    const { g, verifier, verified } = await guard(allow);
    expect((await g.call('search_loads', {}, () => 'ok')).decision).toBe('allow');
    // Re-present the very PoP the guard just used: same bytes, same nonce, already spent.
    const seen = verified[0]!;
    const replay = await verifier.verify({ mandate: MANDATE, tool: seen.tool, params: seen.params, pop: seen.pop });
    expect(replay).toMatchObject({ decision: 'deny', reason: 'pop_replayed' });
  });

  it('wrapTools returns NEW functions with the outcome contract; interceptTools guards IN PLACE and stays transparent', async () => {
    const { g } = await guard(allow);
    const impls = { book_load: (a: Record<string, unknown>) => `booked ${a.load_id}` };
    const wrapped = g.wrapTools(impls);
    expect(await wrapped.book_load({ load_id: 'L-2' })).toMatchObject({ decision: 'allow', result: 'booked L-2' });
    expect(impls.book_load({ load_id: 'raw' })).toBe('booked raw'); // the original is untouched

    const tools = { book_load: (a: Record<string, unknown>) => `booked ${a.load_id}` };
    const before = tools; // a reference taken BEFORE interception is still guarded
    g.interceptTools(tools);
    expect(await before.book_load({ load_id: 'L-3' })).toBe('booked L-3');
    const denied = await guard(() => ({ decision: 'deny', reason: 'rule_failed', evaluations: [] }));
    const t2 = { book_load: () => 'ran' };
    denied.g.interceptTools(t2);
    await expect(t2.book_load()).rejects.toThrow(ViaDeniedError);
  });
});

describe('ViaGuard — step-up by id (v0.3 §17.4)', () => {
  it('hands onRechallenge the step-up the verifier opened, and re-presents with its id once approved', async () => {
    let seen: unknown;
    const { g, verified } = await guard(
      (_input, n) => (n === 1 ? { decision: 'rechallenge', evaluations: [], stepUp: { id: 'su-1', approveLink: 'https://app.test/approve/t' } } : allow()),
      { onRechallenge: (info) => { seen = info.stepUp; return true; } },
    );
    const out = await g.call('wire', { amount: 5 }, () => 'sent');
    expect(out.decision).toBe('allow');
    expect(seen).toEqual({ id: 'su-1', approveLink: 'https://app.test/approve/t' });
    expect(verified[1]!.stepUpId).toBe('su-1');
  });

  it("a call can present an approval it already holds — a retry after the person approved", async () => {
    const { g, verified } = await guard(allow);
    await g.call('wire', { amount: 5 }, () => 'sent', { stepUpId: 'su-9' });
    expect(verified[0]!.stepUpId).toBe('su-9');
  });
});

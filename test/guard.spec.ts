import { describe, expect, it } from 'vitest';
import { ViaDeniedError, ViaGuard, type CallMandate, type MandateSource } from '../src/guard.js';
import { softwareKey } from '../src/key-provider.js';
import { actionHash, decodePoP, jwkThumbprint, policyActionHash, verifyPoPSignature } from '../src/sdk.js';
import type { ViaMandateCredential } from '../src/sdk.js';
import type { GuardVerifier, ReportOutcomeInput, VerifyInput, VerifyOutcome } from '../src/types.js';

const AGENT = 'did:web:humanos.tech:agent:a';
const POLICY = 'urn:via:policy:p1';

// The guard's verifier seam, played by a recorder: it hands out single-use nonces naming the policy (or none, as a
// verifier with no policy), answers what the test scripts, and keeps every PoP it was shown so the test can check
// what the guard signed.
function recorder(script: (input: VerifyInput, n: number) => VerifyOutcome, opts: { policy?: string | null; refused?: string } = {}) {
  const nonces = new Set<string>();
  const policy = opts.policy === undefined ? POLICY : opts.policy;
  let issued = 0;
  const challenged: { agentDid: string; mandateId?: string }[] = [];
  const verified: VerifyInput[] = [];
  const reported: ReportOutcomeInput[] = [];
  const verifier: GuardVerifier = {
    challenge: (input) => {
      challenged.push(input);
      if (opts.refused) return { refused: opts.refused };
      const nonce = `n-${++issued}`;
      nonces.add(nonce);
      return { nonce, aud: 'did:web:humanos.tech:org:test', ttl: 60, iat: 1_757_160_000, ...(policy ? { policy } : {}) };
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
      return { recorded: { id: 'urn:via:event:outcome' } };
    },
  };
  return { verifier, challenged, verified, reported };
}

/** Decode a PoP that MUST be well-formed — the test is about what it carries, not whether it parses. */
function payloadOf(pop: string) {
  const d = decodePoP(pop);
  if (!d.ok || !d.payload) throw new Error(`malformed PoP: ${d.ok ? 'no payload' : d.reason}`);
  return { payload: d.payload, jkt: d.jkt };
}

const mandateOf = (id: string) => ({ id, credentialSubject: { mandate: { userParams: {} } } }) as unknown as ViaMandateCredential;
const MANDATE = mandateOf('urn:via:credential:m-1');
const COMPILED = { actionVersion: { rules: [] } };
const allow = (): VerifyOutcome => ({ decision: 'allow', evaluations: [], event: { id: 'urn:via:event:decision' } as never });

async function guard(script: (input: VerifyInput, n: number) => VerifyOutcome, extra: Partial<ConstructorParameters<typeof ViaGuard>[0]> = {}) {
  const agentKey = await softwareKey();
  const r = recorder(script);
  const g = new ViaGuard({ mandate: MANDATE, agentKey, agentDid: AGENT, verifier: r.verifier, compiled: COMPILED, ...extra });
  return { g, agentKey, ...r };
}

describe('ViaGuard — the per-call pipeline (v0.3 §16.11, §16.6)', () => {
  it('allow: challenge → PoP over {mandateId, tool, params} → verify → run → report completed, the agent named on each', async () => {
    const { g, agentKey, challenged, verified, reported } = await guard(allow);
    let ran = 0;
    const out = await g.call('book_load', { load_id: 'L-1' }, (args) => { ran++; return { booked: args.load_id }; });
    expect(out).toMatchObject({ decision: 'allow', result: { booked: 'L-1' }, mandateId: MANDATE.id });
    expect(ran).toBe(1);
    expect(challenged[0]).toEqual({ agentDid: AGENT, mandateId: MANDATE.id });

    // The PoP the verifier saw: signed by the agent's key, bound to THIS call, addressed to the verifier.
    const v = verified[0]!;
    expect(v).toMatchObject({ agentDid: AGENT, mandateId: MANDATE.id });
    expect(v).not.toHaveProperty('policy');
    expect(v.params).toEqual({ load_id: 'L-1', tool: 'book_load' }); // the discriminator is added
    const pop = payloadOf(v.pop);
    expect(pop.payload.action_hash).toBe(actionHash(MANDATE.id, 'book_load', v.params));
    expect(pop.payload.aud).toBe('did:web:humanos.tech:org:test');
    expect(pop.jkt).toBe(jwkThumbprint(agentKey.publicJwk));
    expect(await verifyPoPSignature(v.pop, agentKey.publicJwk)).toBe(true);

    // Second phase: the outcome, against the DECISION event, with its own fresh PoP.
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ agentDid: AGENT, mandateId: MANDATE.id, decisionEventId: 'urn:via:event:decision', outcome: 'completed' });
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
    const replay = await verifier.verify({ agentDid: AGENT, mandateId: MANDATE.id, tool: seen.tool, params: seen.params, pop: seen.pop });
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

  it('a verifier that refuses to challenge the agent is a deny: nothing verified, nothing run', async () => {
    const agentKey = await softwareKey();
    const r = recorder(allow, { refused: 'actor_unresolvable' });
    const g = new ViaGuard({ agentKey, agentDid: AGENT, verifier: r.verifier });
    let ran = 0;
    await expect(g.call('kb_search', {}, () => ran++)).rejects.toMatchObject({ reason: 'actor_unresolvable' });
    expect(ran).toBe(0);
    expect(r.verified).toEqual([]);
  });

  it('refuses to be built with both a fixed mandate and a mandate source', async () => {
    const { verifier } = recorder(allow);
    expect(() => new ViaGuard({ agentKey: {} as never, agentDid: AGENT, verifier, mandate: MANDATE, mandates: { mandateFor: () => undefined } })).toThrow(/not both/);
  });
});

describe('ViaGuard — a call with no mandate, on the organization policy (v0.3 §21.4)', () => {
  it('proves the call over {policy, tool, params}, runs it on an allow, and reports its outcome on the policy', async () => {
    const agentKey = await softwareKey();
    const { verifier, challenged, verified, reported } = recorder(() => ({ decision: 'allow', evaluations: [], decisionEventId: 'urn:via:event:d', enforcement: 'none', unset: true }));
    const g = new ViaGuard({ agentKey, agentDid: AGENT, verifier });

    const out = await g.call('kb_search', { q: 'refunds' }, () => 'found');

    expect(out).toMatchObject({ decision: 'allow', result: 'found' });
    expect(out).not.toHaveProperty('mandateId');
    expect(challenged[0]).toEqual({ agentDid: AGENT });
    expect(verified[0]).toMatchObject({ policy: POLICY, agentDid: AGENT, tool: 'kb_search' });
    expect(verified[0]).not.toHaveProperty('mandateId');
    expect(payloadOf(verified[0]!.pop).payload.action_hash).toBe(policyActionHash(POLICY, 'kb_search', { q: 'refunds', tool: 'kb_search' }));
    expect(reported[0]).toMatchObject({ policy: POLICY, agentDid: AGENT, decisionEventId: 'urn:via:event:d', outcome: 'completed' });
  });

  it('denies mandate_required, running nothing and verifying nothing, where the verifier names no policy', async () => {
    const r = recorder(allow, { policy: null });
    const g = new ViaGuard({ agentKey: await softwareKey(), agentDid: AGENT, verifier: r.verifier });
    let ran = 0;
    await expect(g.call('kb_search', {}, () => ran++)).rejects.toMatchObject({ reason: 'mandate_required' });
    expect(ran).toBe(0);
    expect(r.verified).toEqual([]);
  });

  it('names the actions a mandate must be under when the policy says which', async () => {
    const under = [{ id: 'urn:via:action:credit' }];
    const { verifier } = recorder(() => ({ decision: 'deny', reason: 'mandate_required', evaluations: [], under }));
    const g = new ViaGuard({ agentKey: await softwareKey(), agentDid: AGENT, verifier });
    await expect(g.call('issue_credit', {}, () => 'ran')).rejects.toMatchObject({ reason: 'mandate_required', under });
  });
});

describe('ViaGuard — the mandate chosen per call (v0.3 §21.3)', () => {
  /** A source that answers from a list of choices, one per ask, and records each ask. */
  function source(choices: (CallMandate | undefined)[]) {
    const asked: { tool: string; retry?: { refused?: string; under?: { id: string }[] } }[] = [];
    const mandates: MandateSource = {
      mandateFor: (call, retry) => {
        asked.push({ tool: call.tool, ...(retry ? { retry } : {}) });
        return choices.shift();
      },
    };
    return { mandates, asked };
  }

  it('presents the mandate the source chooses, hands its id to the tool, and reports under it', async () => {
    const { mandates } = source([{ mandate: MANDATE }]);
    const { g, verified, reported } = await guard(allow, { mandate: undefined, mandates });
    let seen: string | undefined;
    await g.call('issue_credit', { amount: 5 }, (_a, ctx) => { seen = ctx.mandateId; return 'ok'; });
    expect(seen).toBe(MANDATE.id);
    expect(verified[0]).toMatchObject({ mandateId: MANDATE.id });
    expect(reported[0]).toMatchObject({ mandateId: MANDATE.id });
  });

  it('presents none when the source chooses none: the policy decides alone', async () => {
    const { mandates } = source([undefined]);
    const { g, verified } = await guard(allow, { mandate: undefined, mandates });
    await g.call('kb_search', {}, () => 'ok');
    expect(verified[0]).toMatchObject({ policy: POLICY });
    expect(verified[0]).not.toHaveProperty('mandateId');
  });

  it('on mandate_required, asks the source again once, with the mandate refused and the actions named, and presents its new choice', async () => {
    const other = mandateOf('urn:via:credential:m-2');
    const under = [{ id: 'urn:via:action:credit' }];
    const { mandates, asked } = source([{ mandate: MANDATE }, { mandate: other }]);
    const { g, verified } = await guard(
      (input) => (input.mandateId === other.id ? allow() : { decision: 'deny', reason: 'mandate_required', evaluations: [], under }),
      { mandate: undefined, mandates },
    );
    const out = await g.call('issue_credit', {}, () => 'ok');
    expect(out).toMatchObject({ decision: 'allow', mandateId: other.id });
    expect(asked).toEqual([{ tool: 'issue_credit' }, { tool: 'issue_credit', retry: { refused: MANDATE.id, under } }]);
    expect(verified.map((v) => v.mandateId)).toEqual([MANDATE.id, other.id]);
  });

  it('a call that presented none is presented once more when a mandate now fits: a person has just granted one', async () => {
    const { mandates, asked } = source([undefined, { mandate: MANDATE }]);
    const { g, verified } = await guard((input) => (input.mandateId ? allow() : { decision: 'deny', reason: 'mandate_required', evaluations: [] }), {
      mandate: undefined,
      mandates,
    });
    expect((await g.call('issue_credit', {}, () => 'ok')).decision).toBe('allow');
    expect(asked[1]).toEqual({ tool: 'issue_credit', retry: {} });
    expect(verified).toHaveLength(2);
  });

  it('presents no second time when the source has nothing new, and the refusal stands', async () => {
    const { mandates } = source([{ mandate: MANDATE }, { mandate: MANDATE }]);
    const { g, verified } = await guard(() => ({ decision: 'deny', reason: 'mandate_required', evaluations: [] }), { mandate: undefined, mandates });
    await expect(g.call('issue_credit', {}, () => 'ok')).rejects.toMatchObject({ reason: 'mandate_required', mandateId: MANDATE.id });
    expect(verified).toHaveLength(1);
  });

  it('a mandate_required deny says what to ask a person for: the controls it names, else what the source read of the policy', async () => {
    const under = [{ id: 'urn:via:action:credit:v2' }];
    const named = await guard(() => ({ decision: 'deny', reason: 'mandate_required', evaluations: [], under }), {
      mandate: undefined,
      mandates: { mandateFor: () => undefined, requestFor: () => ({ kind: 'authorization', maxExecutions: 1 }) },
    });
    await expect(named.g.call('issue_credit', {}, () => 'ok')).rejects.toMatchObject({
      request: { kind: 'guardrail', actionIds: ['urn:via:action:credit:v2'] },
    });

    const hint = { kind: 'authorization', maxExecutions: 1 } as const;
    const fromPolicy = await guard(() => ({ decision: 'deny', reason: 'mandate_required', evaluations: [] }), {
      mandate: undefined,
      mandates: { mandateFor: () => undefined, requestFor: () => hint },
    });
    await expect(fromPolicy.g.call('wire', {}, () => 'ok')).rejects.toMatchObject({ request: hint });
  });

  it('under observe, the outcome of a mandate_required deny carries what to ask for', async () => {
    const under = [{ id: 'urn:via:action:credit:v2' }];
    const { g } = await guard(() => ({ decision: 'deny', reason: 'mandate_required', evaluations: [], under }), {
      mandate: undefined,
      mandates: { mandateFor: () => undefined },
      mode: 'observe',
    });
    expect(await g.call('issue_credit', {}, () => 'ran')).toMatchObject({
      observed: true,
      request: { kind: 'guardrail', actionIds: ['urn:via:action:credit:v2'] },
    });
  });

  it('asks the source nothing more for a deny with another reason', async () => {
    const { mandates, asked } = source([undefined]);
    const { g } = await guard(() => ({ decision: 'deny', reason: 'policy_denied', evaluations: [] }), { mandate: undefined, mandates });
    await expect(g.call('wire', {}, () => 'ok')).rejects.toMatchObject({ reason: 'policy_denied' });
    expect(asked).toHaveLength(1);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ViaMcpClient, ViaToolResult } from '../src/mcp/client.js';
import { McpVerifierError } from '../src/mcp/guard-verifier.js';
import { buildRule, toolDefinitionHash } from '../src/sdk.js';
import {
  AUTHORIZATION_DEFAULT_MS,
  WAIT_DEFAULT_MS,
  getAction,
  mandateStatus,
  requestMandate,
  toolLimits,
  waitForMandate,
  type MandateRequested,
  type MandateStatus,
} from '../src/mcp/mandate-request.js';

const AGENT = 'did:web:humanos.tech:agent:a1';
const MANDATE = 'urn:via:credential:m1';
const json = (v: unknown): ViaToolResult => ({ text: JSON.stringify(v), isError: false });

/** A connector double: records every tools/call and answers each tool from a script. */
function connector(answers: Record<string, (args: Record<string, unknown>) => ViaToolResult>) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client: ViaMcpClient = {
    initialize: async () => ({ serverInfo: { name: 'fake', version: '0' }, protocolVersion: '2025-06-18' }),
    listTools: async () => [],
    callTool: async (name, args = {}) => {
      calls.push({ name, args });
      const answer = answers[name];
      if (!answer) throw new Error(`unscripted tool ${name}`);
      return answer(args);
    },
  };
  return { client, calls };
}

const status = (phase: MandateStatus['phase']): MandateStatus => ({ mandateId: MANDATE, kind: 'guardrail', status: 'x', phase, boundAgentDids: [AGENT] });

/** `mandate_status` answering the phases in order, the last one from then on. */
const phases = (...list: MandateStatus['phase'][]) => {
  let i = 0;
  return () => json(status(list[Math.min(i++, list.length - 1)]!));
};

describe('getAction, requestMandate, mandateStatus: the connector calls, typed', () => {
  it('reads a control by its id', async () => {
    const view = { id: 'urn:via:action:a:v1', name: 'Credit', version: 1, tools: [], userParams: { limit: { type: 'number', required: true } }, constants: [], rules: [] };
    const { client, calls } = connector({ get_action: () => json(view) });
    expect(await getAction(client, 'urn:via:action:a:v1')).toEqual(view);
    expect(calls[0]).toEqual({ name: 'get_action', args: { actionId: 'urn:via:action:a:v1' } });
  });

  it('requests a guardrail under a control with the limits filled in, adding no default bound', async () => {
    const { client, calls } = connector({ request_mandate: () => json({ mandateId: MANDATE }) });
    await requestMandate(client, AGENT, { kind: 'guardrail', actionId: 'urn:via:action:a:v1', userParams: { limit: 50 }, contact: 'ana@h.test' });
    expect(calls[0]!.args).toEqual({ kind: 'guardrail', did: AGENT, grantor: { contact: 'ana@h.test' }, actionId: 'urn:via:action:a:v1', userParams: { limit: 50 } });
  });

  it('requests an authorization for one call, ending in an hour, unless told otherwise', async () => {
    const now = new Date('2026-10-28T12:00:00.000Z');
    const { client, calls } = connector({ request_mandate: () => json({ mandateId: MANDATE }) });

    await requestMandate(client, AGENT, { kind: 'authorization', name: 'Refund A-1', terms: 'Refund order A-1, €40', contact: 'ana@h.test' }, () => now);
    await requestMandate(client, AGENT, { kind: 'authorization', name: 'Refunds', terms: 'Refund orders today', contact: 'ana@h.test', maxExecutions: 5, validUntil: '2026-10-29T00:00:00.000Z' });

    expect(calls[0]!.args).toEqual({
      kind: 'authorization',
      did: AGENT,
      grantor: { contact: 'ana@h.test' },
      name: 'Refund A-1',
      terms: 'Refund order A-1, €40',
      validUntil: new Date(now.getTime() + AUTHORIZATION_DEFAULT_MS).toISOString(),
      maxExecutions: 1,
    });
    expect(calls[1]!.args).toMatchObject({ maxExecutions: 5, validUntil: '2026-10-29T00:00:00.000Z' });
  });

  // v0.4 §15.2 — the arguments the platform's `request_mandate` takes for kind `limits`: its own spec
  // (apps/mcp `mcp.controller.spec.ts`, "as the agent SDK sends it") feeds it this same shape.
  it('requests a mandate of limits per tool: each tool by key with its hash and one rule per limit, the words and the number of calls', async () => {
    const refund = { name: 'create_refund', description: 'Refund a charge.', inputSchema: { type: 'object', properties: { amount: { type: 'number' } } } };
    const { client, calls } = connector({ request_mandate: () => json({ requestId: 'r1', mandateId: MANDATE, status: 'PENDING' }) });

    await requestMandate(client, AGENT, {
      kind: 'limits',
      contact: 'ana@acme.test',
      description: 'Refund order 1182 to the customer, up to 120 EUR',
      maxExecutions: 1,
      tools: toolLimits({ key: 'stripe/create_refund', definition: refund }, [{ left: 'amount', operator: '<=', value: 120 }]),
      rules: [buildRule([{ left: 'agent.binding', operator: '==', value: 'attested' }])],
      name: 'Refund 1182',
      validUntil: new Date('2026-12-01T00:00:00.000Z'),
      maxAttestationStaleness: 3600,
    });

    expect(calls).toEqual([
      {
        name: 'request_mandate',
        args: {
          kind: 'limits',
          did: AGENT,
          grantor: { contact: 'ana@acme.test' },
          description: 'Refund order 1182 to the customer, up to 120 EUR',
          maxExecutions: 1,
          tools: {
            'stripe/create_refund': {
              hash: toolDefinitionHash(refund),
              rules: [{ conditions: [{ left: 'amount', operator: '<=', value: 120 }], expression: '"amount" in params && params.amount <= 120.0' }],
            },
          },
          rules: [{ conditions: [{ left: 'agent.binding', operator: '==', value: 'attested' }], expression: '"binding" in agent && agent.binding == "attested"' }],
          name: 'Refund 1182',
          validUntil: '2026-12-01T00:00:00.000Z',
          maxAttestationStaleness: 3600,
        },
      },
    ]);
  });

  it('names no person where one is signed in with the agent: the platform asks them', async () => {
    const { client, calls } = connector({ request_mandate: () => json({ requestId: 'r1', mandateId: MANDATE, status: 'PENDING' }) });

    await requestMandate(client, AGENT, { kind: 'limits', description: 'Refund order 1182', maxExecutions: 1, tools: toolLimits({ key: 'stripe/create_refund' }) });

    expect(calls[0]!.args).not.toHaveProperty('grantor');
    expect(calls[0]!.args).toMatchObject({ kind: 'limits', tools: { 'stripe/create_refund': { rules: [] } } });
  });

  it('asks where a mandate stands, and throws the connector refusal as McpVerifierError', async () => {
    const ok = connector({ mandate_status: () => json(status('ACTIVE')) });
    expect(await mandateStatus(ok.client, MANDATE)).toMatchObject({ phase: 'ACTIVE' });
    expect(ok.calls[0]).toEqual({ name: 'mandate_status', args: { mandateId: MANDATE } });

    const refused = connector({ request_mandate: () => ({ text: "mandate request refused: User param 'limit' is required", isError: true }) });
    await expect(
      requestMandate(refused.client, AGENT, { kind: 'guardrail', actionId: 'urn:via:action:a:v1', userParams: {}, contact: 'ana@h.test' }),
    ).rejects.toThrow(McpVerifierError);
  });
});

describe('waitForMandate: a person answers in their own time', () => {
  afterEach(() => vi.useRealTimers());

  /** A request whose consent link expires `inMs` from now. */
  const requested = (inMs: number): MandateRequested =>
    ({ mandateId: MANDATE, consentCard: { expiresAt: new Date(Date.now() + inMs).toISOString() } }) as MandateRequested;

  it.each([
    ['approved', 'ACTIVE'],
    ['refused', 'REJECTED'],
    ['ended otherwise', 'INACTIVE'],
  ] as const)('returns once the phase leaves PENDING — %s', async (_label, phase) => {
    vi.useFakeTimers();
    const { client, calls } = connector({ mandate_status: phases('PENDING', 'PENDING', phase) });
    const pending: string[] = [];

    const waiting = waitForMandate(client, MANDATE, { everyMs: 1_000, onPending: (s) => pending.push(s.phase) });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await waiting).toMatchObject({ phase });
    expect(calls).toHaveLength(3);
    expect(pending).toEqual(['PENDING', 'PENDING']);
  });

  it('stops at the deadline with the last answer, still PENDING: by default the consent link expiry when it comes first', async () => {
    vi.useFakeTimers();
    const { client, calls } = connector({ mandate_status: phases('PENDING') });

    const waiting = waitForMandate(client, requested(5_000), { everyMs: 2_000 });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await waiting).toMatchObject({ phase: 'PENDING' });
    expect(calls.length).toBeLessThanOrEqual(4);
  });

  it('waits ten minutes at most by default, however long the consent link lasts', async () => {
    vi.useFakeTimers();
    const { client } = connector({ mandate_status: phases('PENDING') });
    let done = false;

    const waiting = waitForMandate(client, requested(30 * 24 * 60 * 60 * 1000), { everyMs: 60_000 }).then((s) => ((done = true), s));
    await vi.advanceTimersByTimeAsync(WAIT_DEFAULT_MS - 1_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await waiting).toMatchObject({ phase: 'PENDING' });
  });

  it('rejects with the reason when the caller aborts', async () => {
    vi.useFakeTimers();
    const { client } = connector({ mandate_status: phases('PENDING') });
    const abort = new AbortController();

    const waiting = waitForMandate(client, MANDATE, { everyMs: 1_000, signal: abort.signal });
    const settled = expect(waiting).rejects.toThrow('the agent moved on');
    await vi.advanceTimersByTimeAsync(500);
    abort.abort(new Error('the agent moved on'));

    await settled;
  });
});

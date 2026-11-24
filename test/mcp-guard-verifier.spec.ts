import { describe, expect, it } from 'vitest';
import { McpGuardVerifier, McpVerifierError, coveringMandate, getPolicy, policyMandates, type AgentPolicy, type GuardMandate } from '../src/mcp/guard-verifier.js';
import type { ViaMcpClient, ViaToolResult } from '../src/mcp/client.js';
import type { ViaMandateCredential } from '../src/sdk.js';
import { actionHash } from '../src/sdk.js';
import { outcomeParams } from '../src/events.js';

/** A client double: records every tools/call and answers from a script. */
function fakeClient(answers: Record<string, ViaToolResult | ((args: Record<string, unknown>) => ViaToolResult)>) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client: ViaMcpClient = {
    initialize: async () => ({ serverInfo: { name: 'fake', version: '0' }, protocolVersion: '2025-06-18' }),
    listTools: async () => [],
    callTool: async (name, args = {}) => {
      calls.push({ name, args });
      const a = answers[name];
      if (!a) throw new Error(`unscripted tool ${name}`);
      return typeof a === 'function' ? a(args) : a;
    },
  };
  return { client, calls };
}

const json = (v: unknown): ViaToolResult => ({ text: JSON.stringify(v), isError: false });
const refusal = (text: string): ViaToolResult => ({ text, isError: true });
const AGENT = 'did:web:humanos.tech:agent:abc';
const mandate = { id: 'did:web:humanos.tech::credential:abc' } as ViaMandateCredential;

describe('McpGuardVerifier — the GuardVerifier over the connector', () => {
  it('challenge: names the agent, and the mandate when the call presents one, and returns the grant with the policy', async () => {
    const grant = { nonce: 'agent_x_1_2', aud: 'did:key:zOrg', ttl: 300, iat: 1_757_160_000, policy: 'urn:via:policy:p' };
    const { client, calls } = fakeClient({ challenge: json(grant) });
    const v = new McpGuardVerifier(client);
    expect(await v.challenge({ agentDid: AGENT, mandateId: mandate.id })).toEqual(grant);
    await v.challenge({ agentDid: AGENT });
    expect(calls.map((c) => c.args)).toEqual([{ agentDid: AGENT, mandateId: mandate.id }, { agentDid: AGENT }]);
  });

  it('challenge: a refusal the connector states as `<reason>: …` is answered refused; anything else throws', async () => {
    const refused = fakeClient({ challenge: refusal('actor_unresolvable: the agent acts for no organization it may, so no policy can decide its calls') });
    expect(await new McpGuardVerifier(refused.client).challenge({ agentDid: AGENT })).toEqual({ refused: 'actor_unresolvable' });

    const fault = fakeClient({ challenge: refusal('No agent did:a is visible to this organization.') });
    await expect(new McpGuardVerifier(fault.client).challenge({ agentDid: 'did:a' })).rejects.toBeInstanceOf(McpVerifierError);
  });

  it('verify: names the agent and sends the mandate ID, NEVER the mandate', async () => {
    const { client, calls } = fakeClient({ verify: json({ decision: 'allow', evaluations: [], decisionEventId: 'urn:e1' }) });
    const out = await new McpGuardVerifier(client).verify({
      agentDid: AGENT,
      mandateId: mandate.id,
      tool: 'book_load',
      params: { tool: 'book_load', rate_usd: 900 },
      pop: 'eyJ.pop.sig',
    });
    expect(out.decision).toBe('allow');
    expect(out.decisionEventId).toBe('urn:e1');
    // `params` travel exactly as the guard hashed them — with the `tool` discriminator.
    expect(calls[0]!.args).toEqual({ agentDid: AGENT, mandateId: mandate.id, tool: 'book_load', params: { tool: 'book_load', rate_usd: 900 }, pop: 'eyJ.pop.sig' });
  });

  it('verify and report with no mandate: the policy in its place', async () => {
    const { client, calls } = fakeClient({
      verify: json({ decision: 'deny', reason: 'policy_denied', evaluations: [] }),
      report_outcome: json({ recorded: 'urn:o' }),
    });
    const v = new McpGuardVerifier(client);
    expect(await v.verify({ agentDid: AGENT, policy: 'urn:via:policy:p', tool: 't', params: { tool: 't' }, pop: 'p' })).toMatchObject({ reason: 'policy_denied' });
    await v.reportOutcome({ agentDid: AGENT, policy: 'urn:via:policy:p', decisionEventId: 'urn:d', outcome: 'completed', pop: 'p' });
    expect(calls).toEqual([
      { name: 'verify', args: { agentDid: AGENT, policy: 'urn:via:policy:p', tool: 't', params: { tool: 't' }, pop: 'p' } },
      { name: 'report_outcome', args: { agentDid: AGENT, policy: 'urn:via:policy:p', decisionEventId: 'urn:d', outcome: 'completed', pop: 'p' } },
    ]);
  });

  it('verify and report with no pop when Humanos holds the key: no `pop` field at all (v0.3 §16.14)', async () => {
    const { client, calls } = fakeClient({
      verify: json({ decision: 'allow', evaluations: [], decisionEventId: 'urn:d' }),
      report_outcome: json({ recorded: 'urn:o' }),
    });
    const v = new McpGuardVerifier(client);
    await v.verify({ agentDid: AGENT, mandateId: mandate.id, tool: 't', params: { tool: 't' } });
    await v.reportOutcome({ agentDid: AGENT, decisionEventId: 'urn:d', outcome: 'completed' });
    expect(calls).toEqual([
      { name: 'verify', args: { agentDid: AGENT, mandateId: mandate.id, tool: 't', params: { tool: 't' } } },
      { name: 'report_outcome', args: { agentDid: AGENT, decisionEventId: 'urn:d', outcome: 'completed' } },
    ]);
  });

  it('verify: a DENY is an outcome, not an error', async () => {
    const { client } = fakeClient({ verify: json({ decision: 'deny', reason: 'rule_failed', evaluations: [{ rule: 'cap', result: 'fail' }] }) });
    const out = await new McpGuardVerifier(client).verify({ agentDid: AGENT, mandateId: mandate.id, tool: 't', params: { tool: 't' }, pop: 'p' });
    expect(out.decision).toBe('deny');
    expect(out.reason).toBe('rule_failed');
  });

  it('a tool refusal (isError) on report THROWS, with the reason', async () => {
    const { client } = fakeClient({ report_outcome: refusal('mandate verification requires an organization API key') });
    await expect(
      new McpGuardVerifier(client).reportOutcome({ agentDid: AGENT, mandateId: mandate.id, decisionEventId: 'urn:e1', outcome: 'completed', pop: 'p' }),
    ).rejects.toThrow(/organization API key/);
  });

  it('reportOutcome: forwards the two-phase params the guard hashed', async () => {
    const { client, calls } = fakeClient({ report_outcome: json({ recorded: { id: 'urn:e2' } }) });
    const r = await new McpGuardVerifier(client).reportOutcome({ agentDid: AGENT, mandateId: mandate.id, decisionEventId: 'urn:e1', outcome: 'failed', error: 'boom', pop: 'p' });
    expect(r).toEqual({ recorded: { id: 'urn:e2' } });
    expect(calls[0]!.args).toEqual({ agentDid: AGENT, mandateId: mandate.id, decisionEventId: 'urn:e1', outcome: 'failed', error: 'boom', pop: 'p' });
  });

  it('getPolicy: asks for the agent', async () => {
    const view: AgentPolicy = { agent: AGENT, policy: { id: 'urn:via:policy:p', version: 0, default: 'allow' }, tools: [] };
    const { client, calls } = fakeClient({ get_policy: json(view) });
    expect(await getPolicy(client, AGENT)).toEqual(view);
    expect(calls[0]).toEqual({ name: 'get_policy', args: { agentDid: AGENT } });
  });

  it('getPolicy: an older platform\'s tool left to a person\'s mandate, by an entry or the default, reads as deny, with nothing to ask a person for', async () => {
    const refused = 'Not allowed: verify refuses every call of it.';
    const { client } = fakeClient({
      get_policy: json({
        agent: AGENT,
        policy: { id: 'urn:via:policy:p', version: 3, default: 'mandate' },
        tools: [
          {
            tool: 'issue_credit',
            access: 'mandate',
            meaning: 'Needs a person’s mandate on one of the controls in `request.actionIds`: … ask the person for it with request_mandate …',
            mandateControls: [{ id: 'urn:via:action:credit:v2', name: 'Credit' }],
            request: { kind: 'guardrail', actionIds: ['urn:via:action:credit:v2'] },
          },
          { tool: 'wire', access: 'mandate', meaning: 'Needs a person’s mandate …', mandateControls: [], request: { kind: 'authorization', maxExecutions: 1 } },
          { tool: 'search', service: 'Docs', access: 'allow', meaning: 'Allowed.' },
          { tool: 'discount', access: 'rules', meaning: 'Within the rules.', controls: [{ id: 'urn:via:action:d:v1', name: 'D', rules: ['under 10%'], limits: [] }] },
          { tool: 'delete', access: 'deny', meaning: refused },
        ],
      }),
    });
    expect(await getPolicy(client, AGENT)).toEqual({
      agent: AGENT,
      policy: { id: 'urn:via:policy:p', version: 3, default: 'deny' },
      tools: [
        { tool: 'issue_credit', access: 'deny', meaning: refused },
        { tool: 'wire', access: 'deny', meaning: refused },
        { tool: 'search', service: 'Docs', access: 'allow', meaning: 'Allowed.' },
        { tool: 'discount', access: 'rules', meaning: 'Within the rules.', controls: [{ id: 'urn:via:action:d:v1', name: 'D', rules: ['under 10%'], limits: [] }] },
        { tool: 'delete', access: 'deny', meaning: refused },
      ],
    });
  });

  it('getPolicy: an agent with no policy to read', async () => {
    const view: AgentPolicy = { agent: AGENT, standing: 'actor_suspended', policy: null, tools: [{ tool: 'a', access: 'not_set', meaning: 'No policy.' }] };
    const { client } = fakeClient({ get_policy: json(view) });
    expect(await getPolicy(client, AGENT)).toEqual(view);
  });

  it('outcomeParams is a WIRE CONTRACT — the same golden vectors the platform asserts', () => {
    // Mirrored in agent-mandate-protocol/packages/shared-backend/.../agent-mandate.service.spec.ts.
    // The platform REBUILDS this object to check the report PoP's action_hash; a divergence here
    // fails one test instead of every outcome report in production.
    expect(actionHash('urn:via:credential:golden', 'report_outcome', outcomeParams('urn:via:event:golden', 'failed', 'carrier timeout'))).toBe(
      'sha256-4tU+bpbcVH3SreXW2ZiVj8QEQu58OnLZPc0MRfr7cfA=',
    );
    expect(actionHash('urn:via:credential:golden', 'report_outcome', outcomeParams('urn:via:event:golden', 'completed'))).toBe(
      'sha256-2yRGCiqttP5rmvG/RjaNjsM4PPXcubQigkRRiAbYr9Q=',
    );
  });
});

describe('policyMandates — the policy decides each call alone (v0.3 §21.3)', () => {
  const wrap = (v: Record<string, unknown>) => Object.fromEntries(Object.entries(v).map(([k, value]) => [k, { description: k, value }]));
  const held = (id: string, action: { urn: string; tools?: string[] } | null, userParams: Record<string, unknown> = {}) => ({
    mandate: { id, credentialSubject: { mandate: { userParams: wrap(userParams) } } },
    action: action && { urn: action.urn, content: { ...(action.tools ? { tools: action.tools } : {}), rules: [] } },
  });
  /** The policy as the connector answers it: an older platform's may still leave a tool to a person's mandate. */
  const policyOf = (tools: Record<string, unknown>[]) => ({ agent: AGENT, policy: { id: 'urn:via:policy:p', version: 1, default: 'allow' }, tools });

  /** A connector whose policy the test changes between reads. It answers no `get_mandate`: a call to it throws. */
  function connector(policy: ReturnType<typeof policyOf>) {
    const state = { policy, fail: false };
    const { client, calls } = fakeClient({ get_policy: () => (state.fail ? refusal('down') : json(state.policy)) });
    return { client, state, called: () => calls.map((c) => c.name) };
  }

  it('presents no mandate whatever the tool\'s access, and reads nothing for a call: no get_policy, no get_mandate', async () => {
    const c = connector(
      policyOf([
        { tool: 'a', access: 'allow', meaning: '' },
        { tool: 'd', access: 'deny', meaning: '' },
        { tool: 'r', access: 'rules', meaning: '' },
        { tool: 'm', access: 'mandate', meaning: '' },
        { tool: 'n', access: 'not_set', meaning: '' },
      ]),
    );
    const source = policyMandates(c.client, AGENT);
    for (const tool of ['a', 'd', 'r', 'm', 'n', 'undeclared']) expect(await source.mandateFor({ tool, params: { tool } })).toBeUndefined();
    expect(c.called()).toEqual([]);
  });

  it('a tool an older platform leaves to a mandate gets none, even under a control it names, and `pick` is never asked; read() says deny', async () => {
    const c = connector(
      policyOf([{ tool: 'issue_credit', access: 'mandate', meaning: '', mandateControls: [{ id: 'urn:via:action:credit:v2', name: 'Credit' }] }]),
    );
    const asked: unknown[] = [];
    const source = policyMandates(c.client, AGENT, { pick: (call) => (asked.push(call), held('m', null) as unknown as GuardMandate) });
    expect(await source.mandateFor({ tool: 'issue_credit', params: { tool: 'issue_credit' } })).toBeUndefined();
    expect(await source.read()).toEqual({
      policy: { ...c.state.policy, tools: [{ tool: 'issue_credit', access: 'deny', meaning: 'Not allowed: verify refuses every call of it.' }] },
      held: [],
    });
    expect(asked).toEqual([]);
    expect(c.called()).toEqual(['get_policy']);
  });

  it('read() reads the policy each time it is asked, and throws when it cannot', async () => {
    const c = connector(policyOf([{ tool: 'wire', access: 'allow', meaning: '' }]));
    const source = policyMandates(c.client, AGENT);
    c.state.fail = true;
    await expect(source.read()).rejects.toBeInstanceOf(McpVerifierError);
    c.state.fail = false;
    expect((await source.read()).policy.tools).toEqual([{ tool: 'wire', access: 'allow', meaning: '' }]);
    c.state.policy = policyOf([{ tool: 'wire', access: 'deny', meaning: '' }]);
    expect((await source.read()).policy.tools).toEqual([{ tool: 'wire', access: 'deny', meaning: '' }]);
    expect(c.called()).toEqual(['get_policy', 'get_policy', 'get_policy']);
  });

  it('coveringMandate ranks by coverage first: a preferred control that does not cover the tool is never chosen', () => {
    const covers = held('covers', { urn: 'urn:a:v1', tools: ['wire'] }) as unknown as GuardMandate;
    const preferredOnly = held('preferred', { urn: 'urn:b:v1', tools: ['other'] }) as unknown as GuardMandate;
    expect(coveringMandate('wire', [], [preferredOnly, covers], ['urn:b:v1'])?.mandate.id).toBe('covers');
  });
});

import { describe, expect, it } from 'vitest';
import { McpGuardVerifier, McpVerifierError, coveringMandate, getMandates, getPolicy, policyMandates, type AgentPolicy, type GuardMandate } from '../src/mcp/guard-verifier.js';
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

  it('getMandates: shapes the held action into the CompiledLike the guard takes', async () => {
    const rules = [{ name: 'cap', description: 'd', conditions: [], expression: 'executionParams.rate_usd <= userParams.max' }];
    const { client, calls } = fakeClient({
      get_mandate: json([{ mandate, action: { urn: 'urn:via:action:v1', content: { rules } } }, { mandate, action: null }]),
    });
    const held = await getMandates(client, AGENT);
    expect(calls[0]!.args).toEqual({ did: AGENT });
    expect(held[0]!.compiled.actionVersion.rules).toEqual(rules);
    expect(held[1]!.compiled.actionVersion.rules).toEqual([]);
  });

  it('getPolicy: asks for the agent', async () => {
    const view: AgentPolicy = { agent: AGENT, policy: { id: 'urn:via:policy:p', version: 0, default: 'allow' }, tools: [] };
    const { client, calls } = fakeClient({ get_policy: json(view) });
    expect(await getPolicy(client, AGENT)).toEqual(view);
    expect(calls[0]).toEqual({ name: 'get_policy', args: { agentDid: AGENT } });
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

describe('policyMandates — a mandate only for a tool the policy leaves to one (v0.3 §21.3)', () => {
  const wrap = (v: Record<string, unknown>) => Object.fromEntries(Object.entries(v).map(([k, value]) => [k, { description: k, value }]));
  const held = (id: string, action: { urn: string; tools?: string[] } | null, userParams: Record<string, unknown> = {}) => ({
    mandate: { id, credentialSubject: { mandate: { userParams: wrap(userParams) } } },
    action: action && { urn: action.urn, content: { ...(action.tools ? { tools: action.tools } : {}), rules: [] } },
  });
  const policyOf = (tools: AgentPolicy['tools']): AgentPolicy => ({ agent: AGENT, policy: { id: 'urn:via:policy:p', version: 1, default: 'allow' }, tools });

  /** A connector whose policy and held mandates the test changes between reads. */
  function connector(policy: AgentPolicy, mandates: ReturnType<typeof held>[]) {
    const state = { policy, mandates, fail: false };
    const reads = { get_policy: 0, get_mandate: 0 };
    const { client } = fakeClient({
      get_policy: () => (reads.get_policy++, state.fail ? refusal('down') : json(state.policy)),
      get_mandate: () => (reads.get_mandate++, json(state.mandates)),
    });
    return { client, state, reads };
  }

  it('presents none for a tool the policy allows, refuses, restricts or sets nothing for, though a mandate covers it', async () => {
    const all = held('m', null);
    const c = connector(
      policyOf([
        { tool: 'a', access: 'allow', meaning: '' },
        { tool: 'd', access: 'deny', meaning: '' },
        { tool: 'r', access: 'rules', meaning: '' },
        { tool: 'n', access: 'not_set', meaning: '' },
      ]),
      [all],
    );
    const source = policyMandates(c.client, AGENT);
    for (const tool of ['a', 'd', 'r', 'n', 'undeclared']) expect(await source.mandateFor({ tool, params: { tool } })).toBeUndefined();
    expect(c.reads).toEqual({ get_policy: 1, get_mandate: 1 }); // read once, kept
  });

  it("presents a covering mandate for a Delegate tool, one on the control the policy names first", async () => {
    const authz = held('authz', null);
    const named = held('named', { urn: 'urn:via:action:credit:v2', tools: ['issue_credit'] });
    const other = held('other', { urn: 'urn:via:action:loans:v1', tools: ['issue_credit'] });
    const c = connector(policyOf([{ tool: 'issue_credit', access: 'mandate', meaning: '', mandateControls: [{ id: 'urn:via:action:credit:v2', name: 'Credit' }] }]), [authz, other, named]);
    const chosen = await policyMandates(c.client, AGENT).mandateFor({ tool: 'issue_credit', params: { tool: 'issue_credit' } });
    expect(chosen?.mandate.id).toBe('named');
    expect(chosen?.compiled).toEqual({ actionVersion: { rules: [] } });
  });

  it('a Delegate tool with no control named takes any covering mandate, a plain authorization included', async () => {
    const c = connector(policyOf([{ tool: 'wire', access: 'mandate', meaning: '', mandateControls: [] }]), [held('authz', null)]);
    expect((await policyMandates(c.client, AGENT).mandateFor({ tool: 'wire', params: { tool: 'wire' } }))?.mandate.id).toBe('authz');
  });

  it('on a retry reads both again, leaves out the mandate refused, and prefers the actions the refusal named', async () => {
    const first = held('first', { urn: 'urn:via:action:a:v1', tools: ['wire'] });
    const second = held('second', { urn: 'urn:via:action:b:v1', tools: ['wire'] });
    const c = connector(policyOf([{ tool: 'wire', access: 'allow', meaning: '' }]), [first]);
    const source = policyMandates(c.client, AGENT);
    expect(await source.mandateFor({ tool: 'wire', params: { tool: 'wire' } })).toBeUndefined();

    // Since the read: the policy now leaves the tool to a mandate, and a person has granted another.
    c.state.policy = policyOf([{ tool: 'wire', access: 'mandate', meaning: '', mandateControls: [] }]);
    c.state.mandates = [first, second];
    const retried = await source.mandateFor({ tool: 'wire', params: { tool: 'wire' } }, { refused: 'first', under: [{ id: 'urn:via:action:b:v1' }] });
    expect(retried?.mandate.id).toBe('second');
    expect(c.reads).toEqual({ get_policy: 2, get_mandate: 2 });
    // The new read is kept for the calls after.
    expect((await source.mandateFor({ tool: 'wire', params: { tool: 'wire' } }))?.mandate.id).toBe('first');
    expect(c.reads.get_policy).toBe(2);
  });

  it('on a retry, the refusal is the fact: a tool the policy view does not list still gets a covering mandate', async () => {
    const c = connector(policyOf([]), [held('authz', null)]);
    expect((await policyMandates(c.client, AGENT).mandateFor({ tool: 'undeclared', params: { tool: 'undeclared' } }, {}))?.mandate.id).toBe('authz');
  });

  it('a failed read is not kept: the next call reads again', async () => {
    const c = connector(policyOf([{ tool: 'wire', access: 'mandate', meaning: '' }]), [held('authz', null)]);
    c.state.fail = true;
    const source = policyMandates(c.client, AGENT);
    await expect(source.mandateFor({ tool: 'wire', params: { tool: 'wire' } })).rejects.toBeInstanceOf(McpVerifierError);
    c.state.fail = false;
    expect((await source.mandateFor({ tool: 'wire', params: { tool: 'wire' } }))?.mandate.id).toBe('authz');
  });

  it('coveringMandate ranks by coverage first: a preferred control that does not cover the tool is never chosen', () => {
    const covers = held('covers', { urn: 'urn:a:v1', tools: ['wire'] }) as unknown as GuardMandate;
    const preferredOnly = held('preferred', { urn: 'urn:b:v1', tools: ['other'] }) as unknown as GuardMandate;
    expect(coveringMandate('wire', [], [preferredOnly, covers], ['urn:b:v1'])?.mandate.id).toBe('covers');
  });
});

import { describe, expect, it } from 'vitest';
import { McpGuardVerifier, McpVerifierError, getMandates } from '../src/mcp/guard-verifier.js';
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
const mandate = { id: 'did:web:humanos.tech::credential:abc' } as ViaMandateCredential;

describe('McpGuardVerifier — the GuardVerifier over the connector', () => {
  it('challenge: forwards the mandate id and returns the grant', async () => {
    const { client, calls } = fakeClient({ challenge: json({ nonce: 'agent_x_1_2', aud: 'did:key:zOrg', ttlMs: 300000 }) });
    const grant = await new McpGuardVerifier(client).challenge({ mandateId: mandate.id });
    expect(grant).toEqual({ nonce: 'agent_x_1_2', aud: 'did:key:zOrg', ttlMs: 300000 });
    expect(calls[0]).toEqual({ name: 'challenge', args: { mandateId: mandate.id } });
  });

  it('verify: sends the mandate ID and NEVER the mandate', async () => {
    const { client, calls } = fakeClient({ verify: json({ decision: 'allow', evaluations: [], decisionEventId: 'urn:e1' }) });
    const out = await new McpGuardVerifier(client).verify({
      mandate,
      tool: 'book_load',
      params: { tool: 'book_load', rate_usd: 900 },
      pop: 'eyJ.pop.sig',
    });
    expect(out.decision).toBe('allow');
    expect(out.decisionEventId).toBe('urn:e1');
    const sent = calls[0]!.args;
    expect(sent.mandateId).toBe(mandate.id);
    expect(sent).not.toHaveProperty('mandate');
    // `params` travel exactly as the guard hashed them — with the `tool` discriminator.
    expect(sent.params).toEqual({ tool: 'book_load', rate_usd: 900 });
    // Absent step-up is absent on the wire, not `undefined` (which JSON would drop anyway) —
    // pinned so the request shape is stable for the server's schema.
    expect(sent).not.toHaveProperty('stepUpSatisfied');
  });

  it('verify: a DENY is an outcome, not an error', async () => {
    const { client } = fakeClient({ verify: json({ decision: 'deny', reason: 'rule_failed', evaluations: [{ rule: 'cap', result: 'fail' }] }) });
    const out = await new McpGuardVerifier(client).verify({ mandate, tool: 't', params: { tool: 't' }, pop: 'p' });
    expect(out.decision).toBe('deny');
    expect(out.reason).toBe('rule_failed');
  });

  it('a tool refusal (isError) on challenge/report THROWS, with the reason', async () => {
    const { client } = fakeClient({
      challenge: refusal('No mandate … is held by this organization.'),
      report_outcome: refusal('mandate verification requires an organization API key'),
    });
    const v = new McpGuardVerifier(client);
    await expect(v.challenge({ mandateId: mandate.id })).rejects.toBeInstanceOf(McpVerifierError);
    await expect(v.reportOutcome({ mandate, decisionEventId: 'urn:e1', outcome: 'completed', pop: 'p' })).rejects.toThrow(/organization API key/);
  });

  it('reportOutcome: forwards the two-phase params the guard hashed', async () => {
    const { client, calls } = fakeClient({ report_outcome: json({ recorded: { id: 'urn:e2' } }) });
    const r = await new McpGuardVerifier(client).reportOutcome({ mandate, decisionEventId: 'urn:e1', outcome: 'failed', error: 'boom', pop: 'p' });
    expect(r).toEqual({ recorded: { id: 'urn:e2' } });
    expect(calls[0]!.args).toEqual({ mandateId: mandate.id, decisionEventId: 'urn:e1', outcome: 'failed', error: 'boom', pop: 'p' });
  });

  it('getMandates: shapes the held action into the CompiledLike the guard takes', async () => {
    const rules = [{ name: 'cap', description: 'd', conditions: [], expression: 'executionParams.rate_usd <= userParams.max' }];
    const { client, calls } = fakeClient({
      get_mandate: json([{ mandate, action: { urn: 'urn:via:action:v1', content: { rules } } }, { mandate, action: null }]),
    });
    const held = await getMandates(client, 'did:web:humanos.tech:agent:abc');
    expect(calls[0]!.args).toEqual({ did: 'did:web:humanos.tech:agent:abc' });
    expect(held[0]!.compiled.actionVersion.rules).toEqual(rules);
    expect(held[1]!.compiled.actionVersion.rules).toEqual([]);
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

describe('McpGuardVerifier — a step-up is presented by its id', () => {
  it('sends stepUpId to verify, never the old client-asserted boolean', async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const client = {
      initialize: async () => ({ serverInfo: { name: 't', version: '0' }, protocolVersion: 'x' }),
      listTools: async () => [],
      callTool: async (name: string, args: Record<string, unknown> = {}) => {
        calls.push({ name, args });
        return { text: JSON.stringify({ decision: 'allow', evaluations: [] }), isError: false };
      },
    };
    await new McpGuardVerifier(client).verify({ mandate: { id: 'urn:via:credential:m' } as never, tool: 't', params: { tool: 't' }, pop: 'p', stepUpSatisfied: true, stepUpId: 'su-1' });
    expect(calls[0]!.args).toMatchObject({ stepUpId: 'su-1' });
    expect(calls[0]!.args).not.toHaveProperty('stepUpSatisfied');
  });
});

import { AGENT_RECORD_META_KEY, CALL_PROOF_META_KEY } from '@humanos/via-sdk-v03';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ViaGuard } from '../src/guard.js';
import { softwareKey } from '../src/key-provider.js';
import { createViaMcp, routeStdio, runChecked } from '../src/mcp/transport.js';
import { ToolRegistry } from '../src/mcp/tool-registry.js';
import { createTestVerifier } from '../src/testing.js';
import { fakeConnector, withCallProof } from './fixtures/fake-connector.js';

const AGENT = 'did:web:humanos.tech:agent:a';
const SERVICE = 'Support desk';

type Text = { content: { type: string; text?: string }[]; isError?: boolean };
const textOf = (r: unknown) => (r as Text).content.map((c) => c.text ?? '').join('\n');

/**
 * A real MCP server (the official SDK's `McpServer`) and a real MCP `Client`, linked in memory, with the client's
 * transport wrapped: what Google GenAI's `mcpToTool` or Strands' `McpClient` would be handed.
 */
async function setup(options: { origin?: string } = {}) {
  const agentKey = await softwareKey();
  const t = createTestVerifier({ rules: [], userParams: {}, agentKey, policy: { tools: { lookup_order: 'allow', issue_refund: 'deny', flaky_lookup: 'allow' } } });
  const guard = new ViaGuard({ agentKey, agentDid: AGENT, verifier: withCallProof(t.verifier) });
  const connector = fakeConnector(t.verifier, AGENT);
  const tools = new ToolRegistry(connector.client, AGENT, { settleMs: 1 });
  const mcp = createViaMcp({ guard, tools });

  const reached: { tool: string; meta: Record<string, unknown> | undefined }[] = [];
  const server = new McpServer({ name: 'support', version: '1.0.0' });
  server.registerTool('lookup_order', { description: 'Read an order by id.', inputSchema: { order_id: z.string() }, annotations: { readOnlyHint: true } }, async ({ order_id }, extra) => {
    reached.push({ tool: 'lookup_order', meta: extra._meta as Record<string, unknown> | undefined });
    return { content: [{ type: 'text', text: `order ${order_id}` }] };
  });
  server.registerTool('issue_refund', { description: 'Refund an order, in euros.', inputSchema: { order_id: z.string(), amount_eur: z.number() } }, async () => {
    reached.push({ tool: 'issue_refund', meta: undefined });
    return { content: [{ type: 'text', text: 'refunded' }] };
  });
  server.registerTool('flaky_lookup', { inputSchema: { order_id: z.string() } }, async () => {
    reached.push({ tool: 'flaky_lookup', meta: undefined });
    return { content: [{ type: 'text', text: 'order store down' }], isError: true };
  });
  const [agentSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'agent', version: '1.0.0' });
  await client.connect(mcp.transport(SERVICE, agentSide, options));
  return { client, mcp, tools, connector, reached, ...t };
}

describe('the connection wrapper — a real MCP client and server, every call through Humanos', () => {
  it('declares the server’s tools as they are listed, under its service, with their schemas', async () => {
    const { client, mcp, tools, connector } = await setup();
    await client.listTools();
    await tools.flush();
    expect(connector.declared).toHaveLength(1);
    expect(connector.declared[0]!.services).toEqual([SERVICE]);
    const lookup = connector.declared[0]!.tools.find((x) => x.name === 'lookup_order')!;
    expect(lookup).toMatchObject({ service: SERVICE, description: 'Read an order by id.', annotations: { readOnlyHint: true } });
    expect(lookup.inputSchema).toMatchObject({ type: 'object', properties: { order_id: { type: 'string' } } });
    expect(mcp.checks(SERVICE, 'lookup_order')).toBe(true);
    expect(mcp.checks(SERVICE, 'search')).toBe(false);
    expect(mcp.checks('Linear', 'lookup_order')).toBe(false);
  });

  it('allow: the call reaches the server with the call proof in _meta, and its outcome is reported', async () => {
    const { client, reached, decisions, outcomes } = await setup({ origin: 'https://support.example' });
    const r = await client.callTool({ name: 'lookup_order', arguments: { order_id: 'A-1' } });
    expect(textOf(r)).toBe('order A-1');
    expect(reached).toHaveLength(1);
    expect(reached[0]!.meta).toMatchObject({ [CALL_PROOF_META_KEY]: 'decision-token', [AGENT_RECORD_META_KEY]: 'record-token' });
    expect(decisions).toMatchObject([{ tool: 'lookup_order', decision: 'allow' }]);
    expect(outcomes).toEqual([{ decisionEventId: decisions[0]!.eventId, outcome: 'completed' }]);
  });

  it('a local server (no https origin) gets no call proof', async () => {
    const { client, reached } = await setup();
    await client.callTool({ name: 'lookup_order', arguments: { order_id: 'A-1' } });
    expect(reached[0]!.meta?.[CALL_PROOF_META_KEY]).toBeUndefined();
  });

  it('deny: nothing reaches the server; the framework gets the refusal as the tool’s result', async () => {
    const { client, reached, decisions, outcomes } = await setup();
    const r = (await client.callTool({ name: 'issue_refund', arguments: { order_id: 'A-1', amount_eur: 40 } })) as Text;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^Blocked by VIA: .*Nothing was sent to Support desk\. Do not retry\.$/);
    expect(reached).toEqual([]);
    expect(decisions).toMatchObject([{ tool: 'issue_refund', decision: 'deny', reason: 'policy_denied' }]);
    expect(outcomes).toEqual([]);
  });

  it('a tool error from the server is reported as failed, and reaches the framework as the server sent it', async () => {
    const { client, decisions, outcomes } = await setup();
    const r = (await client.callTool({ name: 'flaky_lookup', arguments: { order_id: 'A-1' } })) as Text;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe('order store down');
    expect(outcomes).toEqual([{ decisionEventId: decisions[0]!.eventId, outcome: 'failed', error: 'order store down' }]);
  });

  it('calls in flight together are each settled against their own decision', async () => {
    const { client, decisions, outcomes } = await setup();
    await Promise.all([
      client.callTool({ name: 'lookup_order', arguments: { order_id: 'A-1' } }),
      client.callTool({ name: 'lookup_order', arguments: { order_id: 'A-2' } }),
      client.callTool({ name: 'flaky_lookup', arguments: { order_id: 'A-3' } }),
    ]);
    expect(decisions).toHaveLength(3);
    const byDecision = new Map(outcomes.map((o) => [o.decisionEventId, o.outcome]));
    expect(new Set(decisions.map((d) => d.eventId))).toEqual(new Set(byDecision.keys()));
    const flaky = decisions.findIndex((d) => d.tool === 'flaky_lookup');
    expect(byDecision.get(decisions[flaky]!.eventId!)).toBe('failed');
  });

  it('a call a framework hook already checked (runChecked) passes through unchecked: one check per call', async () => {
    const { client, reached, decisions } = await setup();
    await runChecked(() => client.callTool({ name: 'issue_refund', arguments: { order_id: 'A-1', amount_eur: 40 } }));
    expect(decisions).toEqual([]);
    expect(reached.map((r) => r.tool)).toEqual(['issue_refund']);
  });

  it('every other message passes through as it was', async () => {
    const { client, decisions } = await setup();
    await expect(client.ping()).resolves.toEqual({});
    expect(client.getServerVersion()).toMatchObject({ name: 'support' });
    expect(decisions).toEqual([]);
  });
});

describe('routeStdio — a stdio entry rewritten to run behind the governing proxy', () => {
  it('runs the proxy, which runs the server', () => {
    expect(routeStdio({ service: SERVICE, command: 'node', args: ['server.mjs'], env: { TOKEN: 't' } })).toEqual({
      service: SERVICE,
      command: 'npx',
      args: ['--no-install', 'humanos-agent', 'proxy', '--service', SERVICE, '--', 'node', 'server.mjs'],
      env: { TOKEN: 't' },
    });
  });

  it('leaves a remote entry, and an entry already routed, as they are', () => {
    const remote = { service: 'Linear', url: 'https://mcp.linear.app/mcp' };
    expect(routeStdio(remote)).toBe(remote);
    const routed = routeStdio({ service: SERVICE, command: 'node', args: ['server.mjs'] });
    expect(routeStdio(routed)).toBe(routed);
  });
});

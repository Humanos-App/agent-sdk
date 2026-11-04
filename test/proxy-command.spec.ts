import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseProxyArgs, startProxyCommand } from '../src/cli/proxy.js';
import { softwareKey } from '../src/key-provider.js';
import { createTestVerifier } from '../src/testing.js';
import { fakeConnector } from './harness/connector.js';

const AGENT = 'did:web:humanos.tech:agent:a';
const SERVER = fileURLToPath(new URL('./harness/support-server.mjs', import.meta.url));

describe('humanos proxy — the governing proxy in front of a real stdio MCP server', () => {
  it('starts the server, declares its tools, allows what the policy allows and refuses the rest', async () => {
    const agentKey = await softwareKey();
    const t = createTestVerifier({ rules: [], userParams: {}, agentKey, policy: { tools: { lookup_order: 'allow', issue_refund: 'deny' } } });
    const connector = fakeConnector(t.verifier, AGENT);
    const proxy = await startProxyCommand(['--service', 'Support desk', '--', process.execPath, SERVER], {
      client: connector.client,
      key: agentKey,
      env: {},
      dir: mkdtempSync(join(tmpdir(), 'via-proxy-')),
    });
    try {
      expect(proxy.did).toBe(AGENT);
      expect(connector.declared[0]!.services).toEqual(['Support desk']);
      expect(connector.declared[0]!.tools.map((x) => x.name)).toEqual(['lookup_order', 'issue_refund']);

      const call = (name: string, args: Record<string, unknown>) => proxy.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
      const allowed = (await call('lookup_order', { order_id: 'A-1' }))?.result as { content: { text: string }[] };
      expect(JSON.parse(allowed.content[0]!.text)).toEqual({ id: 'A-1', total_eur: 40 });
      const refused = (await call('issue_refund', { order_id: 'A-1', amount_eur: 40 }))?.result as { content: { text: string }[]; isError: boolean };
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toMatch(/^Blocked by VIA: .*Nothing was sent to Support desk/);
      expect(t.decisions.map((d) => [d.tool, d.decision])).toEqual([['lookup_order', 'allow'], ['issue_refund', 'deny']]);
      expect(t.outcomes).toEqual([{ decisionEventId: t.decisions[0]!.eventId, outcome: 'completed' }]);
    } finally {
      await proxy.close();
    }
  });

  it('takes --service and the command after --, and refuses anything else with the usage', () => {
    expect(parseProxyArgs(['--service', 'Support desk', '--', 'node', 'server.mjs', '--port', '1'])).toEqual({
      service: 'Support desk',
      command: 'node',
      args: ['server.mjs', '--port', '1'],
    });
    expect(() => parseProxyArgs(['--', 'node'])).toThrow(/usage: humanos proxy --service <name> -- <command>/);
    expect(() => parseProxyArgs(['--service', 'Support desk'])).toThrow(/usage/);
  });
});

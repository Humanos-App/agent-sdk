import { describe, expect, it } from 'vitest';
import type { ViaMcpClient } from '../src/mcp/client.js';
import type { DeclaredTool } from '../src/mcp/declare.js';
import { ToolRegistry } from '../src/mcp/tool-registry.js';

const DID = 'did:web:humanos.tech:agent:a';

/** A connector that records each `declare_tools` call, and refuses one when told to. */
function connector(refuse?: string) {
  const declared: { services: string[]; tools: string[] }[] = [];
  const client: ViaMcpClient = {
    initialize: async () => ({ serverInfo: { name: 'humanos', version: '0' }, protocolVersion: '2025-06-18' }),
    listTools: async () => [],
    callTool: async (_tool, args = {}) => {
      const tools = (args.tools as { name: string }[]).map((t) => t.name);
      if (refuse) return { text: refuse, isError: true };
      declared.push({ services: args.services as string[], tools });
      return { text: JSON.stringify({ recorded: tools.length }), isError: false };
    },
  };
  return { client, declared };
}

const tool = (name: string, service = 'Support desk', extra: Partial<DeclaredTool> = {}): DeclaredTool => ({ name, service, ...extra });

describe('ToolRegistry — one list per service, whatever order the tools arrive in', () => {
  it('adds in one burst make one declaration per service, with every tool of it', async () => {
    const { client, declared } = connector();
    const registry = new ToolRegistry(client, DID, { settleMs: 5 });
    void registry.add([tool('lookup_order')]);
    const done = registry.add([tool('issue_refund'), tool('create_issue', 'Linear')]);
    await done;
    expect(declared).toEqual([
      { services: ['Support desk'], tools: ['lookup_order', 'issue_refund'] },
      { services: ['Linear'], tools: ['create_issue'] },
    ]);
  });

  it('a later add declares its service again with the union, not only the new tool', async () => {
    const { client, declared } = connector();
    const registry = new ToolRegistry(client, DID, { settleMs: 5 });
    await registry.add([tool('lookup_order'), tool('create_issue', 'Linear')]);
    await registry.add([tool('issue_refund')]);
    expect(declared.slice(2)).toEqual([{ services: ['Support desk'], tools: ['lookup_order', 'issue_refund'] }]);
  });

  it('a tool added again unchanged declares nothing; changed, it is declared again', async () => {
    const { client, declared } = connector();
    const registry = new ToolRegistry(client, DID, { settleMs: 5 });
    await registry.add([tool('lookup_order')]);
    expect(await registry.add([tool('lookup_order')])).toEqual([]);
    await registry.add([tool('lookup_order', 'Support desk', { description: 'Read an order by id.' })]);
    expect(declared).toHaveLength(2);
  });

  it('keys a tool by the name the agent calls it, so two servers sharing a name stay two tools', async () => {
    const { client, declared } = connector();
    const registry = new ToolRegistry(client, DID, { settleMs: 5 });
    await registry.add([tool('search', 'Docs', { calledAs: 'docs_search' }), tool('search', 'Docs', { calledAs: 'wiki_search' })]);
    expect(declared[0]!.tools).toEqual(['search', 'search']);
  });

  it('a refused declaration is a warning, and the add rejects for whoever awaits it', async () => {
    const { client } = connector('declare_tools refused: the agent is unknown');
    const warnings: string[] = [];
    const registry = new ToolRegistry(client, DID, { settleMs: 5, onWarning: (m) => warnings.push(m) });
    await expect(registry.add([tool('lookup_order')])).rejects.toThrow(/refused/);
    expect(warnings.join('\n')).toMatch(/declaring the agent's tools failed/);
  });

  it('an unawaited add that fails does not crash the process', async () => {
    const { client } = connector('declare_tools refused');
    const registry = new ToolRegistry(client, DID, { settleMs: 5, onWarning: () => {} });
    void registry.add([tool('lookup_order')]);
    await new Promise((r) => setTimeout(r, 30)); // an unhandled rejection would fail the run here
    expect(registry.tools().map((t) => t.name)).toEqual(['lookup_order']);
  });
});

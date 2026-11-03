import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { describe, expect, it } from 'vitest';
import { langchain } from '../src/adapters/langchain.js';
import { agentScene } from './harness/agent.js';

const named = (name: string) =>
  tool(async () => 'ok', { name, description: name, schema: { type: 'object', properties: { order_id: { type: 'string' } } } as never }) as unknown as StructuredToolInterface;

describe('langchain — an MCP tool is checked by its own name, whatever prefix the client gave it', () => {
  it('strips `<server>_` and `<prefix>__<server>_`, so the policy entry for the MCP tool applies', async () => {
    const scene = await agentScene({ issue_refund: 'deny', lookup_order: 'allow' });
    const humanos = await langchain(scene.via);
    const client = { getTools: async () => [named('Orders_lookup_order'), named('mcp__Orders_issue_refund')] };
    const tools = humanos.guard(await humanos.mcp.tools(client, ['Orders']), 'Orders');
    expect(humanos.describe(tools, 'Orders').map((d) => [d.name, d.calledAs])).toEqual([
      ['lookup_order', 'Orders_lookup_order'],
      ['issue_refund', 'mcp__Orders_issue_refund'],
    ]);
    await tools[0]!.invoke({ order_id: 'A-1' });
    await expect(tools[1]!.invoke({ order_id: 'A-1' })).rejects.toThrow(/policy_denied/);
    expect(scene.decisions.map((d) => [d.tool, d.decision])).toEqual([['lookup_order', 'allow'], ['issue_refund', 'deny']]);
    await scene.close();
  });
});

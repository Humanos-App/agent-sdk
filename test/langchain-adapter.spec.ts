import { ToolMessage } from '@langchain/core/messages';
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

describe('langchain guard — a tool that answers with an error ToolMessage failed', () => {
  it('reports it as failed, and hands the ToolMessage back as the tool answered', async () => {
    const scene = await agentScene({ lookup_order: 'allow' });
    const humanos = await langchain(scene.via);
    const failing = tool(async (_args: Record<string, unknown>, config) => new ToolMessage({ content: 'order store down', tool_call_id: config.toolCall?.id ?? '', status: 'error' }), {
      name: 'lookup_order',
      description: 'Read an order by id.',
      schema: { type: 'object', properties: { order_id: { type: 'string' } } } as never,
    }) as unknown as StructuredToolInterface;
    const [guarded] = humanos.guard([failing], 'Support desk');
    const out = await guarded!.invoke({ name: 'lookup_order', args: { order_id: 'A-1' }, id: 'call_1', type: 'tool_call' });
    expect(ToolMessage.isInstance(out) && out.status).toBe('error');
    expect(scene.outcomes).toEqual([expect.objectContaining({ outcome: 'failed', error: 'order store down' })]);
    await scene.close();
  });
});

import { AIMessage, ToolMessage } from '@langchain/core/messages';
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

describe('langchain gate — each call reports the model that asked for it (#654)', () => {
  type Hooks = { wrapModelCall: (r: unknown, h: () => Promise<unknown>) => Promise<unknown>; wrapToolCall: (r: unknown, h: () => Promise<unknown>) => Promise<unknown> };
  const answer = (metadata: Record<string, unknown>) =>
    new AIMessage({
      id: 'chatcmpl-1',
      content: '',
      tool_calls: [
        { id: 'call_1', name: 'lookup_order', args: {} },
        { id: 'call_2', name: 'lookup_order', args: {} },
      ],
      response_metadata: metadata,
      usage_metadata: { input_tokens: 900, output_tokens: 40, total_tokens: 940 },
    });
  const toolCall = (id: string, messages: unknown[] = []) => ({ toolCall: { id, name: 'lookup_order', args: {} }, state: { messages } });
  const ran = async () => new ToolMessage({ content: 'found', tool_call_id: 'call_1' });

  it.each([
    ['OpenAI', { model_name: 'gpt-5-2026-08-07' }],
    ['Anthropic', { model: 'gpt-5-2026-08-07' }],
    ['Bedrock', { model_id: 'gpt-5-2026-08-07' }],
  ])('reports the model asked for, the one that answered and its tokens, for each call of the response — %s', async (_case, metadata) => {
    const scene = await agentScene({ lookup_order: 'allow' });
    const gate = (await langchain(scene.via)).gate() as unknown as Hooks;

    await gate.wrapModelCall({ tools: [], model: { model: 'gpt-5' } }, async () => answer(metadata));
    await gate.wrapToolCall(toolCall('call_1'), ran);
    await gate.wrapToolCall(toolCall('call_2'), ran);

    const context = { model: { requested: 'gpt-5', answered: 'gpt-5-2026-08-07', source: 'framework' }, step: { id: 'chatcmpl-1', inputTokens: 900, outputTokens: 40 } };
    expect(scene.decisions.map((d) => d.context)).toEqual([expect.objectContaining(context), expect.objectContaining(context)]);
    expect(scene.decisions[0]!.context?.framework).toEqual({ name: 'langchain', version: expect.any(String) });
    await scene.close();
  });

  it("reads a call whose model response it did not see from the agent's messages", async () => {
    const scene = await agentScene({ lookup_order: 'allow' });
    const gate = (await langchain(scene.via)).gate() as unknown as Hooks;

    await gate.wrapToolCall(toolCall('call_1', [answer({ model_name: 'gpt-5-2026-08-07' })]), ran);

    expect(scene.decisions[0]!.context?.model).toEqual({ answered: 'gpt-5-2026-08-07', source: 'framework' });
    await scene.close();
  });

  it('reports the model not accessed for a provider that names it nowhere it reads, and for a guarded ToolNode', async () => {
    const scene = await agentScene({ lookup_order: 'allow' });
    const humanos = await langchain(scene.via);
    const gate = humanos.gate() as unknown as Hooks;

    await gate.wrapModelCall({ tools: [], model: {} }, async () => answer({ engine: 'x' }));
    await gate.wrapToolCall(toolCall('call_1'), ran);
    await humanos.guard([named('lookup_order')], 'Orders')[0]!.invoke({ order_id: 'A-1' });

    expect(scene.decisions.map((d) => d.context?.model)).toEqual([{ source: 'not_accessed' }, { source: 'not_accessed' }]);
    await scene.close();
  });
});

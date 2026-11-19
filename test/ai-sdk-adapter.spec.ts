import { generateText, jsonSchema, simulateReadableStream, streamText, tool, type ToolSet } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { aiSdk } from '../src/adapters/ai-sdk.js';
import { ViaDeniedError } from '../src/guard.js';
import { agentScene } from './harness/agent.js';

describe('aiSdk — what guard leaves alone, and what describe declares', () => {
  it('a tool with no execute (the provider or the client runs it) is left as it is', async () => {
    const scene = await agentScene({});
    const humanos = await aiSdk(scene.via);
    const clientSide = tool({ description: 'Ask the user.', inputSchema: jsonSchema({ type: 'object' }) });
    expect(humanos.guard({ ask_user: clientSide }, 'Support desk').ask_user).toBe(clientSide);
    await scene.close();
  });

  it('a routed service’s tools are left to the proxy that checks them', async () => {
    const scene = await agentScene({});
    const humanos = await aiSdk(scene.via);
    scene.via.mcp.route({ service: 'Orders', command: 'node', args: ['server.mjs'] });
    const t = tool({ inputSchema: jsonSchema({ type: 'object' }), execute: async () => 'ok' });
    expect(humanos.guard({ lookup_order: t }, 'Orders').lookup_order).toBe(t);
    expect(humanos.guard({ lookup_order: t }, 'Support desk').lookup_order).not.toBe(t);
    await scene.close();
  });

  it('a refusal reaches the model in the words every adapter uses, still a ViaDeniedError; unreachable fails closed', async () => {
    const scene = await agentScene({ issue_refund: 'deny', lookup_order: 'allow' });
    const humanos = await aiSdk(scene.via);
    let ran = 0;
    const tools = humanos.guard({ issue_refund: tool({ inputSchema: jsonSchema({ type: 'object' }), execute: async () => ++ran }), lookup_order: tool({ inputSchema: jsonSchema({ type: 'object' }), execute: async () => ++ran }) }, 'Support desk');
    const refused = await (tools.issue_refund!.execute as (i: unknown, o: unknown) => Promise<unknown>)({}, {}).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ViaDeniedError);
    expect((refused as Error).message).toBe('Blocked by Humanos (policy_denied): the organization’s policy does not allow it. Nothing was run. Do not retry.');
    scene.humanos.down = true;
    await expect((tools.lookup_order!.execute as (i: unknown, o: unknown) => Promise<unknown>)({}, {})).rejects.toThrow(/^Blocked: Humanos could not be reached/);
    expect(ran).toBe(0);
    await scene.close();
  });

  it('describes a zod schema as JSON Schema, and declares only a fixed description', async () => {
    const scene = await agentScene({});
    const humanos = await aiSdk(scene.via);
    const tools: ToolSet = {
      issue_refund: tool({ description: 'Refund an order.', inputSchema: z.object({ order_id: z.string(), amount_eur: z.number() }), execute: async () => 'ok' }),
      dynamic: { description: () => 'depends on the call', inputSchema: jsonSchema({ type: 'object' }), execute: async () => 'ok' } as never,
    };
    const [refund, dynamic] = await humanos.describe(tools, 'Support desk');
    expect(refund).toMatchObject({ name: 'issue_refund', service: 'Support desk', description: 'Refund an order.', inputSchema: { type: 'object', properties: { amount_eur: { type: 'number' } } } });
    expect(dynamic).not.toHaveProperty('description');
    await scene.close();
  });
});

const USAGE = {
  inputTokens: { total: 1200, noCache: 1200, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 80, text: 80, reasoning: undefined },
};
const TOOL_CALLS = { unified: 'tool-calls' as const, raw: 'tool_calls' };
const call = (toolCallId: string) => ({ type: 'tool-call' as const, toolCallId, toolName: 'lookup_order', input: '{}' });

/** A model whose one response asks for `ids`, answered by a dated id, as a provider does. */
function mockModel(ids: string[], provider = 'openai.responses') {
  return new MockLanguageModelV4({
    provider,
    modelId: 'gpt-5',
    doGenerate: async () => ({
      content: ids.map(call),
      finishReason: TOOL_CALLS,
      usage: USAGE,
      response: { id: 'resp_1', modelId: 'gpt-5-2026-08-07' },
      warnings: [],
    }),
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start' as const, warnings: [] },
          { type: 'response-metadata' as const, id: 'resp_1', modelId: 'gpt-5-2026-08-07' },
          ...ids.map(call),
          { type: 'finish' as const, finishReason: TOOL_CALLS, usage: USAGE },
        ],
      }),
    }),
  });
}

describe("aiSdk — each call reports the model that asked for it (#654)", () => {
  const lookup = () => tool({ inputSchema: jsonSchema({ type: 'object' }), execute: async () => 'found' });

  it.each([['generateText'], ['streamText']])('reports the answering model and its step, two calls of one step sharing it — %s', async (run) => {
    const scene = await agentScene({ lookup_order: 'allow' });
    const humanos = await aiSdk(scene.via);
    const options = { model: humanos.model(mockModel(['call_1', 'call_2'])), prompt: 'Find my orders', tools: humanos.guard({ lookup_order: lookup() }, 'Orders') };

    if (run === 'generateText') await generateText(options);
    else await streamText(options).consumeStream();

    const step = { id: 'resp_1', inputTokens: 1200, outputTokens: 80 };
    expect(scene.decisions.map((d) => d.reported)).toEqual([
      { v: 1, framework: { name: 'ai-sdk', version: expect.any(String) }, model: { requested: 'gpt-5', answered: 'gpt-5-2026-08-07', source: 'framework' }, step },
      { v: 1, framework: { name: 'ai-sdk', version: expect.any(String) }, model: { requested: 'gpt-5', answered: 'gpt-5-2026-08-07', source: 'framework' }, step },
    ]);
    await scene.close();
  });

  it.each([
    ['OpenRouter as the provider', 'openrouter.chat', undefined, 'openrouter'],
    ['a Cloudflare Worker', 'openai.responses', 'Cloudflare-Workers', 'cloudflare-agents'],
  ])('names the framework the call ran in — %s', async (_case, provider, userAgent, name) => {
    if (userAgent) vi.stubGlobal('navigator', { userAgent });
    const scene = await agentScene({ lookup_order: 'allow' });
    const humanos = await aiSdk(scene.via);

    await generateText({ model: humanos.model(mockModel(['call_1'], provider)), prompt: 'Find my order', tools: humanos.guard({ lookup_order: lookup() }, 'Orders') });

    expect(scene.decisions[0]!.reported?.framework.name).toBe(name);
    vi.unstubAllGlobals();
    await scene.close();
  });

  it('reports the model not accessed for a model it did not wrap', async () => {
    const scene = await agentScene({ lookup_order: 'allow' });
    const humanos = await aiSdk(scene.via);

    await generateText({ model: mockModel(['call_1']), prompt: 'Find my order', tools: humanos.guard({ lookup_order: lookup() }, 'Orders') });

    expect(scene.decisions[0]!.reported).toEqual({ v: 1, framework: { name: 'ai-sdk', version: expect.any(String) }, model: { source: 'not_accessed' } });
    await scene.close();
  });
});

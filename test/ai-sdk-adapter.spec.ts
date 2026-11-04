import { jsonSchema, tool, type ToolSet } from 'ai';
import { describe, expect, it } from 'vitest';
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

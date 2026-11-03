/**
 * A Cloudflare Agent (`agents`, a Durable Object) whose tools go through `@humanos-ai/agent-sdk/ai-sdk`, run by the Workers
 * runtime itself (workerd, through wrangler) in the framework tests.
 *
 * A Worker has no disk and no `.env`: the agent's Humanos comes from its bindings, the connector's credentials and the
 * agent's key (`HUMANOS_AGENT_KEY`, the key file's content) as secrets, handed to `via({ env })`. Here the test sends
 * each scenario's in the request, where a deployed agent would read `this.env`.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { Agent, getAgentByName, type AgentNamespace } from 'agents';
import { generateText, jsonSchema, stepCountIs, tool } from 'ai';
import { aiSdk } from '../../../src/adapters/ai-sdk.js';
import { via } from '../../../src/via.js';

interface Env {
  SupportAgent: AgentNamespace<SupportAgent>;
}

/** One scenario: what to ask, which tools fail, the agent's Humanos variables, and the model to use. */
export interface Ask {
  prompt: string;
  failing?: string[];
  humanos: Record<string, string>;
  modelUrl: string;
}

export class SupportAgent extends Agent<Env> {
  async onRequest(request: Request): Promise<Response> {
    const ask = (await request.json()) as Ask;
    const humanos = await aiSdk(await via({ env: ask.humanos, cwd: '/' }));
    const ran: string[] = [];
    const run = (name: string, result: unknown) => async () => {
      ran.push(name);
      if (ask.failing?.includes(name)) throw new Error('order store down');
      return result;
    };
    const object = (properties: Record<string, unknown>) => jsonSchema({ type: 'object', properties, required: Object.keys(properties) } as never);
    const tools = humanos.guard(
      {
        lookup_order: tool({ description: 'Read an order by id.', inputSchema: object({ order_id: { type: 'string' } }), execute: run('lookup_order', { id: 'A-1', total_eur: 40 }) }),
        issue_refund: tool({ description: 'Refund an order, in euros.', inputSchema: object({ order_id: { type: 'string' }, amount_eur: { type: 'number' } }), execute: run('issue_refund', { refunded: 40 }) }),
      },
      'Support desk',
    );
    let error: string | undefined;
    await generateText({
      model: createAnthropic({ baseURL: `${ask.modelUrl}/v1`, apiKey: 'sk-ant-local-test' })('claude-test'),
      tools,
      prompt: ask.prompt,
      stopWhen: stepCountIs(5),
    }).catch((e: unknown) => {
      error = e instanceof Error ? e.message : String(e);
    });
    await humanos.via.tools.flush().catch(() => []);
    // `Cloudflare-Workers` in workerd: the proof the test ran in the Workers runtime, not in Node.
    return Response.json({ ran, error, runtime: navigator.userAgent });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const agent = await getAgentByName(env.SupportAgent, 'support');
    return agent.fetch(request);
  },
};

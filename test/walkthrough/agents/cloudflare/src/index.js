// A support agent on Cloudflare Agents (an Agent, a Durable Object), its model and tools on AI SDK, with the lines
// `humanos init` printed added (marked "Humanos"). GET /?case=<lookup|refund|discount5|discount15>.
import { createAnthropic } from '@ai-sdk/anthropic';
import { Agent, getAgentByName } from 'agents';
import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { aiSdk } from '@humanos-ai/agent-sdk/ai-sdk'; // Humanos
import { CASES, SERVICE } from '../cases.mjs';

export class SupportAgent extends Agent {
  async onRequest(request) {
    const humanos = await aiSdk(); // Humanos
    const ran = [];
    const tools = {
      lookup_order: tool({ description: 'Read an order by id.', inputSchema: z.object({ order_id: z.string() }), execute: async ({ order_id }) => (ran.push(`lookup_order ${order_id}`), { id: order_id, total_eur: 40, status: 'delivered' }) }),
      issue_refund: tool({ description: 'Refund an order, in euros.', inputSchema: z.object({ order_id: z.string(), amount_eur: z.number() }), execute: async ({ order_id, amount_eur }) => (ran.push(`issue_refund ${order_id} ${amount_eur}`), { refunded: amount_eur }) }),
      approve_discount: tool({ description: 'Approve a discount on an order, in percent.', inputSchema: z.object({ order_id: z.string(), percent: z.number() }), execute: async ({ order_id, percent }) => (ran.push(`approve_discount ${order_id} ${percent}%`), { approved: percent }) }),
    };
    try {
      const { text } = await generateText({
        model: createAnthropic({ apiKey: this.env.ANTHROPIC_API_KEY })('claude-haiku-5-5'),
        tools: humanos.guard(tools, SERVICE), // Humanos
        prompt: CASES[new URL(request.url).searchParams.get('case') ?? 'lookup'],
        stopWhen: stepCountIs(4),
      });
      return Response.json({ ran, text, runtime: navigator.userAgent });
    } catch (e) {
      return Response.json({ ran, error: String(e), runtime: navigator.userAgent }, { status: 500 });
    }
  }
}

export default {
  async fetch(request, env) {
    return (await getAgentByName(env.SupportAgent, 'support')).fetch(request);
  },
};

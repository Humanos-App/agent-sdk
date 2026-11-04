// A support agent on LangChain (createAgent), with the lines `humanos-agent init` printed added (marked "Humanos").
import { ChatAnthropic } from '@langchain/anthropic';
import { tool } from '@langchain/core/tools';
import { createAgent } from 'langchain';
import { z } from 'zod';
import { langchain } from '@humanos-ai/agent-sdk/langchain'; // Humanos
import { CASES, SERVICE } from './cases.mjs';

const humanos = await langchain(); // Humanos

const tools = [
  tool(async ({ order_id }) => (console.log(`TOOL RAN: lookup_order ${order_id}`), JSON.stringify({ id: order_id, total_eur: 40, status: 'delivered' })), {
    name: 'lookup_order', description: 'Read an order by id.', schema: z.object({ order_id: z.string() }),
  }),
  tool(async ({ order_id, amount_eur }) => (console.log(`TOOL RAN: issue_refund ${order_id} ${amount_eur}`), JSON.stringify({ refunded: amount_eur })), {
    name: 'issue_refund', description: 'Refund an order, in euros.', schema: z.object({ order_id: z.string(), amount_eur: z.number() }),
  }),
  tool(async ({ order_id, percent }) => (console.log(`TOOL RAN: approve_discount ${order_id} ${percent}%`), JSON.stringify({ approved: percent })), {
    name: 'approve_discount', description: 'Approve a discount on an order, in percent.', schema: z.object({ order_id: z.string(), percent: z.number() }),
  }),
];

const agent = createAgent({
  model: new ChatAnthropic({ model: 'claude-haiku-5-5' }),
  tools,
  middleware: [humanos.gate({ service: SERVICE })], // Humanos
});
const out = await agent.invoke({ messages: [{ role: 'user', content: CASES[process.argv[2] ?? 'lookup'] }] });
console.log(`AGENT: ${out.messages.at(-1).content}`);

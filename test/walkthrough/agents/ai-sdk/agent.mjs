// A support agent on Vercel AI SDK, with the lines `humanos-agent init` printed added (marked "Humanos").
import { anthropic } from '@ai-sdk/anthropic';
import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { aiSdk } from '@humanos-ai/agent-sdk/ai-sdk'; // Humanos
import { CASES, SERVICE } from './cases.mjs';

const humanos = await aiSdk(); // Humanos

const tools = {
  lookup_order: tool({
    description: 'Read an order by id.',
    inputSchema: z.object({ order_id: z.string() }),
    execute: async ({ order_id }) => (console.log(`TOOL RAN: lookup_order ${order_id}`), { id: order_id, total_eur: 40, status: 'delivered' }),
  }),
  issue_refund: tool({
    description: 'Refund an order, in euros.',
    inputSchema: z.object({ order_id: z.string(), amount_eur: z.number() }),
    execute: async ({ order_id, amount_eur }) => (console.log(`TOOL RAN: issue_refund ${order_id} ${amount_eur}`), { refunded: amount_eur }),
  }),
  approve_discount: tool({
    description: 'Approve a discount on an order, in percent.',
    inputSchema: z.object({ order_id: z.string(), percent: z.number() }),
    execute: async ({ order_id, percent }) => (console.log(`TOOL RAN: approve_discount ${order_id} ${percent}%`), { approved: percent }),
  }),
};

const { text } = await generateText({
  model: anthropic('claude-haiku-5-5'),
  tools: humanos.guard(tools, SERVICE), // Humanos
  prompt: CASES[process.argv[2] ?? 'lookup'],
  stopWhen: stepCountIs(4),
});
console.log(`AGENT: ${text}`);

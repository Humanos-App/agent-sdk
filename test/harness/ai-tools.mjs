// An agent's AI SDK tools, as a module exports them: what `humanos-agent declare --entry` reads.
import { tool } from 'ai';
import { z } from 'zod';

export const tools = {
  lookup_order: tool({ description: 'Read an order by id.', inputSchema: z.object({ order_id: z.string() }), execute: async ({ order_id }) => ({ id: order_id }) }),
  issue_refund: tool({ description: 'Refund an order, in euros.', inputSchema: z.object({ order_id: z.string(), amount_eur: z.number() }), execute: async () => 'ok' }),
};

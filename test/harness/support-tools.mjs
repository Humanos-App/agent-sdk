// The support desk's tools, as a real MCP server registers them: one server's surface for every MCP test.
import { z } from 'zod';

/** Registers `lookup_order` and `issue_refund`; `record` gets each call with the `_meta` it arrived with. */
export function registerSupportTools(server, record) {
  server.registerTool(
    'lookup_order',
    { description: 'Read an order by id.', inputSchema: { order_id: z.string() }, annotations: { readOnlyHint: true } },
    async (args, extra) => {
      record({ tool: 'lookup_order', args, meta: extra._meta });
      return { content: [{ type: 'text', text: JSON.stringify({ id: args.order_id, total_eur: 40 }) }] };
    },
  );
  server.registerTool(
    'issue_refund',
    { description: 'Refund an order, in euros.', inputSchema: { order_id: z.string(), amount_eur: z.number() }, annotations: { destructiveHint: true } },
    async (args, extra) => {
      record({ tool: 'issue_refund', args, meta: extra._meta });
      return { content: [{ type: 'text', text: `refunded ${args.amount_eur}` }] };
    },
  );
}

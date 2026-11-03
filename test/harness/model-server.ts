/**
 * A scripted Anthropic Messages API: the model whose choices a scenario sets, so a framework runs its real agent loop
 * and its real Anthropic provider against it, and only the decisions are scripted.
 *
 * The step a request gets is the number of assistant turns already in its conversation, so the script follows the
 * conversation whatever side requests the framework makes. Past the last step the model answers in text with what
 * the last tool results said, which is how a test sees what the model was told. Streamed (SSE) and plain JSON both,
 * as `stream` asks. Every request is kept.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Step = { calls: { name: string; input: Record<string, unknown> }[] } | { text: string };

export interface ModelRequest {
  path: string;
  model?: string;
  stream?: boolean;
  tools: { name: string; description?: string; input_schema?: Record<string, unknown> }[];
  messages: { role: string; content: unknown }[];
}

export interface ModelServer {
  /** The base URL a provider takes (`baseURL`, `ANTHROPIC_BASE_URL`). */
  url: string;
  requests: ModelRequest[];
  /** Every `tool_result` the model was sent, by the tool call it answers, as text. */
  toolResults(): { toolUseId: string; text: string; isError: boolean }[];
  close(): Promise<void>;
}

type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: { text?: string }) => c.text ?? '').join('\n') : JSON.stringify(content ?? '');

export async function startModelServer(steps: Step[]): Promise<ModelServer> {
  const requests: ModelRequest[] = [];
  let ids = 0;

  // A framework may expose a tool under a longer name (`mcp__support__lookup_order`, `orders_lookup_order`): the script
  // names the tool, and the call goes out under the name the request offered it as.
  const exposed = (req: ModelRequest, name: string): string =>
    req.tools.find((t) => t.name === name)?.name ?? req.tools.find((t) => t.name.endsWith(`__${name}`) || t.name.endsWith(`_${name}`))?.name ?? name;

  const blocksFor = (req: ModelRequest): Block[] => {
    const step = steps[req.messages.filter((m) => m.role === 'assistant').length];
    if (step && 'calls' in step) return step.calls.map((c) => ({ type: 'tool_use', id: `toolu_${++ids}`, name: exposed(req, c.name), input: c.input }));
    if (step) return [{ type: 'text', text: step.text }];
    const last = req.messages[req.messages.length - 1];
    const results = Array.isArray(last?.content) ? (last.content as { type: string; content?: unknown }[]).filter((c) => c.type === 'tool_result') : [];
    return [{ type: 'text', text: results.length ? `Tool results: ${results.map((r) => textOf(r.content)).join(' | ')}` : 'Done.' }];
  };

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c));
    req.on('end', () => {
      const body = (raw ? JSON.parse(raw) : {}) as Partial<ModelRequest> & { stream?: boolean };
      const path = (req.url ?? '').split('?')[0]!;
      if (path.endsWith('/count_tokens')) return json(res, { input_tokens: 10 });
      if (!path.endsWith('/v1/messages')) return json(res, { type: 'error', error: { type: 'not_found_error', message: path } }, 404);
      const request: ModelRequest = { path, tools: body.tools ?? [], messages: body.messages ?? [], ...(body.model ? { model: body.model } : {}), ...(body.stream !== undefined ? { stream: body.stream } : {}) };
      requests.push(request);
      const blocks = blocksFor(request);
      const stopReason = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
      const message = { id: `msg_${++ids}`, type: 'message', role: 'assistant', model: body.model ?? 'claude-test', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } };
      if (!body.stream) return json(res, { ...message, content: blocks, stop_reason: stopReason });

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const event = (data: Record<string, unknown>) => res.write(`event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`);
      event({ type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } });
      blocks.forEach((b, index) => {
        if (b.type === 'text') {
          event({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
          event({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
        } else {
          event({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
          event({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
        }
        event({ type: 'content_block_stop', index });
      });
      event({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } });
      event({ type: 'message_stop' });
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    toolResults: () =>
      requests.flatMap((r) =>
        r.messages.flatMap((m) =>
          Array.isArray(m.content)
            ? (m.content as { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[])
                .filter((c) => c.type === 'tool_result')
                .map((c) => ({ toolUseId: String(c.tool_use_id), text: textOf(c.content), isError: c.is_error === true }))
            : [],
        ),
      ).filter((r, i, all) => all.findIndex((x) => x.toolUseId === r.toolUseId) === i),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function json(res: import('node:http').ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

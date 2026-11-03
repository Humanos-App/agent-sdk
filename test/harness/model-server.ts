/**
 * A scripted model: the model whose choices a scenario sets, so a framework runs its real agent loop and its real
 * provider against it, and only the decisions are scripted. It speaks two APIs, so most providers can point at it:
 * Anthropic's Messages API (`/v1/messages`), and the OpenAI-compatible Chat Completions API (`/chat/completions`,
 * which OpenRouter speaks, at `/api/v1`).
 *
 * The step a request gets is the number of assistant turns already in its conversation, so the script follows the
 * conversation whatever side requests the framework makes. Past the last step the model answers in text with what
 * the last tool results said, which is how a test sees what the model was told. Streamed (SSE) and plain JSON both,
 * as `stream` asks. Every request is kept, in one shape whichever API it came in on.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Step = { calls: { name: string; input: Record<string, unknown> }[] } | { text: string };

export interface ModelRequest {
  /** Which API the request came in on. */
  api: 'anthropic' | 'openai';
  path: string;
  model?: string;
  stream?: boolean;
  /** The tools offered, by name, whichever API offered them. */
  tools: { name: string; description?: string }[];
  /** The conversation as sent, in its API's own shape. */
  messages: { role: string; content?: unknown; tool_call_id?: string }[];
}

export interface ModelServer {
  /** The base URL a provider takes: Anthropic's `baseURL` / `ANTHROPIC_BASE_URL`; OpenRouter's is this plus `/api/v1`. */
  url: string;
  requests: ModelRequest[];
  /** Every tool result the model was sent, by the tool call it answers, as text. */
  toolResults(): { toolUseId: string; text: string; isError: boolean }[];
  close(): Promise<void>;
}

type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: { text?: string }) => c.text ?? '').join('\n') : JSON.stringify(content ?? '');

/** The tool results in a conversation, Anthropic's (`tool_result` blocks) or OpenAI's (`role: 'tool'` messages). */
function resultsIn(req: ModelRequest): { toolUseId: string; text: string; isError: boolean }[] {
  if (req.api === 'openai') return req.messages.filter((m) => m.role === 'tool').map((m) => ({ toolUseId: String(m.tool_call_id), text: textOf(m.content), isError: false }));
  return req.messages.flatMap((m) =>
    Array.isArray(m.content)
      ? (m.content as { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[])
          .filter((c) => c.type === 'tool_result')
          .map((c) => ({ toolUseId: String(c.tool_use_id), text: textOf(c.content), isError: c.is_error === true }))
      : [],
  );
}

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
    // Past the script: tell back the results the last turn carried.
    const last = req.messages.filter((m) => m.role === 'assistant').length;
    const results = resultsIn({ ...req, messages: req.api === 'openai' ? req.messages.slice(req.messages.map((m) => m.role).lastIndexOf('assistant') + 1) : req.messages.slice(-1) });
    return [{ type: 'text', text: last && results.length ? `Tool results: ${results.map((r) => r.text).join(' | ')}` : 'Done.' }];
  };

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c));
    req.on('end', () => {
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
      const path = (req.url ?? '').split('?')[0]!;
      if (path.endsWith('/count_tokens')) return json(res, { input_tokens: 10 });
      if (path.endsWith('/chat/completions')) return openai(res, body, path);
      if (path.endsWith('/v1/messages')) return anthropic(res, body, path);
      return json(res, { error: { message: `no such endpoint: ${path}` } }, 404);
    });
  });

  const anthropic = (res: ServerResponse, body: Record<string, unknown>, path: string) => {
    const request: ModelRequest = {
      api: 'anthropic',
      path,
      tools: ((body.tools ?? []) as { name: string; description?: string }[]).map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}) })),
      messages: (body.messages ?? []) as ModelRequest['messages'],
      ...(body.model ? { model: String(body.model) } : {}),
      ...(body.stream !== undefined ? { stream: body.stream === true } : {}),
    };
    requests.push(request);
    const blocks = blocksFor(request);
    const stopReason = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
    const message = { id: `msg_${++ids}`, type: 'message', role: 'assistant', model: request.model ?? 'claude-test', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } };
    if (!body.stream) return json(res, { ...message, content: blocks, stop_reason: stopReason });

    const event = sse(res, true);
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
  };

  const openai = (res: ServerResponse, body: Record<string, unknown>, path: string) => {
    const request: ModelRequest = {
      api: 'openai',
      path,
      tools: ((body.tools ?? []) as { function: { name: string; description?: string } }[]).map((t) => ({ name: t.function.name, ...(t.function.description ? { description: t.function.description } : {}) })),
      messages: (body.messages ?? []) as ModelRequest['messages'],
      ...(body.model ? { model: String(body.model) } : {}),
      ...(body.stream !== undefined ? { stream: body.stream === true } : {}),
    };
    requests.push(request);
    const blocks = blocksFor(request);
    const calls = blocks.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
    const text = blocks.filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('') || null;
    const finish = calls.length ? 'tool_calls' : 'stop';
    const toolCalls = calls.map((c, index) => ({ index, id: `call_${c.id}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } }));
    const base = { id: `chatcmpl_${++ids}`, created: Math.floor(Date.now() / 1000), model: request.model ?? 'scripted' };
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    if (!body.stream) {
      return json(res, {
        ...base,
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: text, ...(toolCalls.length ? { tool_calls: toolCalls.map(({ index: _, ...c }) => c) } : {}) }, finish_reason: finish }],
        usage,
      });
    }
    const event = sse(res, false);
    const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => event({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finishReason }] });
    chunk({ role: 'assistant', content: text ?? '' });
    if (toolCalls.length) chunk({ tool_calls: toolCalls });
    chunk({}, finish);
    event({ ...base, object: 'chat.completion.chunk', choices: [], usage });
    res.write('data: [DONE]\n\n');
    res.end();
  };

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    toolResults: () => requests.flatMap(resultsIn).filter((r, i, all) => all.findIndex((x) => x.toolUseId === r.toolUseId) === i),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Server-sent events: Anthropic names each event; Chat Completions sends `data:` lines only. */
function sse(res: ServerResponse, named: boolean): (data: Record<string, unknown>) => void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  return (data) => void res.write(`${named ? `event: ${String(data.type)}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

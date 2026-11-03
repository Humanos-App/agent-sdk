/**
 * The custom path: an agent written straight on `@anthropic-ai/sdk`, with its own loop. `via()` is all it takes from
 * the SDK — `guard.call` around each tool of its own, the registry for declaring them, and MCP servers through
 * `via.mcp` (a stdio one routed behind the proxy, an HTTP one through the connection wrapper). No adapter.
 */
import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ViaDeniedError } from '../../src/guard.js';
import { routeStdio } from '../../src/mcp/transport.js';
import { runContract, type FrameworkDriver, type RunContext } from './contract.js';

type Message = Anthropic.MessageParam;

const custom: FrameworkDriver = {
  name: 'custom (@anthropic-ai/sdk)',
  callProofOverHttp: true,
  async run(ctx: RunContext) {
    const anthropic = new Anthropic({ baseURL: ctx.model.url, apiKey: 'sk-ant-local-test' });
    const { via } = ctx;

    // The agent's own tools: declared once, each call through the guard.
    void via.tools.add(ctx.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, service: ctx.service })));
    const run = new Map<string, (input: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>>();
    for (const t of ctx.tools) {
      run.set(t.name, async (input) => {
        try {
          const out = await via.guard.call(t.name, input, (a) => t.execute(a));
          return { text: JSON.stringify(out.result), isError: false };
        } catch (e) {
          if (e instanceof ViaDeniedError) return { text: `Blocked by Humanos (${e.reason})`, isError: true };
          return { text: `Error: ${e instanceof Error ? e.message : String(e)}`, isError: true };
        }
      });
    }

    // MCP servers: checked where they connect, never again here.
    const clients: Client[] = [];
    const mcpTools: Anthropic.Tool[] = [];
    const connect = async (transport: ConstructorParameters<typeof Object>[0]) => {
      const client = new Client({ name: 'custom-agent', version: '1.0.0' });
      await client.connect(transport as never);
      clients.push(client);
      for (const t of (await client.listTools()).tools) {
        mcpTools.push({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema as Anthropic.Tool.InputSchema });
        run.set(t.name, async (input) => {
          const r = (await client.callTool({ name: t.name, arguments: input })) as { content: { text?: string }[]; isError?: boolean };
          return { text: r.content.map((c) => c.text ?? '').join('\n'), isError: r.isError === true };
        });
      }
    };
    if (ctx.mcp.stdio) {
      const routed = routeStdio(ctx.mcp.stdio, ctx.proxy);
      await connect(new StdioClientTransport({ command: routed.command!, args: routed.args ?? [], env: { ...getDefaultEnvironment(), ...ctx.env, ...(routed.env ?? {}) }, stderr: 'ignore' }));
    }
    if (ctx.mcp.http) {
      const { service, url, origin } = ctx.mcp.http;
      await connect(via.mcp.transport(service, new StreamableHTTPClientTransport(new URL(url)), { origin }));
    }

    try {
      const tools: Anthropic.Tool[] = [
        ...ctx.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Tool.InputSchema })),
        ...mcpTools,
      ];
      const messages: Message[] = [{ role: 'user', content: ctx.prompt }];
      for (let turn = 0; turn < 5; turn++) {
        const reply = await anthropic.messages.create({ model: 'claude-test', max_tokens: 1024, tools, messages });
        messages.push({ role: 'assistant', content: reply.content });
        if (reply.stop_reason !== 'tool_use') return;
        const uses = reply.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
        const results = await Promise.all(
          uses.map(async (u) => {
            const r = await run.get(u.name)!(u.input as Record<string, unknown>);
            return { type: 'tool_result' as const, tool_use_id: u.id, content: r.text, is_error: r.isError };
          }),
        );
        messages.push({ role: 'user', content: results });
      }
    } finally {
      await Promise.all(clients.map((c) => c.close()));
    }
  },
};

runContract(custom);

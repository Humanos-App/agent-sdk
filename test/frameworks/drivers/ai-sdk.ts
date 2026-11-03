/**
 * Vercel AI SDK, for real: `generateText` and `streamText` with `@ai-sdk/anthropic` against the scripted model, the
 * agent's tools through `aiSdk().guard`, MCP servers through `@ai-sdk/mcp` (stdio routed behind the proxy, HTTP through
 * the connection wrapper).
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { experimental_createMCPClient as createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport as StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { generateText, stepCountIs, jsonSchema, streamText, tool, type ToolSet } from 'ai';
import { aiSdk } from '../../../src/adapters/ai-sdk.js';
import type { FrameworkDriver, RunContext } from '../contract.js';

/** The scenario's tools and servers as an AI SDK agent has them; `close` ends the MCP clients. */
export async function toolsFor(ctx: RunContext): Promise<{ tools: ToolSet; close: () => Promise<void> }> {
  const humanos = await aiSdk(ctx.via);
  const own: ToolSet = Object.fromEntries(
    ctx.tools.map((t) => [t.name, tool({ description: t.description, inputSchema: jsonSchema(t.inputSchema as never), execute: (input) => t.execute(input as Record<string, unknown>) })]),
  );
  let tools: ToolSet = humanos.guard(own, ctx.service);
  const clients: { close(): Promise<void> }[] = [];
  if (ctx.mcp.stdio) {
    const routed = ctx.via.mcp.route(ctx.mcp.stdio, ctx.proxy);
    const client = await createMCPClient({ transport: new StdioMCPTransport({ command: routed.command!, args: routed.args ?? [], env: { ...(process.env as Record<string, string>), ...ctx.env, ...(routed.env ?? {}) } }) });
    clients.push(client);
    tools = { ...tools, ...humanos.guard(await client.tools(), ctx.mcp.stdio.service) };
  }
  if (ctx.mcp.http) {
    const { service, url, origin } = ctx.mcp.http;
    const client = await createMCPClient({ transport: ctx.via.mcp.transport(service, new StreamableHTTPClientTransport(new URL(url)), { origin }) });
    clients.push(client);
    tools = { ...tools, ...humanos.guard(await client.tools(), service) };
  }
  return { tools, close: async () => void (await Promise.all(clients.map((c) => c.close()))) };
}

const model = (ctx: RunContext) => createAnthropic({ baseURL: `${ctx.llm.baseURL}/v1`, apiKey: ctx.llm.apiKey })(ctx.llm.model);

export const generate: FrameworkDriver = {
  name: 'AI SDK generateText',
  callProofOverHttp: true,
  async run(ctx) {
    const { tools, close } = await toolsFor(ctx);
    try {
      await generateText({ model: model(ctx), tools, prompt: ctx.prompt, stopWhen: stepCountIs(5) });
    } finally {
      await close();
    }
  },
};

export const stream: FrameworkDriver = {
  name: 'AI SDK streamText',
  callProofOverHttp: true,
  async run(ctx) {
    const { tools, close } = await toolsFor(ctx);
    try {
      const result = streamText({ model: model(ctx), tools, prompt: ctx.prompt, stopWhen: stepCountIs(5), onError: () => {} });
      await result.consumeStream();
    } finally {
      await close();
    }
  },
};


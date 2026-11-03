/**
 * LangChain, for real: `createAgent` with `ChatAnthropic` against the scripted model and `langchain().gate()` as its
 * middleware, and a LangGraph graph of its own (`ToolNode`) with `langchain().guard()`. MCP servers through
 * `@langchain/mcp-adapters` (stdio routed behind the proxy, HTTP checked by the gate).
 */
import { ChatAnthropic } from '@langchain/anthropic';
import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { createAgent } from 'langchain';
import { langchain, type LangChainHumanos } from '../../src/adapters/langchain.js';
import { runContract, type FrameworkDriver, type RunContext } from './contract.js';

const model = (ctx: RunContext) => new ChatAnthropic({ model: 'claude-test', apiKey: 'sk-ant-local-test', anthropicApiUrl: ctx.model.url });

const ownTools = (ctx: RunContext): StructuredToolInterface[] =>
  ctx.tools.map((t) => tool(async (args: Record<string, unknown>) => JSON.stringify(await t.execute(args)), { name: t.name, description: t.description, schema: t.inputSchema as never }) as unknown as StructuredToolInterface);

/** The scenario's MCP servers through one `MultiServerMCPClient`, stdio ones routed behind the proxy. */
async function mcpTools(ctx: RunContext, humanos: LangChainHumanos) {
  const entries: Record<string, object> = {
    ...(ctx.mcp.stdio ? { [ctx.mcp.stdio.service]: { transport: 'stdio', command: ctx.mcp.stdio.command, args: ctx.mcp.stdio.args, env: { ...(process.env as Record<string, string>), ...ctx.env, ...ctx.mcp.stdio.env } } } : {}),
    ...(ctx.mcp.http ? { [ctx.mcp.http.service]: { transport: 'http', url: ctx.mcp.http.url } } : {}),
  };
  if (!Object.keys(entries).length) return { tools: [] as StructuredToolInterface[], close: async () => {} };
  const client = new MultiServerMCPClient({ mcpServers: humanos.mcp.servers(entries, ctx.proxy) as never });
  return { tools: await humanos.mcp.tools(client), close: () => client.close() };
}

const agent: FrameworkDriver = {
  name: 'LangChain createAgent',
  toolErrorsThrow: true,
  async run(ctx) {
    const humanos = await langchain(ctx.via);
    const mcp = await mcpTools(ctx, humanos);
    try {
      const a = createAgent({ model: model(ctx), tools: [...ownTools(ctx), ...mcp.tools], middleware: [humanos.gate({ service: ctx.service })] });
      await a.invoke({ messages: [{ role: 'user', content: ctx.prompt }] }, { recursionLimit: 12 });
    } finally {
      await mcp.close();
    }
  },
};

const graph: FrameworkDriver = {
  name: 'LangGraph ToolNode',
  async run(ctx) {
    const humanos = await langchain(ctx.via);
    const mcp = await mcpTools(ctx, humanos);
    try {
      const tools = [...humanos.guard(ownTools(ctx), ctx.service), ...humanos.guard(mcp.tools, ctx.mcp.stdio?.service ?? ctx.mcp.http?.service ?? ctx.service)];
      const llm = model(ctx).bindTools(tools);
      const app = new StateGraph(MessagesAnnotation)
        .addNode('agent', async (state) => ({ messages: [await llm.invoke(state.messages)] }))
        .addNode('tools', new ToolNode(tools))
        .addEdge(START, 'agent')
        .addConditionalEdges('agent', toolsCondition, ['tools', END])
        .addEdge('tools', 'agent')
        .compile();
      await app.invoke({ messages: [{ role: 'user', content: ctx.prompt }] }, { recursionLimit: 12 });
    } finally {
      await mcp.close();
    }
  },
};

runContract(agent);
runContract(graph);

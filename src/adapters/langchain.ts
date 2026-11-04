/**
 * LANGCHAIN — `@humanos-ai/agent-sdk/langchain`, for LangChain 1.x agents (`createAgent`) and LangGraph graphs.
 *
 * `gate()` is middleware for `createAgent({ middleware })`: `wrapToolCall` checks every tool call, the ones it loaded
 * from MCP servers included, and settles it from the `ToolMessage` the tool answered; a refused call never runs and
 * the model gets the refusal as an error `ToolMessage`. On the agent's first model call, `wrapModelCall` declares the
 * tools it was given, with their schemas. For a graph of your own (a LangGraph `ToolNode`), `guard(tools, service)`
 * hands the tools back with each call verified.
 *
 * MCP (`@langchain/mcp-adapters`): `mcp.servers` routes a `MultiServerMCPClient`'s stdio servers behind the proxy, and
 * `mcp.tools(client)` records which server each of its tools came from, so a tool is checked under its server's
 * service, and a routed server's tools are left to the proxy.
 */
import { ToolMessage } from '@langchain/core/messages';
import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { createMiddleware } from 'langchain';
import type { DeclaredTool } from '../mcp/declare.js';
import type { Via, ViaOptions } from '../via.js';
import { checkCall, refusalError, routeStdioEntries, runAndSettle, viaFrom } from './shared.js';

type Tools = readonly StructuredToolInterface[];
/** A `MultiServerMCPClient` server entry, as far as Humanos reads it. */
interface ServerEntry {
  transport?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/** A tool that answers with an error `ToolMessage` (LangChain's form of a tool's failure): what it said. */
const toolMessageFailure = (out: unknown): string | undefined => (ToolMessage.isInstance(out) && out.status === 'error' ? textOf(out.content) : undefined);

export interface LangChainHumanos {
  via: Via;
  /** Middleware for `createAgent`: every tool call checked; the agent's tools declared under `service` (MCP tools under their server's). */
  gate(options?: { service?: string }): ReturnType<typeof createMiddleware>;
  /** The tools again, each call verified before it runs, and declared under `service`: for a graph's own `ToolNode`. */
  guard(tools: Tools, service: string): StructuredToolInterface[];
  /** The tools as Humanos is told of them, with their JSON Schema. */
  describe(tools: Tools, service: string): DeclaredTool[];
  mcp: {
    /** `MultiServerMCPClient`'s `mcpServers` with each stdio entry routed behind the proxy. */
    servers<T extends Record<string, ServerEntry | object>>(servers: T, proxy?: { command: string; args: readonly string[] }): T;
    /** The client's tools, each recorded under the server it came from. */
    tools(client: { getTools(...servers: string[]): Promise<StructuredToolInterface[]> }, servers?: string[]): Promise<StructuredToolInterface[]>;
  };
}

/** An MCP tool's own name, from the name `MultiServerMCPClient` gave it. */
function ownName(name: string, server: string): string {
  const prefix = `${server}_`;
  if (name.startsWith(prefix)) return name.slice(prefix.length);
  const at = name.indexOf(`__${prefix}`);
  return at === -1 ? name : name.slice(at + 2 + prefix.length);
}

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: { text?: string }) => c.text ?? '').join('\n') : JSON.stringify(content);

export async function langchain(from?: Via | ViaOptions): Promise<LangChainHumanos> {
  const v = await viaFrom(from);
  /** A tool the agent calls by `name`, as Humanos names it: its server's service, and the MCP tool's own name. */
  const fromServer = new Map<string, { service: string; tool: string }>();
  const servers = new Set<string>();
  const named = (name: string, service: string) => fromServer.get(name) ?? { service, tool: name };

  const describe = (tools: Tools, service: string): DeclaredTool[] =>
    tools.map((t) => {
      const n = named(t.name, service);
      return { name: n.tool, service: n.service, ...(n.tool !== t.name ? { calledAs: t.name } : {}), ...(t.description ? { description: t.description } : {}), inputSchema: toJsonSchema(t.schema as never) as Record<string, unknown> };
    });
  /** Declared here unless the proxy a routed server runs behind declares it. */
  const declare = (tools: Tools, service: string) => {
    const own = tools.filter((t) => { const n = named(t.name, service); return !v.mcp.checks(n.service, n.tool); });
    if (own.length) void v.tools.add(describe(own, service)).catch(() => {}); // the registry warns on a failed declaration
  };

  const gate = (options: { service?: string } = {}) => {
    const service = options.service ?? 'Agent tools';
    let declared = false;
    return createMiddleware({
      name: 'HumanosMiddleware',
      wrapModelCall: async (request, handler) => {
        if (!declared) {
          declared = true;
          declare(request.tools.filter((t): t is StructuredToolInterface => typeof (t as StructuredToolInterface).name === 'string' && 'schema' in t), service);
        }
        return handler(request);
      },
      wrapToolCall: async (request, handler) => {
        const { name, args, id } = request.toolCall;
        const n = named(name, service);
        if (v.mcp.checks(n.service, n.tool)) return handler(request); // the proxy in front of its server checks it
        const call = await checkCall(v, n.tool, (args ?? {}) as Record<string, unknown>);
        // A refusal is the tool's answer, an error ToolMessage the model reads; the tool never runs.
        if (!call.ok) return new ToolMessage({ content: call.message, tool_call_id: id ?? '', name, status: 'error' });
        return runAndSettle(v, call.checked, () => handler(request), toolMessageFailure);
      },
    });
  };

  const guard = (tools: Tools, service: string): StructuredToolInterface[] => {
    declare(tools, service);
    return tools.map((t) => {
      const n = named(t.name, service);
      if (v.mcp.checks(n.service, n.tool)) return t;
      return tool(
        async (input: Record<string, unknown>, config) => {
          const call = await checkCall(v, n.tool, input ?? {});
          if (!call.ok) throw refusalError(call); // the ToolNode hands the model the error's words
          return runAndSettle(v, call.checked, () => t.invoke(input, config), toolMessageFailure);
        },
        { name: t.name, description: t.description, schema: t.schema as never },
      ) as unknown as StructuredToolInterface;
    });
  };

  return {
    via: v,
    gate,
    guard,
    describe,
    mcp: {
      servers(entries, proxy) {
        for (const name of Object.keys(entries)) servers.add(name);
        return routeStdioEntries(v, entries, proxy);
      },
      async tools(client, names = [...servers]) {
        const all: StructuredToolInterface[] = [];
        for (const server of names) {
          for (const t of await client.getTools(server)) {
            // `MultiServerMCPClient` prefixes each name with its server (`<server>_<tool>`, after any
            // `additionalToolNamePrefix__`): the policy speaks of the MCP tool's own name, so that is the one checked.
            fromServer.set(t.name, { service: server, tool: ownName(t.name, server) });
            all.push(t);
          }
        }
        return all;
      },
    },
  };
}

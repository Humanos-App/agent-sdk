/**
 * VERCEL AI SDK — `@humanos/agent-sdk/ai-sdk`, for `generateText`, `streamText` and `ToolLoopAgent` (AI SDK 5 and
 * later), and so for Cloudflare Agents (`AIChatAgent` runs `streamText`) and OpenRouter as a provider.
 *
 * `guard(tools, service)` hands the same `ToolSet` back with each `execute` going through Humanos first (checked, run,
 * its outcome reported; refused, it throws and AI SDK gives the model the error), and declares the tools, with their
 * schemas, under `service`. MCP tools from `createMCPClient().tools()` are tools like any other. Their connection can
 * go through `via.mcp.transport` instead, which checks them there with the call proof; `guard` then leaves them be.
 *
 * Out of reach: a tool the provider runs itself (no `execute`, as a provider's web search), and an `execute` that
 * returns a stream, whose outcome is reported when it is returned, not when the stream ends.
 */
import { asSchema, type ToolSet } from 'ai';
import type { DeclaredTool } from '../mcp/declare.js';
import { runChecked } from '../mcp/transport.js';
import type { Via, ViaOptions } from '../via.js';
import { viaFrom } from './shared.js';

export interface AiSdkHumanos {
  via: Via;
  /** `tools`, each `execute` verified before it runs, and declared under `service`. Tools with no `execute` are left as they are. */
  guard<T extends ToolSet>(tools: T, service: string): T;
  /** The tools as Humanos is told of them: name, title, description, input and output JSON Schema. */
  describe(tools: ToolSet, service: string): Promise<DeclaredTool[]>;
}

type Execute = (input: unknown, options: unknown) => unknown;

export async function aiSdk(from?: Via | ViaOptions): Promise<AiSdkHumanos> {
  const v = await viaFrom(from);

  const describe = (tools: ToolSet, service: string): Promise<DeclaredTool[]> =>
    Promise.all(
      Object.entries(tools).map(async ([name, t]) => ({
        name,
        service,
        // `title` came with AI SDK 6: read it so the adapter builds against 5 too.
        ...((t as { title?: string }).title ? { title: (t as { title?: string }).title } : {}),
        // AI SDK 7 lets a description be a function of the call's context; only a fixed one can be declared.
        ...(typeof t.description === 'string' ? { description: t.description } : {}),
        ...(t.inputSchema ? { inputSchema: (await asSchema(t.inputSchema).jsonSchema) as Record<string, unknown> } : {}),
        ...(t.outputSchema ? { outputSchema: (await asSchema(t.outputSchema).jsonSchema) as Record<string, unknown> } : {}),
      })),
    );

  const guard = <T extends ToolSet>(tools: T, service: string): T => {
    void describe(tools, service).then((d) => v.tools.add(d)).catch(() => {}); // the registry warns on a failed declaration
    const guarded: Record<string, unknown> = {};
    for (const [name, t] of Object.entries(tools)) {
      const execute = t.execute as Execute | undefined;
      // No execute: the provider or the client runs it. A tool a wrapped MCP connection serves is checked there.
      if (!execute || v.mcp.checks(service, name)) {
        guarded[name] = t;
        continue;
      }
      guarded[name] = {
        ...t,
        execute: async (input: unknown, options: unknown) =>
          (await v.guard.call(name, (input ?? {}) as Record<string, unknown>, () => runChecked(() => execute(input, options)))).result,
      };
    }
    return guarded as T;
  };

  return { via: v, guard, describe };
}

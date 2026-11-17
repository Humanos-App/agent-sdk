/**
 * VERCEL AI SDK — `@humanos-ai/agent-sdk/ai-sdk`, for `generateText`, `streamText` and `ToolLoopAgent` (AI SDK 5 and
 * later), and so for Cloudflare Agents (`AIChatAgent` runs `streamText`) and OpenRouter as a provider.
 *
 * `guard(tools, service)` hands the same `ToolSet` back with each `execute` going through Humanos first (checked, run,
 * its outcome reported; refused, it throws and AI SDK gives the model the error), and declares the tools, with their
 * schemas, under `service`. MCP tools from `createMCPClient().tools()` are tools like any other. Their connection can
 * go through `via.mcp.transport` instead, which checks them there with the call proof; `guard` then leaves them be.
 *
 * `model(m)` wraps the agent's model so each call it asks for reports which model asked and the response's tokens
 * (#654). An execute only learns its call's id, so a model not wrapped reports its calls' model as `not_accessed`.
 *
 * Out of reach: a tool the provider runs itself (no `execute`, as a provider's web search), and an `execute` that
 * returns a stream, whose outcome is reported when it is returned, not when the stream ends.
 */
import { asSchema, wrapLanguageModel, type LanguageModel, type ToolSet } from 'ai';
import { callContext, installedVersion, StepLedger, type CallContext, type FrameworkName, type StepReport } from '../context.js';
import type { DeclaredTool } from '../mcp/declare.js';
import type { Via, ViaOptions } from '../via.js';
import { checkCall, refusalError, runAndSettle, viaFrom } from './shared.js';
import { reportingMiddleware, type ModelStep } from './utils/ai-sdk-steps.js';

export interface AiSdkHumanos {
  via: Via;
  /** `tools`, each `execute` verified before it runs, and declared under `service`. Tools with no `execute` are left as they are. */
  guard<T extends ToolSet>(tools: T, service: string): T;
  /**
   * `model`, wrapped so each tool call it asks for reports which model asked and that response's tokens (#654). A model
   * named by a string (the AI Gateway) cannot be wrapped and comes back as it is.
   */
  model(model: LanguageModel): LanguageModel;
  /** The tools as Humanos is told of them: name, title, description, input and output JSON Schema. */
  describe(tools: ToolSet, service: string): Promise<DeclaredTool[]>;
}

type Execute = (input: unknown, options: unknown) => unknown;

/** How long a streamed call waits for its step's tokens, which arrive just after the call itself. Local, never the network. */
const STEP_WAIT_MS = 100;

export async function aiSdk(from?: Via | ViaOptions): Promise<AiSdkHumanos> {
  const v = await viaFrom(from);
  const steps = new StepLedger<ModelStep>();
  const version = await installedVersion('ai');

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

  /** The context of one call: the step that asked for it, once its tokens are in (or after a short wait). */
  const contextFor = async (callId: string | undefined): Promise<CallContext> => {
    const step = steps.take(callId);
    if (step) await Promise.race([step.done, _pause(STEP_WAIT_MS)]);
    const report: StepReport | undefined = step && { requested: step.requested, answered: step.answered, ...(step.step ? { step: step.step } : {}) };
    return callContext({ name: _frameworkOf(step?.provider), ...(version ? { version } : {}) }, report);
  };

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
        // AI SDK hands the model a thrown error's message: a refusal throws, in the words every adapter uses.
        execute: async (input: unknown, options: unknown) => {
          const context = await contextFor((options as { toolCallId?: string } | undefined)?.toolCallId);
          const call = await checkCall(v, name, (input ?? {}) as Record<string, unknown>, context);
          if (!call.ok) throw refusalError(call);
          return runAndSettle(v, call.checked, () => execute(input, options));
        },
      };
    }
    return guarded as T;
  };

  const model = (m: LanguageModel): LanguageModel =>
    typeof m === 'string' ? m : wrapLanguageModel({ model: m, middleware: reportingMiddleware(steps) });

  return { via: v, guard, model, describe };
}

/** The framework a call ran in: a Cloudflare Worker, OpenRouter as the provider, or AI SDK itself. */
function _frameworkOf(provider: string | undefined): FrameworkName {
  if ((globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent === 'Cloudflare-Workers') return 'cloudflare-agents';
  return provider?.startsWith('openrouter') ? 'openrouter' : 'ai-sdk';
}

/** Resolves after `ms`, never holding the process open for it. */
function _pause(ms: number): Promise<void> {
  return new Promise((done) => (setTimeout(done, ms) as { unref?: () => void }).unref?.());
}

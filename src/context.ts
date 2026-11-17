/**
 * What an agent's framework reports about one tool call (#654): the model whose response asked for it, that
 * response's id and tokens, and the framework. Each adapter reads it locally, from memory or a local file and never
 * the network, and the guard sends it with `verify`. The agent's own process declares it, so Humanos keeps it beside
 * the decision and never decides on it.
 */

/** Where the model came from: read from the framework, passed by the developer, or out of reach. */
export type ModelSource = 'framework' | 'declared' | 'not_accessed';

/** The names the adapters send; a guard used directly is `custom`, a call checked in the MCP proxy `mcp-proxy`. */
export type FrameworkName = 'ai-sdk' | 'openrouter' | 'cloudflare-agents' | 'langchain' | 'claude-agent-sdk' | 'mcp-proxy' | 'custom';

/** The model response that asked for a call. Every call one response asks for carries its tokens: count it once, by `id`. */
export interface CallStep {
  id: string;
  inputTokens?: number;
  outputTokens?: number;
  /** The output count was read before the response finished. */
  outputPartial?: boolean;
}

/** The context sent with `verify`, version 1. */
export interface CallContext {
  v: 1;
  framework: { name: FrameworkName; version?: string };
  model: { requested?: string; answered?: string; source: ModelSource };
  step?: CallStep;
}

/** What a framework knows of the response that asked for a call, before the call is checked. */
export interface StepReport {
  requested?: string;
  answered?: string;
  step?: CallStep;
}

/** The context a guard sends when its caller gave none: an integration that did not say. */
export const UNREPORTED: CallContext = { v: 1, framework: { name: 'custom' }, model: { source: 'not_accessed' } };

/** A call's context from the framework and what it read of the step; with no model read, `not_accessed`. */
export function callContext(framework: CallContext['framework'], report?: StepReport): CallContext {
  const model = { ...(report?.requested ? { requested: report.requested } : {}), ...(report?.answered ? { answered: report.answered } : {}) };
  return {
    v: 1,
    framework: { name: framework.name, ...(framework.version ? { version: framework.version } : {}) },
    model: { ...model, source: model.requested || model.answered ? 'framework' : 'not_accessed' },
    ...(report?.step ? { step: report.step } : {}),
  };
}

/** The context of a custom integration that knows its model: `declared`, as the developer passes it. */
export function declaredContext(model: { requested?: string; answered?: string }, step?: CallStep): CallContext {
  const known = model.requested || model.answered;
  return { ...callContext({ name: 'custom' }, { ...model, ...(step ? { step } : {}) }), model: { ...model, source: known ? 'declared' : 'not_accessed' } };
}

/**
 * Tool call id → the step that asked for it: filled when a model responds, read once when the call is checked.
 * Bounded, the oldest entry going first, so a call never checked cannot grow it.
 */
export class StepLedger {
  private readonly steps = new Map<string, StepReport>();

  constructor(private readonly max = 1_000) {}

  put(callId: string, report: StepReport): void {
    this.steps.delete(callId);
    this.steps.set(callId, report);
    if (this.steps.size > this.max) this.steps.delete(this.steps.keys().next().value as string);
  }

  /** The step that asked for the call, once: a call is checked once, so its entry goes. */
  take(callId: string | undefined): StepReport | undefined {
    if (!callId) return undefined;
    const report = this.steps.get(callId);
    this.steps.delete(callId);
    return report;
  }
}

const versions = new Map<string, Promise<string | undefined>>();

/** A package's version as the agent installed it, read once; none where no package file can be read (a Worker). */
export function installedVersion(pkg: string): Promise<string | undefined> {
  let version = versions.get(pkg);
  if (!version) {
    version = readVersion(pkg).catch(() => undefined);
    versions.set(pkg, version);
  }
  return version;
}

/** Resolves the package as this module would import it, then walks up to its own `package.json`. */
async function readVersion(pkg: string): Promise<string | undefined> {
  const [{ readFile }, { dirname, join }, { fileURLToPath }] = await Promise.all([import('node:fs/promises'), import('node:path'), import('node:url')]);
  let dir = dirname(fileURLToPath(import.meta.resolve(pkg)));
  for (;;) {
    const read = await readFile(join(dir, 'package.json'), 'utf8').catch(() => undefined);
    const json = read ? (JSON.parse(read) as { name?: string; version?: string }) : undefined;
    if (json?.name === pkg) return json.version;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

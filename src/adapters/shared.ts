/**
 * What every framework adapter shares: the agent's `via()`, given or built; one way to check a call (failing closed,
 * refusing in one set of words); one way to run it and report its outcome once; and one way to route a framework's
 * stdio MCP entries behind the proxy. Each adapter only maps these onto its framework's shapes (a thrown error, an
 * error `ToolMessage`, a hook's deny), so every framework refuses the same way.
 */
import { ViaDeniedError, type GuardCheck } from '../guard.js';
import { defaultPlainReason } from '../mcp/server.js';
import { runChecked } from '../mcp/transport.js';
import { via, type Via, type ViaOptions } from '../via.js';

const isVia = (v: Via | ViaOptions | undefined): v is Via => !!v && typeof (v as Via).guard?.check === 'function' && 'mcp' in v;

/** The agent's Humanos: the one given, or `via(options)` (one per process without options). */
export async function viaFrom(from?: Via | ViaOptions): Promise<Via> {
  return isVia(from) ? from : via(from);
}

/** The words a framework hands the model when Humanos keeps a call: the reason's code, so the agent can act on it, and its plain sense. */
export function blocked(reason: string | undefined): string {
  return `Blocked by Humanos (${reason ?? 'denied'}): ${defaultPlainReason(reason)}. Nothing was run. Do not retry.`;
}

/** The words when Humanos could not be asked: the call is refused, not let through. */
export function unreachable(error: unknown): string {
  return `Blocked: Humanos could not be reached to check this call (${error instanceof Error ? error.message : String(error)}). Nothing was run.`;
}

/** A call's check: go on with `checked`, or the refusal's words (with the check when Humanos refused it, none when it could not be asked). */
export type CallCheck = { ok: true; checked: GuardCheck } | { ok: false; message: string; checked?: GuardCheck };

/** Check one call. Fails closed: a call Humanos cannot be asked about is refused, never let through. */
export async function checkCall(v: Via, tool: string, args: Record<string, unknown>): Promise<CallCheck> {
  let checked: GuardCheck;
  try {
    checked = await v.guard.check(tool, args);
  } catch (e) {
    return { ok: false, message: unreachable(e) };
  }
  return checked.proceed ? { ok: true, checked } : { ok: false, message: blocked(checked.reason), checked };
}

/** A refusal as an error a framework throws: a `ViaDeniedError` with the refusal's words when Humanos refused, else an `Error`. */
export function refusalError(refused: Extract<CallCheck, { ok: false }>): Error {
  if (!refused.checked) return new Error(refused.message);
  const { reason, evaluations, under, mandateId, request } = refused.checked;
  const denied = new ViaDeniedError(reason, evaluations, under, mandateId, request);
  denied.message = refused.message;
  return denied;
}

/**
 * Run a checked call and report its outcome once: failed when `run` throws (rethrown as the framework would see it),
 * or when `failure` reads one in what it returned; completed otherwise. It runs inside `runChecked`, so a wrapped MCP
 * connection the call reaches does not check it a second time.
 */
export async function runAndSettle<T>(v: Via, checked: GuardCheck, run: () => T | Promise<T>, failure?: (out: T) => string | undefined): Promise<T> {
  let out: T;
  try {
    out = await runChecked(run);
  } catch (e) {
    await v.guard.settle(checked, { error: e });
    throw e;
  }
  const error = failure?.(out);
  await v.guard.settle(checked, error === undefined ? {} : { error });
  return out;
}

/** An MCP server entry in a framework's config, as far as routing reads it: Claude's `type`, LangChain's `transport`. */
interface ServerEntry {
  type?: string;
  transport?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * A framework's MCP server entries with each stdio one routed behind the governing proxy, under the entry's name as its
 * service (the proxy then checks and declares its tools, and `via.mcp.checks` leaves them to it); remote ones as they
 * are, checked by the adapter.
 */
export function routeStdioEntries<T extends Record<string, object>>(v: Via, entries: T, proxy?: { command: string; args: readonly string[] }): T {
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(entries)) {
    const e = entry as ServerEntry;
    if (!e.command || (e.type ?? e.transport ?? 'stdio') !== 'stdio') {
      out[name] = entry;
      continue;
    }
    const routed = v.mcp.route({ service: name, command: e.command, ...(e.args ? { args: e.args } : {}), ...(e.env ? { env: e.env } : {}) }, proxy);
    out[name] = { ...e, command: routed.command, args: routed.args };
  }
  return out as T;
}

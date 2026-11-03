/** What every framework adapter starts from: the agent's `via()`, given or built. */
import { via, type Via, type ViaOptions } from '../via.js';

const isVia = (v: Via | ViaOptions | undefined): v is Via => !!v && typeof (v as Via).guard?.check === 'function' && 'mcp' in v;

/** The agent's Humanos: the one given, or `via(options)` (one per process without options). */
export async function viaFrom(from?: Via | ViaOptions): Promise<Via> {
  return isVia(from) ? from : via(from);
}

/** The words a framework hands the model when Humanos keeps a call: the reason's code, so the agent can act on it. */
export function blocked(reason: string | undefined): string {
  return `Blocked by Humanos (${reason ?? 'denied'}): nothing was run. Do not retry.`;
}

/**
 * Registering an agent over the Humanos connector (v0.3 §16.5): `register_challenge` gives a single-use nonce and
 * `aud`, the platform's DID; the key's evidence is bound to both; `register` grades how the key is held and answers
 * the agent's DID. The agent's tools can go with it (`tools`), or be declared after it (`declareTools`).
 *
 * An agent with no key of its own registers with `humanosHoldsKey` (v0.3 §16.14): Humanos mints and holds its key.
 */
import type { Assurance, Binding, ViaAgentKey } from '../key-provider.js';
import type { ViaMcpClient } from './client.js';
import { DECLARE_TOOLS_MAX, wireTool, type DeclaredTool } from './declare.js';
import { McpVerifierError } from './guard-verifier.js';

/** What `register` answers. */
export interface RegisteredAgent {
  /** The agent's DID: the guard's `agentDid`, and `did` on every call after. */
  did: string;
  keyId: string;
  /** How Humanos graded the key (v0.3 §16). */
  granted: { assurance: Assurance; binding: Binding };
  /** Set when Humanos could not confirm the rung the key claimed, and granted a lower one. */
  degradedFrom?: Assurance;
  /** True when this key was already registered: the same agent, after a restart. */
  existing: boolean;
  /** `platform` when Humanos holds the agent's key (`humanosHoldsKey`). */
  custody?: 'platform';
}

/** The choice that Humanos holds the agent's key: `humanosHoldsKey`, the one value of this type. */
export interface HumanosHeldKey {
  readonly heldBy: 'humanos';
}

/**
 * For `registerAgent`: Humanos mints the agent's key and holds it, for an agent with no secure place to keep one
 * (v0.3 §16.14). Only under an agent key issued for this agent, never the organization's API key
 * (`custodial_needs_agent_key`). The agent key is bound to the agent it registers, and the choice is for good: an
 * agent that later holds its own key is a new agent, and its mandates stay with this one. Its guard takes no
 * `agentKey`.
 */
export const humanosHoldsKey: HumanosHeldKey = Object.freeze({ heldBy: 'humanos' as const });

/** By shape, not identity: two copies of this package each have their own `humanosHoldsKey`. */
const isHumanosHeld = (key: unknown): key is HumanosHeldKey =>
  typeof key === 'object' && key !== null && (key as { heldBy?: unknown }).heldBy === 'humanos';

const isAgentKey = (key: unknown): key is ViaAgentKey =>
  typeof key === 'object' && key !== null && 'publicJwk' in key && typeof (key as ViaAgentKey).evidence === 'function';

export interface RegisterAgentOptions {
  /**
   * The agent's tools, recorded with the registration as `declareTools` records them. At most
   * `DECLARE_TOOLS_MAX` in one registration; more go through `declareTools`, one call per service.
   */
  tools?: DeclaredTool[];
}

async function call<T>(client: ViaMcpClient, tool: string, args: Record<string, unknown>): Promise<T> {
  const r = await client.callTool(tool, args);
  if (r.isError) throw new McpVerifierError(tool, r.text);
  try {
    return JSON.parse(r.text) as T;
  } catch {
    throw new McpVerifierError(tool, `unparseable answer: ${r.text.slice(0, 200)}`);
  }
}

/**
 * Register the agent's key under the organization whose API key the client holds. The key is the agent: while
 * Humanos has no key rotation (v0.3 §16.5), a new key is a new agent, so keep it — `storedSoftwareKey` does — and
 * registering it again answers the same DID (`existing`). With `humanosHoldsKey`, Humanos holds it instead, and the
 * client's agent key is the agent: registering again under it answers the same DID.
 *
 * A key is never optional here: a key left out by mistake (a file or a variable that did not load) would register an
 * agent whose key Humanos holds, for good. Not having one is said with `humanosHoldsKey`.
 */
export async function registerAgent(client: ViaMcpClient, key: ViaAgentKey | HumanosHeldKey, options: RegisterAgentOptions = {}): Promise<RegisteredAgent> {
  const held = isHumanosHeld(key);
  if (!held && !isAgentKey(key)) {
    throw new TypeError(`registerAgent needs the agent's key, or humanosHoldsKey for a key Humanos holds (got ${key === null ? 'null' : typeof key})`);
  }
  const tools = options.tools ?? [];
  // Checked before the challenge: the platform refuses a larger registration outright, and the agent would not exist.
  if (tools.length > DECLARE_TOOLS_MAX) {
    throw new RangeError(`registerAgent takes at most ${DECLARE_TOOLS_MAX} tools (got ${tools.length}); declare the rest with declareTools`);
  }
  const declared = tools.length ? { tools: tools.map(wireTool) } : {};
  // No key to prove: `register` with no `publicKeyJwk` is the platform minting one (v0.3 §16.14), and needs no challenge.
  if (held) return call<RegisteredAgent>(client, 'register', declared);
  const { regNonce, aud } = await call<{ regNonce: string; aud: string }>(client, 'register_challenge', {});
  return call<RegisteredAgent>(client, 'register', {
    publicKeyJwk: key.publicJwk,
    evidence: await key.evidence(regNonce, aud),
    regNonce,
    ...declared,
  });
}

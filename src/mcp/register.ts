/**
 * Registering an agent over the Humanos connector (v0.3 §16.5): `register_challenge` gives a single-use nonce and
 * `aud`, the platform's DID; the key's evidence is bound to both; `register` grades how the key is held and answers
 * the agent's DID. The agent's tools can go with it (`tools`), or be declared after it (`declareTools`).
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
}

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
 * registering it again answers the same DID (`existing`).
 */
export async function registerAgent(client: ViaMcpClient, key: ViaAgentKey, options: RegisterAgentOptions = {}): Promise<RegisteredAgent> {
  const tools = options.tools ?? [];
  // Checked before the challenge: the platform refuses a larger registration outright, and the agent would not exist.
  if (tools.length > DECLARE_TOOLS_MAX) {
    throw new RangeError(`registerAgent takes at most ${DECLARE_TOOLS_MAX} tools (got ${tools.length}); declare the rest with declareTools`);
  }
  const { regNonce, aud } = await call<{ regNonce: string; aud: string }>(client, 'register_challenge', {});
  return call<RegisteredAgent>(client, 'register', {
    publicKeyJwk: key.publicJwk,
    evidence: await key.evidence(regNonce, aud),
    regNonce,
    ...(tools.length ? { tools: tools.map(wireTool) } : {}),
  });
}

/**
 * Registering an agent over the Humanos connector (v0.3 §16.5): `register_challenge` gives a single-use nonce and
 * `aud`, the platform's DID; the key's evidence is bound to both; `register` grades how the key is held and answers
 * the agent's DID. Declare the agent's tools after it (`declareTools`).
 */
import type { Assurance, Binding, ViaAgentKey } from '../key-provider.js';
import type { ViaMcpClient } from './client.js';
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
 * Register the agent's key under the organization whose API key the client holds. The key is the agent: keep it, and
 * registering it again answers the same DID (`existing`).
 */
export async function registerAgent(client: ViaMcpClient, key: ViaAgentKey): Promise<RegisteredAgent> {
  const { regNonce, aud } = await call<{ regNonce: string; aud: string }>(client, 'register_challenge', {});
  return call<RegisteredAgent>(client, 'register', { publicKeyJwk: key.publicJwk, evidence: await key.evidence(regNonce, aud), regNonce });
}

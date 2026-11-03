import { describe, expect, it } from 'vitest';
import { createRegChallengeStore, registerAgentKey, registerChallenge } from '@humanos/via-sdk-v03';
import type { ViaMcpClient } from '../src/mcp/client.js';
import { DECLARE_TOOLS_MAX, type DeclaredTool } from '../src/mcp/declare.js';
import { McpVerifierError } from '../src/mcp/guard-verifier.js';
import { registerAgent } from '../src/mcp/register.js';
import { softwareKey } from '../src/key-provider.js';

const AUD = 'did:web:humanos.tech';
const DID = 'did:web:humanos.tech:agent:a';

/**
 * A stand-in Humanos that registers for real: its challenge comes from the protocol SDK's store, and `register` runs
 * the protocol SDK's `registerAgentKey` over what the agent sent — so a proof bound to the wrong nonce or `aud` fails
 * here as it would on the platform. `refuse` answers a tool with a sentence, as the connector does.
 */
function platform(refuse: Partial<Record<'register_challenge' | 'register', string>> = {}) {
  const store = createRegChallengeStore();
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const client: ViaMcpClient = {
    initialize: async () => ({ serverInfo: { name: 'humanos', version: '0' }, protocolVersion: '2025-06-18' }),
    listTools: async () => [],
    callTool: async (tool, args = {}) => {
      calls.push({ tool, args });
      const refusal = refuse[tool as keyof typeof refuse];
      if (refusal) return { text: refusal, isError: true };
      if (tool === 'register_challenge') {
        const { regNonce } = await registerChallenge({ store });
        return { text: JSON.stringify({ regNonce, aud: AUD }), isError: false };
      }
      const res = await registerAgentKey(
        { cnf: { jwk: args.publicKeyJwk as never }, evidence: args.evidence as never, regNonce: args.regNonce as string },
        { store, audience: AUD },
      );
      if (!res.ok) return { text: `registration refused: ${res.reason}`, isError: true };
      const answer = { did: DID, keyId: `${DID}#key-1`, granted: { assurance: res.assurance, binding: res.binding }, existing: false };
      return { text: JSON.stringify(answer), isError: false };
    },
  };
  return { client, calls };
}

const tool = (name: string, extra: Partial<DeclaredTool> = {}): DeclaredTool => ({ name, service: 'Slack', ...extra });

describe('registerAgent', () => {
  it('asks for a challenge, then registers the key with evidence bound to its nonce and aud', async () => {
    const p = platform();
    const key = await softwareKey();

    const registered = await registerAgent(p.client, key);

    expect(p.calls.map((c) => c.tool)).toEqual(['register_challenge', 'register']);
    expect(p.calls[1].args.publicKeyJwk).toEqual(key.publicJwk);
    // the stand-in ran the protocol SDK's check over the proof, so this only passes if it is bound correctly
    expect(registered).toEqual({ did: DID, keyId: `${DID}#key-1`, granted: { assurance: 'pop', binding: 'self' }, existing: false });
  });

  it('sends no tools unless given, and given ones as declareTools sends them', async () => {
    const bare = platform();
    await registerAgent(bare.client, await softwareKey(), { tools: [] });
    expect(bare.calls[1].args).not.toHaveProperty('tools');

    const p = platform();
    await registerAgent(p.client, await softwareKey(), { tools: [tool('post', { title: undefined, description: 'Post a message' })] });
    // a field the tool does not have is not sent as `undefined`
    expect(p.calls[1].args.tools).toEqual([{ name: 'post', service: 'Slack', description: 'Post a message' }]);
  });

  it('throws the platform refusal, and registers nothing after a refused challenge', async () => {
    const p = platform({ register_challenge: 'rate limited' });
    await expect(registerAgent(p.client, await softwareKey())).rejects.toThrow(McpVerifierError);
    expect(p.calls.map((c) => c.tool)).toEqual(['register_challenge']);

    const q = platform({ register: 'registration refused: pop_invalid' });
    await expect(registerAgent(q.client, await softwareKey())).rejects.toThrow(/pop_invalid/);
  });

  it('refuses more tools than one registration takes before it asks for a challenge', async () => {
    const p = platform();
    const many = Array.from({ length: DECLARE_TOOLS_MAX + 1 }, (_, i) => tool(`t${i}`));
    await expect(registerAgent(p.client, await softwareKey(), { tools: many })).rejects.toThrow(RangeError);
    expect(p.calls).toHaveLength(0);
  });
});

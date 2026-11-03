import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRegChallengeStore, registerAgentKey, registerChallenge } from '@humanos/via-sdk-v03';
import type { ViaMcpClient } from '../src/mcp/client.js';
import { via } from '../src/via.js';

const AUD = 'did:web:humanos.tech';
const DID = 'did:web:humanos.tech:agent:a';

/** A stand-in Humanos that registers for real, as in register.spec.ts, and counts each tool it is asked for. */
function platform() {
  const store = createRegChallengeStore();
  const calls: string[] = [];
  const client: ViaMcpClient = {
    initialize: async () => ({ serverInfo: { name: 'humanos', version: '0' }, protocolVersion: '2025-06-18' }),
    listTools: async () => [],
    callTool: async (tool, args = {}) => {
      calls.push(tool);
      if (tool === 'register_challenge') {
        const { regNonce } = await registerChallenge({ store });
        return { text: JSON.stringify({ regNonce, aud: AUD }), isError: false };
      }
      if (tool === 'register') {
        const res = await registerAgentKey(
          { cnf: { jwk: args.publicKeyJwk as never }, evidence: args.evidence as never, regNonce: args.regNonce as string },
          { store, audience: AUD },
        );
        if (!res.ok) return { text: `registration refused: ${res.reason}`, isError: true };
        return { text: JSON.stringify({ did: DID, keyId: `${DID}#key-1`, granted: { assurance: res.assurance, binding: res.binding }, existing: false }), isError: false };
      }
      return { text: '{}', isError: false };
    },
  };
  return { client, calls };
}

const home = () => mkdtempSync(join(tmpdir(), 'via-home-'));

describe('via — the agent’s Humanos from its environment', () => {
  it('first start: mints the key in the agent’s directory, registers it, and keeps the DID with it', async () => {
    const dir = home();
    const { client, calls } = platform();
    const v = await via({ client, dir, env: {} });
    expect(v.did).toBe(DID);
    expect(calls).toEqual(['register_challenge', 'register']);
    expect(JSON.parse(readFileSync(join(dir, 'agent-key.json'), 'utf8'))).toMatchObject({ did: DID });
  });

  it('a restart loads the same key and DID, and registers nothing', async () => {
    const dir = home();
    await via({ client: platform().client, dir, env: {} });
    const again = platform();
    const v = await via({ client: again.client, dir, env: {} });
    expect(v.did).toBe(DID);
    expect(again.calls).toEqual([]);
  });

  it('HUMANOS_AGENT_KEY: the key from the variable, for an agent with no disk; its DID skips registering', async () => {
    const dir = home();
    await via({ client: platform().client, dir, env: {} });
    const json = readFileSync(join(dir, 'agent-key.json'), 'utf8');
    const again = platform();
    const v = await via({ client: again.client, dir: home(), env: { HUMANOS_AGENT_KEY: json } });
    expect(v.did).toBe(DID);
    expect(v.key.publicJwk).toEqual(JSON.parse(json).publicJwk);
    expect(again.calls).toEqual([]);
  });

  it('HUMANOS_AGENT_KEY with no DID registers at each start: the same key answers the same DID', async () => {
    const dir = home();
    await via({ client: platform().client, dir, env: {} });
    const { privateJwk, publicJwk } = JSON.parse(readFileSync(join(dir, 'agent-key.json'), 'utf8'));
    const again = platform();
    const v = await via({ client: again.client, env: { HUMANOS_AGENT_KEY: JSON.stringify({ privateJwk, publicJwk }) } });
    expect(v.did).toBe(DID);
    expect(again.calls).toEqual(['register_challenge', 'register']);
  });

  it('without the connector’s credentials it names the variable, and shows no value', async () => {
    await expect(via({ dir: home(), env: { HUMANOS_SIGNATURE_SECRET: 'secret-value' } })).rejects.toThrow(/HUMANOS_API_KEY is not set/);
    await expect(via({ dir: home(), env: { HUMANOS_API_KEY: 'key-value' } })).rejects.toThrow(/^via: HUMANOS_SIGNATURE_SECRET is not set[^]*init` adds it$/);
  });

  it('hands back a guard and a registry for the agent’s DID', async () => {
    const v = await via({ client: platform().client, dir: home(), env: {} });
    expect(typeof v.guard.check).toBe('function');
    expect(v.tools.tools()).toEqual([]);
  });
});

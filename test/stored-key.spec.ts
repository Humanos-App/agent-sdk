import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRegChallengeStore, registerAgentKey, registerChallenge } from '@humanos/via-sdk-v03';
import { ViaGuard } from '../src/guard.js';
import { storedSoftwareKey } from '../src/key-provider.js';
import { createTestVerifier } from '../src/testing.js';

const file = () => join(mkdtempSync(join(tmpdir(), 'via-key-')), 'key.json');

describe('storedSoftwareKey — a key that survives the process', () => {
  it('mints once, then loads the same key; the DID persists; the file is owner-only', async () => {
    const f = file();
    const a = await storedSoftwareKey(f);
    expect(a.minted).toBe(true);
    expect(a.did).toBeUndefined();
    a.save('did:web:humanos.tech:agent:x');
    expect(statSync(f).mode & 0o777).toBe(0o600);

    const b = await storedSoftwareKey(f);
    expect(b.minted).toBe(false);
    expect(b.publicJwk).toEqual(a.publicJwk);
    expect(b.did).toBe('did:web:humanos.tech:agent:x');
    expect(b.publicJwk).not.toHaveProperty('d');
  });

  it('keeps the file format agent-kit already wrote: { privateJwk, publicJwk, did? }', async () => {
    const f = file();
    const key = await storedSoftwareKey(f);
    key.save('did:web:humanos.tech:agent:y');
    const stored = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(['did', 'privateJwk', 'publicJwk']);
  });

  it('its proofs verify: a reloaded key signs calls a verifier accepts', async () => {
    const f = file();
    await storedSoftwareKey(f);
    const key = await storedSoftwareKey(f);
    const t = createTestVerifier({ rules: [], userParams: {}, agentKey: key });
    const guard = new ViaGuard({ mandate: t.mandate, agentKey: key, agentDid: 'did:web:humanos.tech:agent:x', verifier: t.verifier, compiled: t.compiled });
    expect((await guard.call('ping', {}, () => 'pong')).decision).toBe('allow');
    expect(t.outcomes).toHaveLength(1); // the outcome report carries a proof too
  });

  // v0.3 §16.5: a key the agent holds proves it is held, and earns the lowest rung for it.
  it('proves it is held, and the protocol SDK registers it at pop/self', async () => {
    const key = await storedSoftwareKey(file());
    expect([key.claimedAssurance, key.claimedBinding]).toEqual(['pop', 'self']);
    const store = createRegChallengeStore();
    const { regNonce } = await registerChallenge({ store });
    const aud = 'did:web:humanos.tech';
    const res = await registerAgentKey(
      { cnf: { jwk: key.publicJwk }, evidence: await key.evidence(regNonce, aud), regNonce },
      { store, audience: aud },
    );
    expect(res.ok && [res.assurance, res.binding]).toEqual(['pop', 'self']);
  });
});

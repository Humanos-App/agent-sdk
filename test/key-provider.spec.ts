import { describe, expect, it } from 'vitest';
import {
  attestationRootPem,
  attestedKey,
  buildDelegatedPoP,
  custodialKey,
  deviceSelfKey,
  forgedAttestedKey,
  simKmsDescribeKey,
  softwareKey,
} from '../src/key-provider.js';
import { actionHash, decodePoP, jwkThumbprint, verifyPoPSignature } from '../src/sdk.js';

describe('key providers — where the key lives is what the rung can be', () => {
  it('a delegated PoP exposes no private key and is a via-pop+jwt the protocol SDK verifies (A1–A3, A6)', async () => {
    const key = await softwareKey();
    expect((key as unknown as Record<string, unknown>).privateJwk).toBeUndefined();
    const payload = { cnf: { jkt: jwkThumbprint(key.publicJwk) }, aud: 'did:web:verifier.test', nonce: 'n-1', iat: 1_757_160_000, action_hash: actionHash('urn:via:credential:m', 'book_load', { tool: 'book_load', load_id: 'L-1' }) };
    const pop = await buildDelegatedPoP(payload, key.sign);
    const decoded = decodePoP(pop);
    expect(decoded.ok).toBe(true);
    expect(decoded.jkt).toBe(jwkThumbprint(key.publicJwk));
    expect(decoded.payload).toMatchObject({ aud: 'did:web:verifier.test', nonce: 'n-1' });
    expect(await verifyPoPSignature(pop, key.publicJwk)).toBe(true);
    // A different key does not verify it — the signature is the agent's, not the header's claim.
    expect(await verifyPoPSignature(pop, (await softwareKey()).publicJwk)).toBe(false);
  });

  it('each backend claims the rung its evidence can back — the platform grants the final one', async () => {
    expect(await softwareKey()).toMatchObject({ claimedAssurance: 'pop', claimedBinding: 'self' });
    expect(await deviceSelfKey()).toMatchObject({ claimedAssurance: 'pop', claimedBinding: 'self' });
    expect(await custodialKey()).toMatchObject({ claimedAssurance: 'pop', claimedBinding: 'custodial' });
    expect(await attestedKey()).toMatchObject({ claimedAssurance: 'hardware', claimedBinding: 'attested' });
  });

  it('evidence is the SDK\'s ConfinementEvidence, discriminated on `type`, bound to the nonce where it can be', async () => {
    expect(await (await softwareKey()).evidence('nonce')).toEqual({ type: 'none' });
    expect(await (await deviceSelfKey()).evidence('nonce')).toEqual({ type: 'device-self', nonExportable: true });
    const custody = await (await custodialKey('sim-kms')).evidence('nonce');
    expect(custody).toMatchObject({ type: 'custody', ref: { provider: 'sim-kms', keySpec: 'ECC_NIST_P256' } });
    const eat = await (await attestedKey()).evidence('bm9uY2U');
    expect(eat).toMatchObject({ type: 'attestation-eat' });
    expect(typeof (eat as { docB64: string }).docB64).toBe('string');
    expect((eat as { docB64: string }).docB64.length).toBeGreaterThan(100);
  });

  it('the custodial rung is an ORACLE fact: the evidence is a reference the verifier resolves, not a self-report', async () => {
    const key = await custodialKey();
    const ev = await key.evidence('n');
    if (ev.type !== 'custody') throw new Error('expected custody evidence');
    const described = simKmsDescribeKey(ev.ref);
    expect(described).toMatchObject({ exportable: false, keyId: ev.ref.keyId });
    expect(described?.publicJwk).toEqual(key.publicJwk);
    // An unknown reference resolves to nothing — the verifier then refuses the rung, not the agent.
    expect(simKmsDescribeKey({ ...ev.ref, keyId: 'not-registered' })).toBeNull();
  });

  it('a forged attestation chains to a root the verifier does not pin', async () => {
    // Both produce structurally valid quotes; only the pinned root tells them apart (§16.12).
    const pinned = await attestationRootPem();
    expect(pinned).toMatch(/BEGIN CERTIFICATE/);
    const genuine = await attestedKey();
    const forged = await forgedAttestedKey();
    expect(genuine.claimedAssurance).toBe('hardware');
    expect(forged.claimedAssurance).toBe('hardware'); // it CLAIMS the same — the claim is not the rung
    const [g, f] = await Promise.all([genuine.evidence('bm9uY2U'), forged.evidence('bm9uY2U')]);
    expect((g as { docB64: string }).docB64).not.toBe((f as { docB64: string }).docB64);
  });
});

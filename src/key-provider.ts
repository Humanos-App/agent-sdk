/**
 * KEY PROVIDER — where the agent's key lives, and therefore what assurance it
 * has ("hardware or not"). The guard signs through `key.sign()` and never sees a
 * private key it shouldn't; registration submits `key.evidence()` and the
 * platform VERIFIES it (§16.5). Assurance is a property of the provider that the
 * platform confirms — not a label the agent asserts.
 *
 * Backends here are software + two mocks (custodial KMS, attested enclave), but
 * the seam is real: the guard's PoP signing goes through `sign()`, so a genuine
 * KMS/TEE/WebAuthn backend drops in without touching the guard.
 *
 * Prototype-local note: this reimplements PoP *building* with a delegated signer
 * (`buildDelegatedPoP`) because the frozen SDK's `buildPoP` takes a raw private
 * JWK. The output is a standard `via-pop+jwt` the real SDK verifies unchanged —
 * upstream candidate: `buildPoP(payload, signer)`.
 */
import { generateP256Key, signES256, jwkThumbprint, mintNitroCa, buildCoseAttestation } from './sdk.js';
import type {
  Jwk,
  PopPayload,
  Assurance,
  Binding,
  ConfinementEvidence,
  CustodyRef,
  KeyDescription,
  NitroCa,
} from './sdk.js';

export type { Assurance, Binding, ConfinementEvidence };

export interface ViaAgentKey {
  readonly publicJwk: Jwk;
  /** The assurance the provider can back with evidence (the platform grants the final rung). */
  readonly claimedAssurance: Assurance;
  readonly claimedBinding: Binding;
  /** ES256 over the given bytes — in-process for software, delegated for KMS/enclave. */
  sign(bytes: Uint8Array): Promise<Uint8Array>;
  /**
   * Registration evidence bound to a platform-issued single-use nonce (§16.5).
   *
   * This is `ConfinementEvidence` — the SAME type `registerAgentKey` validates. It used to be a
   * parallel `RegistrationEvidence` declared here, discriminated on `kind` where the validator
   * switches on `type`, so nothing this package produced could be validated by the protocol SDK
   * at all. The demo passed because the mock platform carried its own matching validator.
   */
  evidence(regNonce: string): Promise<ConfinementEvidence>;
}

const te = new TextEncoder();
const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url');

/**
 * Build a signed `via-pop+jwt` (ES256) via a DELEGATED signer. Byte-format
 * identical to the SDK's `buildPoP`; the SDK's verify re-derives the signing
 * input from the base64 parts, so key order/formatting here are irrelevant.
 */
export async function buildDelegatedPoP(payload: PopPayload, sign: (bytes: Uint8Array) => Promise<Uint8Array>): Promise<string> {
  const header = { alg: 'ES256', typ: 'via-pop+jwt' };
  const h = b64u(te.encode(JSON.stringify(header)));
  const p = b64u(te.encode(JSON.stringify(payload)));
  const signingInput = `${h}.${p}`;
  const sig = await sign(te.encode(signingInput));
  return `${signingInput}.${b64u(sig)}`;
}

/** The lowest rung: a software key generated and held in the agent process. */
export async function softwareKey(): Promise<ViaAgentKey> {
  const kp = await generateP256Key();
  return {
    publicJwk: kp.publicJwk,
    claimedAssurance: 'pop',
    claimedBinding: 'self',
    sign: (bytes) => signES256(bytes, kp.privateJwk),
    evidence: (_regNonce) => Promise.resolve({ type: 'none' }),
  };
}

/**
 * Custodial binding: the key lives in a (sim) KMS that never exports it. The guard only gets
 * `sign()` — it holds no private material — and the evidence is a REFERENCE the verifier resolves
 * itself via a `DescribeKey` oracle. Grants `pop/CUSTODIAL`: the oracle fact is real and is
 * recorded on the binding axis; the assurance axis stays `pop` because nothing transferable was
 * proved.
 */
export async function custodialKey(provider = 'sim-kms'): Promise<ViaAgentKey> {
  // The private JWK is closed inside this factory — nothing outside can read it.
  const kp = await generateP256Key();
  const ref: CustodyRef = {
    provider,
    region: 'dev-1',
    keySpec: 'ECC_NIST_P256',
    keyId: jwkThumbprint(kp.publicJwk),
    arnClass: 'key',
  };
  // Register with the sim KMS so a verifier's DescribeKey can independently confirm
  // non-exportability. The evidence carries only the REFERENCE — the whole point of the
  // custodial rung is that the verifier asks the KMS rather than believing a self-report.
  SIM_KMS.set(ref.keyId, { exportable: false, publicJwk: kp.publicJwk, keyId: ref.keyId, keySpec: 'ECC_NIST_P256', origin: 'SIM_KMS' });
  return {
    publicJwk: kp.publicJwk,
    // `pop/custodial`. An earlier version of this file claimed `hardware`, reasoning from what
    // `validateCustody` granted — but the SDK was the thing that was wrong, and the spec says so
    // explicitly (§16.5's table; v0.3 §9.1 calls the asymmetry deliberate).
    //
    // The custody fact is NOT lost: it IS `binding: custodial`, a value defined as "a custody
    // oracle reports it". `assurance` answers a different question — what the verifier could
    // PROVE — and an unsigned DescribeKey response is testimony, not a document: real, but not
    // something a verifier can hand to an insurer. Only a chain to a pinned anchor is.
    claimedAssurance: 'pop',
    claimedBinding: 'custodial',
    sign: (bytes) => signES256(bytes, kp.privateJwk), // "the KMS signs" — the caller never sees the key
    evidence: (_regNonce) => Promise.resolve({ type: 'custody', ref }),
  };
}

// ---- the sim KMS (dev only) ----------------------------------------------------------
// Previously `custodialKey` shipped an inline `report: {exportable:false}` and the platform
// "verified" it by reading the agent's own claim back. The real custodial rung is defined by the
// verifier calling DescribeKey OUT OF BAND, which is what makes it stronger than `device-self`.
const SIM_KMS = new Map<string, KeyDescription>();

/**
 * A {@link DescribeKey} oracle over the sim KMS, for a verifier running in the SAME process
 * (tests, in-process demos). Cross-process, the platform must reach a real KMS — that is not a
 * limitation of the sim, it is what the custodial rung MEANS.
 */
export function simKmsDescribeKey(ref: CustodyRef): KeyDescription | null {
  return SIM_KMS.get(ref.keyId) ?? null;
}

/**
 * The self-asserted variant: the agent claims the key is non-exportable and the verifier has no way
 * to check. Grants `pop/self` — the same rung as {@link softwareKey}, because a claim is not
 * evidence. What it adds is on the CHAIN, not in the rung: the assertion is recorded, so a later
 * dispute has something signed to point at.
 */
export async function deviceSelfKey(): Promise<ViaAgentKey> {
  const kp = await generateP256Key();
  return {
    publicJwk: kp.publicJwk,
    claimedAssurance: 'pop',
    claimedBinding: 'self',
    sign: (bytes) => signES256(bytes, kp.privateJwk),
    evidence: (_regNonce) => Promise.resolve({ type: 'device-self', nonExportable: true }),
  };
}

// ---- the attestation root (dev only) -------------------------------------------------
// This used to be a FIXED demo P-256 keypair that signed a bespoke `rootSig` over a digest.
// Nothing validated it: the protocol SDK checks a COSE_Sign1 chained to a pinned X.509 root, so
// the "hardware" tier was decorative. It now mints a real Nitro-shaped CA and real attestation
// documents, via the SDK's own sim — the same producer its validator tests round-trip against.
let devCa: Promise<NitroCa> | null = null;

/**
 * The process-wide dev attestation CA. Memoized so every {@link attestedKey} in a process chains
 * to one root that a verifier can pin via {@link attestationRootPem}.
 *
 * CROSS-PROCESS: this is random per process, so an agent and a platform in DIFFERENT processes
 * must share the root explicitly — mint once, pass `attestationRootPem()` to the verifier's
 * `nitroRoots`. The old fixed keypair papered over this; a real deployment pins real vendor
 * roots, which is the same ceremony done properly.
 */
export function devNitroCa(): Promise<NitroCa> {
  devCa ??= mintNitroCa();
  return devCa;
}

/** The PEM a verifier must pin for {@link attestedKey} quotes to validate. */
export async function attestationRootPem(ca?: NitroCa): Promise<string> {
  return (ca ?? (await devNitroCa())).rootPem;
}

/**
 * Hardware rung: the key comes with a real COSE_Sign1 attestation document binding it to the
 * registration nonce, chained to `ca`'s root. A verifier pinning that root grants
 * `hardware/attested`; one pinning production roots refuses it — which is correct, because this
 * is a simulator.
 */
export async function attestedKey(ca?: NitroCa): Promise<ViaAgentKey> {
  const authority = ca ?? (await devNitroCa());
  const kp = await generateP256Key();
  return {
    publicJwk: kp.publicJwk,
    claimedAssurance: 'hardware',
    claimedBinding: 'attested',
    sign: (bytes) => signES256(bytes, kp.privateJwk),
    evidence: async (regNonce) => ({
      type: 'attestation-eat',
      docB64: await buildCoseAttestation(authority, {
        publicKeyJwk: kp.publicJwk,
        // Passed THROUGH, not re-encoded: `regNonce` is already base64url (the SDK mints it as
        // `randomBytes(18).toString('base64url')`), `buildCoseAttestation` embeds the decoded
        // bytes, and `readAttestationNonce` hands back their base64url — which `registerAgentKey`
        // compares to `regNonce` verbatim. Encoding it again here made every quote's nonce fail
        // that comparison, and the whole hardware tier degraded silently to pop/self.
        //
        // The nonce is COVERED by the COSE signature, which is what makes a captured quote
        // unreplayable against a different registration.
        nonceB64: regNonce,
      }),
    }),
  };
}

/**
 * An agent that CLAIMS hardware but whose attestation chains to a root the verifier does NOT
 * pin — a forged attestation. Structurally valid COSE_Sign1 over a real chain, so it exercises
 * the signature path properly and is refused on the ROOT, not on a malformed document.
 */
export async function forgedAttestedKey(): Promise<ViaAgentKey> {
  return attestedKey(await mintNitroCa()); // a second, unpinned CA
}

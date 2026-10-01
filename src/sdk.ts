/**
 * The Agent SDK's view of the VIA protocol (`sdk-v03`, imported read-only) —
 * only what the AGENT SIDE of the wire needs: P-256 keys + signing, PoP
 * encoding, canonicalization/digests, the credential/event types, and the
 * actor-model types an agent presents or receives. Platform-side machinery
 * (issuance, verification pipelines, CEL evaluation of policy) is deliberately
 * NOT re-exported here — the agent never runs it.
 */
export {
  generateP256Key,
  jwkThumbprint,
  cleanPublicJwk,
  signES256,
  verifyES256,
} from '../../sdk-v03/src/crypto/p256.js';
export type { Jwk, P256KeyPair } from '../../sdk-v03/src/crypto/p256.js';
export { computeSRI } from '../../sdk-v03/src/crypto/digest.js';
export { canonicalizeRFC8785 } from '../../sdk-v03/src/crypto/canonicalize.js';
export { buildPoP, actionHash, decodePoP, verifyPoPSignature } from '../../sdk-v03/src/agent/pop.js';
export type { PopPayload } from '../../sdk-v03/src/agent/pop.js';
export type {
  BoundKey,
  Assurance,
  Binding,
  // THE registration wire contract. The agent produces exactly what the platform validates —
  // this package used to declare a parallel `RegistrationEvidence` that no verifier accepted.
  ConfinementEvidence,
  ConfinementResult,
  CustodyRef,
  NitroCa,
} from '../../sdk-v03/src/agent/types.js';
export type { KeyDescription, DescribeKey } from '../../sdk-v03/src/agent/attestation.js';
// Dev-only attestation PRODUCER (separate SDK entry point — pulls in @peculiar/x509).
// Lets `attestedKey()` mint a real COSE_Sign1 instead of a mock quote.
export { mintNitroCa, buildCoseAttestation } from '../../sdk-v03/src/agent/sim.js';
export type { EventType } from '../../sdk-v03/src/crypto/proof.js';
export type { ViaMandateCredential, ViaEvent } from '../../sdk-v03/src/types.js';
export type { ChainAudit } from '../../sdk-v03/src/event/build.js';
export type { RuleEvaluation } from '../../sdk-v03/src/cel/evaluate.js';
export { evaluateRules } from '../../sdk-v03/src/cel/evaluate.js';
export { unwrapUserParamValues } from '../../sdk-v03/src/action/execution-params.js';
export type { ActionRule } from '../../sdk-v03/src/action/types.js';
export type {
  ViaActorRecord,
  ViaActorSubject,
  ActorKeyState,
  ActorStatus,
  BootstrapAnchor,
} from '../../sdk-v03/src/actor/model.js';

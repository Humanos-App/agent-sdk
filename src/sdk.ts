/**
 * The Agent SDK's view of the VIA protocol (`@humanos/via-sdk-v03`, the published package) —
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
} from '@humanos/via-sdk-v03';
export type { Jwk, P256KeyPair } from '@humanos/via-sdk-v03';
export { computeSRI } from '@humanos/via-sdk-v03';
export { canonicalizeRFC8785 } from '@humanos/via-sdk-v03';
export { buildPoP, actionHash, decodePoP, verifyPoPSignature } from '@humanos/via-sdk-v03';
export type { PopPayload } from '@humanos/via-sdk-v03';
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
} from '@humanos/via-sdk-v03';
export type { KeyDescription, DescribeKey } from '@humanos/via-sdk-v03';
// Dev-only attestation PRODUCER (separate SDK entry point — pulls in @peculiar/x509).
// Lets `attestedKey()` mint a real COSE_Sign1 instead of a mock quote.
export { mintNitroCa, buildCoseAttestation } from '@humanos/via-sdk-v03/agent/sim';
export type { EventType } from '@humanos/via-sdk-v03';
export type { ViaMandateCredential, ViaEvent } from '@humanos/via-sdk-v03';
export type { ChainAudit } from '@humanos/via-sdk-v03';
export type { RuleEvaluation } from '@humanos/via-sdk-v03';
export { evaluateRules, validateCelExpression } from '@humanos/via-sdk-v03';
export { unwrapUserParamValues } from '@humanos/via-sdk-v03';
export type { ActionRule } from '@humanos/via-sdk-v03';
export type {
  ViaActorRecord,
  ViaActorSubject,
  ActorKeyState,
  ActorStatus,
  BootstrapAnchor,
} from '@humanos/via-sdk-v03';

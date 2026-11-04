/**
 * The Agent SDK's view of the VIA protocol (`@humanos-ai/via-sdk`, the published package) —
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
} from '@humanos-ai/via-sdk';
export type { Jwk, P256KeyPair } from '@humanos-ai/via-sdk';
export { computeSRI } from '@humanos-ai/via-sdk';
export { canonicalizeRFC8785 } from '@humanos-ai/via-sdk';
export { buildPoP, actionHash, policyActionHash, decodePoP, verifyPoPSignature } from '@humanos-ai/via-sdk';
// §2.1 — the params an outcome report's PoP binds; the verifier rebuilds them with the same function.
export { outcomeParams } from '@humanos-ai/via-sdk';
export type { AgentOutcomeKind } from '@humanos-ai/via-sdk';
export { buildRegistrationProof } from '@humanos-ai/via-sdk';
export type { PopPayload } from '@humanos-ai/via-sdk';
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
} from '@humanos-ai/via-sdk';
export type { KeyDescription, DescribeKey } from '@humanos-ai/via-sdk';
// Dev-only attestation PRODUCER (separate SDK entry point — pulls in @peculiar/x509).
// Lets `attestedKey()` mint a real COSE_Sign1 instead of a mock quote.
export { mintNitroCa, buildCoseAttestation } from '@humanos-ai/via-sdk/agent/sim';
export type { EventType } from '@humanos-ai/via-sdk';
export type { ViaMandateCredential, ViaEvent } from '@humanos-ai/via-sdk';
export type { ChainAudit } from '@humanos-ai/via-sdk';
export type { RuleEvaluation } from '@humanos-ai/via-sdk';
export { evaluateRules, validateCelExpression } from '@humanos-ai/via-sdk';
export { unwrapUserParamValues } from '@humanos-ai/via-sdk';
export type { ActionRule } from '@humanos-ai/via-sdk';
export type {
  ViaActorRecord,
  ViaActorSubject,
  ActorKeyState,
  ActorStatus,
  BootstrapAnchor,
} from '@humanos-ai/via-sdk';

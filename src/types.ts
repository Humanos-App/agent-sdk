/**
 * THE WIRE CONTRACT — the shapes an agent exchanges with a VIA platform. They
 * live in the Agent SDK (not the platform) because this is the surface an
 * integrator programs against; any conforming platform (the agent2
 * mini-platform today, the real Humanos endpoints tomorrow) implements them.
 */
import type { ActionRule, RuleEvaluation, ViaEvent, ViaMandateCredential } from './sdk.js';

/** The verifier's answer to one presented tool call. */
export interface VerifyOutcome {
  decision: 'allow' | 'deny' | 'rechallenge';
  reason?: string;
  evaluations: RuleEvaluation[];
  /** The signed VERIFICATION_* VIAEvent appended to the credential's chain (absent on rechallenge). */
  event?: ViaEvent;
  /**
   * The decision event's id when the platform signs it ASYNCHRONOUSLY (Humanos appends chain
   * events through an outbox worker, so at answer time only the URN exists). The guard reports
   * the outcome against `event?.id ?? decisionEventId`; a verifier supplies one or the other.
   */
  decisionEventId?: string;
  /**
   * On `rechallenge` (v0.3 §17.4): the step-up the verifier opened — the page where the person
   * approves this exact call, and the id to present once they have.
   */
  stepUp?: StepUpRef;
  /** v0.3 §20.3 — what governed the decision: `rules`, `semantic`, `none`, or — with no mandate — `policy`. */
  enforcement?: string;
  /** v0.3 §21.3 — the organization's policy version the call was checked against. */
  policyDigest?: string;
  /**
   * v0.3 §21.3 — with `mandate_required`: the actions the organization's policy needs the mandate to be under, any one
   * of them. Ask the person for a mandate under one.
   */
  under?: { id: string }[];
}

/** Aggregate exposure metering config (PRD §5.5) — declared at publish time. */
export interface ExposurePolicy {
  /** Commit-class tools whose value accrues against the cap. */
  tools: string[];
  /** The executionParam carrying the exposure amount. */
  param: string;
  /** The mandate userParam holding the cap; absent on the mandate ⇒ no metering. */
  capUserParam: string;
  windowMs: number;
}

/**
 * The slice of a platform's compiled action the GUARD consumes (advisory
 * pre-flight only — the decision always stays with the verifier). Any richer
 * platform compile output satisfies this structurally.
 */
export interface CompiledLike {
  actionVersion: { rules: ActionRule[] };
}

/** v0.3 §16.11 — the verifier's challenge: a single-use nonce, the DID the PoP names as `aud`, and the nonce's life. */
export interface ChallengeGrant {
  nonce: string;
  aud: string;
  /** The nonce's life in seconds, from `iat`. */
  ttl: number;
  /** When it was issued, in epoch seconds. */
  iat: number;
}

/** v0.3 §21.4 — a challenge for a call with no mandate: scoped to the agent, naming the policy its PoP binds. */
export interface PolicyChallengeGrant extends ChallengeGrant {
  policy: string;
}

/** v0.3 §21.4 — a call with no mandate, presented to be decided on the organization's policy. */
export interface PolicyVerifyInput {
  /** The organization's policy, as the challenge named it: the PoP binds it in place of a mandate. */
  policy: string;
  /** The agent making the call — for a credential that is not the agent's own (an organization's key). */
  agentDid?: string;
  tool: string;
  /** Full executionParams INCLUDING the `tool` discriminator — must equal the PoP-hashed params. */
  params: Record<string, unknown>;
  pop: string;
  /** v0.3 §21.3 — an APPROVED step-up one of the policy's approvers gave exactly this call, by id. */
  stepUpId?: string;
  now?: Date;
}

/** v0.3 §21.4 — the outcome of a call made with no mandate (§2.1, the policy in place of the mandate). */
export interface PolicyReportOutcomeInput {
  policy: string;
  agentDid?: string;
  decisionEventId: string;
  outcome: 'completed' | 'failed';
  error?: string;
  pop: string;
  now?: Date;
}

export interface VerifyInput {
  mandate: ViaMandateCredential;
  tool: string;
  /** Full executionParams INCLUDING the `tool` discriminator — must equal the PoP-hashed params. */
  params: Record<string, unknown>;
  pop: string;
  stepUpSatisfied?: boolean;
  /** v0.3 §17.4 — an APPROVED step-up for exactly this call, by id; the verifier checks it against its record. */
  stepUpId?: string;
  now?: Date;
}

export interface ReportOutcomeInput {
  mandate: ViaMandateCredential;
  decisionEventId: string;
  outcome: 'completed' | 'failed';
  error?: string;
  pop: string;
  now?: Date;
}

/**
 * The guard's verifier seam — structural and async-tolerant, so the SAME guard
 * runs against an in-process gateway or an HTTP transport to a remote one.
 */
export interface GuardVerifier {
  challenge(input: { mandateId: string }): ChallengeGrant | Promise<ChallengeGrant>;
  verify(input: VerifyInput): VerifyOutcome | Promise<VerifyOutcome>;
  reportOutcome(input: ReportOutcomeInput): Promise<{ recorded: ViaEvent } | { rejected: string }> | { recorded: ViaEvent } | { rejected: string };
  /**
   * v0.3 §21.4 — a call with no mandate, decided on the organization's policy. Optional: a verifier that has
   * none of the three verifies mandates only, and a guard with no mandate refuses it. `challengeUnderPolicy`
   * answers `refused` (`mandate_required`) when the organization has published no policy.
   */
  challengeUnderPolicy?(input: { agentDid?: string }): PolicyChallengeGrant | { refused: string } | Promise<PolicyChallengeGrant | { refused: string }>;
  verifyUnderPolicy?(input: PolicyVerifyInput): VerifyOutcome | Promise<VerifyOutcome>;
  reportOutcomeUnderPolicy?(input: PolicyReportOutcomeInput): Promise<{ recorded: unknown } | { rejected: string }> | { recorded: unknown } | { rejected: string };
}

// ── MCP shapes (the connector's tool surface) ────────────────────────────────

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolsList {
  serverName: string;
  tools: McpTool[];
}

/** The platform's extraction answer — a guardrail DRAFT for the developer to complete. */
export interface ExtractedDraft {
  yaml: string;
  notes?: string[];
}

/** A step-up as the verifier reports it on a `rechallenge`. */
export interface StepUpRef {
  id: string;
  /** Where the person approves. Show it to them; nothing else on the agent side can approve. */
  approveLink?: string;
  /** `otp` (a code to their channel) or `webauthn` (their passkey). */
  method?: string;
  expiresAt?: string;
  status?: string;
  /** v0.3 §21.3 — `policy`: the organization's approvers decide it in the dashboard, not the grantor. */
  trigger?: 'policy';
}

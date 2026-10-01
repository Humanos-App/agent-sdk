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

export interface ChallengeGrant {
  nonce: string;
  aud: string;
  ttlMs: number;
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
}

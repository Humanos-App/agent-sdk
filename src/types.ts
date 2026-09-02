/**
 * THE WIRE CONTRACT — the shapes an agent exchanges with a VIA platform. They
 * live in the Agent SDK (not the platform) because this is the surface an
 * integrator programs against; any conforming platform (the agent2
 * mini-platform today, the real Humanos endpoints tomorrow) implements them.
 */
import type { ActorSnapshot, ActionRule, RuleEvaluation, ViaEvent, ViaMandateCredential } from './sdk.js';

/** The verifier's answer to one presented tool call. */
export interface VerifyOutcome {
  decision: 'allow' | 'deny' | 'rechallenge';
  reason?: string;
  evaluations: RuleEvaluation[];
  /** The signed VERIFICATION_* VIAEvent appended to the credential's chain (absent on rechallenge). */
  event?: ViaEvent;
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
  /** v0.3 §8 — the actor snapshot the agent PRESENTS; platforms default to their current. */
  actorSnapshot?: ActorSnapshot;
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

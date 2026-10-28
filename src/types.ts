/**
 * THE WIRE CONTRACT — the shapes an agent exchanges with a VIA platform. They
 * live in the Agent SDK (not the platform) because this is the surface an
 * integrator programs against; any conforming platform (the agent2
 * mini-platform today, the real Humanos endpoints tomorrow) implements them.
 */
import type { ActionRule, RuleEvaluation, ViaEvent } from './sdk.js';

/** The verifier's answer to one presented tool call: allow or deny. Nobody is asked to confirm a call (v0.3 §17.4). */
export interface VerifyOutcome {
  decision: 'allow' | 'deny';
  reason?: string;
  evaluations: RuleEvaluation[];
  /** The signed VERIFICATION_* VIAEvent appended to the call's chain. */
  event?: ViaEvent;
  /**
   * The decision event's id when the platform signs it ASYNCHRONOUSLY (Humanos appends chain
   * events through an outbox worker, so at answer time only the URN exists). The guard reports
   * the outcome against `event?.id ?? decisionEventId`; a verifier supplies one or the other.
   */
  decisionEventId?: string;
  /**
   * v0.3 §20.3 — what governed the decision: `policy`, `rules`, `semantic`, or `none` when the policy's default
   * allowed a tool it sets nothing for (observed: no rule ran).
   */
  enforcement?: string;
  /** v0.3 §21.3 — the organization's policy version the call was checked against. */
  policyDigest?: string;
  /** v0.3 §21.3 — no entry of the policy applied to the tool: its `default` decided. */
  unset?: true;
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

/**
 * v0.3 §16.11, §21.4 — the verifier's challenge: a single-use nonce, the DID the PoP names as `aud`, the nonce's life,
 * and the organization's policy, which the PoP binds when the call presents no mandate. A verifier with no policy
 * (the mini-platform) names none, and the guard refuses a call with no mandate `mandate_required`.
 */
export interface ChallengeGrant {
  nonce: string;
  aud: string;
  /** The nonce's life in seconds, from `iat`. */
  ttl: number;
  /** When it was issued, in epoch seconds. */
  iat: number;
  policy?: string;
}

/**
 * v0.3 §21.4 — who a call is for and what its PoP binds: the mandate it presents or, with none, the organization's
 * policy. Exactly one of the two.
 */
export interface CallAuthority {
  /** The agent making the call, named on every call. */
  agentDid: string;
  mandateId?: string;
  policy?: string;
}

export interface VerifyInput extends CallAuthority {
  tool: string;
  /** Full executionParams INCLUDING the `tool` discriminator — must equal the PoP-hashed params. */
  params: Record<string, unknown>;
  pop: string;
  now?: Date;
}

export interface ReportOutcomeInput extends CallAuthority {
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
  /**
   * A challenge for one call of the agent, the mandate's when the call presents one; or why the agent cannot be
   * challenged (`refused`, a reason such as `actor_unresolvable`), which the guard answers as a deny.
   */
  challenge(input: { agentDid: string; mandateId?: string }): ChallengeGrant | { refused: string } | Promise<ChallengeGrant | { refused: string }>;
  verify(input: VerifyInput): VerifyOutcome | Promise<VerifyOutcome>;
  reportOutcome(input: ReportOutcomeInput): Promise<{ recorded: unknown } | { rejected: string }> | { recorded: unknown } | { rejected: string };
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

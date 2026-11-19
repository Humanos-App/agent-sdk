/**
 * THE WIRE CONTRACT — the shapes an agent exchanges with a VIA platform. They
 * live in the Agent SDK (not the platform) because this is the surface an
 * integrator programs against; any conforming platform (the agent2
 * mini-platform today, the real Humanos endpoints tomorrow) implements them.
 */
import type { ActionRule, CallLayerContext, LimitEvaluation, ReviewerPart, RuleEvaluation, ToolDefinition, ViaEvent } from './sdk.js';

/** One rule's result: v0.3's, named by its rule, or under a v0.4 policy named by its document, tool and position. */
export type Evaluation = RuleEvaluation | LimitEvaluation;

/** The verifier's answer to one presented tool call: allow or deny. Nobody is asked to confirm a call (v0.3 §17.4). */
export interface VerifyOutcome {
  decision: 'allow' | 'deny';
  reason?: string;
  /**
   * v0.4 §15.7.1 — with `spec_version_mismatch`: the protocol version the agent is under, which the call was not made
   * for. The guard makes the call again that way, once.
   */
  expected?: string;
  /** v0.4 §15.3 — `false` when the call was decided against the definition on record, the host proving none. */
  toolProven?: false;
  /** Each rule's result. Under a v0.4 policy a rule has no name: its result names its document, tool and position. */
  evaluations: Evaluation[];
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
   * v0.3 §16.16 — with an `allow` for an `audience`: the decision token and the agent's record token, both the
   * platform's, carried unchanged on the call they cover.
   */
  callProof?: { decision: string; record: string };
  /**
   * v0.3 §21.3 — with `mandate_required`: the actions the organization's policy needs the mandate to be under, any one
   * of them. Ask the person for a mandate under one.
   */
  under?: { id: string }[];
  /**
   * v0.4 §15.8 — under a v0.4 policy, with `mandate_required`, `grantor_not_allowed` and `one_call_required`: the tool
   * as the policy names it, and who may grant a mandate for it. An empty list: nobody may, until an owner names the
   * tool in the policy.
   */
  tool?: string;
  grantors?: string[] | 'any';
  /** v0.4 §15.8, §14.5 — with `param_undeclared` and `token_unfilled`: the input, as a path. */
  input?: string;
  /** v0.4 — in words, where a code alone would mislead; with `token_unfilled`, the reason the model reads. */
  detail?: string;
  /** v0.4 §15.8 — on a decision under a mandate: what the reviewer did. */
  reviewed?: ReviewerPart;
  /** v0.4 §14.8 — the call's context as Humanos established it. */
  context?: CallLayerContext;
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
  /**
   * v0.4 §15.7 — the policy's version marker: `"0.4"` for a policy of limits per tool. The guard reads it before it
   * signs: under one, a call carries the tool's own inputs and the hash of its definition, under its proof. Absent: v0.3.
   */
  specVersion?: string;
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
  /** The agent's proof of possession. Absent when Humanos holds the agent's key (v0.3 §16.14): it signs for the agent. */
  pop?: string;
  /** v0.3 §16.16 — the party the call goes to, a DID or an `https` origin: an `allow` then carries the call proof. */
  audience?: string;
  /**
   * v0.4 §15.3 — under a v0.4 policy: the hash of the definition the call was made from, which the proof covers.
   * `tool` is then the tool's key (`server/name`) and `params` its own inputs, with no `tool` among them.
   */
  toolHash?: string;
  now?: Date;
}

export interface ReportOutcomeInput extends CallAuthority {
  decisionEventId: string;
  outcome: 'completed' | 'failed';
  error?: string;
  /** As on `VerifyInput`: absent when Humanos holds the agent's key. */
  pop?: string;
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
  /**
   * v0.4 §15.7 — the version marker of the policy the agent's calls are decided under: `"0.4"`, or nothing for v0.3.
   * Asked only when Humanos holds the agent's key, where the guard has no challenge to read it from. A verifier
   * without it is read as v0.3.
   */
  policyVersion?(input: { agentDid: string }): string | undefined | Promise<string | undefined>;
  reportOutcome(input: ReportOutcomeInput): Promise<{ recorded: unknown } | { rejected: string }> | { recorded: unknown } | { rejected: string };
}

/**
 * What a call refused `mandate_required` needs a person to grant: a guardrail under one of `actionIds` (the control's
 * version URNs, what a mandate request takes as `actionId`), or with no control an authorization for one call.
 */
export type MandateRequestHint =
  | { kind: 'guardrail'; actionIds: string[] }
  | { kind: 'authorization'; maxExecutions: 1 }
  /** v0.4 §15.8 — under a v0.4 policy: a mandate that lists this tool, from one of these people. */
  | { kind: 'limits'; tool: string; grantors: string[] | 'any' };

/**
 * v0.4 §15.3 — a tool as the guard names it under a v0.4 policy: its key in the policy (`server/name`), and its
 * definition as the agent holds it. With no definition the tool is known by name only (§13.0), as a host's hook
 * knows it.
 */
export interface GuardTool {
  key: string;
  definition?: ToolDefinition;
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

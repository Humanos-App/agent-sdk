/**
 * The `GuardVerifier` that speaks MCP — so the UNCHANGED `ViaGuard` runs against the Humanos
 * connector (`apps/mcp`) the way it runs against the in-process gateway or the mini-platform.
 *
 * Three tool calls map onto the three seam methods. Two things about the mapping are deliberate:
 *
 *  - **`verify` sends the mandate's ID, never the mandate.** The platform is the store; it loads
 *    its own copy, scoped to the organization the API key belongs to. A presented copy would be
 *    redundant at best and, tampered, a thing the verifier would have to distrust anyway.
 *  - **A deny arrives as a RESULT, not a tool error.** The connector answers `verify` with a
 *    `VerifyOutcome` whatever the decision, so the guard consumes it directly. `isError` on
 *    `challenge` / `report_outcome` means the request could not be answered (a mandate
 *    outside the caller's organization, a caller without an org key), which is thrown.
 *
 * Also here: `getMandates`, the agent's startup question — "which mandates do I hold?" — answered
 * from the platform's record, with the pinned action's rules so the guard's advisory pre-flight
 * has something to evaluate.
 */
import type { ViaMcpClient } from './client.js';
import type { ActionRule, ViaEvent, ViaMandateCredential } from '../sdk.js';
import type {
  ChallengeGrant,
  CompiledLike,
  GuardVerifier,
  PolicyChallengeGrant,
  PolicyReportOutcomeInput,
  PolicyVerifyInput,
  ReportOutcomeInput,
  VerifyInput,
  VerifyOutcome,
} from '../types.js';

/** Raised when the connector could not answer a verifier call — distinct from a deny. */
export class McpVerifierError extends Error {
  constructor(
    public readonly tool: string,
    public readonly detail: string,
  ) {
    super(`${tool}: ${detail}`);
    this.name = 'McpVerifierError';
  }
}

function parse<T>(tool: string, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new McpVerifierError(tool, `unparseable answer: ${text.slice(0, 200)}`);
  }
}

export class McpGuardVerifier implements GuardVerifier {
  constructor(private readonly client: ViaMcpClient) {}

  async challenge(input: { mandateId: string }): Promise<ChallengeGrant> {
    const r = await this.client.callTool('challenge', { mandateId: input.mandateId });
    if (r.isError) throw new McpVerifierError('challenge', r.text);
    return parse<ChallengeGrant>('challenge', r.text);
  }

  async verify(input: VerifyInput): Promise<VerifyOutcome> {
    const r = await this.client.callTool('verify', {
      mandateId: input.mandate.id,
      tool: input.tool,
      params: input.params,
      pop: input.pop,
      // v0.3 §17.4 on the connector: an approval is named by its id and checked against the
      // platform's record. The client-asserted boolean it once took is gone — sending it proves nothing.
      ...(input.stepUpId ? { stepUpId: input.stepUpId } : {}),
    });
    if (r.isError) throw new McpVerifierError('verify', r.text);
    return parse<VerifyOutcome>('verify', r.text);
  }

  async reportOutcome(input: ReportOutcomeInput): Promise<{ recorded: ViaEvent } | { rejected: string }> {
    const r = await this.client.callTool('report_outcome', {
      mandateId: input.mandate.id,
      decisionEventId: input.decisionEventId,
      outcome: input.outcome,
      ...(input.error ? { error: input.error } : {}),
      pop: input.pop,
    });
    if (r.isError) throw new McpVerifierError('report_outcome', r.text);
    return parse<{ recorded: ViaEvent } | { rejected: string }>('report_outcome', r.text);
  }

  /**
   * v0.3 §21.4 — the connector's `challenge` with no mandate: scoped to the agent, naming the organization's
   * policy. An organization that has published none answers `mandate_required`, which is a decision, not a fault.
   */
  async challengeUnderPolicy(input: { agentDid?: string }): Promise<PolicyChallengeGrant | { refused: string }> {
    const r = await this.client.callTool('challenge', input.agentDid ? { agentDid: input.agentDid } : {});
    if (r.isError) {
      if (r.text.startsWith('mandate_required')) return { refused: 'mandate_required' };
      throw new McpVerifierError('challenge', r.text);
    }
    return parse<PolicyChallengeGrant>('challenge', r.text);
  }

  /** v0.3 §21.4 — `verify` with no mandate: the policy in its place, decided on the organization's policy. */
  async verifyUnderPolicy(input: PolicyVerifyInput): Promise<VerifyOutcome> {
    const r = await this.client.callTool('verify', {
      policy: input.policy,
      ...(input.agentDid ? { agentDid: input.agentDid } : {}),
      tool: input.tool,
      params: input.params,
      pop: input.pop,
      ...(input.stepUpId ? { stepUpId: input.stepUpId } : {}),
    });
    if (r.isError) throw new McpVerifierError('verify', r.text);
    return parse<VerifyOutcome>('verify', r.text);
  }

  /** v0.3 §21.4 — `report_outcome` with no mandate (§2.1, the policy in place of `mandateId`). */
  async reportOutcomeUnderPolicy(input: PolicyReportOutcomeInput): Promise<{ recorded: unknown } | { rejected: string }> {
    const r = await this.client.callTool('report_outcome', {
      policy: input.policy,
      ...(input.agentDid ? { agentDid: input.agentDid } : {}),
      decisionEventId: input.decisionEventId,
      outcome: input.outcome,
      ...(input.error ? { error: input.error } : {}),
      pop: input.pop,
    });
    if (r.isError) throw new McpVerifierError('report_outcome', r.text);
    return parse<{ recorded: unknown } | { rejected: string }>('report_outcome', r.text);
  }
}

/** One held mandate, as `get_mandate` returns it. */
export interface HeldMandate {
  mandate: ViaMandateCredential;
  /**
   * The pinned, published action version — `content` holds the rules the guard pre-flights, and the tools it
   * covers (`tools`, v0.3 §0.6.1) when it lists them.
   */
  action: { urn: string; content: { rules?: ActionRule[]; tools?: string[] } } | null;
}

/**
 * The ACTIVE mandates bound to an agent, from the platform's record — with each one's action
 * shaped as the `CompiledLike` the guard takes, so a caller can go straight to `new ViaGuard`.
 */
export async function getMandates(
  client: ViaMcpClient,
  did: string,
): Promise<{ mandate: ViaMandateCredential; compiled: CompiledLike; action: HeldMandate['action'] }[]> {
  const r = await client.callTool('get_mandate', { did });
  if (r.isError) throw new McpVerifierError('get_mandate', r.text);
  const held = parse<HeldMandate[]>('get_mandate', r.text);
  return held.map((h) => ({
    mandate: h.mandate,
    action: h.action,
    compiled: { actionVersion: { rules: h.action?.content.rules ?? [] } },
  }));
}

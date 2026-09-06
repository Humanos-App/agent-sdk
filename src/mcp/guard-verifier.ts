/**
 * The `GuardVerifier` that speaks MCP — so the UNCHANGED `ViaGuard` runs against the Humanos
 * connector (`apps/mcp`) the way it runs against the in-process gateway or the mini-platform.
 *
 * Three tool calls map onto the three seam methods. Two things about the mapping are deliberate:
 *
 *  - **`verify` sends the mandate's ID, never the mandate.** The platform is the store; it loads
 *    its own copy, scoped to the organization the API key belongs to. A presented copy would be
 *    redundant at best and, tampered, a thing the verifier would have to distrust anyway.
 *  - **A deny arrives as a RESULT, not a tool error.** The connector answers `via_verify` with a
 *    `VerifyOutcome` whatever the decision, so the guard consumes it directly. `isError` on
 *    `via_challenge` / `via_report_outcome` means the request could not be answered (a mandate
 *    outside the caller's organization, a caller without an org key), which is thrown.
 *
 * Also here: `getMandates`, the agent's startup question — "which mandates do I hold?" — answered
 * from the platform's record, with the pinned action's rules so the guard's advisory pre-flight
 * has something to evaluate.
 */
import type { ViaMcpClient } from './client.js';
import type { ActionRule, ViaEvent, ViaMandateCredential } from '../sdk.js';
import type { ChallengeGrant, CompiledLike, GuardVerifier, ReportOutcomeInput, VerifyInput, VerifyOutcome } from '../types.js';

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
    const r = await this.client.callTool('via_challenge', { mandateId: input.mandateId });
    if (r.isError) throw new McpVerifierError('via_challenge', r.text);
    return parse<ChallengeGrant>('via_challenge', r.text);
  }

  async verify(input: VerifyInput): Promise<VerifyOutcome> {
    const r = await this.client.callTool('via_verify', {
      mandateId: input.mandate.id,
      tool: input.tool,
      params: input.params,
      pop: input.pop,
      ...(input.stepUpSatisfied !== undefined ? { stepUpSatisfied: input.stepUpSatisfied } : {}),
    });
    if (r.isError) throw new McpVerifierError('via_verify', r.text);
    return parse<VerifyOutcome>('via_verify', r.text);
  }

  async reportOutcome(input: ReportOutcomeInput): Promise<{ recorded: ViaEvent } | { rejected: string }> {
    const r = await this.client.callTool('via_report_outcome', {
      mandateId: input.mandate.id,
      decisionEventId: input.decisionEventId,
      outcome: input.outcome,
      ...(input.error ? { error: input.error } : {}),
      pop: input.pop,
    });
    if (r.isError) throw new McpVerifierError('via_report_outcome', r.text);
    return parse<{ recorded: ViaEvent } | { rejected: string }>('via_report_outcome', r.text);
  }
}

/** One held mandate, as `via_get_mandate` returns it. */
export interface HeldMandate {
  mandate: ViaMandateCredential;
  /** The pinned, published action version — `content` holds the rules the guard pre-flights. */
  action: { urn: string; content: { rules?: ActionRule[] } } | null;
}

/**
 * The ACTIVE mandates bound to an agent, from the platform's record — with each one's action
 * shaped as the `CompiledLike` the guard takes, so a caller can go straight to `new ViaGuard`.
 */
export async function getMandates(
  client: ViaMcpClient,
  did: string,
): Promise<{ mandate: ViaMandateCredential; compiled: CompiledLike; action: HeldMandate['action'] }[]> {
  const r = await client.callTool('via_get_mandate', { did });
  if (r.isError) throw new McpVerifierError('via_get_mandate', r.text);
  const held = parse<HeldMandate[]>('via_get_mandate', r.text);
  return held.map((h) => ({
    mandate: h.mandate,
    action: h.action,
    compiled: { actionVersion: { rules: h.action?.content.rules ?? [] } },
  }));
}

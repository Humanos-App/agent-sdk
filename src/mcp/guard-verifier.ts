/**
 * The `GuardVerifier` that speaks MCP — so `ViaGuard` runs against the Humanos connector
 * (`apps/mcp`) the way it runs against the in-process gateway or the mini-platform.
 *
 * Three tool calls map onto the three seam methods, each naming the agent. Two things about the
 * mapping are deliberate:
 *
 *  - **`verify` sends the mandate's ID, never the mandate.** The platform is the store; it loads
 *    its own copy, scoped to the organization the API key belongs to. A presented copy would be
 *    redundant at best and, tampered, a thing the verifier would have to distrust anyway.
 *  - **No `pop` when Humanos holds the agent's key** (v0.3 §16.14): the connector challenges and signs for the agent
 *    itself, under the agent key the client holds. An agent that holds its own key and sends none is refused.
 *  - **A deny arrives as a RESULT, not a tool error.** The connector answers `verify` with a
 *    `VerifyOutcome` whatever the decision, so the guard consumes it directly. `isError` on
 *    `challenge` / `report_outcome` means the request could not be answered (an agent outside the
 *    caller's organization, a caller without an org key), which is thrown.
 *
 * Also here, the agent's startup question, `getPolicy` ("what does my organization's policy let me
 * do?"), and `policyMandates`, the guard's mandate source built on it. The SDK reads no mandates:
 * the organization's policy decides each call alone, so `policyMandates` presents none.
 */
import type { ViaMcpClient } from './client.js';
import type { CallMandate, MandateSource } from '../guard.js';
import type { ActionRule, ViaEvent } from '../sdk.js';
import { unwrapUserParamValues } from '../sdk.js';
import type { ChallengeGrant, CompiledLike, GuardVerifier, MandateRequestHint, ReportOutcomeInput, VerifyInput, VerifyOutcome } from '../types.js';

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

/** A refusal the connector states as `<reason>: <sentence>`: a decision about the agent, not a fault. */
const REFUSAL = /^([a-z][a-z0-9_]*): /;

/** The authority a call names on the wire: the mandate's id, or with none the policy. */
const authorityOf = (input: { mandateId?: string; policy?: string }): Record<string, string> =>
  input.mandateId ? { mandateId: input.mandateId } : input.policy ? { policy: input.policy } : {};

export class McpGuardVerifier implements GuardVerifier {
  constructor(private readonly client: ViaMcpClient) {}

  /**
   * The challenge for one call of the agent, naming the organization's policy. An agent the connector refuses to
   * challenge (`actor_unresolvable: …`, its operator walk reaching no organization) is answered `refused`.
   */
  async challenge(input: { agentDid: string; mandateId?: string }): Promise<ChallengeGrant | { refused: string }> {
    const r = await this.client.callTool('challenge', { agentDid: input.agentDid, ...(input.mandateId ? { mandateId: input.mandateId } : {}) });
    if (r.isError) {
      const refused = REFUSAL.exec(r.text)?.[1];
      if (refused) return { refused };
      throw new McpVerifierError('challenge', r.text);
    }
    return parse<ChallengeGrant>('challenge', r.text);
  }

  async verify(input: VerifyInput): Promise<VerifyOutcome> {
    const r = await this.client.callTool('verify', {
      agentDid: input.agentDid,
      ...authorityOf(input),
      tool: input.tool,
      params: input.params,
      ...(input.pop ? { pop: input.pop } : {}),
      ...(input.audience ? { audience: input.audience } : {}),
    });
    if (r.isError) throw new McpVerifierError('verify', r.text);
    return parse<VerifyOutcome>('verify', r.text);
  }

  async reportOutcome(input: ReportOutcomeInput): Promise<{ recorded: unknown } | { rejected: string }> {
    const r = await this.client.callTool('report_outcome', {
      agentDid: input.agentDid,
      ...authorityOf(input),
      decisionEventId: input.decisionEventId,
      outcome: input.outcome,
      ...(input.error ? { error: input.error } : {}),
      ...(input.pop ? { pop: input.pop } : {}),
    });
    if (r.isError) throw new McpVerifierError('report_outcome', r.text);
    return parse<{ recorded: ViaEvent } | { rejected: string }>('report_outcome', r.text);
  }
}

/**
 * A mandate ready for the guard: its pinned action's rules as the `CompiledLike` the pre-flight takes. `policyMandates`
 * holds none: the organization's policy decides each call alone.
 */
export type GuardMandate = CallMandate & {
  compiled: CompiledLike;
  /**
   * The pinned, published action version — `content` holds the rules the guard pre-flights, and the tools it
   * covers (`tools`, v0.3 §0.6.1) when it lists them.
   */
  action: { urn: string; content: { rules?: ActionRule[]; tools?: string[] } } | null;
};

/** A tool's access as the organization's policy sets it for the agent (v0.3 §21.1); `not_set`: its default decides. */
export type ToolAccess = 'allow' | 'rules' | 'mandate' | 'deny' | 'not_set';

/** `get_policy`'s answer: the organization's policy as the agent's own calls meet it, for the tools it declared. */
export interface AgentPolicy {
  agent: string;
  /** A refusal every call meets whatever the tool (`actor_suspended`, …); absent when the agent may act. */
  standing?: string;
  /** v0.3 §21.1 — `default`: what a tool no entry sets gets. */
  policy: { id: string; version: number; default: 'allow' | 'deny' } | null;
  tools: {
    tool: string;
    service?: string;
    access: ToolAccess;
    /** What the access means for the agent, in one sentence. */
    meaning: string;
    /** `rules`: every control the call must pass, its rules in words and its limits. */
    controls?: { id: string; name: string; rules: string[]; limits: { name: string; value: unknown; description?: string }[] }[];
    /** `mandate`: the mandate controls made for the tool, narrowed to the one the policy names when it names one. */
    mandateControls?: { id: string; name: string }[];
    /** `mandate`: what to ask a person for (`requestMandate`). */
    request?: MandateRequestHint;
  }[];
}

/** What the organization's policy lets the agent do with each tool it declared (the connector's `get_policy`). */
export async function getPolicy(client: ViaMcpClient, agentDid: string): Promise<AgentPolicy> {
  const r = await client.callTool('get_policy', { agentDid });
  if (r.isError) throw new McpVerifierError('get_policy', r.text);
  return parse<AgentPolicy>('get_policy', r.text);
}

/**
 * How well a held mandate covers a tool: 3 when it names the tool (the person's `allowed_tools`, or the pinned
 * action's `tools`, v0.3 §0.6.1), 2 when its pinned action lists no tools and declares every parameter given, 1 for a
 * plain authorization, 0 not at all. A mandate whose `allowed_tools`, or whose action's `tools`, leaves the tool out
 * never covers it: the person already said no, or the action would refuse it `tool_not_covered`.
 *
 * @deprecated The SDK holds no mandates to rank: the organization's policy decides each call alone, and
 * `policyMandates` presents none. Kept for code that holds mandates of its own.
 */
export function mandateCoverage(h: GuardMandate, tool: string, params: string[]): number {
  const up = unwrapUserParamValues(h.mandate.credentialSubject.mandate.userParams as never);
  if (Array.isArray(up.allowed_tools)) return (up.allowed_tools as unknown[]).includes(tool) ? 3 : 0;
  if (!h.action) return 1;
  const listed = h.action.content?.tools;
  if (Array.isArray(listed)) return listed.includes(tool) ? 3 : 0;
  const declared = ((h.action.content ?? {}) as { executionParams?: Record<string, unknown> }).executionParams ?? {};
  // A tool with no parameters says nothing about which action is its: only an exact match or an authorization.
  return params.length > 0 && params.every((p) => p in declared) ? 2 : 0;
}

/**
 * The held mandate that best covers a tool (`mandateCoverage`), one pinning a `preferred` action version first: the
 * controls the policy names for the tool.
 *
 * @deprecated The SDK holds no mandates to choose from: the organization's policy decides each call alone, and
 * `policyMandates` presents none. Kept for code that holds mandates of its own.
 */
export function coveringMandate(tool: string, params: string[], held: GuardMandate[], preferred: string[] = []): GuardMandate | undefined {
  let best: GuardMandate | undefined;
  let bestRank = 0;
  for (const h of held) {
    const covers = mandateCoverage(h, tool, params);
    const rank = covers && h.action && preferred.includes(h.action.urn) ? covers + 3 : covers;
    if (rank > bestRank) {
      best = h;
      bestRank = rank;
    }
  }
  return best;
}

export interface PolicyMandatesOptions {
  /**
   * Which held mandate a call presents, for a tool the policy leaves to a person's mandate. `preferred`: the action
   * versions the policy names for it.
   *
   * @deprecated Never called: `policyMandates` holds no mandates, and presents none.
   */
  pick?: (call: { tool: string; params: Record<string, unknown> }, held: GuardMandate[], preferred: string[]) => GuardMandate | undefined;
}

/** `policyMandates`' source, with what it last read. */
export interface PolicyMandates extends MandateSource {
  /** Read the organization's policy again, for the calls after. */
  read(): Promise<{
    policy: AgentPolicy;
    /** @deprecated Always empty: the SDK reads no mandates, and presents none. */
    held: GuardMandate[];
  }>;
  /** What a person must grant for a tool the policy leaves to a mandate (`get_policy`'s `request`); none for any other. */
  requestFor(tool: string): Promise<MandateRequestHint | undefined>;
}

/**
 * The guard's mandate source over the connector (v0.3 §21.3): it reads `get_policy` once and keeps it, and presents no
 * mandate. The organization's policy decides each call alone (allow, restrict or deny), so the source reads no
 * mandates, and every call binds the policy. A `mandate_required` refusal, from a policy that still leaves a tool to a
 * person's mandate, reads the policy again, so `requestFor` answers from what it says now; the call is not presented
 * again.
 */
export function policyMandates(client: ViaMcpClient, agentDid: string, _opts: PolicyMandatesOptions = {}): PolicyMandates {
  let state: ReturnType<PolicyMandates['read']> | undefined;
  const read = (): ReturnType<PolicyMandates['read']> => {
    const reading: ReturnType<PolicyMandates['read']> = getPolicy(client, agentDid).then((policy) => ({ policy, held: [] }));
    state = reading;
    // A failed read is not kept: the next call reads again.
    reading.catch(() => {
      if (state === reading) state = undefined;
    });
    return reading;
  };

  return {
    read,
    async requestFor(tool) {
      const { policy } = await (state ?? read());
      return policy.tools.find((t) => t.tool === tool && t.access === 'mandate')?.request;
    },
    async mandateFor(_call, retry) {
      // The policy is read on the first call and kept, and read again on a `mandate_required`: `requestFor` answers
      // from it. A call presents no mandate whatever the tool's access.
      await (retry || !state ? read() : state);
      return undefined;
    },
  };
}

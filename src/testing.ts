/**
 * `@humanos/agent-sdk/testing` — an in-process verifier for testing an agent without a platform.
 *
 * It answers the guard's three calls the way the Humanos connector does, where an agent can tell
 * the difference: a nonce per call, the PoP checked against the agent's key and the hash of THIS
 * call's params over the authority it names (the mandate, or the policy), the organization's
 * policy deciding first when you give one, the action's CEL rules evaluated for a call the mandate
 * decides, and each outcome recorded against its decision. It keeps no chain and signs nothing —
 * decisions and outcomes are plain records for assertions.
 *
 * A separate entry point on purpose: rule evaluation is platform machinery and stays out of the
 * main barrel; here it is the thing a builder tests their proposed rules with.
 */
import { randomUUID } from 'node:crypto';
import { actionHash, decodePoP, evaluateRules, jwkThumbprint, policyActionHash, validateCelExpression, verifyPoPSignature } from './sdk.js';
import type { ActionRule, ViaMandateCredential } from './sdk.js';
import { outcomeParams } from './events.js';
import type { ViaAgentKey } from './key-provider.js';
import type { CallAuthority, CompiledLike, GuardVerifier, VerifyOutcome } from './types.js';

export { evaluateRules, validateCelExpression };

export type TestRule = Pick<ActionRule, 'name' | 'expression'> & Partial<Pick<ActionRule, 'description' | 'appliesTo' | 'requires'>>;

/** A tool's access in the test policy (v0.3 §21.1): allowed, not allowed, or left to the mandate. */
export type TestAccess = 'allow' | 'deny' | 'mandate';

/** The policy the test verifier names in each challenge. */
export const TEST_POLICY = 'urn:via:policy:test';

export interface TestVerifierOptions {
  /** The action's rules, as proposed. */
  rules: TestRule[];
  /** The limits the person set, plain values (`{ credit_limit: 50 }`). */
  userParams: Record<string, unknown>;
  /** The values the action version fixes itself, read as `constants.<name>` (v0.3 §0.6.1), plain values. */
  constants?: Record<string, unknown>;
  /** The agent's key — PoPs are checked against it. */
  agentKey: Pick<ViaAgentKey, 'publicJwk'>;
  /**
   * The organization's policy, deciding first (v0.3 §21.3): each tool's access, and `default` (allow) for a tool it
   * names nothing for. Absent, every tool is the mandate's, as with no policy.
   */
  policy?: { tools?: Record<string, TestAccess>; default?: 'allow' | 'deny' };
}

export interface TestDecision {
  tool: string;
  decision: VerifyOutcome['decision'];
  reason?: string;
  eventId?: string;
  /** The mandate the call presented; none when it bound the policy. */
  mandateId?: string;
}

export interface TestOutcome {
  decisionEventId: string;
  outcome: 'completed' | 'failed';
  error?: string;
}

export function createTestVerifier(opts: TestVerifierOptions): {
  mandate: ViaMandateCredential;
  compiled: CompiledLike;
  verifier: GuardVerifier;
  decisions: TestDecision[];
  outcomes: TestOutcome[];
} {
  const mandate = {
    id: `urn:uuid:${randomUUID()}`,
    credentialSubject: {
      mandate: { userParams: Object.fromEntries(Object.entries(opts.userParams).map(([k, v]) => [k, { value: v, description: k }])) },
    },
  } as unknown as ViaMandateCredential;
  const jkt = jwkThumbprint(opts.agentKey.publicJwk);
  const nonces = new Set<string>();
  const decisions: TestDecision[] = [];
  const outcomes: TestOutcome[] = [];

  /** One generic reason, as a verifier gives: which check failed is not the caller's business. */
  async function popOk(pop: string, authority: CallAuthority, action: string, params: Record<string, unknown>): Promise<boolean> {
    const d = decodePoP(pop);
    if (!d.ok) return false;
    const p = d.payload as { nonce?: string; action_hash?: string; cnf?: { jkt?: string } };
    if (p.cnf?.jkt !== jkt || !(await verifyPoPSignature(pop, opts.agentKey.publicJwk))) return false;
    if (!p.nonce || !nonces.delete(p.nonce)) return false;
    if (authority.mandateId) return authority.mandateId === mandate.id && p.action_hash === actionHash(mandate.id, action, params);
    return authority.policy === TEST_POLICY && p.action_hash === policyActionHash(TEST_POLICY, action, params);
  }

  /** The tool's access, and whether the policy's default gave it. */
  const accessOf = (tool: string): { access: TestAccess; unset?: true } => {
    if (!opts.policy) return { access: 'mandate' };
    const set = opts.policy.tools?.[tool];
    return set ? { access: set } : { access: opts.policy.default ?? 'allow', unset: true };
  };

  const record = (tool: string, mandateId: string | undefined, o: VerifyOutcome): VerifyOutcome => {
    decisions.push({
      tool,
      decision: o.decision,
      ...(o.reason ? { reason: o.reason } : {}),
      ...(o.decisionEventId ? { eventId: o.decisionEventId } : {}),
      ...(mandateId ? { mandateId } : {}),
    });
    return o;
  };
  const eventId = () => `urn:uuid:${randomUUID()}`;

  const verifier: GuardVerifier = {
    challenge: () => {
      const nonce = randomUUID();
      nonces.add(nonce);
      return { nonce, aud: 'did:web:verifier.test', ttl: 60, iat: Math.floor(Date.now() / 1000), ...(opts.policy ? { policy: TEST_POLICY } : {}) };
    },
    verify: async ({ tool, params, pop, ...authority }) => {
      const answer = (o: Omit<VerifyOutcome, 'decisionEventId'>) => record(tool, authority.mandateId, { ...o, decisionEventId: eventId() });
      if (!(await popOk(pop, authority, tool, params))) return answer({ decision: 'deny', reason: 'pop_invalid', evaluations: [] });
      const { access, unset } = accessOf(tool);
      const byDefault = unset ? { unset } : {};
      // A mandate presented for a tool the policy does not leave to one is ignored (v0.3 §21.3).
      if (access === 'allow') return answer({ decision: 'allow', evaluations: [], enforcement: unset ? 'none' : 'policy', ...byDefault });
      if (access === 'deny') return answer({ decision: 'deny', reason: 'policy_denied', evaluations: [], enforcement: 'policy', ...byDefault });
      if (!authority.mandateId) return answer({ decision: 'deny', reason: 'mandate_required', evaluations: [], enforcement: 'policy' });
      const { decision, evaluations } = evaluateRules(opts.rules as ActionRule[], {
        userParams: opts.userParams,
        ...(opts.constants ? { constants: opts.constants } : {}),
        executionParams: params,
      });
      if (decision === 'deny') return answer({ decision: 'deny', reason: 'rule_failed', evaluations, enforcement: 'rules' });
      return answer({ decision: 'allow', evaluations, enforcement: 'rules' });
    },
    reportOutcome: async ({ decisionEventId, outcome, error, pop, ...authority }) => {
      if (!(await popOk(pop, authority, 'report_outcome', outcomeParams(decisionEventId, outcome, error)))) return { rejected: 'pop_invalid' };
      outcomes.push({ decisionEventId, outcome, ...(error ? { error } : {}) });
      return { recorded: {} };
    },
  };

  return {
    mandate,
    compiled: { actionVersion: { rules: opts.rules.map((r) => ({ conditions: [], ...r })) as ActionRule[] } },
    verifier,
    decisions,
    outcomes,
  };
}

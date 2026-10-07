/**
 * `@humanos/agent-sdk/testing` — an in-process verifier for testing an agent without a platform.
 *
 * It answers the guard's three calls the way the Humanos connector does, where an agent can tell
 * the difference: a nonce per call, the PoP checked against the agent's key and the hash of THIS
 * call's params, the action's CEL rules evaluated, a step-up opened for the tools you name, and
 * each outcome recorded against its decision. It keeps no chain and signs nothing — decisions and
 * outcomes are plain records for assertions.
 *
 * A separate entry point on purpose: rule evaluation is platform machinery and stays out of the
 * main barrel; here it is the thing a builder tests their proposed rules with.
 */
import { randomUUID } from 'node:crypto';
import { actionHash, decodePoP, evaluateRules, jwkThumbprint, validateCelExpression, verifyPoPSignature } from './sdk.js';
import type { ActionRule, ViaMandateCredential } from './sdk.js';
import { outcomeParams } from './events.js';
import type { ViaAgentKey } from './key-provider.js';
import type { CompiledLike, GuardVerifier, VerifyOutcome } from './types.js';

export { evaluateRules, validateCelExpression };

export type TestRule = Pick<ActionRule, 'name' | 'expression'> & Partial<Pick<ActionRule, 'description' | 'appliesTo' | 'requires'>>;

export interface TestVerifierOptions {
  /** The action's rules, as proposed. */
  rules: TestRule[];
  /** The limits the person set, plain values (`{ credit_limit: 50 }`). */
  userParams: Record<string, unknown>;
  /** The agent's key — PoPs are checked against it. */
  agentKey: Pick<ViaAgentKey, 'publicJwk'>;
  /** Tools the verifier puts behind a step-up (v0.3 §17.4). */
  stepUpTools?: string[];
  /** How the person answers a step-up. Default: decline. */
  approveStepUp?: boolean;
}

export interface TestDecision {
  tool: string;
  decision: VerifyOutcome['decision'];
  reason?: string;
  eventId?: string;
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
  /** Pass as the guard's `onRechallenge`: the person's answer to a step-up. */
  onRechallenge: () => Promise<boolean>;
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
  const stepUps = new Map<string, boolean>();
  const decisions: TestDecision[] = [];
  const outcomes: TestOutcome[] = [];

  /** One generic reason, as a verifier gives: which check failed is not the caller's business. */
  async function popOk(pop: string, action: string, params: Record<string, unknown>): Promise<boolean> {
    const d = decodePoP(pop);
    if (!d.ok) return false;
    const p = d.payload as { nonce?: string; action_hash?: string; cnf?: { jkt?: string } };
    if (p.cnf?.jkt !== jkt || !(await verifyPoPSignature(pop, opts.agentKey.publicJwk))) return false;
    if (!p.nonce || !nonces.delete(p.nonce)) return false;
    return p.action_hash === actionHash(mandate.id, action, params);
  }

  const record = (tool: string, o: VerifyOutcome): VerifyOutcome => {
    decisions.push({ tool, decision: o.decision, ...(o.reason ? { reason: o.reason } : {}), ...(o.decisionEventId ? { eventId: o.decisionEventId } : {}) });
    return o;
  };
  const eventId = () => `urn:uuid:${randomUUID()}`;

  const verifier: GuardVerifier = {
    challenge: () => {
      const nonce = randomUUID();
      nonces.add(nonce);
      return { nonce, aud: 'did:web:verifier.test', ttlMs: 60_000 };
    },
    verify: async ({ tool, params, pop, stepUpId }) => {
      if (!(await popOk(pop, tool, params))) return record(tool, { decision: 'deny', reason: 'pop_invalid', evaluations: [], decisionEventId: eventId() });
      const { decision, evaluations } = evaluateRules(opts.rules as ActionRule[], { userParams: opts.userParams, executionParams: params });
      if (decision === 'deny') return record(tool, { decision: 'deny', reason: 'rule_failed', evaluations, decisionEventId: eventId() });
      if (opts.stepUpTools?.includes(tool) && !(stepUpId && stepUps.get(stepUpId))) {
        const id = randomUUID();
        stepUps.set(id, opts.approveStepUp ?? false);
        return record(tool, { decision: 'rechallenge', evaluations, stepUp: { id, approveLink: `https://verifier.test/approve/${id}`, method: 'otp' } });
      }
      return record(tool, { decision: 'allow', evaluations, decisionEventId: eventId() });
    },
    reportOutcome: async ({ decisionEventId, outcome, error, pop }) => {
      if (!(await popOk(pop, 'report_outcome', outcomeParams(decisionEventId, outcome, error)))) return { rejected: 'pop_invalid' };
      outcomes.push({ decisionEventId, outcome, ...(error ? { error } : {}) });
      return { recorded: {} as never };
    },
  };

  return {
    mandate,
    compiled: { actionVersion: { rules: opts.rules.map((r) => ({ conditions: [], ...r })) as ActionRule[] } },
    verifier,
    onRechallenge: async () => opts.approveStepUp ?? false,
    decisions,
    outcomes,
  };
}

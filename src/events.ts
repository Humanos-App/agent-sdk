import type { EventType } from '@humanos/via-sdk-v03';

/**
 * The two-phase outcome kinds. **They landed upstream on 2026-09-03**: both are in
 * `sdk-v03`'s `EVENT_TYPES`, `EVENT_SCOPE` maps them to `credential`, and v0.3 §2.1
 * specifies them. This comment previously said they were deliberately kept OUT of the
 * spec and the SDK — that was true when written and stopped being true when they were
 * added to the union without it being updated.
 *
 * Why they exist: the chain otherwise records DECISIONS, not EXECUTIONS — a
 * `VERIFICATION_APPROVED` followed by a crash leaves signed history claiming an
 * authorization that may never have become an act. Two-phase closes that:
 *
 *   VERIFICATION_APPROVED  (the decision — verifier-signed, pre-execution)
 *     └─ ACTION_COMPLETED | ACTION_FAILED  (the outcome — gateway-signed, agent-attested)
 *
 * The outcome is REPORTED by the agent and AUTHENTICATED with the same §16.6
 * PoP mechanics as any action (`action: "report_outcome"`, params binding the
 * decision event id + outcome), so "what happened after the approval" is a
 * cryptographically attributable claim, not gateway hearsay. A decision event
 * with no outcome event after it is itself evidence: the visible crash window.
 *
 * Still 🔮 on the platform side: nothing persists an outcome event yet (v0.3 §11).
 */
export const AGENT_OUTCOME_EVENTS = ['ACTION_COMPLETED', 'ACTION_FAILED'] as const;
export type AgentOutcomeKind = 'completed' | 'failed';

/**
 * Map a prototype outcome kind onto the EventType. (Since the sdk-v03 cutover
 * the kinds are REAL union members — the old widening cast is retired; this
 * stays as the naming boundary.)
 */
export const asEventType = (kind: AgentOutcomeKind): EventType =>
  kind === 'completed' ? 'ACTION_COMPLETED' : 'ACTION_FAILED';

/**
 * The exact params object BOTH sides hash for the report PoP (`action_hash`
 * binds it, A6) — guard builds it, gateway rebuilds it; any divergence is an
 * `action_hash_mismatch` denial.
 */
export function outcomeParams(
  decisionEventId: string,
  outcome: AgentOutcomeKind,
  error?: string,
): Record<string, unknown> {
  return { decisionEventId, outcome, ...(error ? { error } : {}) };
}

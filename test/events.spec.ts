import { describe, expect, it } from 'vitest';
import { AGENT_OUTCOME_EVENTS, asEventType, outcomeParams } from '../src/events.js';

describe('outcome events — the second phase of two-phase execution (v0.3 §2.1)', () => {
  it('maps the two kinds onto the two EventTypes and nothing else', () => {
    expect(asEventType('completed')).toBe('ACTION_COMPLETED');
    expect(asEventType('failed')).toBe('ACTION_FAILED');
    expect([...AGENT_OUTCOME_EVENTS]).toEqual(['ACTION_COMPLETED', 'ACTION_FAILED']);
  });

  it('builds the exact params both sides hash for the report PoP — error only when there is one', () => {
    // A6 binds `action_hash` over these; a key present on one side and absent on the other is an
    // `action_hash_mismatch`, so `error: undefined` must not become a key.
    expect(outcomeParams('urn:via:event:1', 'completed')).toEqual({ decisionEventId: 'urn:via:event:1', outcome: 'completed' });
    expect(outcomeParams('urn:via:event:1', 'failed', 'boom')).toEqual({ decisionEventId: 'urn:via:event:1', outcome: 'failed', error: 'boom' });
    expect(Object.keys(outcomeParams('x', 'failed', ''))).toEqual(['decisionEventId', 'outcome']);
  });
});

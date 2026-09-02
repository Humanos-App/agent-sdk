import { actionHash, evaluateRules, jwkThumbprint, unwrapUserParamValues } from './sdk.js';
import type { RuleEvaluation, ViaEvent, ViaMandateCredential } from './sdk.js';
import { buildDelegatedPoP, type ViaAgentKey } from './key-provider.js';
import { outcomeParams, type AgentOutcomeKind } from './events.js';
import type { CompiledLike, GuardVerifier, VerifyOutcome } from './types.js';

export type { GuardVerifier, VerifyOutcome } from './types.js';

export class ViaDeniedError extends Error {
  constructor(
    public readonly reason: string | undefined,
    public readonly evaluations: RuleEvaluation[],
  ) {
    super(`via: tool call denied (${reason ?? 'unknown'})`);
    this.name = 'ViaDeniedError';
  }
}

export interface GuardCallOutcome<T = unknown> {
  decision: 'allow' | 'deny';
  reason?: string;
  evaluations: RuleEvaluation[];
  /** Present when the tool ran (allow, or deny under `observe`). */
  result?: T;
  /** True when a deny was recorded but the tool executed anyway (`observe` mode, R5b). */
  observed?: boolean;
}

export interface GuardOptions {
  mandate: ViaMandateCredential;
  /** The agent's key PROVIDER — signing is delegated through it, so a KMS/enclave key works unchanged. */
  agentKey: ViaAgentKey;
  verifier: GuardVerifier;
  compiled: CompiledLike;
  /**
   * R5b — `observe`: the full pipeline runs (challenge, PoP, verify, signed decision
   * event) but the tool executes regardless; the record is real, the block is not.
   * `enforce`: a deny refuses the call. Phase A of the ramp (G4) runs `observe`.
   */
  mode?: 'observe' | 'enforce';
  /** §17.4 — route a RECHALLENGE to the builder's approval channel; return true once satisfied. */
  onRechallenge?: (info: { tool: string; params: Record<string, unknown> }) => boolean | Promise<boolean>;
  now?: () => Date;
}

type ToolFn = (args: Record<string, unknown>) => unknown | Promise<unknown>;

/**
 * The runtime interceptor (PRD §5.3). Per guarded call, all spec mechanics
 * (§16.11 + §16.6): optional local pre-flight (advisory, never authoritative) →
 * verifier challenge → PoP over `{mandateId, action, params}` (A6 binds THIS
 * transaction) → agent-direct verify → execute / refuse / step-up round-trip.
 */
export class ViaGuard {
  private readonly mode: 'observe' | 'enforce';

  constructor(private readonly opts: GuardOptions) {
    this.mode = opts.mode ?? 'enforce';
  }

  /**
   * EXPLICIT style: returns NEW functions with a NEW contract — each call yields
   * the full `GuardCallOutcome` (decision, evaluations, result). Use when the
   * caller wants the decision metadata. Every call site must use the returned
   * map; a reference to the original slips past the guard.
   */
  wrapTools<T extends Record<string, ToolFn>>(impls: T): { [K in keyof T]: (args: Record<string, unknown>) => Promise<GuardCallOutcome> } {
    const wrapped = {} as { [K in keyof T]: (args: Record<string, unknown>) => Promise<GuardCallOutcome> };
    for (const name of Object.keys(impls) as (keyof T)[]) {
      wrapped[name] = (args) => this.call(String(name), args, impls[name]);
    }
    return wrapped;
  }

  /**
   * INTERCEPTION style: guards the tools object IN PLACE and preserves the
   * ORIGINAL call contract — intercepted tools still return the tool's own
   * result (and throw `ViaDeniedError` on an enforced deny), so nothing
   * downstream changes. Every existing reference to the OBJECT is guarded,
   * including ones taken before this call — which closes the silent-bypass
   * hole `wrapTools` leaves open (an un-migrated call site).
   *
   * Known limit: a reference captured to an individual FUNCTION before
   * interception (`const f = tools.book_load`) bypasses it — only the object's
   * properties are replaced. The true fix is guarding at a protocol chokepoint
   * (the MCP `tools/call` handler, or the M3 proxy), where there is exactly one
   * dispatch path and nothing to forget. See docs/guarding-tool-calls.md.
   */
  interceptTools<T extends Record<string, ToolFn>>(tools: T): T {
    for (const name of Object.keys(tools)) {
      const impl = tools[name] as ToolFn;
      (tools as Record<string, ToolFn>)[name] = async (args: Record<string, unknown>) => {
        const out = await this.call(name, args ?? {}, impl);
        return out.result; // transparent: the caller sees exactly what the tool returned
      };
    }
    return tools;
  }

  /** Guard one tool call. Unmanifested tools are still presented (R6) — drift is spec-native denials. */
  async call<T = unknown>(tool: string, args: Record<string, unknown>, impl: ToolFn): Promise<GuardCallOutcome<T>> {
    const params = { ...args, tool };

    // Local pre-flight (advisory only, R5/§5.3.1): saves a round-trip on obvious denials
    // in enforce mode; NEVER authoritative and never a substitute for the verifier.
    if (this.mode === 'enforce') {
      const preflight = evaluateRules(this.opts.compiled.actionVersion.rules.filter((r) => !r.name.startsWith('assurance_floor')), {
        userParams: unwrapUserParamValues(this.opts.mandate.credentialSubject.mandate.userParams),
        executionParams: params,
      });
      void preflight; // advisory: a real SDK would log/telemetry this; the decision stays with the verifier.
    }

    let outcome = await this.present(tool, params, false);

    if (outcome.decision === 'rechallenge') {
      const satisfied = this.opts.onRechallenge ? await this.opts.onRechallenge({ tool, params }) : false;
      outcome = satisfied
        ? await this.present(tool, params, true) // fresh challenge + fresh PoP — the old nonce is spent
        : { decision: 'deny', reason: 'stepup_declined', evaluations: [] };
    }

    if (outcome.decision === 'allow') {
      return {
        decision: 'allow',
        evaluations: outcome.evaluations,
        result: await this.execute<T>(args, impl, outcome.event),
      };
    }
    if (this.mode === 'observe') {
      // R5b: record the deny, execute anyway — and STILL report the execution
      // outcome, so the chain honestly shows "denied, executed regardless".
      return {
        decision: 'deny',
        reason: outcome.reason,
        evaluations: outcome.evaluations,
        observed: true,
        result: await this.execute<T>(args, impl, outcome.event),
      };
    }
    throw new ViaDeniedError(outcome.reason, outcome.evaluations);
  }

  /**
   * Two-phase, second phase: run the tool, then report the outcome — the
   * decision event proved the authorization; ACTION_COMPLETED/FAILED proves
   * what became of it. A tool error is reported as `failed` and RETHROWN
   * (the guard evidences failures, it does not swallow them). A crash between
   * execution and report leaves a decision event with no outcome — the visible
   * gap two-phase exists to expose.
   */
  private async execute<T>(args: Record<string, unknown>, impl: ToolFn, decision?: ViaEvent): Promise<T> {
    try {
      const result = (await impl(args)) as T;
      await this.report(decision, 'completed');
      return result;
    } catch (e) {
      await this.report(decision, 'failed', e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  private async report(decision: ViaEvent | undefined, outcome: AgentOutcomeKind, error?: string): Promise<void> {
    if (!decision) return;
    const { mandate, agentKey, verifier } = this.opts;
    const params = outcomeParams(decision.id, outcome, error);
    const ch = await verifier.challenge({ mandateId: mandate.id });
    const pop = await buildDelegatedPoP(
      {
        cnf: { jkt: jwkThumbprint(agentKey.publicJwk) },
        aud: ch.aud,
        nonce: ch.nonce,
        iat: Math.floor((this.opts.now?.() ?? new Date()).getTime() / 1000),
        action_hash: actionHash(mandate.id, 'report_outcome', params),
      },
      agentKey.sign,
    );
    await verifier.reportOutcome({
      mandate,
      decisionEventId: decision.id,
      outcome,
      error,
      pop,
      now: this.opts.now?.(),
    });
  }

  private async present(tool: string, params: Record<string, unknown>, stepUpSatisfied: boolean): Promise<VerifyOutcome> {
    const { mandate, agentKey, verifier } = this.opts;
    const ch = await verifier.challenge({ mandateId: mandate.id });
    const pop = await buildDelegatedPoP(
      {
        cnf: { jkt: jwkThumbprint(agentKey.publicJwk) },
        aud: ch.aud,
        nonce: ch.nonce,
        iat: Math.floor((this.opts.now?.() ?? new Date()).getTime() / 1000),
        action_hash: actionHash(mandate.id, tool, params),
      },
      agentKey.sign,
    );
    return verifier.verify({ mandate, tool, params, pop, stepUpSatisfied, now: this.opts.now?.() });
  }
}

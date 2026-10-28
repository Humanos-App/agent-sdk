import { actionHash, evaluateRules, jwkThumbprint, policyActionHash, unwrapUserParamValues } from './sdk.js';
import type { RuleEvaluation, ViaMandateCredential } from './sdk.js';
import { buildDelegatedPoP, type ViaAgentKey } from './key-provider.js';
import { outcomeParams, type AgentOutcomeKind } from './events.js';
import type { CallAuthority, ChallengeGrant, CompiledLike, GuardVerifier, VerifyOutcome } from './types.js';

export type { GuardVerifier, VerifyOutcome } from './types.js';

export class ViaDeniedError extends Error {
  constructor(
    public readonly reason: string | undefined,
    public readonly evaluations: RuleEvaluation[],
    /** v0.3 §21.3 — with `mandate_required`: the actions a mandate must be under, any one of them. */
    public readonly under?: { id: string }[],
    /** The mandate the call presented; none when the policy alone decided it. */
    public readonly mandateId?: string,
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
  /** On a `mandate_required` deny: the actions a mandate must be under, any one of them (v0.3 §21.3). */
  under?: { id: string }[];
  /** The mandate the call presented; none when the policy alone decided it. */
  mandateId?: string;
}

/** The mandate one call presents, with its pinned action for the advisory pre-flight. */
export interface CallMandate {
  mandate: ViaMandateCredential;
  compiled?: CompiledLike;
}

/**
 * Which mandate each call presents (v0.3 §21.3): one only for a tool the organization's policy leaves to a person's
 * mandate, none for any other. `policyMandates` reads both from the Humanos connector.
 */
export interface MandateSource {
  /**
   * The mandate this call presents, or none. With `retry`, the verifier has just refused the call `mandate_required`:
   * read again what the choice rests on, and choose a mandate other than `refused` (the one the call presented),
   * preferring one under `under` when the refusal named it.
   */
  mandateFor(
    call: { tool: string; params: Record<string, unknown> },
    retry?: { refused?: string; under?: { id: string }[] },
  ): CallMandate | undefined | Promise<CallMandate | undefined>;
}

export interface GuardOptions {
  /** The agent's key PROVIDER — signing is delegated through it, so a KMS/enclave key works unchanged. */
  agentKey: ViaAgentKey;
  /** The agent the calls are for, named on every call (v0.3 §21.4). */
  agentDid: string;
  verifier: GuardVerifier;
  /**
   * Which mandate each call presents. With neither this nor `mandate`, every call is decided on the organization's
   * policy alone, and a tool it leaves to a person is refused `mandate_required`.
   */
  mandates?: MandateSource;
  /**
   * A mandate every call presents: for a verifier with no policy (the mini-platform, `createTestVerifier` without
   * one). A verifier deciding on a policy ignores it for a tool the policy does not leave to a mandate (v0.3 §21.3).
   */
  mandate?: ViaMandateCredential;
  /** `mandate`'s pinned action, for the advisory pre-flight. */
  compiled?: CompiledLike;
  /**
   * R5b — `observe`: the full pipeline runs (challenge, PoP, verify, signed decision
   * event) but the tool executes regardless; the record is real, the block is not.
   * `enforce`: a deny refuses the call. Phase A of the ramp (G4) runs `observe`.
   */
  mode?: 'observe' | 'enforce';
  now?: () => Date;
}

/** What the guard hands a tool when it runs it: the decision the call runs under. */
export interface GuardCallContext {
  /** The verifier's answer for THIS call — an `allow`, or the `deny` a tool runs past under `observe`. */
  outcome: VerifyOutcome;
  /** The mandate the call presented; none when the policy alone decided it. */
  mandateId?: string;
}

type ToolFn = (args: Record<string, unknown>, ctx: GuardCallContext) => unknown | Promise<unknown>;

/**
 * The runtime interceptor (PRD §5.3). Per guarded call, all spec mechanics
 * (§16.11 + §16.6 + §21.3): the mandate the call presents, if any → optional local
 * pre-flight (advisory, never authoritative) → verifier challenge → PoP over
 * `{mandateId | policy, action, params}` (A6 binds THIS transaction) → verify, the
 * organization's policy deciding first → execute / refuse. One guard per agent:
 * the mandate is chosen per call.
 */
export class ViaGuard {
  private readonly mode: 'observe' | 'enforce';

  constructor(private readonly opts: GuardOptions) {
    this.mode = opts.mode ?? 'enforce';
    if (opts.mandate && opts.mandates) {
      throw new TypeError('via: a guard presents one fixed `mandate` or chooses one per call from `mandates`, not both');
    }
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
    let presented = await this.mandateFor(tool, params);

    // Local pre-flight (advisory only, R5/v0.2-new §5.3.1): saves a round-trip on obvious denials
    // in enforce mode; NEVER authoritative and never a substitute for the verifier.
    if (this.mode === 'enforce' && presented?.compiled) {
      const preflight = evaluateRules(presented.compiled.actionVersion.rules.filter((r) => !r.name.startsWith('assurance_floor')), {
        userParams: unwrapUserParamValues(presented.mandate.credentialSubject.mandate.userParams),
        executionParams: params,
      });
      void preflight; // advisory: a real SDK would log/telemetry this; the decision stays with the verifier.
    }

    let outcome = await this.present(tool, params, presented?.mandate.id);
    // The policy may have changed since the source read it, or a person may just have granted a mandate: the source
    // reads again, and the call is presented once more when that changes the mandate it presents.
    if (outcome.decision === 'deny' && outcome.reason === 'mandate_required' && this.opts.mandates) {
      const again = await this.opts.mandates.mandateFor(
        { tool, params },
        { ...(presented ? { refused: presented.mandate.id } : {}), ...(outcome.under ? { under: outcome.under } : {}) },
      );
      if (again && again.mandate.id !== presented?.mandate.id) {
        presented = again;
        outcome = await this.present(tool, params, again.mandate.id);
      }
    }

    // The decision to report against — the signed event when the verifier returned it, or the
    // id alone when the platform appends the signed event later (outbox).
    const decisionId = outcome.event?.id ?? outcome.decisionEventId;
    const mandateId = presented?.mandate.id;
    const presentedAs = mandateId ? { mandateId } : {};

    if (outcome.decision === 'allow') {
      return {
        decision: 'allow',
        evaluations: outcome.evaluations,
        ...presentedAs,
        result: await this.execute<T>(args, impl, decisionId, outcome, mandateId),
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
        ...(outcome.under ? { under: outcome.under } : {}),
        ...presentedAs,
        result: await this.execute<T>(args, impl, decisionId, outcome, mandateId),
      };
    }
    throw new ViaDeniedError(outcome.reason, outcome.evaluations, outcome.under, mandateId);
  }

  /** The mandate this call presents: the fixed one, the source's choice, or none. */
  private async mandateFor(tool: string, params: Record<string, unknown>): Promise<CallMandate | undefined> {
    const { mandate, compiled, mandates } = this.opts;
    if (mandate) return { mandate, ...(compiled ? { compiled } : {}) };
    return mandates?.mandateFor({ tool, params });
  }

  /**
   * Two-phase, second phase: run the tool, then report the outcome — the
   * decision event proved the authorization; ACTION_COMPLETED/FAILED proves
   * what became of it. A tool error is reported as `failed` and RETHROWN
   * (the guard evidences failures, it does not swallow them). A crash between
   * execution and report leaves a decision event with no outcome — the visible
   * gap two-phase exists to expose.
   */
  private async execute<T>(args: Record<string, unknown>, impl: ToolFn, decisionId: string | undefined, outcome: VerifyOutcome, mandateId?: string): Promise<T> {
    try {
      const result = (await impl(args, { outcome, ...(mandateId ? { mandateId } : {}) })) as T;
      await this.report(decisionId, mandateId, 'completed');
      return result;
    } catch (e) {
      await this.report(decisionId, mandateId, 'failed', e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  /** v0.3 §2.1 — the outcome, under the authority the call was presented with: a fresh challenge, a fresh PoP. */
  private async report(decisionId: string | undefined, mandateId: string | undefined, outcome: AgentOutcomeKind, error?: string): Promise<void> {
    if (!decisionId) return;
    const { verifier, agentDid } = this.opts;
    const ch = await verifier.challenge({ agentDid, ...(mandateId ? { mandateId } : {}) });
    if ('refused' in ch) return;
    const authority = this.authority(ch, mandateId);
    if (!authority) return;
    const params = outcomeParams(decisionId, outcome, error);
    const pop = await this.sign(ch, this.hash(authority, 'report_outcome', params));
    await verifier.reportOutcome({
      ...authority,
      decisionEventId: decisionId,
      outcome,
      ...(error ? { error } : {}),
      pop,
      now: this.opts.now?.(),
    });
  }

  /**
   * One presentation: the challenge for the agent (the mandate's when the call presents one), a PoP over the mandate
   * or, with none, the policy the challenge names, and verify. A verifier that names no policy authorizes nothing
   * without a mandate (v0.3 §21.4).
   */
  private async present(tool: string, params: Record<string, unknown>, mandateId?: string): Promise<VerifyOutcome> {
    const { verifier, agentDid } = this.opts;
    const ch = await verifier.challenge({ agentDid, ...(mandateId ? { mandateId } : {}) });
    if ('refused' in ch) return { decision: 'deny', reason: ch.refused, evaluations: [] };
    const authority = this.authority(ch, mandateId);
    if (!authority) return { decision: 'deny', reason: 'mandate_required', evaluations: [] };
    const pop = await this.sign(ch, this.hash(authority, tool, params));
    return verifier.verify({ ...authority, tool, params, pop, now: this.opts.now?.() });
  }

  /** What the PoP binds: the mandate presented or, with none, the policy the challenge named. */
  private authority(ch: ChallengeGrant, mandateId?: string): CallAuthority | undefined {
    const { agentDid } = this.opts;
    if (mandateId) return { agentDid, mandateId };
    return ch.policy ? { agentDid, policy: ch.policy } : undefined;
  }

  private hash(authority: CallAuthority, action: string, params: Record<string, unknown>): string {
    return authority.mandateId ? actionHash(authority.mandateId, action, params) : policyActionHash(authority.policy!, action, params);
  }

  /** A PoP over one call's `action_hash`, signed through the key provider. */
  private sign(ch: { aud: string; nonce: string }, action_hash: string): Promise<string> {
    const { agentKey } = this.opts;
    return buildDelegatedPoP(
      {
        cnf: { jkt: jwkThumbprint(agentKey.publicJwk) },
        aud: ch.aud,
        nonce: ch.nonce,
        iat: Math.floor((this.opts.now?.() ?? new Date()).getTime() / 1000),
        action_hash,
      },
      agentKey.sign,
    );
  }
}

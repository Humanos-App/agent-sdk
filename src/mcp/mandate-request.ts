/**
 * Asking a person for a mandate, over the Humanos connector: what a Delegate tool needs (`get_policy`'s `request`), a
 * control's limits (`get_action`), the request itself (`request_mandate`), and its answer (`mandate_status`, waited for).
 *
 * Whom to ask and the values of the limits are the builder's, from the agent's own context: these calls carry them, they
 * do not choose them. An authorization asks for one call by default: with no rules, it would open every tool the policy
 * leaves to a mandate without naming a control, for as long as it lasts.
 */
import type { ViaMcpClient } from './client.js';
import { McpVerifierError } from './guard-verifier.js';

/** A limit a person sets on a mandate under a control, as `get_action` describes it. */
export interface ActionParam {
  type: string;
  required?: boolean;
  description?: string;
  /** `array` only: the element type. */
  items?: string;
  /** `map` only: the value type. */
  values?: string;
}

/** A control as `get_action` returns it: what a person grants under it, what it fixes, its rules in words. */
export interface ActionView {
  /** The version's URN: what `requestMandate` takes as `actionId`. */
  id: string;
  name: string;
  description?: string;
  version: number;
  tools: string[];
  /** The limits the person sets, by name: `requestMandate`'s `userParams`, each `required` one filled in. */
  userParams: Record<string, ActionParam>;
  constants: { name: string; value: unknown; description?: string }[];
  rules: string[];
}

/** The bounds any mandate request may set. */
interface RequestBounds {
  /** The email or phone of the person who grants it. */
  contact: string;
  /** When it ends. An authorization defaults to an hour from now. */
  validUntil?: Date | string;
  /** How many calls it allows. An authorization defaults to 1. */
  maxExecutions?: number;
  /** The re-attest window, in seconds. */
  maxAttestationStaleness?: number;
  /** Context the person sees under the name. */
  description?: string;
}

export type MandateRequestInput =
  | (RequestBounds & {
      kind: 'guardrail';
      /** The control's id: one of the hint's `actionIds`. */
      actionId: string;
      /** The limits' values, as `getAction` describes them. */
      userParams: Record<string, unknown>;
      name?: string;
    })
  | (RequestBounds & {
      kind: 'authorization';
      /** The label the person sees. */
      name: string;
      /** In plain words, what the call will do: the whole grant. */
      terms: string;
    });

/** What `request_mandate` answers: the mandate, still pending, and the card to show the person. */
export interface MandateRequested {
  requestId: string;
  mandateId: string;
  status: 'PENDING';
  grantor: string;
  /** The consent link, when the platform includes it: hand it to the person. */
  authorizeLink?: string;
  consentCard: {
    title: string;
    terms: string;
    termsAuthor: 'issuer' | 'agent';
    kind: 'guardrail' | 'authorization';
    link?: string;
    grantor: string;
    /** When the consent link stops working. */
    expiresAt: string;
    /** For the agent to say to the person. */
    note: string;
  };
}

/** Where a requested mandate stands. */
export interface MandateStatus {
  mandateId: string;
  kind: 'guardrail' | 'authorization';
  /** The spec's status (v0.3 §0.10.1). */
  status: string;
  /** `PENDING` until the person decides; then `ACTIVE`, `REJECTED`, or `INACTIVE` for any other ending. */
  phase: 'PENDING' | 'ACTIVE' | 'REJECTED' | 'INACTIVE';
  boundAgentDids: string[];
}

/** An authorization's life when the request names none. */
export const AUTHORIZATION_DEFAULT_MS = 60 * 60 * 1000;
/** How long `waitForMandate` waits by default, unless the consent link expires first. */
export const WAIT_DEFAULT_MS = 10 * 60 * 1000;

async function call<T>(client: ViaMcpClient, tool: string, args: Record<string, unknown>): Promise<T> {
  const r = await client.callTool(tool, args);
  if (r.isError) throw new McpVerifierError(tool, r.text);
  try {
    return JSON.parse(r.text) as T;
  } catch {
    throw new McpVerifierError(tool, `unparseable answer: ${r.text.slice(0, 200)}`);
  }
}

const iso = (d: Date | string): string => (typeof d === 'string' ? d : d.toISOString());

/** A control the organization published, by its id: the limits to fill in a request under it (the connector's `get_action`). */
export function getAction(client: ViaMcpClient, actionId: string): Promise<ActionView> {
  return call<ActionView>(client, 'get_action', { actionId });
}

/**
 * Ask a person for a mandate for the agent (`did`): a guardrail under a control, its limits filled in, or an
 * authorization in plain words, for one call unless `maxExecutions` says otherwise. It answers at once, still pending;
 * show the person `consentCard.link` and wait for their answer (`waitForMandate`).
 */
export function requestMandate(
  client: ViaMcpClient,
  did: string,
  input: MandateRequestInput,
  now: () => Date = () => new Date(),
): Promise<MandateRequested> {
  const { contact, validUntil, maxExecutions, maxAttestationStaleness, description } = input;
  const authorization = input.kind === 'authorization';
  const until = validUntil ?? (authorization ? new Date(now().getTime() + AUTHORIZATION_DEFAULT_MS) : undefined);
  const uses = maxExecutions ?? (authorization ? 1 : undefined);
  return call<MandateRequested>(client, 'request_mandate', {
    kind: input.kind,
    did,
    grantor: { contact },
    ...(input.kind === 'guardrail'
      ? { actionId: input.actionId, userParams: input.userParams, ...(input.name ? { name: input.name } : {}) }
      : { name: input.name, terms: input.terms }),
    ...(description ? { description } : {}),
    ...(until ? { validUntil: iso(until) } : {}),
    ...(uses !== undefined ? { maxExecutions: uses } : {}),
    ...(maxAttestationStaleness !== undefined ? { maxAttestationStaleness } : {}),
  });
}

/** Where a requested mandate stands (the connector's `mandate_status`). */
export function mandateStatus(client: ViaMcpClient, mandateId: string): Promise<MandateStatus> {
  return call<MandateStatus>(client, 'mandate_status', { mandateId });
}

export interface WaitForMandateOptions {
  /**
   * When to stop waiting: by default the earlier of the consent link's expiry (when given the request) and ten minutes
   * from now. Past it, the last status is returned, still `PENDING`.
   */
  until?: Date | string;
  /** How often to ask, in milliseconds (default 3 s). */
  everyMs?: number;
  /** Called after each answer that is still `PENDING`. */
  onPending?: (status: MandateStatus) => void;
  /** Stops waiting: the promise rejects with the signal's reason. */
  signal?: AbortSignal;
}

/**
 * Wait for a person's answer to a mandate request: the status once it leaves `PENDING` (`ACTIVE`, `REJECTED` or
 * `INACTIVE`), or the last one, still `PENDING`, when `until` passes. Once it is `ACTIVE`, call the tool again: the
 * guard's mandate source reads the new mandate on the `mandate_required` it meets first.
 */
export async function waitForMandate(
  client: ViaMcpClient,
  requested: MandateRequested | string,
  opts: WaitForMandateOptions = {},
): Promise<MandateStatus> {
  const mandateId = typeof requested === 'string' ? requested : requested.mandateId;
  const expires = typeof requested === 'string' ? Infinity : Date.parse(requested.consentCard.expiresAt);
  const deadline = opts.until !== undefined ? Date.parse(iso(opts.until)) : Math.min(expires, Date.now() + WAIT_DEFAULT_MS);
  const everyMs = opts.everyMs ?? 3_000;
  for (;;) {
    opts.signal?.throwIfAborted();
    const status = await mandateStatus(client, mandateId);
    if (status.phase !== 'PENDING' || Date.now() >= deadline) return status;
    opts.onPending?.(status);
    await _sleep(Math.min(everyMs, Math.max(0, deadline - Date.now())), opts.signal);
  }
}

/** A pause that an abort cuts short, rejecting with the signal's reason. */
function _sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

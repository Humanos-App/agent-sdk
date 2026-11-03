/**
 * What an agent reads when the guard keeps a call from an MCP server: the governing proxy and the in-process
 * connection wrapper answer a refused `tools/call` with the same words, so a model meets one refusal whichever of the
 * two stood in front of the server.
 */
import type { MandateRequestHint } from '../types.js';
import { defaultPlainReason } from './server.js';

export interface Refused {
  reason?: string;
  /** With `mandate_required`: what to ask a person for. */
  request?: MandateRequestHint;
  /** The mandate the call presented, when it presented one. */
  mandateId?: string;
}

/** The text of the refusal: which mandate is missing and where to get it, or the plain reason and not to retry. */
export function refusalText(tool: { name: string; service: string }, refused: Refused, plainReason: (reason?: string) => string = defaultPlainReason): string {
  if (refused.reason !== 'mandate_required') {
    return `Blocked by VIA: ${plainReason(refused.reason)}. Nothing was sent to ${tool.service}. Do not retry.`;
  }
  const { request } = refused;
  return (
    `${refused.mandateId ? 'The mandate this agent holds does not cover' : 'No mandate covers'} ${tool.name} (${tool.service}). ` +
    `Nothing was sent to ${tool.service}. ` +
    (request?.kind === 'guardrail'
      ? `The organization's policy needs a person's mandate under ${request.actionIds.join(' or ')} for it: ask the person for one (its limits: get_action).`
      : request?.kind === 'authorization'
        ? `The organization's policy needs a person's authorization for it, and names no control: ask the person to authorize this one call.`
        : `The organization's policy leaves it to a person's mandate: the person accepts one on a control made for ${tool.service}.`)
  );
}

/** The party a call goes to (v0.3 §16.16): a remote server's `https` origin; none for a local one, so no call proof. */
export function audienceOf(origin: string | undefined): { audience?: string } {
  return origin?.startsWith('https://') ? { audience: origin } : {};
}

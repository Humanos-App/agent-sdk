/**
 * What an agent reads when the guard keeps a call from an MCP server: the governing proxy and the in-process
 * connection wrapper answer a refused `tools/call` with the same words, so a model meets one refusal whichever of the
 * two stood in front of the server.
 */
import { defaultPlainReason } from './server.js';

export interface Refused {
  reason?: string;
}

/**
 * The text of the refusal: the plain reason, and not to retry. The SDK asks nobody for a mandate: a `mandate_required`,
 * which only an older platform answers, reads as the policy refusing the call.
 */
export function refusalText(tool: { name: string; service: string }, refused: Refused, plainReason: (reason?: string) => string = defaultPlainReason): string {
  return `Blocked by VIA: ${plainReason(refused.reason)}. Nothing was sent to ${tool.service}. Do not retry.`;
}

/** The party a call goes to (v0.3 §16.16): a remote server's `https` origin; none for a local one, so no call proof. */
export function audienceOf(origin: string | undefined): { audience?: string } {
  return origin?.startsWith('https://') ? { audience: origin } : {};
}

/**
 * A stand-in Humanos connector over `createTestVerifier`: the connector's tools (`challenge`, `verify`,
 * `report_outcome`, `get_policy`, `get_mandate`, `declare_tools`, `register_challenge`, `register`) answered by the
 * in-process verifier, so code that talks to the connector (the proxy, `via()`) runs against the test policy.
 */
import type { ViaMcpClient } from '../../src/mcp/client.js';
import type { GuardVerifier } from '../../src/types.js';

export function fakeConnector(verifier: GuardVerifier, did: string) {
  const declared: { services: string[]; tools: Record<string, unknown>[] }[] = [];
  const json = (v: unknown) => ({ text: JSON.stringify(v), isError: false });
  const client: ViaMcpClient = {
    initialize: async () => ({ serverInfo: { name: 'humanos', version: '0' }, protocolVersion: '2025-06-18' }),
    listTools: async () => [],
    callTool: async (tool, args = {}) => {
      switch (tool) {
        case 'challenge': return json(await verifier.challenge(args as never));
        case 'verify': return json(await verifier.verify(args as never));
        case 'report_outcome': return json(await verifier.reportOutcome(args as never));
        case 'get_policy': return json({ agent: did, tools: [] });
        case 'get_mandate': return json([]);
        case 'register_challenge': return json({ regNonce: 'reg-nonce', aud: 'did:web:humanos.tech' });
        case 'register': return json({ did, keyId: `${did}#key-1`, granted: { assurance: 'pop', binding: 'self' }, existing: false });
        case 'declare_tools': {
          const tools = args.tools as Record<string, unknown>[];
          declared.push({ services: args.services as string[], tools });
          return json({ recorded: tools.length });
        }
        default: return { text: `unknown tool ${tool}`, isError: true };
      }
    },
  };
  return { client, declared };
}

/** The verifier, making a call proof for each allow addressed to an audience, as the platform does (v0.3 §16.16). */
export function withCallProof(v: GuardVerifier): GuardVerifier {
  return {
    challenge: (input) => v.challenge(input),
    verify: async (input) => {
      const outcome = await v.verify(input);
      return outcome.decision === 'allow' && input.audience ? { ...outcome, callProof: { decision: 'decision-token', record: 'record-token' } } : outcome;
    },
    reportOutcome: (input) => v.reportOutcome(input),
  };
}

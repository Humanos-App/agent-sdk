/**
 * A stand-in Humanos connector over `createTestVerifier`: the connector's tools (`challenge`, `verify`,
 * `report_outcome`, `get_policy`, `get_mandate`, `declare_tools`, `register_challenge`, `register`) answered by the
 * in-process verifier, so code that talks to the connector (the proxy, `via()`) runs against the test policy.
 *
 * In process it is a `ViaMcpClient`; `serveConnector` puts the same one on HTTP, checking each request's HMAC as the
 * platform does, for agents in another process (a hook, the `humanos-agent proxy` binary). Both record into the same
 * state, so a test reads one set of decisions whichever process made them. `down` makes every call fail, as when
 * Humanos cannot be reached.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { signRequest, type ViaMcpClient } from '../../src/mcp/client.js';
import type { GuardVerifier } from '../../src/types.js';

export interface FakeConnector {
  client: ViaMcpClient;
  declared: { services: string[]; tools: Record<string, unknown>[] }[];
  /** True: every call fails as an unreachable connector would. */
  down: boolean;
}

export function fakeConnector(verifier: GuardVerifier, did: string): FakeConnector {
  const declared: FakeConnector['declared'] = [];
  const json = (v: unknown) => ({ text: JSON.stringify(v), isError: false });
  const fake: FakeConnector = {
    declared,
    down: false,
    client: {
      initialize: async () => ({ serverInfo: { name: 'humanos', version: '0' }, protocolVersion: '2025-06-18' }),
      listTools: async () => [],
      callTool: async (tool, args = {}) => {
        if (fake.down) throw new Error('fetch failed: connect ECONNREFUSED (the test connector is down)');
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
    },
  };
  return fake;
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

export interface ServedConnector {
  /** `HUMANOS_MCP_URL`. */
  url: string;
  close(): Promise<void>;
}

/** The fake connector on HTTP, as `createViaMcpClient` speaks to the platform: a request signed wrong is refused 401. */
export async function serveConnector(fake: FakeConnector, credentials: { apiKey: string; signatureSecret: string }): Promise<ServedConnector> {
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c));
    req.on('end', () => {
      void (async () => {
        const send = (status: number, payload: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        const timestamp = Number(req.headers['x-timestamp']);
        const signed = req.headers.authorization === `Bearer ${credentials.apiKey}` && req.headers['x-signature'] === signRequest(body, credentials.signatureSecret, timestamp);
        if (!signed) return send(401, { message: 'Invalid signature' });
        const msg = JSON.parse(body) as { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
        const reply = (result: unknown) => send(200, { jsonrpc: '2.0', id: msg.id, result });
        if (msg.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'humanos', version: '0' } });
        if (msg.method === 'tools/list') return reply({ tools: [] });
        if (msg.method !== 'tools/call') return send(200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: msg.method } });
        if (fake.down) return send(503, { message: 'the test connector is down' });
        const r = await fake.client.callTool(String(msg.params?.name), msg.params?.arguments ?? {});
        reply({ content: [{ type: 'text', text: r.text }], ...(r.isError ? { isError: true } : {}) });
      })().catch((e: unknown) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: e instanceof Error ? e.message : String(e) }));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

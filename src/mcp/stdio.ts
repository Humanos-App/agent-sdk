/**
 * The stdio transport for the VIA-governed MCP connector — what Claude Desktop /
 * Cursor / MCP Inspector launch. stdout carries ONLY newline-delimited JSON-RPC;
 * all logs go to stderr.
 *
 * Bidirectional: the transport can also SEND server→client requests
 * (elicitation) — create it FIRST, pass its `sendRequest` into
 * `startViaMcpServer`, then `run(server)` — and notifications: pass its
 * `notify` into `startViaMcpProxy`, so the agent hears when its tools change.
 */
import { createInterface } from 'node:readline';
import type { JsonRpcMessage, ViaMcpServer } from './server.js';

export interface StdioTransport {
  /** Server→client JSON-RPC request; resolves on the client's matching response. */
  sendRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /** Server→client notification, which has no answer: `notifications/tools/list_changed`. */
  notify: (msg: JsonRpcMessage) => void;
  /** Start pumping stdin→handleRpc→stdout. Exits the process when drained after stdin closes. */
  run(server: Pick<ViaMcpServer, 'handleRpc'>): void;
}

export function createStdioTransport(): StdioTransport {
  const outbound = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  let outSeq = 0;

  const sendRequest = (method: string, params: Record<string, unknown>): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = `srv-${++outSeq}`;
      const timer = setTimeout(() => { if (outbound.delete(id)) reject(new Error('client did not respond')); }, 300_000);
      outbound.set(id, { resolve, reject, timer });
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  const notify = (msg: JsonRpcMessage): void => void process.stdout.write(JSON.stringify(msg) + '\n');

  const run = (server: Pick<ViaMcpServer, 'handleRpc'>): void => {
    let inflight = 0;
    let closed = false;
    const exitIfDrained = (): void => { if (closed && inflight === 0 && outbound.size === 0) process.exit(0); };

    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const text = line.trim();
      if (!text) return;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(text) as JsonRpcMessage;
      } catch {
        return; // ignore non-JSON noise
      }
      if (msg.method === 'initialize') {
        // Diagnostic: what did this client declare? (Is in-app approval / elicitation available?)
        const caps = (msg.params?.capabilities ?? {}) as Record<string, unknown>;
        process.stderr.write(
          `  client: ${JSON.stringify((msg.params?.clientInfo as Record<string, unknown>) ?? {})} · elicitation: ${caps.elicitation ? 'yes (in-app approval)' : 'no (approve on the dashboard)'}\n`,
        );
      }
      if (msg.method !== undefined) {
        // a request or notification FROM the client
        inflight++;
        void server.handleRpc(msg)
          .then((resp) => { if (resp) process.stdout.write(JSON.stringify(resp) + '\n'); })
          .finally(() => { inflight--; exitIfDrained(); });
      } else if (msg.id != null && outbound.has(String(msg.id))) {
        // a RESPONSE to one of our server→client requests (elicitation)
        const p = outbound.get(String(msg.id))!;
        clearTimeout(p.timer);
        outbound.delete(String(msg.id));
        if (msg.error) p.reject(new Error(typeof msg.error === 'object' ? JSON.stringify(msg.error) : String(msg.error)));
        else p.resolve(msg.result);
        exitIfDrained();
      }
    });
    rl.on('close', () => { closed = true; exitIfDrained(); });
  };

  return { sendRequest, notify, run };
}

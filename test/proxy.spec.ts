import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import { softwareKey } from '../src/key-provider.js';
import { evaluateRules, unwrapUserParamValues } from '../src/sdk.js';
import type { ViaMcpClient } from '../src/mcp/client.js';
import { declaredParams, pickMandate, startViaMcpProxy, type ViaMcpProxyConfig } from '../src/mcp/proxy.js';
import type { JsonRpcMessage } from '../src/mcp/server.js';
import { connectUpstream, inProcessUpstream, type UpstreamTool } from '../src/mcp/upstream.js';

// ── stand-in upstream servers: real-shaped tools, every call journalled instead of performed ──
function standin(service: string, tools: UpstreamTool[], fail: string[] = []) {
  const journal: { tool: string; args: Record<string, unknown> }[] = [];
  const metas: unknown[] = []; // each call's `params._meta`, kept apart so the journal stays what the server was asked to do
  const listings = { count: 0 }; // how often the server was asked for its tools
  const handleRpc = async (msg: JsonRpcMessage): Promise<JsonRpcMessage | null> => {
    const ok = (result: unknown): JsonRpcMessage => ({ jsonrpc: '2.0', id: msg.id ?? null, result });
    switch (msg.method) {
      case 'initialize': return ok({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: service, version: '0' } });
      case 'notifications/initialized': return null;
      case 'tools/list': listings.count++; return ok({ tools });
      case 'tools/call': {
        const name = String(msg.params?.name);
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        journal.push({ tool: name, args });
        metas.push(msg.params?._meta);
        if (fail.includes(name)) return ok({ content: [{ type: 'text', text: `${name} failed upstream` }], isError: true });
        return ok({ content: [{ type: 'text', text: `${service}.${name} ok` }] });
      }
      default: return { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32601, message: 'no' } };
    }
  };
  // How the server says its tools changed, as a stdio server would by writing the notification.
  let notify: ((msg: JsonRpcMessage) => void) | undefined;
  const notifications = (n: (msg: JsonRpcMessage) => void): void => void (notify = n);
  const toolsChanged = (): void => notify?.({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  return { handleRpc, journal, metas, listings, notifications, toolsChanged };
}
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required });
const SLACK: UpstreamTool[] = [
  { name: 'slack_send_message', description: 'Post', inputSchema: obj({ channel_id: { type: 'string' }, message: { type: 'string' } }, ['channel_id', 'message']) },
  { name: 'slack_search_users', description: 'Find people', inputSchema: obj({ query: { type: 'string' } }, ['query']), annotations: { readOnlyHint: true } },
  { name: 'slack_delete_message', inputSchema: obj({ channel_id: { type: 'string' }, message_ts: { type: 'string' } }, ['channel_id', 'message_ts']), annotations: { destructiveHint: true } },
  { name: 'slack_create_canvas', inputSchema: obj({ title: { type: 'string' } }) },
  { name: 'search', inputSchema: obj({ q: { type: 'string' } }) },
];
const GMAIL: UpstreamTool[] = [
  { name: 'send_message', inputSchema: obj({ to: { type: 'array', items: { type: 'string' } }, subject: { type: 'string' }, body: { type: 'string' } }) },
  { name: 'search', inputSchema: obj({ q: { type: 'string' } }) },
];

// ── a stand-in Humanos: holds mandates, evaluates rules with the SDK's evaluator, runs step-ups ──
const wrap = (v: Record<string, unknown>) => Object.fromEntries(Object.entries(v).map(([k, value]) => [k, { description: k, value }]));
const SLACK_MANDATE = {
  mandate: { id: 'urn:via:credential:slack', credentialSubject: { mandate: { userParams: wrap({ allowed_tools: ['slack_send_message', 'slack_search_users', 'slack_delete_message'], allowed_channels: ['C-OK'] }) } } },
  action: { urn: 'urn:via:action:slack', content: {
    executionParams: { tool: {}, channel_id: {}, message: {}, query: {}, message_ts: {} },
    rules: [
      { name: 'allowed_tools', expression: 'executionParams.tool in userParams.allowed_tools' },
      { name: 'allowed_channels', expression: '!has(executionParams.channel_id) || executionParams.channel_id in userParams.allowed_channels' },
    ],
    stepUp: { tools: ['slack_delete_message'] },
  } },
};
const GMAIL_MANDATE = {
  mandate: { id: 'urn:via:credential:gmail', credentialSubject: { mandate: { userParams: wrap({ allowed_recipients: ['ana@h.test'] }) } } },
  action: { urn: 'urn:via:action:gmail', content: {
    executionParams: { tool: {}, to: {}, subject: {}, body: {} },
    rules: [{ name: 'allowed_recipients', expression: '!has(executionParams.to) || executionParams.to.all(v, v in userParams.allowed_recipients)' }],
  } },
};

function humanos(held = [SLACK_MANDATE, GMAIL_MANDATE]) {
  const declared: Record<string, unknown>[] = [];
  const refuse = new Set<string>(); // services whose declarations the platform refuses
  const verified: Record<string, unknown>[] = [];
  const reported: Record<string, unknown>[] = [];
  const stepUps = new Map<string, { terms: string; status: 'pending' | 'approved' | 'declined' | 'consumed' }>();
  let n = 0;
  const answer = (v: unknown) => ({ text: JSON.stringify(v), isError: false });
  const client: ViaMcpClient = {
    initialize: async () => ({ serverInfo: { name: 'humanos', version: '0' }, protocolVersion: '2025-06-18' }),
    listTools: async () => [],
    callTool: async (name, args = {}) => {
      if (name === 'declare_tools') {
        if ((args.services as string[]).some((s) => refuse.has(s))) return { text: 'declarations are refused', isError: true };
        declared.push(args);
        return answer({ recorded: (args.tools as unknown[]).length });
      }
      if (name === 'get_mandate') return answer(held);
      if (name === 'challenge') return answer({ nonce: `n-${++n}`, aud: 'did:web:org', ttlMs: 60_000 });
      if (name === 'report_outcome') { reported.push(args); return answer({ recorded: { id: `urn:via:event:o-${reported.length}` } }); }
      if (name === 'verify') {
        verified.push(args);
        const h = held.find((x) => x.mandate.id === args.mandateId)!;
        const params = args.params as Record<string, unknown>;
        const terms = JSON.stringify([args.mandateId, args.tool, params]);
        if ((h.action.content as { stepUp?: { tools: string[] } }).stepUp?.tools.includes(String(args.tool))) {
          const su = args.stepUpId ? stepUps.get(String(args.stepUpId)) : undefined;
          if (su?.status === 'declined') return answer({ decision: 'deny', reason: 'stepup_declined', evaluations: [] });
          if (!su || su.status !== 'approved' || su.terms !== terms) {
            const open = [...stepUps.entries()].find(([, v]) => v.terms === terms && v.status === 'pending');
            const id = open?.[0] ?? `su-${stepUps.size + 1}`;
            if (!open) stepUps.set(id, { terms, status: 'pending' });
            return answer({ decision: 'rechallenge', evaluations: [], stepUp: { id, approveLink: `https://app.test/approve/${id}`, method: 'otp' } });
          }
          su.status = 'consumed';
        }
        const r = evaluateRules(h.action.content.rules as never, { userParams: unwrapUserParamValues(h.mandate.credentialSubject.mandate.userParams as never), executionParams: params } as never);
        return answer({ ...r, ...(r.decision === 'deny' ? { reason: 'rule_failed' } : {}), decisionEventId: `urn:via:event:d-${verified.length}` });
      }
      return { text: `unknown tool ${name}`, isError: true };
    },
  };
  return { client, declared, refuse, verified, reported, stepUps };
}

async function setup(opts: { fail?: string[]; decorateCall?: ViaMcpProxyConfig['decorateCall'] } = {}) {
  const slack = standin('Slack', SLACK, opts.fail);
  const gmail = standin('Gmail', GMAIL);
  const h = humanos();
  const proxy = await startViaMcpProxy({
    upstreams: [await inProcessUpstream('Slack', slack.handleRpc), await inProcessUpstream('Gmail', gmail.handleRpc)],
    humanos: h.client,
    agentKey: await softwareKey(),
    did: 'did:web:humanos.tech:agent:proxy',
    ...(opts.decorateCall ? { decorateCall: opts.decorateCall } : {}),
  });
  let id = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await proxy.handleRpc({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }))!.result as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join(''), isError: r.isError === true };
  };
  return { proxy, slack, gmail, h, call };
}

describe('the governing proxy — ViaGuard in front of MCP servers', () => {
  it('merges the servers into one surface, prefixing only a name two services share, and declares each service as its server describes it', async () => {
    const { proxy, h } = await setup();
    const list = (await proxy.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))!.result as { tools: { name: string; annotations?: unknown }[] };
    expect(list.tools.map((t) => t.name)).toEqual(['slack_send_message', 'slack_search_users', 'slack_delete_message', 'slack_create_canvas', 'slack__search', 'send_message', 'gmail__search']);
    expect(list.tools.find((t) => t.name === 'slack_delete_message')!.annotations).toEqual({ destructiveHint: true });
    expect(h.declared.map((d) => d.services)).toEqual([['Slack'], ['Gmail']]);
    const gmailDeclared = h.declared[1]!.tools as Record<string, unknown>[];
    // the schema verbatim, never flattened, and the server it came from
    expect(gmailDeclared.find((t) => t.name === 'send_message')).toEqual({ name: 'send_message', inputSchema: GMAIL[0]!.inputSchema, service: 'Gmail', server: { name: 'Gmail', version: '0' } });
    // declared under the upstream's real name (rules speak of real names), with the name the agent calls it by
    expect(gmailDeclared.find((t) => t.name === 'search')).toMatchObject({ calledAs: 'gmail__search' });
    const slackDeclared = h.declared[0]!.tools as Record<string, unknown>[];
    expect(slackDeclared.find((t) => t.name === 'slack_search_users')).toMatchObject({ description: 'Find people', annotations: { readOnlyHint: true } });
  });

  it('allow: the call reaches the server, and its outcome is reported', async () => {
    const { call, slack, h } = await setup();
    expect(await call('slack_send_message', { channel_id: 'C-OK', message: 'hi' })).toEqual({ text: 'Slack.slack_send_message ok', isError: false });
    expect(slack.journal).toEqual([{ tool: 'slack_send_message', args: { channel_id: 'C-OK', message: 'hi' } }]);
    expect(h.verified[0]).toMatchObject({ mandateId: 'urn:via:credential:slack', tool: 'slack_send_message' });
    expect(h.reported[0]).toMatchObject({ outcome: 'completed' });
  });

  it('deny: nothing reaches the server — another channel, or a tool the person did not allow', async () => {
    const { call, slack } = await setup();
    const other = await call('slack_send_message', { channel_id: 'C-GENERAL', message: 'hi' });
    expect(other.isError).toBe(true);
    expect(other.text).toMatch(/Blocked by VIA: .*Nothing was sent to Slack/);
    const canvas = await call('slack_create_canvas', { title: 'x' });
    expect(canvas).toMatchObject({ isError: true });
    expect(canvas.text).toMatch(/No mandate covers slack_create_canvas \(Slack\)/);
    expect(slack.journal).toEqual([]);
  });

  it('the guarded "where" rule lets a tool without the target through', async () => {
    const { call, slack } = await setup();
    expect((await call('slack_search_users', { query: 'ana' })).isError).toBe(false);
    expect(slack.journal.map((j) => j.tool)).toEqual(['slack_search_users']);
  });

  it('picks the mandate per call: Gmail\'s runs under the Gmail mandate, every recipient checked', async () => {
    const { call, gmail, h } = await setup();
    expect((await call('send_message', { to: ['ana@h.test'], subject: 's', body: 'b' })).isError).toBe(false);
    expect(h.verified.at(-1)).toMatchObject({ mandateId: 'urn:via:credential:gmail' });
    expect((await call('send_message', { to: ['ana@h.test', 'x@elsewhere.test'], subject: 's', body: 'b' })).isError).toBe(true);
    expect(gmail.journal).toHaveLength(1);
  });

  it('step-up: the link comes back at once, nothing is sent; after approval the same call goes through, presenting the approval by id', async () => {
    const { call, slack, h } = await setup();
    const args = { channel_id: 'C-OK', message_ts: '17.1' };
    const first = await call('slack_delete_message', args);
    expect(first.isError).toBe(true);
    expect(first.text).toMatch(/needs the person's approval before it reaches Slack: https:\/\/app\.test\/approve\/su-1/);
    expect(slack.journal).toEqual([]);
    h.stepUps.get('su-1')!.status = 'approved'; // the person approves on the page
    const retry = await call('slack_delete_message', args);
    expect(retry).toEqual({ text: 'Slack.slack_delete_message ok', isError: false });
    expect(h.verified.at(-1)).toMatchObject({ stepUpId: 'su-1' });
    expect(slack.journal).toEqual([{ tool: 'slack_delete_message', args }]);
    // spent: the same call again opens a new step-up
    expect((await call('slack_delete_message', args)).text).toMatch(/approve\/su-2/);
  });

  it('step-up declined: the retry is refused and nothing is sent', async () => {
    const { call, slack, h } = await setup();
    const args = { channel_id: 'C-OK', message_ts: '17.2' };
    await call('slack_delete_message', args);
    h.stepUps.get('su-1')!.status = 'declined';
    const retry = await call('slack_delete_message', args);
    expect(retry.isError).toBe(true);
    expect(retry.text).toMatch(/Blocked by VIA/);
    expect(slack.journal).toEqual([]);
  });

  it('decorateCall: what it returns rides the call as _meta — it is given the decision, and runs only for a call that will be sent', async () => {
    const seen: string[] = [];
    const { call, slack } = await setup({
      decorateCall: ({ tool, mandateId, outcome }) => {
        seen.push(tool.upstreamName);
        return { meta: { 'test.example/decision': { id: outcome.decisionEventId, decision: outcome.decision, mandateId } } };
      },
    });
    await call('slack_send_message', { channel_id: 'C-OK', message: 'hi' });
    expect(slack.metas).toEqual([{ 'test.example/decision': { id: 'urn:via:event:d-1', decision: 'allow', mandateId: 'urn:via:credential:slack' } }]);
    // the arguments are the server's, untouched: what was added sits beside them
    expect(slack.journal).toEqual([{ tool: 'slack_send_message', args: { channel_id: 'C-OK', message: 'hi' } }]);
    await call('slack_send_message', { channel_id: 'C-GENERAL', message: 'hi' }); // denied
    expect(seen).toEqual(['slack_send_message']);
    expect(slack.journal).toHaveLength(1);
  });

  it('without decorateCall the call carries no _meta', async () => {
    const { call, slack } = await setup();
    await call('slack_send_message', { channel_id: 'C-OK', message: 'hi' });
    expect(slack.metas).toEqual([undefined]);
  });

  it('an upstream error is the server\'s own answer, and reported as a failed outcome', async () => {
    const { call, h } = await setup({ fail: ['slack_send_message'] });
    expect(await call('slack_send_message', { channel_id: 'C-OK', message: 'hi' })).toEqual({ text: 'slack_send_message failed upstream', isError: true });
    expect(h.reported[0]).toMatchObject({ outcome: 'failed' });
  });
});

// ── a proxy over Slack alone, recording what it tells its agent and what it warns about ──
async function live() {
  const slackTools = [...SLACK];
  const slack = standin('Slack', slackTools);
  const h = humanos();
  const notified: JsonRpcMessage[] = [];
  const proxy = await startViaMcpProxy({
    upstreams: [await inProcessUpstream('Slack', slack.handleRpc, slack.notifications)],
    humanos: h.client,
    agentKey: await softwareKey(),
    did: 'did:web:humanos.tech:agent:proxy',
    notify: (m) => notified.push(m),
  });
  const names = async (): Promise<string[]> => ((await proxy.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))!.result as { tools: { name: string }[] }).tools.map((t) => t.name);
  return { proxy, slack, slackTools, h, notified, names };
}
const pin: UpstreamTool = { name: 'slack_pin', inputSchema: obj({ message_ts: { type: 'string' } }) };

describe('a surface that changes while the proxy runs', () => {
  it('refresh declares again only the service whose tools changed, and nothing when none did', async () => {
    const { proxy, slackTools, h } = await live();
    await proxy.addUpstream(await inProcessUpstream('Gmail', standin('Gmail', [GMAIL[0]!]).handleRpc));
    h.declared.length = 0;
    slackTools.push(pin);

    await proxy.refresh();
    expect(h.declared.map((d) => d.services)).toEqual([['Slack']]);
    expect(await proxy.refresh()).toEqual([]);
    expect(h.declared).toHaveLength(1);
  });

  it('adding a server declares it, and declares again a service whose tool now carries a prefix', async () => {
    const { proxy, h, names } = await live();
    h.declared.length = 0;

    await proxy.addUpstream(await inProcessUpstream('Gmail', standin('Gmail', GMAIL).handleRpc));

    expect(await names()).toEqual(expect.arrayContaining(['slack__search', 'gmail__search', 'send_message']));
    expect(h.declared.map((d) => d.services)).toEqual([['Slack'], ['Gmail']]);
    expect((h.declared[0]!.tools as Record<string, unknown>[]).find((t) => t.name === 'search')).toMatchObject({ calledAs: 'slack__search' });
  });

  it('tells the agent its tools changed, having announced that they can', async () => {
    const { proxy, notified } = await live();
    const init = (await proxy.handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))!.result as { capabilities: { tools: { listChanged: boolean } } };
    expect(init.capabilities.tools.listChanged).toBe(true);

    await proxy.addUpstream(await inProcessUpstream('Gmail', standin('Gmail', GMAIL).handleRpc));
    await proxy.refresh(); // nothing changed: nothing to tell
    expect(notified).toEqual([{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }]);
  });

  it('removing a server declares its service with no tools, and stops offering them', async () => {
    const { proxy, h, names } = await live();
    await proxy.addUpstream(await inProcessUpstream('Gmail', standin('Gmail', GMAIL).handleRpc));
    h.declared.length = 0;

    await proxy.removeUpstream('Gmail');

    // Slack's search loses its prefix, so Slack is declared again; Gmail is declared empty.
    expect(h.declared.map((d) => [d.services, (d.tools as unknown[]).length])).toEqual([[['Slack'], 5], [['Gmail'], 0]]);
    expect(await names()).toEqual(SLACK.map((t) => t.name));
    expect(proxy.declared).toEqual({ services: ['Slack'], tools: 5 });
  });

  it('a local server saying its tools changed refreshes that service by itself, once for a burst', async () => {
    const { proxy, slack, slackTools, h } = await live();
    h.declared.length = 0;
    slackTools.push(pin);
    const before = slack.listings.count;

    slack.toolsChanged();
    slack.toolsChanged();
    expect(await proxy.refresh()).toEqual([]); // queued behind the one the notifications started

    expect(slack.listings.count - before).toBe(2); // one for the burst, one for this refresh
    expect(h.declared).toHaveLength(1);
    expect((h.declared[0]!.tools as { name: string }[]).map((t) => t.name)).toContain('slack_pin');
  });

  it('a refused declaration leaves the new tools callable, and they are declared on the next change', async () => {
    const { proxy, slackTools, h, names } = await live();
    h.refuse.add('Slack');
    slackTools.push(pin);

    await expect(proxy.refresh()).rejects.toThrow(/declare_tools refused for Slack/);
    expect(await names()).toContain('slack_pin');

    h.refuse.clear();
    h.declared.length = 0;
    await proxy.refresh();
    expect(h.declared.map((d) => d.services)).toEqual([['Slack']]);
  });
});

describe('mandate selection and parameter declaration', () => {
  const tool = (name: string, props: Record<string, unknown>) => ({ exposedName: name, upstreamName: name, service: 'S', upstream: {} as never, definition: { name, inputSchema: obj(props) } });
  const held = (id: string, userParams: Record<string, unknown>, executionParams: Record<string, unknown> | null) =>
    ({ mandate: { id, credentialSubject: { mandate: { userParams: wrap(userParams) } } }, action: executionParams ? { urn: id, content: { executionParams, rules: [] } } : null, compiled: { actionVersion: { rules: [] } } }) as never;

  it('exact beats service beats a plain authorization; a person\'s allowed_tools that leaves the tool out never matches', () => {
    const t = tool('post', { channel: { type: 'string' } });
    const authz = held('authz', {}, null);
    const service = held('service', {}, { tool: {}, channel: {} });
    const exact = held('exact', { allowed_tools: ['post'] }, { tool: {}, channel: {} });
    const refused = held('refused', { allowed_tools: ['read'] }, { tool: {}, channel: {} });
    expect((pickMandate(t, [authz, service, exact, refused]) as { mandate: { id: string } }).mandate.id).toBe('exact');
    expect((pickMandate(t, [authz, service]) as { mandate: { id: string } }).mandate.id).toBe('service');
    expect((pickMandate(t, [authz, refused]) as { mandate: { id: string } }).mandate.id).toBe('authz');
    expect(pickMandate(tool('noparams', {}), [service])).toBeUndefined();
  });

  it('JSON Schema flattens to the declared shape: one type word, required, a list\'s element type', () => {
    expect(declaredParams({ properties: { to: { type: 'array', items: { type: 'string' } }, n: { type: ['number', 'null'], description: 'count' } }, required: ['to'] })).toEqual({
      to: { type: 'array', required: true, items: 'string' },
      n: { type: 'number', description: 'count' },
    });
  });
});

describe('upstream over stdio', () => {
  it('spawns the server, completes the handshake, lists and calls', async () => {
    const u = await connectUpstream({ service: 'Echo', command: process.execPath, args: [new URL('./fixtures/stdio-standin.mjs', import.meta.url).pathname] });
    const tools = await u.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    expect(tools[0]!.annotations).toEqual({ readOnlyHint: true });
    expect(await u.callTool('echo', { text: 'hi' })).toEqual({ content: [{ type: 'text', text: 'echo:{"text":"hi"}' }] });
    await u.close();
  });
});

describe('upstream over stdio: the server behind it', () => {
  it('knows the server it reached by its command name, never its arguments, and hears it say its tools changed', async () => {
    const u = await connectUpstream({ service: 'Echo', command: process.execPath, args: [new URL('./fixtures/stdio-standin.mjs', import.meta.url).pathname] });
    expect(u.server).toEqual({ transport: 'stdio', host: basename(process.execPath), name: 'standin', version: '0' });
    let heard = 0;
    u.onToolsChanged!(() => heard++);

    await u.callTool('echo', { text: 'grow' }); // the server notifies before it answers

    expect(heard).toBe(1);
    expect((await u.listTools()).map((t) => t.name)).toEqual(['echo', 'echo2']);
    await u.close();
  });
});

describe('upstream over Streamable HTTP', () => {
  it('per-call headers and _meta reach the server; a header the transport or the credential set is never replaced', async () => {
    const calls: { headers: Record<string, unknown>; params: Record<string, unknown> }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const msg = JSON.parse(body) as JsonRpcMessage;
        if (msg.method === 'tools/call') calls.push({ headers: req.headers, params: msg.params ?? {} });
        if (msg.id === undefined) return void res.writeHead(202).end();
        const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'h', version: '0' } } : { content: [{ type: 'text', text: 'ok' }] };
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const u = await connectUpstream({ service: 'H', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, headers: { Authorization: 'Bearer upstream' } });
      // the server by its host only: never the URL's path, query or the credential
      expect(u.server).toEqual({ transport: 'http', host: '127.0.0.1', name: 'h', version: '0' });
      await u.callTool('echo', { text: 'hi' }, { meta: { 'test.example/decision': 'd-1' }, headers: { 'X-Decision': 'd-1', authorization: 'Bearer other', 'content-type': 'text/plain' } });
      await u.callTool('echo', { text: 'again' });
      expect(calls[0]!.headers).toMatchObject({ 'x-decision': 'd-1', authorization: 'Bearer upstream', 'content-type': 'application/json' });
      expect(calls[0]!.params).toEqual({ name: 'echo', arguments: { text: 'hi' }, _meta: { 'test.example/decision': 'd-1' } });
      // per call means per call: the next one carries neither
      expect(calls[1]!.headers['x-decision']).toBeUndefined();
      expect(calls[1]!.params).toEqual({ name: 'echo', arguments: { text: 'again' } });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

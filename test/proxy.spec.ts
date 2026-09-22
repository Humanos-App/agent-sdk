import { describe, expect, it } from 'vitest';
import { softwareKey } from '../src/key-provider.js';
import { evaluateRules, unwrapUserParamValues } from '../src/sdk.js';
import type { ViaMcpClient } from '../src/mcp/client.js';
import { declaredParams, pickMandate, startViaMcpProxy } from '../src/mcp/proxy.js';
import type { JsonRpcMessage } from '../src/mcp/server.js';
import { connectUpstream, inProcessUpstream, type UpstreamTool } from '../src/mcp/upstream.js';

// ── stand-in upstream servers: real-shaped tools, every call journalled instead of performed ──
function standin(service: string, tools: UpstreamTool[], fail: string[] = []) {
  const journal: { tool: string; args: Record<string, unknown> }[] = [];
  const handleRpc = async (msg: JsonRpcMessage): Promise<JsonRpcMessage | null> => {
    const ok = (result: unknown): JsonRpcMessage => ({ jsonrpc: '2.0', id: msg.id ?? null, result });
    switch (msg.method) {
      case 'initialize': return ok({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: service, version: '0' } });
      case 'notifications/initialized': return null;
      case 'tools/list': return ok({ tools });
      case 'tools/call': {
        const name = String(msg.params?.name);
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        journal.push({ tool: name, args });
        if (fail.includes(name)) return ok({ content: [{ type: 'text', text: `${name} failed upstream` }], isError: true });
        return ok({ content: [{ type: 'text', text: `${service}.${name} ok` }] });
      }
      default: return { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32601, message: 'no' } };
    }
  };
  return { handleRpc, journal };
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
  const verified: Record<string, unknown>[] = [];
  const reported: Record<string, unknown>[] = [];
  const stepUps = new Map<string, { terms: string; status: 'pending' | 'approved' | 'declined' | 'consumed' }>();
  let n = 0;
  const answer = (v: unknown) => ({ text: JSON.stringify(v), isError: false });
  const client: ViaMcpClient = {
    initialize: async () => ({ serverInfo: { name: 'humanos', version: '0' }, protocolVersion: '2025-06-18' }),
    listTools: async () => [],
    callTool: async (name, args = {}) => {
      if (name === 'declare_tools') { declared.push(args); return answer({ recorded: (args.tools as unknown[]).length }); }
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
  return { client, declared, verified, reported, stepUps };
}

async function setup(opts: { fail?: string[] } = {}) {
  const slack = standin('Slack', SLACK, opts.fail);
  const gmail = standin('Gmail', GMAIL);
  const h = humanos();
  const proxy = await startViaMcpProxy({
    upstreams: [await inProcessUpstream('Slack', slack.handleRpc), await inProcessUpstream('Gmail', gmail.handleRpc)],
    humanos: h.client,
    agentKey: await softwareKey(),
    did: 'did:web:humanos.tech:agent:proxy',
  });
  let id = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await proxy.handleRpc({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }))!.result as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join(''), isError: r.isError === true };
  };
  return { proxy, slack, gmail, h, call };
}

describe('the governing proxy — ViaGuard in front of MCP servers', () => {
  it('merges the servers into one surface, prefixing only a name two services share, and declares it per service with the servers\' own annotations', async () => {
    const { proxy, h } = await setup();
    const list = (await proxy.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))!.result as { tools: { name: string; annotations?: unknown }[] };
    expect(list.tools.map((t) => t.name)).toEqual(['slack_send_message', 'slack_search_users', 'slack_delete_message', 'slack_create_canvas', 'slack__search', 'send_message', 'gmail__search']);
    expect(list.tools.find((t) => t.name === 'slack_delete_message')!.annotations).toEqual({ destructiveHint: true });
    expect(h.declared.map((d) => (d.tools as { service: string }[])[0]!.service)).toEqual(['Slack', 'Gmail']);
    const gmailDeclared = h.declared[1]!.tools as { name: string; params: Record<string, unknown> }[];
    expect(gmailDeclared.find((t) => t.name === 'send_message')!.params.to).toEqual({ type: 'array', items: 'string' });
    // declared under the upstream's real name, not the prefixed one: rules speak of real names
    expect(gmailDeclared.map((t) => t.name)).toContain('search');
    const slackDeclared = h.declared[0]!.tools as { name: string; readOnlyHint?: boolean; destructiveHint?: boolean }[];
    expect(slackDeclared.find((t) => t.name === 'slack_search_users')).toMatchObject({ readOnlyHint: true });
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

  it('an upstream error is the server\'s own answer, and reported as a failed outcome', async () => {
    const { call, h } = await setup({ fail: ['slack_send_message'] });
    expect(await call('slack_send_message', { channel_id: 'C-OK', message: 'hi' })).toEqual({ text: 'slack_send_message failed upstream', isError: true });
    expect(h.reported[0]).toMatchObject({ outcome: 'failed' });
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

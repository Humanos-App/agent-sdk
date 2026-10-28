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
        metas.push(msg.params?._meta);
        if (fail.includes(name)) return ok({ content: [{ type: 'text', text: `${name} failed upstream` }], isError: true });
        return ok({ content: [{ type: 'text', text: `${service}.${name} ok` }] });
      }
      default: return { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32601, message: 'no' } };
    }
  };
  return { handleRpc, journal, metas };
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

// ── a stand-in Humanos: decides on the organization's policy first, holds mandates, evaluates rules with the SDK's evaluator ──
const wrap = (v: Record<string, unknown>) => Object.fromEntries(Object.entries(v).map(([k, value]) => [k, { description: k, value }]));
const SLACK_MANDATE = {
  mandate: { id: 'urn:via:credential:slack', credentialSubject: { mandate: { userParams: wrap({ allowed_tools: ['slack_send_message', 'slack_search_users', 'slack_delete_message'], allowed_channels: ['C-OK'] }) } } },
  action: { urn: 'urn:via:action:slack', content: {
    executionParams: { tool: {}, channel_id: {}, message: {}, query: {}, message_ts: {} },
    rules: [
      { name: 'allowed_tools', expression: 'executionParams.tool in userParams.allowed_tools' },
      { name: 'allowed_channels', expression: '!has(executionParams.channel_id) || executionParams.channel_id in userParams.allowed_channels' },
    ],
  } },
};
const GMAIL_MANDATE = {
  mandate: { id: 'urn:via:credential:gmail', credentialSubject: { mandate: { userParams: wrap({ allowed_recipients: ['ana@h.test'] }) } } },
  action: { urn: 'urn:via:action:gmail', content: {
    executionParams: { tool: {}, to: {}, subject: {}, body: {} },
    rules: [{ name: 'allowed_recipients', expression: '!has(executionParams.to) || executionParams.to.all(v, v in userParams.allowed_recipients)' }],
  } },
};

/** v0.3 §21.3 — the organization's policy, per tool: allowed, refused, or left to a person's mandate (under an action). */
type StandinPolicy = Record<string, 'allow' | 'deny' | 'mandate' | { under: string }>;
const POLICY_URN = 'urn:via:policy:p1';
/** The tools the mandates above are for are left to them; every other tool gets the default. */
const DELEGATED: StandinPolicy = { slack_send_message: 'mandate', slack_search_users: 'mandate', slack_delete_message: 'mandate', send_message: 'mandate' };
type StandinMandate = { mandate: { id: string; credentialSubject: { mandate: { userParams: unknown } } }; action: { urn: string; content: unknown } | null };

function humanos(held: StandinMandate[] = [SLACK_MANDATE, GMAIL_MANDATE], policy: StandinPolicy = DELEGATED, byDefault: 'allow' | 'deny' = 'deny') {
  const declared: Record<string, unknown>[] = [];
  const refuse = new Set<string>(); // services whose declarations the platform refuses
  const verified: Record<string, unknown>[] = [];
  const reported: Record<string, unknown>[] = [];
  const reads = { get_policy: 0, get_mandate: 0 };
  let n = 0;
  const answer = (v: unknown) => ({ text: JSON.stringify(v), isError: false });
  const decide = (args: Record<string, unknown>) => {
    const set = policy[String(args.tool)];
    const effect = set ?? byDefault;
    const lane = { evaluations: [], enforcement: 'policy', ...(set ? {} : { unset: true }) };
    if (effect === 'allow') return { decision: 'allow', ...lane, ...(set ? {} : { enforcement: 'none' }), decisionEventId: `urn:via:event:p-${verified.length}` };
    if (effect === 'deny') return { decision: 'deny', reason: 'policy_denied', ...lane };
    const under = typeof effect === 'object' ? { under: [{ id: effect.under }] } : {};
    const h = held.find((x) => x.mandate.id === args.mandateId);
    if (!h || (typeof effect === 'object' && h.action?.urn !== effect.under)) return { decision: 'deny', reason: 'mandate_required', ...lane, ...under };
    const rules = ((h.action?.content ?? {}) as { rules?: never }).rules ?? [];
    const r = evaluateRules(rules, { userParams: unwrapUserParamValues(h.mandate.credentialSubject.mandate.userParams as never), executionParams: args.params } as never);
    return { ...r, ...(r.decision === 'deny' ? { reason: 'rule_failed' } : {}), enforcement: 'rules', decisionEventId: `urn:via:event:d-${verified.length}` };
  };
  const access = (tool: string) => {
    const e = policy[tool];
    return e === undefined ? 'not_set' : e === 'allow' || e === 'deny' ? e : 'mandate';
  };
  const client: ViaMcpClient = {
    initialize: async () => ({ serverInfo: { name: 'humanos', version: '0' }, protocolVersion: '2025-06-18' }),
    listTools: async () => [],
    callTool: async (name, args = {}) => {
      if (name === 'declare_tools') {
        if ((args.services as string[]).some((s) => refuse.has(s))) return { text: 'declarations are refused', isError: true };
        declared.push(args);
        return answer({ recorded: (args.tools as unknown[]).length });
      }
      if (name === 'get_mandate') {
        reads.get_mandate++;
        return answer(held);
      }
      if (name === 'get_policy') {
        reads.get_policy++;
        const names = [...new Set(declared.flatMap((d) => (d.tools as { name: string }[]).map((t) => t.name)))];
        // A Delegate tool's request, as the connector words it: under the control the policy names, else one call's authorization.
        const request = (tool: string) => {
          const e = policy[tool];
          return typeof e === 'object' ? { kind: 'guardrail', actionIds: [e.under] } : e === 'mandate' ? { kind: 'authorization', maxExecutions: 1 } : undefined;
        };
        return answer({
          agent: args.agentDid,
          policy: { id: POLICY_URN, version: 1, default: byDefault },
          tools: names.map((tool) => ({ tool, access: access(tool), meaning: '', ...(request(tool) ? { request: request(tool) } : {}) })),
        });
      }
      // Every organization has a policy (v0 at the least): every challenge names it.
      if (name === 'challenge') return answer({ nonce: `n-${++n}`, aud: 'did:web:org', ttl: 60, iat: 1_757_160_000, policy: POLICY_URN });
      if (name === 'report_outcome') { reported.push(args); return answer({ recorded: { id: `urn:via:event:o-${reported.length}` } }); }
      if (name === 'verify') {
        verified.push(args);
        return answer(decide(args));
      }
      return { text: `unknown tool ${name}`, isError: true };
    },
  };
  return { client, declared, refuse, verified, reported, reads, held };
}

async function setup(
  opts: {
    fail?: string[];
    decorateCall?: ViaMcpProxyConfig['decorateCall'];
    /** The organization's policy, over `DELEGATED`. */
    policy?: StandinPolicy;
    default?: 'allow' | 'deny';
    held?: StandinMandate[];
  } = {},
) {
  const slack = standin('Slack', SLACK, opts.fail);
  const gmail = standin('Gmail', GMAIL);
  const h = humanos(opts.held, { ...DELEGATED, ...opts.policy }, opts.default);
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
    const { call, slack } = await setup({ policy: { slack_create_canvas: 'mandate' } });
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

  it('presents a mandate only for a tool the policy leaves to one: an allowed tool binds the policy, though a mandate covers it', async () => {
    const { call, h } = await setup({ policy: { slack_search_users: 'allow' } });
    expect((await call('slack_search_users', { query: 'ana' })).isError).toBe(false);
    expect(h.verified[0]).toMatchObject({ policy: POLICY_URN, agentDid: 'did:web:humanos.tech:agent:proxy' });
    expect(h.verified[0]).not.toHaveProperty('mandateId');
  });

  it('reads the policy and the mandates once at start, and again on a mandate_required: a mandate a person has just granted is presented', async () => {
    const { call, slack, h } = await setup({ held: [GMAIL_MANDATE] });
    expect(h.reads).toEqual({ get_policy: 1, get_mandate: 1 });
    h.held.push(SLACK_MANDATE); // the person grants it after the proxy started
    expect(await call('slack_send_message', { channel_id: 'C-OK', message: 'hi' })).toEqual({ text: 'Slack.slack_send_message ok', isError: false });
    expect(h.verified.map((v) => v.mandateId ?? v.policy)).toEqual([POLICY_URN, 'urn:via:credential:slack']);
    expect(h.reads).toEqual({ get_policy: 2, get_mandate: 2 });
    expect(slack.journal).toHaveLength(1);
  });

  it('a mandate the policy refuses as not under its action is not presented again; one under it is', async () => {
    const GMAIL_2 = { ...GMAIL_MANDATE, mandate: { ...GMAIL_MANDATE.mandate, id: 'urn:via:credential:gmail-2' }, action: { ...GMAIL_MANDATE.action, urn: 'urn:via:action:gmail-2' } };
    const { call, h } = await setup({ held: [GMAIL_MANDATE, GMAIL_2], policy: { send_message: { under: 'urn:via:action:gmail-2' } } });
    expect((await call('send_message', { to: ['ana@h.test'], subject: 's', body: 'b' })).isError).toBe(false);
    expect(h.verified.map((v) => v.mandateId)).toEqual(['urn:via:credential:gmail', 'urn:via:credential:gmail-2']);
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

// ── a proxy over Slack and part of Gmail, whose tool lists the tests change ──
async function live() {
  const slackTools = [...SLACK];
  const gmailTools = [GMAIL[0]!]; // no name shared with Slack, yet
  const h = humanos();
  const proxy = await startViaMcpProxy({
    upstreams: [await inProcessUpstream('Slack', standin('Slack', slackTools).handleRpc), await inProcessUpstream('Gmail', standin('Gmail', gmailTools).handleRpc)],
    humanos: h.client,
    agentKey: await softwareKey(),
    did: 'did:web:humanos.tech:agent:proxy',
  });
  h.declared.length = 0; // what the start declared is the first test's business, not these
  const names = async (): Promise<string[]> => ((await proxy.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))!.result as { tools: { name: string }[] }).tools.map((t) => t.name);
  return { proxy, slackTools, gmailTools, h, names };
}
const pin: UpstreamTool = { name: 'slack_pin', inputSchema: obj({ message_ts: { type: 'string' } }) };

describe('a call the policy decides alone (v0.3 §21.3)', () => {
  it('allowed, it reaches the server, and its outcome is reported against the policy', async () => {
    const { call, slack, h } = await setup({ policy: { slack_create_canvas: 'allow' } });
    expect(await call('slack_create_canvas', { title: 'Q4' })).toEqual({ text: 'Slack.slack_create_canvas ok', isError: false });
    expect(slack.journal).toEqual([{ tool: 'slack_create_canvas', args: { title: 'Q4' } }]);
    expect(h.verified[0]).toMatchObject({ policy: POLICY_URN, agentDid: 'did:web:humanos.tech:agent:proxy', tool: 'slack_create_canvas' });
    expect(h.verified[0]).not.toHaveProperty('mandateId');
    expect(h.reported[0]).toMatchObject({ policy: POLICY_URN, agentDid: 'did:web:humanos.tech:agent:proxy', outcome: 'completed', decisionEventId: 'urn:via:event:p-1' });
  });

  it('a tool the policy sets nothing for gets its default: allowed, it runs', async () => {
    const { call, slack } = await setup({ default: 'allow' });
    expect((await call('slack_create_canvas', { title: 'Q4' })).isError).toBe(false);
    expect(slack.journal).toHaveLength(1);
  });

  it.each([
    ['the policy refuses it', { slack_create_canvas: 'deny' } as StandinPolicy, /Blocked by VIA: the organization’s policy does not allow it/],
    ['its default refuses it', {} as StandinPolicy, /Blocked by VIA: the organization’s policy does not allow it/],
    [
      'the policy leaves it to a person with no control, and no mandate covers it',
      { slack_create_canvas: 'mandate' } as StandinPolicy,
      /No mandate covers slack_create_canvas \(Slack\).*ask the person to authorize this one call/,
    ],
    [
      'the policy needs a mandate under a named action',
      { slack_create_canvas: { under: 'urn:via:action:canvas' } } as StandinPolicy,
      /needs a person's mandate under urn:via:action:canvas for it: ask the person for one/,
    ],
  ])('sends nothing when %s', async (_case, policy, said) => {
    const { call, slack } = await setup({ policy });
    const out = await call('slack_create_canvas', { title: 'Q4' });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(said);
    expect(slack.journal).toEqual([]);
  });
});

describe('refresh: the agent says its tools changed', () => {
  it('declares again only the service whose tools changed, and nothing when none did', async () => {
    const { proxy, slackTools, h } = await live();
    slackTools.push(pin);

    await proxy.refresh();
    expect(h.declared.map((d) => d.services)).toEqual([['Slack']]);
    expect(await proxy.refresh()).toEqual([]);
    expect(h.declared).toHaveLength(1);
  });

  it('serves the new tools, and declares again a service whose tool now carries a prefix', async () => {
    const { proxy, gmailTools, h, names } = await live();
    gmailTools.push(GMAIL[1]!); // Gmail's search: Slack has one too

    await proxy.refresh('Gmail');

    expect(await names()).toEqual(expect.arrayContaining(['slack__search', 'gmail__search']));
    expect(h.declared.map((d) => d.services)).toEqual([['Slack'], ['Gmail']]);
    expect((h.declared[0]!.tools as Record<string, unknown>[]).find((t) => t.name === 'search')).toMatchObject({ calledAs: 'slack__search' });
  });

  it('declares a service whose server lists no tools any more with none, so Humanos marks them absent', async () => {
    const { proxy, gmailTools, h } = await live();
    gmailTools.length = 0;

    await proxy.refresh();

    expect(h.declared).toEqual([{ did: 'did:web:humanos.tech:agent:proxy', tools: [], services: ['Gmail'] }]);
    expect(proxy.declared).toEqual({ services: ['Slack'], tools: SLACK.length });
  });

  it('a refused declaration leaves the new tools callable, and they are declared on the next refresh', async () => {
    const { proxy, slackTools, h, names } = await live();
    h.refuse.add('Slack');
    slackTools.push(pin);

    await expect(proxy.refresh()).rejects.toThrow(/declare_tools refused for Slack/);
    expect(await names()).toContain('slack_pin');

    h.refuse.clear();
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
    // At the same rank, one on the control the policy names first.
    const other = held('other', {}, { tool: {}, channel: {} });
    expect((pickMandate(t, [service, other], ['other']) as { mandate: { id: string } }).mandate.id).toBe('other');
  });

  it("an action that lists its tools covers those exactly, and never another", () => {
    const t = tool('post', { channel: { type: 'string' } });
    const listed = (id: string, tools: string[]) =>
      ({ mandate: { id, credentialSubject: { mandate: { userParams: {} } } }, action: { urn: id, content: { tools, executionParams: { tool: {}, channel: {} }, rules: [] } }, compiled: { actionVersion: { rules: [] } } }) as never;
    const service = held('service', {}, { tool: {}, channel: {} });
    expect((pickMandate(t, [service, listed('names-it', ['post'])]) as { mandate: { id: string } }).mandate.id).toBe('names-it');
    // Its parameters match, but the action would refuse the tool `tool_not_covered`.
    expect(pickMandate(t, [listed('others', ['read'])])).toBeUndefined();
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
  it('knows the server it reached by its command name, never its arguments', async () => {
    const u = await connectUpstream({ service: 'Echo', command: process.execPath, args: [new URL('./fixtures/stdio-standin.mjs', import.meta.url).pathname] });
    expect(u.server).toEqual({ transport: 'stdio', host: basename(process.execPath), name: 'standin', version: '0' });
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

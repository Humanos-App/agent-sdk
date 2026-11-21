// The live test agent under limits per tool (VIA v0.4 §15), against a running platform — a local stack by default.
// One real agent of the test organization, holding its own key, does what a developer's agent does: it registers,
// declares one tool, asks a person to approve a call the policy leaves to a person, waits, then calls twice.
//
//   npm run build && node test/live/limits-walk.mjs
//
// Run it again after each thing it asks of you (move the agent, approve the request): it finds where it was.
// Credentials: `test/.env` (HUMANOS_LIVE_API_KEY, HUMANOS_LIVE_SIGNATURE_SECRET, HUMANOS_LIVE_MCP_URL, and
// HUMANOS_LIVE_CONTACT, the person asked to approve). The values never reach the output.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import {
  ViaDeniedError,
  createViaMcpClient,
  getPolicy,
  guardTool,
  mandateStatus,
  requestMandate,
  toolLimits,
  via,
  waitForMandate,
} from '../../dist/index.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const say = (line) => process.stdout.write(`${line}\n`);

/** The tool the walk calls: a tool of the agent's own service, so no other agent's policy entry is touched. */
const TOOL = {
  name: 'book_meeting',
  service: 'Live test desk',
  description: 'Books a meeting in the team calendar and invites its attendees.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'The meeting’s title.' },
      attendees: { type: 'integer', description: 'How many people are invited.' },
    },
    required: ['title', 'attendees'],
  },
};
const ARGS = { title: 'Live test: quarterly review', attendees: 3 };
const WAIT_MS = 5 * 60_000;

const file = [here('../.env'), here('./.env')].find((f) => existsSync(f));
const env = { ...(file ? parseEnv(readFileSync(file, 'utf8')) : {}), ...process.env };
if (!env.HUMANOS_LIVE_API_KEY || !env.HUMANOS_LIVE_SIGNATURE_SECRET) {
  say('limits-walk: no test/.env with HUMANOS_LIVE_API_KEY and HUMANOS_LIVE_SIGNATURE_SECRET');
  process.exit(2);
}
const mcpUrl = env.HUMANOS_LIVE_MCP_URL || 'http://localhost:4005/mcp';
const dir = here(`./.humanos/${new URL(mcpUrl).host.replace(/[^A-Za-z0-9.-]/g, '_')}`);
const stateFile = `${dir}/limits-walk.json`;
const state = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {});
const remember = (next) => writeFileSync(stateFile, JSON.stringify(next, null, 2), { mode: 0o600 });

/** One guarded call, as a developer writes it: what ran, or why it was refused. */
async function call(agent, named) {
  try {
    const outcome = await agent.guard.call(TOOL.name, ARGS, () => 'booked', { named });
    return { ran: outcome.result === 'booked', decision: outcome.decision, reason: outcome.reason };
  } catch (error) {
    if (!(error instanceof ViaDeniedError)) throw error;
    return { ran: false, decision: 'deny', reason: error.reason, request: error.request };
  }
}

async function main() {
  const client = createViaMcpClient({
    url: mcpUrl,
    apiKey: env.HUMANOS_LIVE_API_KEY,
    signatureSecret: env.HUMANOS_LIVE_SIGNATURE_SECRET,
  });
  await client.initialize();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const agent = await via({ client, env: {}, dir, onWarning: (m) => say(`  (sdk) ${m}`) });
  say(`platform   ${mcpUrl}`);
  say(`agent      ${agent.did}${agent.registration ? '  (registered now)' : ''}`);

  await agent.tools.add([TOOL]);
  await agent.tools.flush();
  const named = guardTool(TOOL.service, TOOL.name, TOOL);
  say(`tool       ${named.key}  (declared)`);

  const policy = await getPolicy(agent.client, agent.did);
  say(`policy     version ${policy.version ?? '?'}, protocol ${policy.specVersion ?? '0.3'}`);
  if (policy.specVersion !== '0.4') {
    say('');
    say('NEXT: this agent is under the old policy. In the dashboard, Policy → step 2 "Move your agents",');
    say('      select this agent, move it to the new policy, then run this again.');
    return;
  }
  const access = (policy.tools ?? []).find((t) => t.key === named.key)?.access ?? `default (${policy.default ?? '?'})`;
  say(`access     ${access}`);

  const first = await call(agent, named);
  say(`call 1     ${first.ran ? 'RAN' : `refused: ${first.reason}`}`);
  if (first.ran) {
    const second = await call(agent, named);
    say(`call 2     ${second.ran ? 'RAN' : `refused: ${second.reason}`}`);
    return;
  }
  if (first.reason !== 'mandate_required') return;

  let { mandateId } = state();
  const known = mandateId ? await mandateStatus(agent.client, mandateId).catch(() => undefined) : undefined;
  if (!known || known.phase !== 'PENDING') {
    if (!env.HUMANOS_LIVE_CONTACT) {
      say('limits-walk: HUMANOS_LIVE_CONTACT is not set: nobody to ask');
      return;
    }
    const asked = await requestMandate(agent.client, agent.did, {
      kind: 'limits',
      contact: env.HUMANOS_LIVE_CONTACT,
      description: 'Book the quarterly review in the team calendar, for up to 5 people',
      maxExecutions: 1,
      tools: toolLimits(named, [{ left: 'attendees', operator: '<=', value: 5 }]),
    });
    mandateId = asked.mandateId;
    remember({ mandateId });
    say(`asked      ${mandateId}  (reviewer: ${asked.consentCard?.reviewed ?? '?'})`);
    if (asked.authorizeLink) say(`link       ${asked.authorizeLink}`);
  } else say(`waiting    ${mandateId}  (asked on an earlier run)`);

  say('');
  say(`NEXT: approve the request (the person asked was sent its link). Waiting up to ${WAIT_MS / 60_000} minutes…`);
  const settled = await waitForMandate(agent.client, mandateId, { until: new Date(Date.now() + WAIT_MS) }).catch(
    (error) => ({ phase: `not settled (${error instanceof Error ? error.message : error})` }),
  );
  say(`approval   ${settled.phase}`);
  if (settled.phase !== 'ACTIVE') return;

  const allowed = await call(agent, named);
  say(`call 1     ${allowed.ran ? 'RAN under the approval' : `refused: ${allowed.reason}`}`);
  const again = await call(agent, named);
  say(`call 2     ${again.ran ? 'RAN (unexpected: the approval covers one call)' : `refused: ${again.reason}`}`);
}

main().then(
  () => process.exit(0),
  (error) => {
    say(`limits-walk: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  },
);

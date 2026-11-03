# @humanos/agent-sdk

Put an AI agent under its organization's **policy**, and a **mandate** where the policy asks for one: a signed,
bounded permission a person grants. The agent holds its own key; every tool call is proved with it and verified by
Humanos *before* the tool runs, and every decision and outcome is written to a signed, hash-chained record.

The VIA protocol itself — credentials, events, verification — is
[`@humanos/via-sdk-v03`](https://github.com/Humanos-App), a peer dependency. This package is the
agent's side of the wire.

For complete, runnable agents built on it, see
[Humanos-App/agent-kit](https://github.com/Humanos-App/agent-kit).

## What is in it

| | |
|---|---|
| **Keys** — `storedSoftwareKey`, `softwareKey`, `deviceSelfKey`, `custodialKey`, `attestedKey`, `humanosHoldsKey` | where the agent's key lives, and the evidence Humanos grades it on (v0.3 §16). `storedSoftwareKey` keeps the key in a file across restarts; `softwareKey` lasts only as long as the process; `humanosHoldsKey` has Humanos hold it |
| **`ViaGuard`** | the gate around every tool call: the mandate it presents, if any → challenge → proof of possession → verify → run or refuse → report the outcome |
| **`createViaMcpClient`** | the Humanos connector, authenticated with an API key and its signing secret: the organization's, or an agent key issued for one agent |
| **`McpGuardVerifier`**, **`policyMandates`** | the connector as the guard's verifier, and the mandate each call presents, from the policy (`getPolicy`) and the mandates held (`getMandates`) |
| **`requestMandate`**, **`waitForMandate`** | ask a person for a mandate a tool needs, under a control `getAction` describes or as a one-call authorization, and wait for their answer (`mandateStatus`) |
| **`startViaMcpProxy`** | a governing proxy in front of MCP servers you did not write; `refresh()` declares their new tools |
| **`registerAgent`** | register the agent's key with the organization, and optionally its tools; Humanos grades how the key is held and answers the agent's DID. With `humanosHoldsKey`, Humanos mints the key and holds it |
| **`declareTools`** | tell Humanos which tools an agent can call, each as its server describes it, one call per service |
| **`startViaMcpServer`** | expose a guarded agent's tools to an MCP host |
| **`extractFromToolsList`**, **`importActionDraft`** | turn an existing tool surface into a draft action for the organization |
| **`@humanos/agent-sdk/testing`** | `createTestVerifier`: an in-process verifier for testing an agent offline |

## Install

Neither package is on a registry yet. Install both from this repository, pinned to a release tag:

```json
{
  "dependencies": {
    "@humanos/agent-sdk": "github:Humanos-App/agent-sdk#v0.4.2",
    "@humanos/via-sdk-v03": "https://raw.githubusercontent.com/Humanos-App/agent-sdk/v0.4.2/vendor/humanos-via-sdk-v03-0.8.0.tgz"
  }
}
```

npm clones the tagged commit and builds it (`prepare`), so a first install takes a few seconds
longer than a registry package. Requires Node.js 20 or later and `git`.

## Use

```ts
import { createViaMcpClient, McpGuardVerifier, policyMandates, registerAgent, storedSoftwareKey, ViaGuard, ViaDeniedError } from '@humanos/agent-sdk';

const client = createViaMcpClient({
  url: 'https://mcptest.humanos.tech/mcp', // Humanos staging
  apiKey: process.env.HUMANOS_API_KEY!,
  signatureSecret: process.env.HUMANOS_SIGNATURE_SECRET!,
});
await client.initialize();

// The key is the agent: a new key registers a new agent, and its mandates stay with the old one. This one is
// created in the file on the first run and loaded on every run after, so registering again answers the same DID.
// Keep the file like the API key: out of the repository, readable only by the agent.
const agentKey = await storedSoftwareKey('.agent-key.json');
const { did } = await registerAgent(client, agentKey);

const guard = new ViaGuard({
  agentKey,
  agentDid: did,
  verifier: new McpGuardVerifier(client),
  mandates: policyMandates(client, did),
});

try {
  const out = await guard.call('issue_refund', { order_id: 'A-1', amount_eur: 40 }, issueRefund);
  console.log(out.result);
} catch (e) {
  if (e instanceof ViaDeniedError) console.log(`blocked: ${e.reason}`); // the tool never ran
  else throw e;
}
```

### When the agent has no safe place for a key

An agent with no secure hardware, or with nowhere to keep a key file across restarts (a container that starts
clean), can have Humanos hold its key (v0.3 §16.14). The client then runs on an **agent key**: an API key the
organization issues for this one agent. The organization's own API key cannot do this, and is refused
`custodial_needs_agent_key`.

```ts
import { createViaMcpClient, humanosHoldsKey, McpGuardVerifier, policyMandates, registerAgent, ViaGuard } from '@humanos/agent-sdk';

const client = createViaMcpClient({
  url: 'https://mcptest.humanos.tech/mcp',
  apiKey: process.env.HUMANOS_AGENT_KEY!, // an agent key, not the organization's API key
  signatureSecret: process.env.HUMANOS_AGENT_KEY_SECRET!,
});
await client.initialize();

const { did } = await registerAgent(client, humanosHoldsKey); // registering again answers the same DID
const guard = new ViaGuard({ agentDid: did, verifier: new McpGuardVerifier(client), mandates: policyMandates(client, did) });
```

- **The guard takes no `agentKey`.** Each call goes without a proof of possession, and Humanos signs for the agent.
  An agent that holds its own key and leaves it out of the guard is refused.
- **The agent key is the agent.** Whoever holds it acts as the agent, so keep it as you would the organization's
  API key.
- **The choice is for good.** Registering binds the agent key to the agent. An agent that later holds its own key
  is a new agent, and its mandates stay with this one. That is why `registerAgent` never treats a missing key as
  "Humanos holds it": `undefined` or anything that is not a key throws before anything reaches Humanos.

### How a call is decided

The organization's policy decides first (v0.3 §21.3): a tool it allows runs, one it refuses is `policy_denied`, one
under a control's rules runs within them, and one it leaves to a person's mandate needs one. A tool it sets nothing
for gets its default, allowed or not. `agentDid` names the agent on every call.

`policyMandates` reads `get_policy` and `get_mandate` once, and presents a held mandate only for a tool the policy
leaves to one: one on the control the policy names first, else any covering the tool, a plain authorization
included. Every other call binds the policy alone. A `mandate_required` deny reads both again, and the guard
presents the call once more when a mandate now fits: a person has just granted one, or the policy changed. Nobody
is asked to confirm a call: one a policy or a mandate puts behind a step-up is refused `stepup_required`.

### When a tool needs a person's mandate

A `mandate_required` deny says what to ask for in `ViaDeniedError.request`: a guardrail under one of `actionIds`, whose
limits `getAction` describes, or, with no control for the tool, an authorization in plain words. Whom to ask and the
limits' values come from your agent's own context:

```ts
import { getAction, requestMandate, waitForMandate, ViaDeniedError } from '@humanos/agent-sdk';

try {
  await guard.call('issue_refund', args, issueRefund);
} catch (e) {
  if (!(e instanceof ViaDeniedError) || e.reason !== 'mandate_required' || !e.request) throw e;
  const req =
    e.request.kind === 'guardrail'
      ? await requestMandate(client, did, {
          kind: 'guardrail',
          actionId: e.request.actionIds[0]!,
          userParams: limitsFor(await getAction(client, e.request.actionIds[0]!)), // yours: the values the person sets
          contact,
        })
      : await requestMandate(client, did, { kind: 'authorization', name: 'Refund A-1', terms: 'Refund order A-1, €40', contact });
  show(req.consentCard.link); // the person approves on their own device
  if ((await waitForMandate(client, req)).phase === 'ACTIVE') await guard.call('issue_refund', args, issueRefund);
}
```

An authorization asks for one call, ending in an hour, unless `maxExecutions` and `validUntil` say otherwise: with no
rules, it opens every tool the policy leaves to a mandate without naming a control. `waitForMandate` returns once the
person decides (`ACTIVE`, `REJECTED`, `INACTIVE`), or still `PENDING` at the earlier of the consent link's expiry and
ten minutes (`until` changes it; `signal` stops it). The call after an approval presents the new mandate on its own.
`mandateStatus` asks once, for a builder that waits its own way.

## Govern MCP servers you did not write

```ts
import { createStdioTransport, startViaMcpProxy, connectUpstream, declareTools } from '@humanos/agent-sdk';

const proxy = await startViaMcpProxy({
  upstreams: [await connectUpstream({ service: 'Slack', url: 'https://mcp.slack.com/mcp', headers: { Authorization: `Bearer ${slackToken}` } })],
  humanos: client,
  agentKey,
  did,
});
createStdioTransport().run(proxy);

// Declaring new tools is the agent's job: when a server's tools change, say so.
await proxy.refresh('Slack');

// An agent that stops using a service: Humanos keeps its tools, marked no longer declared.
await declareTools(client, did, [], { emptyServices: ['Files'] });
```

Per call, the proxy presents a mandate only for a tool the organization's policy leaves to one: the one whose
person's `allowed_tools`, or whose action's `tools`, names the tool. Every other call is decided on the policy alone.

A call to a remote server reached over `https` names that server's origin as the receiver, and an `allow` then
carries the call proof (v0.3 §16.16): the decision token and the agent's record token, both signed by Humanos. The
proxy sends them with the call, unchanged: in `_meta` (`tech.humanos/call-proof`, `tech.humanos/agent-record`) and in
the `Humanos-Call-Proof` and `Humanos-Agent-Record` headers. The server checks them offline with the protocol SDK's
`verifyCallProof`. A local or plain-`http` server is named no receiver and gets no proof. With `decorateCall`, what
the call carries is yours; `callProofExtra(outcome)` gives the proof's part.

At start, and on each `refresh`, every tool is declared to Humanos as its server describes it:
schemas, annotations and the server it comes from, never cut by the SDK (Humanos caps long text
itself, the same way for every agent). A `refresh` declares again only the services whose tools
changed. A service is declared in one call of at most 500 tools; past that, and when the agent
reaches its tool limit, the proxy warns (`onWarning`, stderr by default). This needs a Humanos
platform that takes full tool definitions: an earlier one refuses descriptions over 1,000
characters.

## Test without a platform

```ts
import { ViaGuard, softwareKey } from '@humanos/agent-sdk';
import { createTestVerifier } from '@humanos/agent-sdk/testing';

const agentKey = await softwareKey();
const t = createTestVerifier({
  rules: [{ name: 'cap', expression: "executionParams.tool != 'pay' || executionParams.amount <= userParams.limit" }],
  userParams: { limit: 100 },
  agentKey,
});
const guard = new ViaGuard({ mandate: t.mandate, compiled: t.compiled, agentKey, agentDid: 'did:web:agent.test', verifier: t.verifier });
await guard.call('pay', { amount: 500 }, pay); // throws ViaDeniedError: rule_failed
```

Give it a `policy` (`{ tools: { pay: 'mandate', search: 'allow' }, default: 'deny' }`) and it decides first, as the
connector does: the mandate decides only the tools the policy leaves to one.

## Develop

Requires Node.js 20 or later.

```
npm ci
npm run check-types
npm test
npm run build     # dist/: ES modules + type declarations
```

`npm ci` also builds `dist/` (`prepare`). `@humanos/via-sdk-v03` is not on a registry yet;
development installs it from `vendor/`, and that tarball is the copy projects install by URL.

To release: bump `version` in `package.json` and `SDK_VERSION` in `src/mcp/client.ts` (a test
holds them equal), update the tag in the Install snippet above, add the release's entry to
[CHANGELOG.md](CHANGELOG.md), then tag the commit `v<version>`.

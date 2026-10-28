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
| **Keys** — `softwareKey`, `deviceSelfKey`, `custodialKey`, `attestedKey` | where the agent's key lives, and the evidence Humanos grades it on (v0.3 §16) |
| **`ViaGuard`** | the gate around every tool call: the mandate it presents, if any → challenge → proof of possession → verify → run or refuse → report the outcome |
| **`createViaMcpClient`** | the Humanos connector, authenticated with the organization's API key and signing secret |
| **`McpGuardVerifier`**, **`policyMandates`** | the connector as the guard's verifier, and the mandate each call presents, from the policy (`getPolicy`) and the mandates held (`getMandates`) |
| **`startViaMcpProxy`** | a governing proxy in front of MCP servers you did not write; `refresh()` declares their new tools |
| **`declareTools`** | tell Humanos which tools an agent can call, each as its server describes it, one call per service |
| **`startViaMcpServer`** | expose a guarded agent's tools to an MCP host |
| **`extractFromToolsList`**, **`importActionDraft`** | turn an existing tool surface into a draft action for the organization |
| **`@humanos/agent-sdk/testing`** | `createTestVerifier`: an in-process verifier for testing an agent offline |

## Install

Neither package is on a registry yet. Install both from this repository, pinned to a release tag:

```json
{
  "dependencies": {
    "@humanos/agent-sdk": "github:Humanos-App/agent-sdk#v0.3.0",
    "@humanos/via-sdk-v03": "https://raw.githubusercontent.com/Humanos-App/agent-sdk/v0.3.0/vendor/humanos-via-sdk-v03-0.6.2.tgz"
  }
}
```

npm clones the tagged commit and builds it (`prepare`), so a first install takes a few seconds
longer than a registry package. Requires Node.js 20 or later and `git`.

## Use

```ts
import { createViaMcpClient, McpGuardVerifier, policyMandates, ViaGuard, ViaDeniedError } from '@humanos/agent-sdk';

const client = createViaMcpClient({
  url: 'https://mcptest.humanos.tech/mcp', // Humanos staging
  apiKey: process.env.HUMANOS_API_KEY!,
  signatureSecret: process.env.HUMANOS_SIGNATURE_SECRET!,
});
await client.initialize();

// `agentKey` is the key the agent registered with; `did` is what registration returned.
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

### How a call is decided

The organization's policy decides first (v0.3 §21.3): a tool it allows runs, one it refuses is `policy_denied`, one
under a control's rules runs within them, and one it leaves to a person's mandate needs one. A tool it sets nothing
for gets its default, allowed or not. `agentDid` names the agent on every call.

`policyMandates` reads `get_policy` and `get_mandate` once, and presents a held mandate only for a tool the policy
leaves to one: one on the control the policy names first, else any covering the tool, a plain authorization
included. Every other call binds the policy alone. A `mandate_required` deny reads both again, and the guard
presents the call once more when a mandate now fits: a person has just granted one, or the policy changed. Nobody
is asked to confirm a call: one a policy or a mandate puts behind a step-up is refused `stepup_required`.

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

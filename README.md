# @humanos-ai/agent-sdk

Put an AI agent under its organization's **policy**, which decides each tool call: allowed, limited by a control's
rules, or refused. The agent holds its own key; every tool call is proved with it and verified by Humanos *before* the
tool runs, and every decision and outcome is written to a signed, hash-chained record.

The VIA protocol itself — credentials, events, verification — is
[`@humanos-ai/via-sdk`](https://github.com/Humanos-App/via-sdk), installed with it. This package is the
agent's side of the wire.

For complete, runnable agents built on it, see
[Humanos-App/agent-kit](https://github.com/Humanos-App/agent-kit).

## What is in it

| | |
|---|---|
| **Keys** — `storedSoftwareKey`, `softwareKeyFromJson`, `softwareKey`, `deviceSelfKey`, `custodialKey`, `attestedKey`, `humanosHoldsKey` | where the agent's key lives, and the evidence Humanos grades it on (v0.3 §16). `storedSoftwareKey` keeps the key in a file across restarts, `softwareKeyFromJson` reads that file's content from a variable where no file persists; `softwareKey` lasts only as long as the process; `humanosHoldsKey` has Humanos hold it |
| **`via`** | the agent's Humanos from its environment: the connector, the key (`HUMANOS_AGENT_KEY` or `.humanos/agent-key.json`), the DID, the guard and the tool registry, one per process |
| **`ViaGuard`** | the gate around every tool call: the mandate it presents, if any → challenge → proof of possession → verify → run or refuse → report the outcome. `check` and `settle` split it for a framework that runs the tool itself |
| **`createViaMcpClient`** | the Humanos connector, authenticated with an API key and its signing secret: the organization's, or an agent key issued for one agent |
| **`McpGuardVerifier`**, **`policyMandates`** | the connector as the guard's verifier, and the guard's mandate source, which reads only the policy (`getPolicy`) and presents no mandate: the policy decides each call alone |
| **`requestMandate`**, **`waitForMandate`** | ask a person for a mandate, under a control `getAction` describes or as a one-call authorization, and wait for their answer (`mandateStatus`); `policyMandates` does not present it ([Mandates](#mandates)) |
| **`startViaMcpProxy`** | a governing proxy in front of MCP servers you did not write; `refresh()` declares their new tools |
| **`@humanos-ai/agent-sdk/mcp`**, **`via().mcp`** | the connection wrapper: an MCP client transport with every `tools/list` declared and every `tools/call` checked, the proxy inside the agent's process; `routeStdio` puts a stdio server entry behind the proxy, which `humanos proxy` runs |
| **`registerAgent`** | register the agent's key with the organization, and optionally its tools; Humanos grades how the key is held and answers the agent's DID. With `humanosHoldsKey`, Humanos mints the key and holds it |
| **`declareTools`** | tell Humanos which tools an agent can call, each as its server describes it, one call per service |
| **`@humanos-ai/agent-sdk/ai-sdk`** — `aiSdk()` | Vercel AI SDK 5 and later (so Cloudflare Agents and OpenRouter as a provider): `guard(tools, service)` gives the `ToolSet` back with each `execute` verified first, and declares the tools with their JSON Schema |
| **`@humanos-ai/agent-sdk/claude-agent-sdk`** — `claudeAgentSdk()` | Claude Agent SDK: `gate()` gives the `PreToolUse` / `PostToolUse` hooks that check and settle every call, built-in tools included; `sdkServer` declares an in-process server's tools; `mcpServers` routes stdio servers behind the proxy. With no code, `humanos hook claude` runs the same hooks from `.claude/settings.json` |
| **`@humanos-ai/agent-sdk/langchain`** — `langchain()` | LangChain 1.x and LangGraph: `gate()` is `createAgent` middleware that checks every tool call and declares the agent's tools; `guard(tools, service)` for a graph's own `ToolNode`; `mcp.servers` / `mcp.tools` for `MultiServerMCPClient` |
| **`humanos`** (bin) | `init` (the framework, `.env`, registering, declaring `.mcp.json`, the interception; for Claude Agent SDK the hooks in `.claude/settings.json`, for the others the lines to add), `register`, `declare`, `status`, `restore` (every file `init` changed put back), and what hosts run: `hook claude`, `proxy` |
| **`ToolRegistry`** | every tool a process hands its adapters, declared as one list per service, again only when a service's list changes |
| **`startViaMcpServer`** | expose a guarded agent's tools to an MCP host |
| **`extractFromToolsList`**, **`importActionDraft`** | turn an existing tool surface into a draft action for the organization |
| **`@humanos-ai/agent-sdk/testing`** | `createTestVerifier`: an in-process verifier for testing an agent offline |

## Install

```
npm install @humanos-ai/agent-sdk
```

`@humanos-ai/via-sdk`, the VIA protocol, comes with it, pinned to the version this release was tested on.
Requires Node.js 22 or later. The framework adapters load their framework from the agent's own dependencies:
`ai` for `./ai-sdk`, `langchain` and `@langchain/core` for `./langchain`, `zod` for `./claude-agent-sdk`.

## Use

Setting it up in Claude Agent SDK, Vercel AI SDK, OpenRouter, LangChain, LangGraph or Cloudflare Agents, with
`npx humanos init`: [docs/SETUP.md](docs/SETUP.md).

```ts
import { createViaMcpClient, McpGuardVerifier, policyMandates, registerAgent, storedSoftwareKey, ViaGuard, ViaDeniedError } from '@humanos-ai/agent-sdk';

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
import { createViaMcpClient, humanosHoldsKey, McpGuardVerifier, policyMandates, registerAgent, ViaGuard } from '@humanos-ai/agent-sdk';

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

The organization's policy decides each call alone (v0.3 §21.3): a tool it allows runs, one it refuses is
`policy_denied`, and one under a control's rules runs within them and is refused over them. A tool it sets nothing for
gets its default, allowed or not. `agentDid` names the agent on every call.

The SDK reads no mandates. `policyMandates` reads `get_policy` once, keeps it, and presents no mandate: every call
binds the policy. It no longer calls `get_mandate`, which Humanos is removing; an agent on 0.4.3 or earlier still
calls it, and needs this release before Humanos removes it. Nobody is asked to confirm a call: one a policy puts
behind a step-up is refused `stepup_required`.

### Mandates

Humanos's Agents product has no mandates for now: Delegate, the access that left a tool to a person's mandate, is no
longer offered. If Humanos still refuses a call `mandate_required` (a policy that leaves the tool to a mandate), the
guard reads the policy again and presents no mandate: the call stays refused, and `ViaDeniedError.request` says what
the policy asked for. Give the tool another access in the policy. `requestMandate`, `waitForMandate`, `mandateStatus`
and `getAction` are still in the SDK, but a mandate they obtain is not presented by `policyMandates`.

## Govern MCP servers you did not write

```ts
import { createStdioTransport, startViaMcpProxy, connectUpstream, declareTools } from '@humanos-ai/agent-sdk';

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

Per call, the organization's policy decides alone: the proxy reads it at start and presents no mandate.

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
import { ViaGuard, softwareKey } from '@humanos-ai/agent-sdk';
import { createTestVerifier } from '@humanos-ai/agent-sdk/testing';

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

Every test tier, what it proves and how to run it: [docs/TESTING.md](docs/TESTING.md).

Requires Node.js 22 or later.

```
npm ci
npm run check-types
npm test
npm run build     # dist/: ES modules + type declarations
```

The framework tests run each adapter inside its real framework: the framework's own agent loop and Anthropic
provider against a scripted model server, a fake Humanos connector deciding on a test policy, and real MCP servers
(stdio and HTTP). Every framework passes the same contract (`test/frameworks/contract.ts`). Their frameworks are
devDependencies, except the heavy test-only ones (Claude Agent SDK's native engine, and wrangler with Cloudflare
Agents, which run a Worker in workerd): they install apart, so `npm ci` stays light:

```
(cd test/frameworks && npm ci)
npm run check-types:frameworks
npm run test:frameworks
```

The live tier runs the same drivers on a real model (Claude Haiku) against the dev platform, as one agent of a test
organization whose policy is set by hand. It needs `HUMANOS_LIVE_API_KEY`, `HUMANOS_LIVE_SIGNATURE_SECRET` and
`ANTHROPIC_API_KEY` (in the environment or `test/.env`), skips without them, and runs only by hand:
`npm run test:live`, or the `live` workflow.

`npm ci` also builds `dist/` (`prepare`).

To release: give the CHANGELOG's Unreleased section its version, then publish a GitHub Release from `main` with the tag
`v<version>`. The `release` workflow runs the whole CI, sets the version from the tag on its runner (the build writes it
into the client), and publishes to npm with the `NPM_TOKEN` secret. Nothing else publishes: not a push, a merge or a
tag alone.

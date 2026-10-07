# @humanos/agent-sdk

Put an AI agent under a **mandate**: a signed, bounded permission a person grants. The agent holds
its own key; every tool call is proved with it and verified by Humanos *before* the tool runs, and
every decision and outcome is written to a signed, hash-chained record.

The VIA protocol itself — credentials, events, verification — is
[`@humanos/via-sdk-v03`](https://github.com/Humanos-App), a peer dependency. This package is the
agent's side of the wire.

For complete, runnable agents built on it, see
[Humanos-App/agent-kit](https://github.com/Humanos-App/agent-kit).

## What is in it

| | |
|---|---|
| **Keys** — `softwareKey`, `deviceSelfKey`, `custodialKey`, `attestedKey` | where the agent's key lives, and the evidence Humanos grades it on (v0.3 §16) |
| **`ViaGuard`** | the gate around every tool call: challenge → proof of possession → verify → run, refuse, or wait for the person's approval (step-up) → report the outcome |
| **`createViaMcpClient`** | the Humanos connector, authenticated with the organization's API key and signing secret |
| **`McpGuardVerifier`**, **`getMandates`** | the connector as the guard's verifier, and "which mandates do I hold?" |
| **`startViaMcpProxy`** | a governing proxy in front of MCP servers you did not write |
| **`startViaMcpServer`** | expose a guarded agent's tools to an MCP host |
| **`extractFromToolsList`**, **`importActionDraft`** | turn an existing tool surface into a draft action for the organization |
| **`@humanos/agent-sdk/testing`** | `createTestVerifier`: an in-process verifier for testing an agent offline |

## Use

```ts
import { createViaMcpClient, McpGuardVerifier, getMandates, ViaGuard, ViaDeniedError } from '@humanos/agent-sdk';

const client = createViaMcpClient({
  url: 'https://mcptest.humanos.tech/mcp', // Humanos staging
  apiKey: process.env.HUMANOS_API_KEY!,
  signatureSecret: process.env.HUMANOS_SIGNATURE_SECRET!,
});
await client.initialize();

// `agentKey` is the key the agent registered with; `did` is what registration returned.
const [held] = await getMandates(client, did);
const guard = new ViaGuard({
  mandate: held.mandate,
  compiled: held.compiled,
  agentKey,
  verifier: new McpGuardVerifier(client),
});

try {
  const out = await guard.call('issue_refund', { order_id: 'A-1', amount_eur: 40 }, issueRefund);
  console.log(out.result);
} catch (e) {
  if (e instanceof ViaDeniedError) console.log(`blocked: ${e.reason}`); // the tool never ran
  else throw e;
}
```

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
const guard = new ViaGuard({ mandate: t.mandate, compiled: t.compiled, agentKey, verifier: t.verifier });
await guard.call('pay', { amount: 500 }, pay); // throws ViaDeniedError: rule_failed
```

## Develop

Requires Node.js 20 or later.

```
npm ci
npm run check-types
npm test
npm run build     # dist/: ES modules + type declarations
```

`@humanos/via-sdk-v03` is not on a registry yet; development installs it from `vendor/`.

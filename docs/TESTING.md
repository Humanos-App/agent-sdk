# Testing agent-sdk

Four tiers, from fast to real. **Unit** tests the SDK on its own. **Contract** runs every framework adapter inside its
real framework, against a scripted model and a fake Humanos. **Live** runs the same agents on a real model against a
real Humanos platform. **Walkthroughs** set up an agent from scratch, the way a developer does. Results on
2026-11-03: 211 unit, 89 contract (2 skipped), 24 live, 5 walkthroughs, all passing.

| Tier | Command | Needs | Proves |
| --- | --- | --- | --- |
| Unit | `npm test` | nothing | the guard, keys, connector client, MCP proxy and wrapper, adapters, CLI |
| Contract | `npm run test:frameworks` | `npm ci` in `test/frameworks` | each adapter in its framework's own agent loop and provider |
| Live | `npm run test:live` | a test organization's API key; a model key for a real model | the same agents against a real platform |
| Walkthrough | `npm run walkthrough -- <project> <command>` | as live | `npm install`, `humanos-agent init`, the printed lines, a real agent |

## Unit (`npm test`)

No infrastructure, no keys, about 1 s. `test/*.spec.ts`:

| Area | Files | Tests |
| --- | --- | --- |
| The guard: check, settle, the offline verifier, outcomes | `guard`, `guard-check`, `testing`, `events` | 45 |
| Keys and registration | `key-provider`, `stored-key`, `register`, `via` | 34 |
| The Humanos connector | `via-mcp-client`, `mcp-guard-verifier`, `mandate-request`, `declare`, `tool-registry` | 55 |
| MCP: the proxy, the proxy command, the connection wrapper (a real MCP SDK client and server) | `proxy`, `proxy-command`, `mcp-transport` | 43 |
| Framework adapters | `ai-sdk-adapter`, `claude-agent-sdk-adapter`, `langchain-adapter` | 11 |
| The CLI on throwaway projects: `init`, `restore`, `register`, `declare`, `status` | `cli` | 10 |
| Drafting an action from existing tools | `extract`, `import-action` | 13 |

## Contract (`npm run test:frameworks`)

Every adapter in its real framework: the framework's own agent loop, its real model provider and real HTTP. Only the
model's choices are scripted.

- **The scripted model** (`test/harness/model-server.ts`) speaks Anthropic's Messages API and the OpenAI-compatible
  Chat Completions API (OpenRouter's), streamed and plain, and keeps every request.
- **The fake Humanos** (`test/harness/connector.ts`) answers the connector's tools on `createTestVerifier`, in process
  and on HTTP with the request signature checked, so agents in another process (the proxy, a hook) are covered too.
- **Real MCP servers** (`test/harness/mcp-servers.ts`), built with the official MCP SDK, over stdio and HTTP.

Every driver runs the same scenarios (`test/frameworks/contract.ts`):

| Scenario | Passes when |
| --- | --- |
| Declare | each tool is declared once per service, with its JSON Schema |
| Allow | the tool runs, its outcome is reported, and the model gets its result |
| Deny | the tool never runs, nothing is reported, and the model is told why |
| Tool error | the outcome is reported as failed |
| Delegate | refused `mandate_required` while no mandate covers it |
| Parallel calls | two calls in one step each get their own decision and outcome |
| Humanos unreachable | the tool never runs (fail closed) |
| MCP over stdio, routed | each call checked once; the refused one never reaches the server |
| MCP over HTTP | each call checked once; with the connection wrapper the call proof reaches the server |

| Driver | File | Tests |
| --- | --- | --- |
| An agent written straight on `@anthropic-ai/sdk` | `custom.test.ts` | 9 |
| Vercel AI SDK, `generateText` and `streamText` | `ai-sdk.test.ts` | 18 |
| OpenRouter through AI SDK, on its own wire | `openrouter.test.ts` | 18 |
| LangChain `createAgent`, and a LangGraph `ToolNode` graph | `langchain.test.ts` | 18 |
| Claude Agent SDK, hooks in code and no code; built-in `Bash` | `claude-agent-sdk.test.ts` | 18, 2 skipped |
| Cloudflare Agents: an `Agent` in workerd (wrangler) | `cloudflare.test.ts` | 6 |
| The live tier's preflight | `live-preflight.test.ts` | 2 |

The two skips are the no-code Claude agent's declaration scenarios: with no Humanos code it declares nothing itself
(`humanos-agent declare` and the platform's observed tools do). A framework that rethrows a tool's error out of the run
(LangChain's `createAgent`) passes the tool error scenario when the failure is reported.

**Versions.** CI runs the contract at the lockfiles' versions and at each adapter's lowest:

| Row | AI SDK | OpenRouter provider | LangChain | Claude Agent SDK |
| --- | --- | --- | --- | --- |
| latest | 7 | 3 | 1.6 | 0.3.317 |
| lowest | 5.0.0 | 1.0.0 | 1.0.1 (core 1.0.1) | 0.3.142 |
| ai-sdk-6 | 6.0.0 | 2.10.0 | latest | latest |

Heavy test-only packages (Claude Agent SDK's native engine, wrangler and Cloudflare Agents) install in
`test/frameworks/package.json`, apart from the package's own devDependencies.

## Live (`npm run test:live`)

The contract's drivers on a real model against a real platform, as one agent of a test organization. Credentials go in
`test/.env` (git-ignored); the tier skips without them.

```env
HUMANOS_LIVE_API_KEY=<the test organization's API Key>
HUMANOS_LIVE_SIGNATURE_SECRET=<its Signature Secret>
HUMANOS_LIVE_MCP_URL=<the connector to test against; default: dev>
ANTHROPIC_API_KEY=<a real model; without it the scripted model plays it>
OPENROUTER_API_KEY=<the OpenRouter driver on a real model>
```

The first run registers the test agent (its key is kept in `test/live/.humanos/<connector host>/`), declares three
tools under "Support desk (live test)", and fails on purpose, naming what to set in the dashboard: `lookup_order`
Allow, `issue_refund` Deny, `approve_discount` Restrict with a control keeping `percent` under 10. Then each of custom,
AI SDK, LangChain, LangGraph, Claude Agent SDK and OpenRouter runs four cases:

| Case | Passes when |
| --- | --- |
| Allow | `lookup_order` runs and the platform records its outcome |
| Deny | `issue_refund` never runs |
| Restrict, 5% | `approve_discount` runs and its outcome is recorded |
| Restrict, 15% | `approve_discount` never runs; refused `policy_denied` |

What the platform answered is read from the connector calls the agent made. The dashboard's audit trail is the
person's check. The `live` GitHub workflow runs the tier by hand only, with the same variables as secrets.

## Walkthroughs (`npm run walkthrough`)

A new project per framework installs agent-sdk and runs `humanos-agent init`; the agent's code is the lines `init`
prints. `npm run walkthrough -- <project> <command>` runs a command there with the test credentials, never showing
them; `npm run walkthrough -- --dev-vars <worker project>` writes a Worker's `.dev.vars`.

| Framework | Checked |
| --- | --- |
| Claude Agent SDK, no code | `init` writes the hooks; `Bash` and `Write` allowed and recorded; `Write` set to Deny is refused; `restore` |
| AI SDK, LangChain, OpenRouter, Cloudflare Agents | `init` registers and prints the lines; with the agent's policy set, the refund and the 15% discount never run, the 5% runs; `restore` |

A new agent's tools start at the policy's default: the policy is set per agent.

## CI

- `ci.yml`, on every push to `main` and every pull request: the unit tests on Node 22 and 24, and the contract in the
  three version rows.
- `live.yml`: the live tier, by hand only.
- `release.yml`: only a GitHub Release a person publishes. It runs `ci.yml` and then publishes to npm.

## Not covered yet

- MCP against a real platform: the contract covers it against the fake Humanos only.
- A mandate a person grants, then the call running: the contract covers the refusal only.
- Cloudflare Agents against a real platform (its connector calls happen in the Worker), MCP inside a Worker, the
  `AIChatAgent` chat path, a deployed Worker.
- The no-code Claude agent's decisions read back automatically (the walkthrough checks them by hand).
- `observe` mode through the adapters; `declare --entry` for LangChain; the interactive `init` prompt in a terminal.
- Remote MCP servers that need OAuth; Python; frameworks beyond these.

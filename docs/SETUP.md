# Setting up Humanos in your agent

Install the SDK, put your API key in `.env`, and run `npx humanos init`. From then on every tool call your
agent makes is checked by Humanos before it runs, and recorded. Until you set the agent's policy every call is allowed;
once you set it, it is enforced. Claude Agent SDK needs no code; the other frameworks need two lines, which `init`
prints.

| Framework | What you add |
| --- | --- |
| [Claude Agent SDK](#claude-agent-sdk) | nothing: `init` writes the hooks into `.claude/settings.json` |
| [Vercel AI SDK](#vercel-ai-sdk) | `humanos.guard(tools, service)` around your tools |
| [OpenRouter](#openrouter) | the same, with OpenRouter's AI SDK provider |
| [LangChain and LangGraph](#langchain-and-langgraph) | `humanos.gate()` as middleware, or `humanos.guard(tools, service)` |
| [Cloudflare Agents](#cloudflare-agents) | the AI SDK lines, and the Worker's secrets |
| [Any other framework](#any-other-framework) | `guard.call` around each tool |

## 1. Install

```bash
npm install @humanos-ai/agent-sdk @humanos-ai/via-sdk
```

Node.js 22 or later. `@humanos-ai/via-sdk` is the VIA protocol, a peer of the SDK.

## 2. Your API key

In the [Humanos dashboard](https://app.humanos.tech), open **API Keys** and create a key. Copy the API Key and the
Signature Secret (the secret is shown once) into your project's `.env`:

```env
HUMANOS_API_KEY=<your API Key>
HUMANOS_SIGNATURE_SECRET=<your Signature Secret>
```

## 3. `npx humanos init`

Run it in the project where you installed the SDK: `npx humanos` is the `humanos` command the SDK installs. (Before
installing, `npx -p @humanos-ai/agent-sdk humanos init` works too; a bare `npx humanos` there would fetch the REST
SDK package named `humanos`, which has no command.)

`init` finds your framework in `package.json` (it asks when it finds more than one), then:

- **registers your agent**: it creates the agent's key in `.humanos/agent-key.json` and registers it. The key is the
  agent: keep it, back it up, and never commit it (`init` adds `.humanos/` to `.gitignore`). A new key is a new agent.
- **declares the tools** of the MCP servers in `.mcp.json`, when there is one;
- **sets up the checks**: for Claude Agent SDK it writes the hooks; for the others it prints the lines to add.

`npx humanos restore` undoes every file change `init` made; the key stays. `npx humanos status` shows the
agent and each tool's access. `npx humanos help` lists every command, with examples.

## 4. Add the lines for your framework

Each adapter declares your tools to Humanos, with their schemas, under the `service` you name ("Support desk",
"Billing"), and checks every call before it runs. A refused call never reaches the tool: the model gets the refusal as
the tool's result, with the reason, and is told not to retry. If Humanos cannot be reached, the call is refused too.

### Claude Agent SDK

Nothing to add. `init` writes `PreToolUse`, `PostToolUse` and `PostToolUseFailure` hooks into
`.claude/settings.json`, which the SDK loads by default. Every call is checked, the SDK's built-in tools (`Bash`,
`Write`, `Edit`, …) as well as your MCP servers'. Built-in tools appear in the dashboard the first time they are
called, ready for you to set their access.

If your agent passes `settingSources: []`, add the hooks in code:

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import { claudeAgentSdk } from '@humanos-ai/agent-sdk/claude-agent-sdk';

const humanos = await claudeAgentSdk();
for await (const message of query({ prompt, options: { hooks: humanos.gate() } })) {
  // …
}
```

`gate(existing)` keeps hooks of your own. For tools in an in-process server, `sdkServer` declares them with their
schemas: `createSdkMcpServer(humanos.sdkServer({ name: 'support', tools }, 'Support desk'))`.

### Vercel AI SDK

```ts
import { aiSdk } from '@humanos-ai/agent-sdk/ai-sdk';

const humanos = await aiSdk();

await generateText({ model, tools: humanos.guard(tools, 'Support desk'), prompt }); // or streamText, ToolLoopAgent
```

`guard` gives your `ToolSet` back with each `execute` checked first. AI SDK 5 and later.

MCP servers through `@ai-sdk/mcp`: guard their tools the same way, `humanos.guard(await client.tools(), 'Linear')`. To
have each call to a remote server carry Humanos's call proof, wrap the connection instead:

```ts
import { experimental_createMCPClient as createMCPClient } from '@ai-sdk/mcp';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = await createMCPClient({
  transport: humanos.via.mcp.transport('Linear', new StreamableHTTPClientTransport(new URL(url)), { origin: 'https://mcp.linear.app' }),
});
```

### OpenRouter

OpenRouter runs through AI SDK's provider, so the lines are the AI SDK's:

```ts
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { aiSdk } from '@humanos-ai/agent-sdk/ai-sdk';

const humanos = await aiSdk();
const model = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })('anthropic/claude-haiku-5.5');

await generateText({ model, tools: humanos.guard(tools, 'Support desk'), prompt });
```

Any OpenRouter model works: Humanos checks the tool calls, whichever model makes them.

### LangChain and LangGraph

With `createAgent`, Humanos is middleware:

```ts
import { langchain } from '@humanos-ai/agent-sdk/langchain';

const humanos = await langchain();
const agent = createAgent({ model, tools, middleware: [humanos.gate({ service: 'Support desk' })] });
```

`gate` checks every tool call, those the agent loaded from MCP servers included, and declares the agent's tools on its
first model call. LangChain 1.x.

In a LangGraph graph of your own, guard the tools you give your `ToolNode`:

```ts
const tools = humanos.guard([lookupOrder, issueRefund], 'Support desk');
graph.addNode('tools', new ToolNode(tools));
```

MCP servers through `@langchain/mcp-adapters`: pass the client's servers through `humanos.mcp.servers(...)` and read
its tools with `humanos.mcp.tools(client)`, so each tool is checked under its server, by its own name:

```ts
const client = new MultiServerMCPClient({ mcpServers: humanos.mcp.servers({ linear: { transport: 'http', url } }) });
const tools = await humanos.mcp.tools(client);
```

### Cloudflare Agents

An agent on Cloudflare Agents runs AI SDK, so the lines are the AI SDK's, inside your `Agent`:

```ts
import { aiSdk } from '@humanos-ai/agent-sdk/ai-sdk';

export class SupportAgent extends Agent<Env> {
  async onRequest(request: Request) {
    const humanos = await aiSdk();
    const { text } = await generateText({ model, tools: humanos.guard(tools, 'Support desk'), prompt });
    return Response.json({ text });
  }
}
```

A Worker has no disk and no `.env`, so give it three secrets:

| Secret | Value |
| --- | --- |
| `HUMANOS_API_KEY` | your API Key |
| `HUMANOS_SIGNATURE_SECRET` | its Signature Secret |
| `HUMANOS_AGENT_KEY` | the content of `.humanos/agent-key.json`, which `init` created: the same agent on every deploy |

Locally, put them in `.dev.vars` (git-ignored); deployed, set each with `npx wrangler secret put <NAME>`. Keep the
`nodejs_compat` compatibility flag on, with a recent compatibility date (the SDK is tested with `2026-10-01`): together
they put the secrets in `process.env`, where the SDK reads them.

### Any other framework

Any agent that runs its own tools can use the core: declare the tools once, and run each call through the guard.

```ts
import { via } from '@humanos-ai/agent-sdk';

const humanos = await via();
await humanos.tools.add([{ name: 'issue_refund', description: 'Refund an order.', inputSchema, service: 'Support desk' }]);

const { result } = await humanos.guard.call('issue_refund', args, (a) => issueRefund(a)); // throws ViaDeniedError when refused
```

## 5. Set the agent's policy

In the dashboard, open **Agents**, then **Policy**, and choose an access for each of the agent's tools:

| Access | The call |
| --- | --- |
| **Allow** | runs |
| **Restrict** | runs within the rules of a control you add (for example, a discount under 10%), and is refused over them |
| **Delegate** | runs only under a mandate a person grants (see the README's mandate section) |
| **Deny** | never runs |

The policy is the agent's own: a new agent starts with every tool at the default, which allows it. Every call, allowed
or refused, is in the agent's audit trail.

## Environment

| Variable | Where | What it is |
| --- | --- | --- |
| `HUMANOS_API_KEY`, `HUMANOS_SIGNATURE_SECRET` | `.env`, or a Worker's secrets | your API key and its secret |
| `HUMANOS_AGENT_KEY` | a Worker's secrets, or any deploy with no disk | the agent's key: the content of `.humanos/agent-key.json` |
| `HUMANOS_DIR` | optional | where the agent's key file lives (default `.humanos` in the project) |

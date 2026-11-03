# Changelog

## Unreleased

- `ViaGuard.check(tool, args)` and `ViaGuard.settle(checked, { error? })`: `call` in two halves, for a framework that
  decides a call in one hook and runs the tool itself. `settle` takes the check or its plain `decisionId` and
  `mandateId`, so a hook in another process can report. `call` is now `check`, run, `settle`, unchanged.
- `via(options?)`: the agent's Humanos from its environment (`HUMANOS_API_KEY`, `HUMANOS_SIGNATURE_SECRET`,
  `HUMANOS_MCP_URL`, `HUMANOS_AGENT_KEY`, `HUMANOS_DIR`, over the working directory's `.env`): the connector, the key,
  the DID (registering the key when it has none), the guard and the tool registry. One per process without options.
- `softwareKeyFromJson(json)`: `storedSoftwareKey`'s key from the key file's content, for an agent with no disk.
- `@humanos/agent-sdk/mcp` and `via().mcp`: `transport(service, inner, { origin? })` wraps an MCP client transport
  (AI SDK's `MCPTransport`, the MCP SDK's `Transport`). Each `tools/list` answer is declared under `service`; each
  `tools/call` is checked before it is sent. A refused call never leaves the process, and the framework gets the
  proxy's refusal text as the tool's result. An allowed one carries the call proof in `_meta` (for an `https`
  origin) and is settled when the server answers. `checks(service, tool)` and `runChecked(fn)` keep a call
  checked once when a framework hook also sees it.
- `routeStdio(spec)` and `humanos-agent proxy --service <name> -- <command> <args…>`: a stdio server entry behind
  the governing proxy, as the project's own agent (`via()`). The package now has a `bin`.
- `McpServerSpec`: the one type an MCP server is named with; `UpstreamSpec` stays as its alias. The proxy's refusal
  text moved to `refusalText`, shared with the connection wrapper.
- `@humanos/agent-sdk/ai-sdk`: `aiSdk(via?)`. `guard(tools, service)` hands a `ToolSet` back with each `execute`
  checked, run and settled (a refusal throws, and AI SDK gives the model the error); it declares the tools, their
  schemas through AI SDK's `asSchema`. A tool with no `execute`, or one a wrapped connection or routed service
  checks, is left as it is. `ai` is an optional peer (>=5). Passes the contract through `generateText` and
  `streamText`, with MCP over `@ai-sdk/mcp`.
- `@humanos/agent-sdk/claude-agent-sdk`: `claudeAgentSdk(via?)`. `gate(existing?)` gives `PreToolUse` (check;
  refuse with the reason, or say nothing so the agent's own permissions decide; `onFailure: 'block'`),
  `PostToolUse` and `PostToolUseFailure` (settle), ahead of the agent's own hooks. An MCP tool
  (`mcp__<server>__<tool>`) is checked as `<tool>` under its server's service, a built-in tool under
  `Claude Agent SDK`. `sdkServer(options, service?)` declares an in-process server's tools (zod shapes as JSON
  Schema); `mcpServers(servers)` routes stdio entries behind the proxy. `zod` is an optional peer.
- `@humanos/agent-sdk/langchain`: `langchain(via?)`. `gate({ service? })` is `createAgent` middleware:
  `wrapToolCall` checks each call (a refusal is an error `ToolMessage`; Humanos unreachable refuses) and settles it
  from the `ToolMessage` the tool answered; `wrapModelCall` declares the agent's tools on its first model call.
  `guard(tools, service)` wraps tools for a LangGraph `ToolNode`. `mcp.servers` routes `MultiServerMCPClient`'s stdio
  servers behind the proxy; `mcp.tools(client)` records each tool's server and the MCP tool's own name (the client
  prefixes `<server>_`), which is the name checked. `langchain` and `@langchain/core` are optional peers.
- `humanos-agent hook claude`: the same hooks as a command, for `.claude/settings.json` (the SDK loads it by
  default), so an agent with no Humanos code is governed. The decision waits in `.humanos/pending/` between the two
  hook processes. It fails closed: a `PreToolUse` it cannot check answers deny.
- `via().mcp.route(spec, via?)` remembers the service it routed, and `checks` answers true for its tools.
- `via({ cwd })`: the project `.env` and `.humanos` are read from.
- Framework tests (`npm run test:frameworks`, a CI job of its own): a scripted Anthropic model server, a fake
  connector on `createTestVerifier` (in process, and on HTTP with the request signature checked), the support desk's
  MCP server over stdio and HTTP, and the contract every framework driver must pass. The first driver is an agent
  written straight on `@anthropic-ai/sdk`, through `via()`, the guard and `via().mcp`.
- `ToolRegistry`: declares every tool added, as one list per service, so tool sets of one service added apart do
  not replace each other on the platform.

## 0.4.2

The version stays on 0.4.x until the spec has a new version.

- `registerAgent(client, key, { tools? })`: the connector's `register_challenge` and `register`, the key's evidence
  bound to the nonce; answers the agent's DID, the rung Humanos granted, and `existing` for a key already registered.
  `tools` records the agent's tools with the registration, as `declareTools` would (at most `DECLARE_TOOLS_MAX`).
- `storedSoftwareKey(file)`: `softwareKey`'s rung for an agent that restarts. The key lives in a file only its owner
  can read, created on the first run and loaded after, so the agent keeps its DID and its mandates (until Humanos has
  key rotation, v0.3 §16.5, a new key is a new agent). The file is the one agent-kit's `lib/stored-key.ts` writes.

## 0.4.1

- The client names its own version in `clientInfo` again: 0.4.0 reported `0.3.0`.

## 0.4.0: the call proof

Needs a Humanos platform whose verify takes `audience` (v0.3 §16.16). Bundles sdk-v03 0.8.0, which agents and the
servers they call share as a peer (`^0.8.0`).

**New**

- The proxy names a remote `https` server's origin as each call's receiver, and sends the call proof an `allow`
  carries with the call: both tokens in `_meta` and in the `Humanos-Call-Proof` / `Humanos-Agent-Record` headers.
  `callProofExtra(outcome)` builds that part for a `decorateCall` of your own.
- `ViaGuard.call` takes `{ audience }`; `VerifyInput.audience` and `VerifyOutcome.callProof`. An upstream reached
  over HTTP records its `origin`.

## 0.3.0: the policy first

Needs a Humanos platform whose verify decides on the organization's policy first and names the agent on every call;
0.2.x mandate calls are refused there. The bundled protocol SDK is unchanged (sdk-v03 0.6.2).

**Breaking**

- `GuardVerifier` is three methods, each naming the agent and what the proof binds (`CallAuthority`: `mandateId`
  or, with none, `policy`): `challenge({ agentDid, mandateId? })`, which may answer `{ refused }`, `verify` and
  `reportOutcome`. `challengeUnderPolicy`, `verifyUnderPolicy`, `reportOutcomeUnderPolicy`, `PolicyChallengeGrant`,
  `PolicyVerifyInput` and `PolicyReportOutcomeInput` are gone; `VerifyInput` and `ReportOutcomeInput` carry the
  mandate's id, not the mandate. `ChallengeGrant` names the `policy`.
- `ViaGuard` needs `agentDid`. One guard per agent: `mandates` chooses each call's mandate; `mandate` (with
  `compiled`) presents one on every call, for a verifier with no policy.
- No step-up: `VerifyOutcome.decision` is `allow` or `deny`. Removed: `onRechallenge`, `call`'s `stepUpId`,
  `VerifyInput.stepUpSatisfied` and `stepUpId`, `StepUpRef`, `ViaStepUpPendingError`, the proxy's `onStepUp`,
  `startViaMcpServer`'s `onStepUp` and `sendRequest`, `MiniPlatformClient.requestStepUp` and `stepUpStatus`, and
  `createTestVerifier`'s `stepUpTools`, `approveStepUp` and `onRechallenge`.
- The proxy runs one guard and presents a mandate only for a tool the policy leaves to one. `policy: false` and
  `mandateRefreshMs` are gone; `mandateFor` takes `(tool, held, preferred)`; `refreshMandates()` reads the policy
  too.
- `getMandates` returns `GuardMandate[]`.

**New**

- `policyMandates(client, did)`, the guard's `MandateSource` on the connector's `get_policy` and `get_mandate`: a
  held mandate only for a tool the policy leaves to one, on the control it names first. A `mandate_required` deny
  reads both again, and the guard presents the call once more when a mandate now fits.
- `getPolicy(client, did)`, with `AgentPolicy` and `ToolAccess`; `coveringMandate` and `mandateCoverage`, the
  ranking `pickMandate` uses.
- `VerifyOutcome.unset`: the policy's default decided (an allow so decided has `enforcement: "none"`).
- `mandateId` on `GuardCallOutcome`, `GuardCallContext` and `ViaDeniedError`: the mandate the call presented.
- `createTestVerifier` takes a `policy` (each tool `allow`, `deny` or `mandate`, and a `default`) that decides first;
  its challenge then names `TEST_POLICY`.
- Asking a person for a mandate: `getAction` (a control's limits, the connector's `get_action`), `requestMandate`
  (a guardrail under a control, or an authorization for one call ending in an hour by default), `mandateStatus`, and
  `waitForMandate` (until the person decides, the consent link expires or ten minutes pass, or an abort).
- `ViaDeniedError.request` and `GuardCallOutcome.request` on `mandate_required`: what to ask for, the controls the deny
  names, else `get_policy`'s `request` (`AgentPolicy.tools[].request`, `MandateSource.requestFor`). The proxy says it.

## 0.2.1

- The bundled protocol SDK is sdk-v03 0.6.2 (the README's Install snippet): the same API, built with
  `@peculiar/x509` 2, tsup 9 and `@sd-jwt` 0.23. The peer range stays `^0.6.1`.
- `mintNitroCa` and `buildCoseAttestation` come from its `agent/sim` entry, which now loads the
  `reflect-metadata` polyfill that x509 2 needs, so importing the SDK installs the Reflect metadata API.

## 0.2.0 — the organization's policy

Install `@humanos/via-sdk-v03` 0.6.1 with it (the Install snippet in the README): the peer range is `^0.6.1`.

**Breaking**

- `@humanos/via-sdk-v03` `^0.6.1`, up from `^0.3.1`: the guard proves a call with no mandate with `policyActionHash`
  (0.4), and builds an outcome report's params with the VIA SDK's `outcomeParams` (0.6).
- `ChallengeGrant` is `{ nonce, aud, ttl, iat }` (v0.3 §16.11), as the connector answers: `ttl` is the nonce's life in
  seconds from `iat`, in place of `ttlMs`. A `GuardVerifier` of your own answers the new shape.
- `ViaMcpProxyConfig.decorateCall` — `ctx.mandateId` is optional: a call no mandate covers runs on the
  organization's policy, and has none.
- The proxy no longer refuses a call no mandate covers on its own: it verifies it on the organization's policy
  (v0.3 §21.4), which may allow it. `policy: false` keeps the old refusal.

**New**

- A call with no mandate (v0.3 §21.4). `ViaGuard` without `mandate` (and `compiled`) verifies every call on the
  organization's policy, its proof bound to `{ policy, action, params }`, and reports outcomes there; `agentDid`
  names the agent for a credential that is not its own. `GuardVerifier` gains three optional methods for it —
  `challengeUnderPolicy`, `verifyUnderPolicy`, `reportOutcomeUnderPolicy` — which `McpGuardVerifier` implements on
  the connector's `challenge`, `verify` and `report_outcome`; a verifier without them verifies mandates only, and a
  guard with no mandate refuses it.
- The proxy picks a mandate by its action's `tools` (v0.3 §0.6.1): an action that lists the tool is an exact match,
  one that lists others never matches (Humanos would refuse the tool `tool_not_covered`).
- New deny reasons in words (`defaultPlainReason`): `tool_not_covered`, `required_param_missing`, `policy_denied`,
  `mandate_required`, `stepup_required`.
- `VerifyOutcome` carries `enforcement` and `policyDigest`; `StepUpRef` carries `trigger: "policy"` for a step-up
  the organization's approvers decide in the dashboard, whose `approveLink` is that page.
- A `mandate_required` deny may name the actions the policy needs the mandate to be under (v0.3 §21.3):
  `VerifyOutcome.under`, `ViaDeniedError.under` and, in `observe`, `GuardCallOutcome.under`. The proxy tells the
  agent to ask the person for a mandate under one of them, a call under another mandate included.
- `createTestVerifier` takes the action version's `constants` (v0.3 §0.6.1), which its rules read as
  `constants.<name>`.
- `outcomeParams` and `AgentOutcomeKind` are the VIA SDK's own, re-exported under the same names.

## 0.1.3

- The proxy declares each tool to Humanos as its server describes it, and new tools on `refresh` (HUM-609).
- Every key provider proves its key is held when it registers (`registrationProof`; v0.3 §16.5): the platform
  refuses evidence without it.
- `importActionDraft` posts to the moved route, falling back to the old one.
- The bundled protocol SDK followed sdk-v03 0.3.1 → 0.3.5 (the v0.3 event structure, datetimes per §0.6.3).

## 0.1.2

- Installable straight from this repository.

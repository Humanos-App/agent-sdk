# The context layer in agent-sdk — plan

**Status:** draft, 2026-11-06; nothing built. Personal data in what a model reads is replaced by tokens (`⟦EMAIL_1⟧`)
before the call and filled back after it — into a tool's arguments only where the organization's policy lets that tool
receive that kind. The protocol is via-protocol's v0.4 §14 (`spec/via-protocol-spec-v0.4.md`, cited as "§14.N"), the
product design `spec/v04-context-brief.md` ("brief §N"), the decisions of 2026-11-06 `spec/DECISIONS-v0.4.md`; the
platform's side is its `docs/PLANS/v04-context-layer.md`.

agent-sdk owns the engine; the platform imports it for the hosted and router modes, so the four modes (§14)
cannot drift apart.

## The engine — `@humanos-ai/agent-sdk/context`

Pure TypeScript, no network: the platform calls it too, supplying what only it has (known-person values, the free-text
model, its store).

```ts
const layer = await via.context({ conversation: 'c-7f3' });   // the policy's `context` and `fill`; known-person hashes
const outbound = await layer.replace(request);                 // before the model call: escape, detect, replace, second pass
const text = layer.fillText(answerText);                       // the model's text, for the person
const call = layer.fillCall('credit.accept', args);            // { args, filled: {param: kind}, refused: [...] }
const entry = layer.entry({ model, sent, received, proposed: [call], refused });   // §14.6, chained
```

| File | What it does | Where |
|---|---|---|
| `src/context/tokens.ts` | the token form (via-sdk's parser), escaping `⟦ ⟧`, the system-prompt line | §14.4 |
| `src/context/detect/structured.ts` | email, phone (`libphonenumber-js`), IBAN, card, IP, national ids beside their word, keys naming a kind | brief §4.2 |
| `src/context/detect/known.ts` | keyed hashes from `context_known`, matched against candidate spans | brief §4.2 |
| `src/context/detect/index.ts` | the detector interface (the platform plugs in its free-text model), merging, normal forms | brief §4.3 |
| `src/context/store.ts` | `MemoryStore`; a `ContextStore` interface for Redis or a file; values encrypted under the conversation's key | brief §5 |
| `src/context/fill.ts` | the fill rule from capabilities' `personalData` and entries' `fill`; whole value, in place, parts | §14.5, brief §6 |
| `src/context/stream.ts` | holding output from `⟦` until `⟧` or 64 characters | brief §6 |
| `src/context/statement.ts` | entries — digests before and after, keyed where they cover a value; value leaves under a Merkle root — their chain, and a statement signed with the instance key | §14.6, §14.7 |

- **No conversation id:** the map is built afresh from the whole history on each call — numbering by first appearance
  stays stable while the history only grows — and entries are not chained.
- **The context key** for the keyed digests is the agent's own, from its key provider; it never leaves the agent.
  The statement it signs is the agent's claim, not proof: a party that needs proof requires hosted mode (§14.7).
- **The policy** comes from `get_policy`, as the proxy reads it today; its `context` absent, `replace` is the identity.

## Adapters

- **AI SDK** (`src/adapters/ai-sdk.ts`): `humanos.model(model)` returns
  `wrapLanguageModel({ model, middleware })`. `transformParams` replaces the prompt; `wrapGenerate` and `wrapStream`
  fill the text and the tool calls' `input` before AI SDK runs `execute`, so `guard`'s `execute` gets real values.
- **LangChain** (`src/adapters/langchain.ts`): `wrapModelCall`, which today only declares tools, also replaces
  `request.messages` and fills the answer's `tool_calls`.
- **Gateway** (`src/cli/gateway.ts`, new): `humanos gateway --port 4100 --upstream <provider URL>`, serving
  Anthropic's `/v1/messages` and OpenAI's `/v1/chat/completions`, streamed; the conversation from the
  `x-humanos-conversation` header. Claude Agent SDK and Claude Code use it through `ANTHROPIC_BASE_URL`: their hooks
  rewrite a tool's input, not the user's prompt or a file the model reads.
- **Governing proxy** (`src/mcp/proxy.ts`), later: replacing personal data in upstream servers' results when its client
  is a host agent-sdk does not run (Claude Desktop on a local stdio proxy).

## The guard

- A filled call goes to `verify` with `context: { conversation, seq, entry }` (§14.8), so its record names the
  model call that proposed it and the kinds filled.
- A call still carrying a token goes to `verify` as is: Humanos refuses it `token_unfilled`, and the guard's refusal
  message carries the reason.

## Phase 1 — the first slice (decided)

1. **Types from via-sdk** — the kinds, `personalData`, `context` and `fill`, the token parser, the entry and statement
   types, `token_unfilled` — from sdk-v04's release, pinned. _Test:_ the barrel exports them.
2. **Tokens and escaping** (`tokens.ts`). _Test:_ a forged `⟦EMAIL_1⟧` in a tool result reaches the model as
   `[EMAIL_1]`; a hint is ignored on fill.
3. **Structured detection** (`structured.ts`). _Test:_ PT and EN fixtures — a valid and an invalid NIF, IBAN and card; a
   9-digit order number with no word beside it left alone; a JSON `email` field found.
4. **Known people** (`known.ts`) over `context_known`. _Test:_ "Maria Silva" matched by hash; "Maria" alone matched only
   after the full name.
5. **Store and determinism** (`store.ts`). _Test:_ the same history gives the same tokens; an appended history keeps
   them; no value is in the clear in the store.
6. **The fill rule** (`fill.ts`). _Test:_ `borrower_contact` filled from the capability; `web_fetch`'s `url` refused; an
   entry narrowing a capability; a token from another conversation left.
7. **The second pass and entries** (`statement.ts`). _Test:_ a value a detector missed in one writing is caught and
   counted in `residual`; `input`, `output`, `args` and leaves are keyed and `sent` is plain; replaying a conversation
   from its first call gives each `sent` again; entries chain; the statement verifies against the instance key.
8. **AI SDK middleware.** _Test:_ with a mock model, `generateText` and `streamText` end to end — the model sees tokens,
   `execute` gets the email, a refused fill reaches `verify` and comes back `token_unfilled`.

Later: the gateway, LangChain, the proxy's results, a local free-text model.

## Open

- **Where entries live:** with the agent, or sent to Humanos for the dashboard and a reader (§14.10).
- **The engine's home:** this export, or a package of its own if the platform should not depend on agent-sdk.
- **Phone parsing's default region:** the organization's country, or a hint on the policy.

# Changelog

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

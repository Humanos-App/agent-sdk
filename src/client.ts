/**
 * The agent-side platform client — `@humanos/agent-sdk`'s HTTP transport: join
 * (actor genesis), guardrail extraction, mandate issuance, the `GuardVerifier`
 * transport (so the UNCHANGED `ViaGuard` runs over HTTP), actor lifecycle ops
 * (rotate/renew — v0.3), and sub-agent delegation.
 *
 * The agent's private key lives in its KEY PROVIDER and never crosses the wire —
 * the platform sees public JWKs, signed evidence, and per-call PoPs only (§16.6).
 * The HTTP surface here is the mini-platform's today; the real Humanos endpoints
 * (P-A…P-E) drop in behind the same methods.
 */
import { actionHash, cleanPublicJwk, jwkThumbprint } from './sdk.js';
import type { ActorSnapshot, BoundKey, ChainAudit, ViaEvent, ViaMandateCredential } from './sdk.js';
import { buildDelegatedPoP, type ViaAgentKey } from './key-provider.js';
import type { CompiledLike, ExposurePolicy, ExtractedDraft, GuardVerifier, McpToolsList, VerifyOutcome } from './types.js';

/**
 * The EXACT params object both sides hash for the delegation PoP (A6 binding):
 * the parent signs `action: "delegate"` over these; the platform rebuilds them
 * byte-identically. Part of the wire contract — any divergence is an
 * `action_hash_mismatch` refusal.
 */
export function delegationParams(
  child: { tools: string[]; userParamValues: Record<string, unknown>; validUntil?: string },
  childKeyThumbprint: string,
): Record<string, unknown> {
  return {
    tools: child.tools,
    userParamValues: child.userParamValues,
    childKeyThumbprint,
    ...(child.validUntil ? { validUntil: child.validUntil } : {}),
  };
}

export interface JoinResult {
  bound: BoundKey;
  did: string;
  keyId: string;
  granted: { assurance: string; binding: string };
  degradedFrom?: string;
  snapshot: ActorSnapshot;
}

export class MiniPlatformClient {
  constructor(private readonly base: string) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(`platform ${path}: ${data.error ?? res.status}`);
    return data;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`);
    return (await res.json()) as T;
  }

  /**
   * §16.5 / v0.3 — join the platform: request a challenge, produce evidence from
   * the key PROVIDER, submit it. Registration IS actor genesis: the platform
   * verifies, grants (or degrades) the rung, mints the DID, writes
   * `ACTOR_REGISTERED`, and returns the first snapshot.
   */
  async join(name: string, key: ViaAgentKey): Promise<JoinResult> {
    const { regNonce } = await this.post<{ regNonce: string }>('/api/register-challenge', {});
    const evidence = await key.evidence(regNonce);
    // `cnf` rides alongside: ConfinementEvidence proves where a key lives, it does not carry
    // the key. For attestation the platform re-derives it from the document and cross-checks.
    return this.post('/api/join', { name, cnf: { jwk: key.publicJwk }, evidence, regNonce });
  }

  /** The platform extracts the guardrail DRAFT from the agent's tool surface. */
  extract(toolsList: McpToolsList, source: 'mcp' | 'langchain' | 'typebox' | 'hermes' = 'mcp'): Promise<ExtractedDraft> {
    return this.post('/api/extract', { toolsList, source });
  }

  /** The developer-completed manifest is compiled, pinned, and published. */
  publishAction(manifestYaml: string, exposure?: ExposurePolicy): Promise<{ actionId: string; digestSRI: string; compiled: CompiledLike }> {
    return this.post('/api/actions', { manifestYaml, exposure });
  }

  /** §9 — the ceremony runs platform-side; the agent receives its STAMPed mandate + pinned action. */
  requestMandate(input: {
    actionId: string;
    agentName: string;
    userParamValues: Record<string, unknown>;
    validUntil?: string;
  }): Promise<{ mandate: ViaMandateCredential; compiled: CompiledLike }> {
    return this.post('/api/mandates', input);
  }

  revoke(mandateId: string, reason: string): Promise<{ revoked: string }> {
    return this.post('/api/revoke', { mandateId, reason });
  }

  /** §17.4 — surface a manager approval on the dashboard and poll until it's decided. */
  requestStepUp(mandateId: string, tool: string, amount: number | null): Promise<{ id: string }> {
    return this.post('/api/stepup/request', { mandateId, tool, amount });
  }
  stepUpStatus(id: string): Promise<{ decided: boolean | null }> {
    return this.get(`/api/stepup/${encodeURIComponent(id)}`);
  }

  // ── v0.3 actor lifecycle (agent-side self-service) ─────────────────────────

  /** The actor's current snapshot + chain (what the dashboard also reads). */
  actor(did: string): Promise<{ snapshot: ActorSnapshot; chain: ViaEvent[] }> {
    return this.get(`/api/actor/${encodeURIComponent(did)}`);
  }

  /** The audit primitive over HTTP: signatures + re-fold-and-diff. */
  actorAudit(did: string): Promise<{ ok: boolean; fold: { ok: boolean; reason?: string } }> {
    return this.get(`/api/actor/audit/${encodeURIComponent(did)}`);
  }

  /**
   * D7 rotation, agent-side: the agent mints a fresh key in ITS provider,
   * proves it with fresh §16.5 evidence, and the platform links the succession.
   * The mandate does not change — that is the point.
   */
  async rotateKey(did: string, newKey: ViaAgentKey): Promise<{ keyId: string; predecessorId: string }> {
    const { regNonce } = await this.post<{ regNonce: string }>('/api/register-challenge', {});
    const evidence = await newKey.evidence(regNonce);
    return this.post('/api/actor/rotate', { did, evidence, regNonce });
  }

  /** Fresh attestation evidence for one key — updates the pointer + `verifiedAt`. */
  renewAttestation(did: string, keyId: string): Promise<{ ok: true }> {
    return this.post('/api/actor/attest-renew', { did, keyId });
  }

  // ── v0.3 delegation (the full ceremony, parent-side) ───────────────────────

  /**
   * Spawn a sub-agent: the PARENT authorizes with a PoP over the exact
   * delegation terms (its key never leaves its provider); the CHILD proves its
   * own fresh key; the platform refuses anything that is not a strict narrowing.
   */
  async delegate(input: {
    parentMandateId: string;
    parentKey: ViaAgentKey;
    childKey: ViaAgentKey;
    tools: string[];
    userParamValues: Record<string, unknown>;
    validUntil?: string;
  }): Promise<{ mandate: ViaMandateCredential; childDid: string; childKeyId: string }> {
    const { nonce, aud } = await this.post<{ nonce: string; aud: string }>('/api/delegate-challenge', {});
    const { regNonce } = await this.post<{ regNonce: string }>('/api/register-challenge', {});
    const evidence = await input.childKey.evidence(regNonce);
    const spec = { tools: input.tools, userParamValues: input.userParamValues, ...(input.validUntil ? { validUntil: input.validUntil } : {}) };
    // The thumbprint comes from the KEY, not the evidence: `ConfinementEvidence` carries only what
    // proves confinement, never the key itself (an attestation's key is derived from the document).
    const params = delegationParams(spec, jwkThumbprint(cleanPublicJwk(input.childKey.publicJwk)));
    const pop = await buildDelegatedPoP(
      {
        cnf: { jkt: jwkThumbprint(input.parentKey.publicJwk) },
        aud,
        nonce,
        iat: Math.floor(Date.now() / 1000),
        action_hash: actionHash(input.parentMandateId, 'delegate', params),
      },
      input.parentKey.sign,
    );
    return this.post('/api/delegate', {
      parentMandateId: input.parentMandateId,
      pop,
      child: { cnf: { jwk: input.childKey.publicJwk }, evidence, regNonce, ...spec },
    });
  }

  // ── chain reads + the guard transport ──────────────────────────────────────

  chain(mandateId: string): Promise<{ chain: ViaEvent[] }> {
    return this.get(`/api/chain/${encodeURIComponent(mandateId)}`);
  }

  audit(mandateId: string): Promise<ChainAudit> {
    return this.get(`/api/audit/${encodeURIComponent(mandateId)}`);
  }

  /** The HTTP `GuardVerifier` — plug into `ViaGuard` unchanged; only PoPs travel. */
  verifierFor(mandateId: string): GuardVerifier {
    return {
      challenge: () => this.post<{ nonce: string; aud: string; ttlMs: number }>('/api/challenge', { mandateId }),
      verify: (input) =>
        this.post<VerifyOutcome>('/api/verify', {
          mandateId,
          tool: input.tool,
          params: input.params,
          pop: input.pop,
          stepUpSatisfied: input.stepUpSatisfied,
        }),
      reportOutcome: (input) =>
        this.post<{ recorded: ViaEvent } | { rejected: string }>('/api/outcome', {
          mandateId,
          decisionEventId: input.decisionEventId,
          outcome: input.outcome,
          error: input.error,
          pop: input.pop,
        }),
    };
  }
}

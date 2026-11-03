/**
 * One agent's world for a test: a project directory with the agent's key and `.env`, the fake connector deciding
 * on a policy, served on HTTP for processes the agent starts, and the agent's `via()` in this process. In-process
 * and out-of-process calls land in one record (`decisions`, `outcomes`, `declared`).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { storedSoftwareKey, type StoredKey } from '../../src/key-provider.js';
import { createTestVerifier, type TestAccess, type TestDecision, type TestOutcome } from '../../src/testing.js';
import { via, type Via } from '../../src/via.js';
import { fakeConnector, serveConnector, withCallProof, type FakeConnector } from './connector.js';

export const AGENT_DID = 'did:web:humanos.tech:agent:test';

/** The built CLI: what a routed stdio entry runs here, in place of `npx --no-install humanos-agent`. */
export const BIN = fileURLToPath(new URL('../../dist/bin/humanos-agent.js', import.meta.url));
export const PROXY = { command: process.execPath, args: [BIN, 'proxy'] } as const;

/** Test credentials, for the fake connector only. */
const CREDENTIALS = { apiKey: 'hk_test_local', signatureSecret: 'test-signature-secret' };

export interface AgentScene {
  via: Via;
  key: StoredKey;
  humanos: FakeConnector;
  decisions: TestDecision[];
  outcomes: TestOutcome[];
  /** The project directory, with `.env` and `.humanos/agent-key.json`. */
  dir: string;
  /** The variables a process the agent starts needs: the served connector, the credentials, the key's directory. */
  env: Record<string, string>;
  close(): Promise<void>;
}

/** `reported`: what `get_policy` says of a tool when it is not what the verifier decides by (a Restrict control the test verifier has no form of). */
export async function agentScene(policy: Record<string, TestAccess>, options: { callProof?: boolean; reported?: Record<string, string> } = {}): Promise<AgentScene> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-project-'));
  const home = join(dir, '.humanos');
  mkdirSync(home, { mode: 0o700 });
  const key = await storedSoftwareKey(join(home, 'agent-key.json'));
  key.save(AGENT_DID);

  const t = createTestVerifier({ rules: [], userParams: {}, agentKey: key, policy: { tools: policy } });
  const humanos = fakeConnector(options.callProof ? withCallProof(t.verifier) : t.verifier, AGENT_DID, { ...policy, ...options.reported });
  const served = await serveConnector(humanos, CREDENTIALS);
  const env = {
    HUMANOS_API_KEY: CREDENTIALS.apiKey,
    HUMANOS_SIGNATURE_SECRET: CREDENTIALS.signatureSecret,
    HUMANOS_MCP_URL: served.url,
    HUMANOS_DIR: home,
  };
  writeFileSync(join(dir, '.env'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');

  const v = await via({ client: humanos.client, key, env: {}, dir: home, onWarning: () => {} });
  return { via: v, key, humanos, decisions: t.decisions, outcomes: t.outcomes, dir, env, close: () => served.close() };
}

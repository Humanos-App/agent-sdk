/**
 * VIA() — an agent's Humanos, set up from its environment: what `humanos-agent init` leaves behind, read back.
 *
 * One call gives a framework adapter everything it needs: the connector (`HUMANOS_API_KEY`,
 * `HUMANOS_SIGNATURE_SECRET`), the agent's key (`HUMANOS_AGENT_KEY`, else `.humanos/agent-key.json`), its DID
 * (registering the key when it has none yet), the guard every call goes through, and the registry its tools are
 * declared through. The variables come from the process environment over the `.env` in the working directory, as
 * `node --env-file` reads it: a variable already set wins.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { ViaGuard } from './guard.js';
import { softwareKeyFromJson, storedSoftwareKey, type StoredKey, type ViaAgentKey } from './key-provider.js';
import { createViaMcpClient, type ViaMcpClient } from './mcp/client.js';
import { McpGuardVerifier, policyMandates } from './mcp/guard-verifier.js';
import { registerAgent } from './mcp/register.js';
import { ToolRegistry } from './mcp/tool-registry.js';
import { createViaMcp, type ViaMcp } from './mcp/transport.js';

/** The Humanos MCP connector, when `HUMANOS_MCP_URL` names no other. */
export const HUMANOS_MCP_URL = 'https://mcp.humanos.tech/mcp';

export interface ViaOptions {
  /** The agent's project: where `.env` and `.humanos` are. Default: the working directory. */
  cwd?: string;
  /** The variables to read. Default: the process environment over the project's `.env`. */
  env?: Record<string, string | undefined>;
  /** Where the agent's key file lives. Default: `HUMANOS_DIR`, else `.humanos` in the project. */
  dir?: string;
  /** The agent's key, when it is kept elsewhere (a KMS, an enclave). Default: `HUMANOS_AGENT_KEY`, else the key file. */
  key?: ViaAgentKey;
  /** The connector, as given (not initialized again). Default: one built from the environment, and initialized. */
  client?: ViaMcpClient;
  /** The guard's mode. Default `enforce`. */
  mode?: 'observe' | 'enforce';
  /** Where warnings go: a declaration cut or refused. Default: stderr. */
  onWarning?: (message: string) => void;
}

export interface Via {
  client: ViaMcpClient;
  key: ViaAgentKey;
  did: string;
  /** Every tool call goes through it: `check` and `settle`, or `call`. */
  guard: ViaGuard;
  /** Every tool the adapters see is added here, and declared by service. */
  tools: ToolRegistry;
  /** MCP connections through Humanos: the connection wrapper, which tools it checks, and stdio routing. */
  mcp: ViaMcp;
}

let fromEnvironment: Promise<Via> | undefined;

/**
 * The agent's Humanos. Without options it is built once per process and shared, so every adapter in it declares
 * through one registry: two registries would each replace the other's lists. With options, each call builds anew.
 */
export function via(options?: ViaOptions): Promise<Via> {
  if (options) return build(options);
  fromEnvironment ??= build({}).catch((e: unknown) => {
    fromEnvironment = undefined; // a failed start (a missing variable, the connector down) may be retried
    throw e;
  });
  return fromEnvironment;
}

async function build(options: ViaOptions): Promise<Via> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? environment(cwd);
  const client = options.client ?? (await connect(env));
  const key = options.key ?? (await agentKey(env, cwd, options.dir));
  const did = await didOf(client, key);
  const guard = new ViaGuard({
    agentKey: key,
    agentDid: did,
    verifier: new McpGuardVerifier(client),
    mandates: policyMandates(client, did),
    ...(options.mode ? { mode: options.mode } : {}),
  });
  const warnings = options.onWarning ? { onWarning: options.onWarning } : {};
  const tools = new ToolRegistry(client, did, warnings);
  return { client, key, did, guard, tools, mcp: createViaMcp({ guard, tools, ...warnings }) };
}

/** The process environment over `.env`. */
export function environment(cwd: string = process.cwd()): Record<string, string | undefined> {
  const file = resolve(cwd, '.env');
  const fromFile = existsSync(file) ? (parseEnv(readFileSync(file, 'utf8')) as Record<string, string>) : {};
  return { ...fromFile, ...process.env };
}

async function connect(env: Record<string, string | undefined>): Promise<ViaMcpClient> {
  const client = createViaMcpClient({
    url: env.HUMANOS_MCP_URL || HUMANOS_MCP_URL,
    apiKey: required(env, 'HUMANOS_API_KEY'),
    signatureSecret: required(env, 'HUMANOS_SIGNATURE_SECRET'),
  });
  await client.initialize();
  return client;
}

async function agentKey(env: Record<string, string | undefined>, cwd: string, dir?: string): Promise<ViaAgentKey> {
  if (env.HUMANOS_AGENT_KEY) return softwareKeyFromJson(env.HUMANOS_AGENT_KEY);
  const home = agentDir(env, cwd, dir);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return storedSoftwareKey(join(home, 'agent-key.json'));
}

/** Where the agent's key file lives: `dir`, else `HUMANOS_DIR`, else `.humanos` in the project. */
export function agentDir(env: Record<string, string | undefined>, cwd: string = process.cwd(), dir?: string): string {
  return resolve(cwd, dir ?? (env.HUMANOS_DIR || '.humanos'));
}

/** The DID kept with the key, else the one registering it gives: the same key always answers the same DID. */
async function didOf(client: ViaMcpClient, key: ViaAgentKey): Promise<string> {
  const kept = isKept(key) ? key.did : undefined;
  if (kept) return kept;
  const { did } = await registerAgent(client, key);
  if (isKept(key)) key.save(did);
  return did;
}

function isKept(key: ViaAgentKey): key is StoredKey {
  return typeof (key as Partial<StoredKey>).save === 'function';
}

/** A variable `via` cannot start without; the message names it and never shows a value. */
function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`via: ${name} is not set (in the environment or .env); \`humanos-agent init\` adds it`);
  return value;
}

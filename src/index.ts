/**
 * `@humanos/agent-sdk` — what an agent builder installs.
 *
 * The VIA protocol (credentials, events, verification) lives in the VIA SDK;
 * this package is the AGENT SIDE of the wire: hold a key (provably — §16.5
 * evidence), join a platform (actor genesis), receive a mandate, and run every
 * tool call through the guard. Plus the MCP connector, so apps that speak MCP
 * (Claude Desktop, Cursor, …) get governed without changing a line.
 */
// Key custody + evidence (§16.5) — assurance is produced here, verified there.
export {
  softwareKey,
  custodialKey,
  attestedKey,
  forgedAttestedKey,
  buildDelegatedPoP,
  attestationRootPublicJwk,
} from './key-provider.js';
export type { ViaAgentKey, RegistrationEvidence, Assurance, Binding } from './key-provider.js';

// The PEP — every tool call: challenge → PoP → verify → execute/refuse/step-up.
export { ViaGuard, ViaDeniedError } from './guard.js';
export type { GuardOptions, GuardCallOutcome } from './guard.js';

// The platform transport + the delegation ceremony.
export { MiniPlatformClient, delegationParams } from './client.js';
export type { JoinResult } from './client.js';

// Two-phase outcome kinds (ACTION_COMPLETED / ACTION_FAILED).
export { AGENT_OUTCOME_EVENTS, asEventType, outcomeParams } from './events.js';
export type { AgentOutcomeKind } from './events.js';

// The MCP connector — govern any MCP-speaking app without changing it.
export { startViaMcpServer, defaultPlainReason } from './mcp/server.js';
export type { ViaMcpConfig, ViaMcpServer, JsonRpcMessage } from './mcp/server.js';
export { createStdioTransport } from './mcp/stdio.js';
export type { StdioTransport } from './mcp/stdio.js';

// The wire contract.
export type {
  VerifyOutcome,
  ExposurePolicy,
  CompiledLike,
  GuardVerifier,
  VerifyInput,
  ReportOutcomeInput,
  ChallengeGrant,
  McpTool,
  McpToolsList,
  ExtractedDraft,
} from './types.js';

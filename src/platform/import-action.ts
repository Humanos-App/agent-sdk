/**
 * Import an already-built agent's tool surface into the platform as a VIAAction DRAFT.
 *
 * This is the step between extraction and policy. `extractFromToolsList` reads the agent's tools
 * and derives names, parameter names, types and requiredness — never constraints (R8). This sends
 * that surface to the platform, which lands it as an unpublished action version. A human then
 * authors the rules in the dashboard and publishes.
 *
 * **Authorship of policy stays with the organization, deliberately.** Extraction supplies what
 * makes a rule *match*; it does not supply the limits. If the builder sent those too, an agent
 * would be widening its own constraints, and the signature over `userParams` would be protecting
 * a number the agent chose.
 *
 * Authenticated with the organization API key and signed exactly as `apps/api` requires — the same
 * scheme as `createViaMcpClient`, from the same function, so the two cannot drift apart.
 */
import { signRequest } from '../mcp/client.js';
import type { McpToolsList } from '../extract/mcp.js';

export interface ImportActionOptions {
  /** Platform API base, e.g. `https://api.humanos.tech`. */
  baseUrl: string;
  /** The organization API key, and its signing secret. */
  apiKey: string;
  signatureSecret: string;
  /** The agent this surface belongs to. Must be affiliated with the key's organization. */
  did: string;
  /** Action name. A re-import under the same name creates a NEW VERSION. */
  name: string;
  description?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface ImportActionResult {
  actionId: string;
  versionId?: string;
  /** False when this was a re-import that added a version to an existing action. */
  created: boolean;
}

/** The endpoint's tool shape — flattened from MCP's JSON Schema, which it does not need to parse. */
interface WireTool {
  name: string;
  description?: string;
  params: Record<string, { type: string; description?: string; required?: boolean }>;
}

/** JSON Schema → the flat `{type, description, required}` the platform stores per parameter. */
export function toWireTools(list: McpToolsList): WireTool[] {
  return list.tools.map((tool) => {
    const required = new Set(tool.inputSchema?.required ?? []);
    const params: WireTool['params'] = {};
    for (const [name, prop] of Object.entries(tool.inputSchema?.properties ?? {})) {
      params[name] = {
        type: prop.type ?? 'string',
        ...(prop.description ? { description: prop.description } : {}),
        ...(required.has(name) ? { required: true } : {}),
      };
    }
    return { name: tool.name, ...(tool.description ? { description: tool.description } : {}), params };
  });
}

export async function importActionDraft(
  list: McpToolsList,
  options: ImportActionOptions,
): Promise<ImportActionResult> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;

  // Serialise once and send the exact bytes signed — see the note in mcp/client.ts.
  const body = JSON.stringify({
    name: options.name,
    ...(options.description ? { description: options.description } : {}),
    tools: toWireTools(list),
  });
  const timestamp = now();

  const url = `${options.baseUrl.replace(/\/+$/, '')}/agents/${encodeURIComponent(options.did)}/actions`;
  const res = await doFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.apiKey}`,
      'x-timestamp': String(timestamp),
      'x-signature': signRequest(body, options.signatureSecret, timestamp),
    },
    body,
  });

  if (!res.ok) {
    // The platform's refusals here are informative — an unaffiliated DID, an empty surface, a
    // content shape it will not accept — so carry the text rather than just the status.
    const detail = await res.text().catch(() => '');
    throw new Error(`import failed: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
  }
  return (await res.json()) as ImportActionResult;
}

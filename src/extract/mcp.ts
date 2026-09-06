/**
 * `via init --framework mcp` — extraction from an MCP server's `tools/list`
 * result (PRD §6). Framework-independent: works on any MCP server, any
 * language, no code access. This module takes the tools/list JSON (in
 * production it would come from spawning the server over stdio); the golden
 * test feeds it the checked-in fixture and compares byte-for-byte (R9).
 *
 * R8: params + descriptions derived; `userParams`/`rules` ALWAYS empty —
 * constraints are policy and are never guessed. Heuristic candidates are
 * emitted as YAML comments (for the human) and as a structured sidecar
 * (for tooling — comments are not API).
 */

export interface McpToolProperty {
  type: string;
  description?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  enum?: unknown[];
  items?: { type?: string };
}

export interface McpTool {
  name: string;
  description?: string;
  /** Front-end extraction caveats (runtime-varying pieces) — carried into the draft as comments. */
  notes?: string[];
  inputSchema: {
    type: 'object';
    properties: Record<string, McpToolProperty>;
    required?: string[];
  };
}

export interface McpToolsList {
  serverName: string;
  tools: McpTool[];
}

export interface ExtractedDraft {
  yaml: string;
  /** Structured candidate annotations — the machine-readable twin of the comments. */
  candidates: Record<string, { tool?: string; params: Record<string, string> }>;
}

export interface ExtractOptions {
  /** Which extraction front-end produced the tools/list shape — changes only the provenance comment. */
  source?: 'mcp' | 'langchain' | 'typebox' | 'hermes';
}

const PROVENANCE: Record<NonNullable<ExtractOptions['source']>, string> = {
  mcp: 'from MCP server name',
  langchain: 'from module name',
  typebox: 'from TypeScript static scan (TypeBox tools)',
  hermes: 'from Hermes registry static scan',
};

const READ_VERBS = new Set(['search', 'check', 'get', 'list', 'read', 'lookup', 'fetch']);
const COMMIT_VERBS = new Set(['book', 'pay', 'send', 'sign', 'transfer', 'order', 'commit']);

const SUPPORTED: Record<string, string> = {
  string: 'string',
  number: 'number',
  integer: 'integer',
  boolean: 'boolean',
  array: 'array',
};

// A name at/over the column width still needs its separating space — otherwise
// `longParamName:{ type: … }` is a YAML compact-mapping error (safari finding).
const padTo = (s: string, width: number): string => (s.length >= width ? s + ' ' : s + ' '.repeat(width - s.length));

/** Safe-plain YAML keys stay bare; anything else is double-quoted. */
const yamlKey = (s: string): string => (/^[A-Za-z0-9_.-]+$/.test(s) ? s : JSON.stringify(s));

/**
 * Real tool descriptions contain newlines, `: `, and `#` (safari finding) —
 * emit as a double-quoted scalar whenever a plain scalar would misparse.
 */
const yamlText = (s: string): string => {
  const needsQuote =
    /[\n#]|: /.test(s) || /:$/.test(s) || /^[\s\-?:,[\]{}&*!|>'"%@`]/.test(s) || /\s$/.test(s);
  return needsQuote ? JSON.stringify(s) : s;
};

const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' ');

export function extractFromToolsList(list: McpToolsList, opts: ExtractOptions = {}): ExtractedDraft {
  const lines: string[] = [];
  const candidates: ExtractedDraft['candidates'] = {};
  let firstPattern = true;
  let firstEnum = true;
  const provenance = PROVENANCE[opts.source ?? 'mcp'];

  lines.push('via: "0.2"');
  lines.push(`${padTo(`action_name: ${list.serverName}`, 38)}# ${provenance}; TODO: confirm Action name`);
  lines.push('tools:');

  for (const tool of list.tools) {
    const toolCandidates: { tool?: string; params: Record<string, string> } = { params: {} };
    lines.push(`  ${yamlKey(tool.name)}:`);
    if (tool.description) lines.push(`    description: ${yamlText(tool.description)}`);
    for (const note of tool.notes ?? []) lines.push(`    # note: ${oneLine(note)}`);
    lines.push('    params:');

    const required = new Set(tool.inputSchema.required ?? []);
    for (const [param, prop] of Object.entries(tool.inputSchema.properties)) {
      const type = SUPPORTED[prop.type] ?? 'string';
      const value = `{ type: ${type}, required: ${required.has(param)} }`;
      const enumValues = Array.isArray(prop.enum) ? prop.enum.filter((v) => v !== null && v !== undefined) : [];

      let comment = '';
      if (prop.pattern) {
        // §6.1 params carry no pattern — preserved as a comment + candidate rule (R8).
        comment = `# pattern ${prop.pattern} → candidate rule${firstPattern ? ' (no param-level pattern in §6.1)' : ''}`;
        firstPattern = false;
        toolCandidates.params[param] = `pattern:${prop.pattern}`;
      } else if (enumValues.length > 0) {
        // §6.1 params carry no enum either (safari: the #1 loss in real repos) —
        // preserved as a comment + candidate values rule.
        const shown = enumValues.slice(0, 3).join('|') + (enumValues.length > 3 ? `|…(${enumValues.length})` : '');
        comment = `# enum ${shown} → candidate values rule${firstEnum ? ' (no param-level enum in §6.1)' : ''}`;
        firstEnum = false;
        toolCandidates.params[param] = `enum:${enumValues.join('|')}`;
      } else if (prop.type === 'object' || (prop.type === 'array' && prop.items?.type === 'object')) {
        // Nested shapes are normal in real repos — flat §6.1 cannot carry them;
        // the gateway-side toolShapes sidecar (§9.2) is their home.
        comment = `# nested ${prop.type === 'object' ? 'object' : 'array of objects'} → toolShapes (§9.2), flattened here`;
        toolCandidates.params[param] = prop.type === 'object' ? 'shape:object' : 'shape:array-of-objects';
      } else if (param.endsWith('_id')) {
        comment = '# candidate scope (id param)';
        toolCandidates.params[param] = 'scope';
      } else if (type === 'number' || type === 'integer') {
        comment = '# candidate limit (numeric)';
        // Bounds ride the structured sidecar (comments stay stable): limit:min..max.
        toolCandidates.params[param] =
          prop.minimum !== undefined || prop.maximum !== undefined
            ? `limit:${prop.minimum ?? ''}..${prop.maximum ?? ''}`
            : 'limit';
      }

      const key = padTo(`${yamlKey(param)}:`, 12);
      lines.push(comment ? `      ${key}${value}   ${comment}` : `      ${key}${value}`);
    }

    // Real repos namespace tool names (yb_send_sticker, feishu_drive_reply_comment):
    // the verb is the first TOKEN that matches, not necessarily the first token.
    const verb = tool.name.split('_').find((t) => READ_VERBS.has(t) || COMMIT_VERBS.has(t)) ?? '';
    if (READ_VERBS.has(verb)) {
      lines.push('    # candidate: advisory (read-only verb)');
      toolCandidates.tool = 'advisory';
    } else if (COMMIT_VERBS.has(verb)) {
      lines.push(`    # candidate: step_up + agent_floor (commit verb "${verb}")`);
      toolCandidates.tool = 'step_up+agent_floor';
    }
    lines.push('');
    candidates[tool.name] = toolCandidates;
  }

  lines.push(`${padTo('userParams: {}', 38)}# TODO: declare mandate-side knobs (locked at issuance)`);
  lines.push(`${padTo('rules: []', 38)}# TODO: author conditions; CEL is generated (§6.2), never hand-written`);

  return { yaml: lines.join('\n') + '\n', candidates };
}

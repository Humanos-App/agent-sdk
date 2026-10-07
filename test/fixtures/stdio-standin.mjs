// A stand-in MCP server over stdio, for the upstream client's transport tests: one tool, and every
// call echoed back so the test can see exactly what reached the server. Echoing "grow" adds a tool.
import { createInterface } from 'node:readline';
const tools = [{ name: 'echo', description: 'Echo the arguments', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } }];
const write = (m) => process.stdout.write(JSON.stringify(m) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') return write({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'standin', version: '0' } } });
  if (m.method === 'notifications/initialized') return;
  if (m.method === 'tools/list') return write({ jsonrpc: '2.0', id: m.id, result: { tools } });
  if (m.method === 'tools/call') {
    // `grow` adds a tool, and the server says so before it answers, as a server whose tools change does.
    if (m.params.arguments.text === 'grow') {
      tools.push({ name: 'echo2', inputSchema: { type: 'object', properties: {} } });
      write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    }
    return write({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `echo:${JSON.stringify(m.params.arguments)}` }] } });
  }
  if (m.id !== undefined) write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } });
});

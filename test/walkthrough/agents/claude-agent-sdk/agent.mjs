// A Claude Agent SDK agent with no Humanos code: it lists the files here, then writes hello.txt.
import { existsSync } from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';

if (existsSync('.env')) process.loadEnvFile('.env'); // the agent's own .env, as most agents load one

const prompt = process.argv[2] ?? 'List the files in this folder with the Bash tool, then use the Write tool to write hello.txt containing "hi". Then say in one sentence what you did.';
for await (const m of query({ prompt, options: { allowedTools: ['Bash', 'Write'], maxTurns: 8, model: 'claude-haiku-5-5' } })) {
  if (m.type === 'assistant') {
    for (const c of m.message.content) {
      if (c.type === 'text') console.log(`agent: ${c.text}`);
      if (c.type === 'tool_use') console.log(`tool call: ${c.name} ${JSON.stringify(c.input)}`);
    }
  }
  if (m.type === 'user' && Array.isArray(m.message.content)) {
    for (const c of m.message.content) if (c.type === 'tool_result') console.log(`tool result${c.is_error ? ' (error)' : ''}: ${JSON.stringify(c.content).slice(0, 200)}`);
  }
  if (m.type === 'result') console.log(`result: ${m.subtype}`);
}

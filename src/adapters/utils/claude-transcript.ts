/**
 * The step behind a Claude tool call (#654), read from the session's own transcript: the assistant message holding the
 * `tool_use` block names the model that answered, its id and its tokens. A local file, read from its end, never the
 * network.
 */
import { open } from 'node:fs/promises';
import type { StepReport } from '../../context.js';

/** How much of the transcript's end is read: the call's message was written last. */
const TAIL_BYTES = 1 << 20;

type Usage = { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };
type Entry = { type?: string; message?: { id?: string; model?: string; stop_reason?: string | null; usage?: Usage; content?: { type?: string; id?: string }[] } };

/** How often the transcript is read again while the call's message is not in it yet. */
const POLL_MS = 10;

/**
 * The assistant message that asked for `toolUseId`; none when the transcript cannot be read or does not hold it within
 * `waitMs`. A hook in code runs before Claude writes the message (about 70 ms on a local run); a hook command, after.
 */
export async function transcriptStep(path: string | undefined, toolUseId: string | undefined, waitMs = 0): Promise<StepReport | undefined> {
  if (!path || !toolUseId) return undefined;
  const until = Date.now() + waitMs;
  for (;;) {
    const found = await _find(path, toolUseId);
    if (found || Date.now() >= until) return found;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function _find(path: string, toolUseId: string): Promise<StepReport | undefined> {
  const tail = await _tail(path).catch(() => undefined);
  if (!tail) return undefined;
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.includes(toolUseId)) continue;
    const message = _parse(lines[i]!)?.message;
    if (!message?.content?.some((b) => b.type === 'tool_use' && b.id === toolUseId)) continue;
    return _report(message);
  }
  return undefined;
}

async function _tail(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

function _parse(line: string): Entry | undefined {
  try {
    const entry = JSON.parse(line) as Entry;
    return entry.type === 'assistant' ? entry : undefined;
  } catch {
    return undefined; // the first line of a cut tail, or one being written
  }
}

/** Input counts the cached tokens too: what the model was sent. Output is partial while the response still streams. */
function _report(message: NonNullable<Entry['message']>): StepReport {
  const u = message.usage;
  const input = u && [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens].reduce<number>((sum, n) => sum + (n ?? 0), 0);
  return {
    ...(message.model ? { answered: message.model } : {}),
    ...(message.id
      ? {
          step: {
            id: message.id,
            ...(u ? { inputTokens: input } : {}),
            ...(u?.output_tokens !== undefined ? { outputTokens: u.output_tokens } : {}),
            ...(message.stop_reason == null ? { outputPartial: true } : {}),
          },
        }
      : {}),
  };
}

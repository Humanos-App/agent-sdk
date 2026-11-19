/**
 * The AI SDK middleware `aiSdk().model()` adds (#654): from each response of the wrapped model it reads which model
 * answered, the response's id and its tokens, and files them under every tool call the response asks for. Read from
 * the response already in memory, never the network.
 */
import type { wrapLanguageModel } from 'ai';
import type { StepLedger, StepReport } from '../../context.js';

/** One response of the wrapped model, as each call it asked for finds it; `done` once its tokens are in. */
export interface ModelStep extends StepReport {
  provider?: string;
  done: Promise<void>;
}

// Read from `wrapLanguageModel` itself: AI SDK 5, 6 and 7 each type the model and the middleware differently.
type WrapOptions = Parameters<typeof wrapLanguageModel>[0];
/** A model the installed AI SDK can wrap. */
export type WrappableModel = WrapOptions['model'];
type Middleware = Exclude<WrapOptions['middleware'], readonly unknown[]>;
type Wrapped = NonNullable<Middleware['wrapStream']>;
type StreamPart = Awaited<ReturnType<Wrapped>>['stream'] extends ReadableStream<infer P> ? P : never;
type Seen = { type: string; toolCallId?: string; usage?: unknown; id?: string; modelId?: string };
type ModelInfo = { provider?: string; modelId?: string };
type ResponseInfo = { id?: string; modelId?: string };

/** The middleware that files each response's model and tokens under the tool calls it asks for. */
export function reportingMiddleware(steps: StepLedger<ModelStep>): Middleware {
  return {
    // AI SDK 6 requires the field, 7 accepts it and 5 has none: spread, so 5 does not reject it as unknown.
    ...{ specificationVersion: 'v3' as const },
    wrapGenerate: async ({ doGenerate, model }) => {
      const result = await doGenerate();
      const step = _stepOf(model, result.response, result.usage, Promise.resolve());
      for (const part of result.content as Seen[]) if (part.type === 'tool-call' && part.toolCallId) steps.put(part.toolCallId, step);
      return result;
    },
    // A streamed call can run before its step's `finish`: the step is filed at the call and its tokens added at the finish.
    wrapStream: async ({ doStream, model }) => {
      const { stream, ...rest } = await doStream();
      let finish = (): void => {};
      const done = new Promise<void>((resolve) => (finish = resolve));
      let response: ResponseInfo = {};
      let step: ModelStep | undefined;
      const watched = stream.pipeThrough(
        new TransformStream<StreamPart, StreamPart>({
          transform(part, controller) {
            const p = part as Seen;
            if (p.type === 'response-metadata') response = { id: p.id ?? response.id, modelId: p.modelId ?? response.modelId };
            if (p.type === 'tool-call' && p.toolCallId) {
              step ??= _stepOf(model, response, undefined, done);
              steps.put(p.toolCallId, step);
            }
            if (p.type === 'finish') {
              if (step?.step) Object.assign(step.step, _tokensOf(p.usage));
              finish();
            }
            controller.enqueue(part);
          },
          flush: () => finish(),
        }),
      );
      return { stream: watched, ...rest };
    },
  };
}

function _stepOf(model: ModelInfo, response: ResponseInfo | undefined, usage: unknown, done: Promise<void>): ModelStep {
  return {
    ...(model.modelId ? { requested: model.modelId } : {}),
    ...(response?.modelId ? { answered: response.modelId } : {}),
    // A provider that names no response still gets a step id, so its calls count their tokens once.
    step: { id: response?.id ?? globalThis.crypto.randomUUID(), ..._tokensOf(usage) },
    ...(model.provider ? { provider: model.provider } : {}),
    done,
  };
}

function _tokensOf(usage: unknown): { inputTokens?: number; outputTokens?: number } {
  const u = usage as { inputTokens?: unknown; outputTokens?: unknown } | undefined;
  const input = _count(u?.inputTokens);
  const output = _count(u?.outputTokens);
  return { ...(input !== undefined ? { inputTokens: input } : {}), ...(output !== undefined ? { outputTokens: output } : {}) };
}

/** A count as AI SDK 5 gives it (a number) or as 6 and later do (`{ total }`). */
function _count(n: unknown): number | undefined {
  if (typeof n === 'number') return n;
  const total = (n as { total?: unknown } | undefined)?.total;
  return typeof total === 'number' ? total : undefined;
}

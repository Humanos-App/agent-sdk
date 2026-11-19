/**
 * The step behind a LangChain tool call (#654): the `AIMessage` that asked for it names the model that answered (in
 * `response_metadata`, under the name its provider uses), its id and its tokens (`usage_metadata`). Read from the
 * agent's own messages, never the network.
 */
import type { StepReport } from '../../context.js';

/** An `AIMessage`, as far as the step is read from it. */
export interface AskingMessage {
  id?: string;
  tool_calls?: { id?: string }[];
  response_metadata?: Record<string, unknown>;
  usage_metadata?: { input_tokens?: number; output_tokens?: number };
}

/** Where providers name the model in `response_metadata`: OpenAI `model_name`, Anthropic `model`, Bedrock `model_id`. */
const MODEL_KEYS = ['model_name', 'model', 'model_id'] as const;

/** The step a message reports, with the model the agent asked for when it is known. */
export function messageStep(message: AskingMessage, requested?: string): StepReport {
  const meta = message.response_metadata ?? {};
  const answered = MODEL_KEYS.map((k) => meta[k]).find((v): v is string => typeof v === 'string' && v.length > 0);
  const usage = message.usage_metadata;
  return {
    ...(requested ? { requested } : {}),
    ...(answered ? { answered } : {}),
    ...(message.id
      ? {
          step: {
            id: message.id,
            ...(usage?.input_tokens !== undefined ? { inputTokens: usage.input_tokens } : {}),
            ...(usage?.output_tokens !== undefined ? { outputTokens: usage.output_tokens } : {}),
          },
        }
      : {}),
  };
}

/** The message among the agent's that asked for `callId`, newest first. */
export function askingMessage(messages: unknown, callId: string | undefined): AskingMessage | undefined {
  if (!callId || !Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as AskingMessage;
    if (m?.tool_calls?.some((c) => c.id === callId)) return m;
  }
  return undefined;
}

/** The model a chat model was configured with, under the name its class uses. */
export function configuredModel(model: unknown): string | undefined {
  const m = model as { model?: unknown; modelName?: unknown; modelId?: unknown } | undefined;
  return [m?.model, m?.modelName, m?.modelId].find((v): v is string => typeof v === 'string' && v.length > 0);
}

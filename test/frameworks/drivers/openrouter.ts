/**
 * OpenRouter, for real: AI SDK with `@openrouter/ai-sdk-provider`, so the model is any of OpenRouter's and the wire is
 * OpenRouter's OpenAI-compatible Chat Completions API. The tools go through `aiSdk().guard` exactly as with any other
 * AI SDK provider; this driver is what shows the adapter does not depend on the provider.
 */
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateText, stepCountIs, streamText } from 'ai';
import type { FrameworkDriver, RunContext } from '../contract.js';
import { toolsFor } from './ai-sdk.js';

const model = (ctx: RunContext) => {
  if (!ctx.openrouter) throw new Error('no OpenRouter model in this run');
  return createOpenRouter({ baseURL: ctx.openrouter.baseURL, apiKey: ctx.openrouter.apiKey })(ctx.openrouter.model);
};

export const openrouterGenerate: FrameworkDriver = {
  name: 'OpenRouter (AI SDK generateText)',
  callProofOverHttp: true,
  async run(ctx) {
    const { tools, close } = await toolsFor(ctx);
    try {
      await generateText({ model: model(ctx), tools, prompt: ctx.prompt, stopWhen: stepCountIs(5) });
    } finally {
      await close();
    }
  },
};

export const openrouterStream: FrameworkDriver = {
  name: 'OpenRouter (AI SDK streamText)',
  callProofOverHttp: true,
  async run(ctx) {
    const { tools, close } = await toolsFor(ctx);
    try {
      await streamText({ model: model(ctx), tools, prompt: ctx.prompt, stopWhen: stepCountIs(5), onError: () => {} }).consumeStream();
    } finally {
      await close();
    }
  },
};

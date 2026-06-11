import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { google } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { ProviderName } from './types';

const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8',
  openai: process.env.OPENAI_MODEL ?? 'gpt-5',
  google: process.env.GOOGLE_MODEL ?? 'gemini-3.1-pro-preview',
};

// Read once at module load time — avoids repeated synchronous disk reads on every request.
const CODEX_TOKEN: string | null = (() => {
  try {
    const authPath = path.join(os.homedir(), '.codex', 'auth.json');
    const raw = fs.readFileSync(authPath, 'utf8');
    const auth = JSON.parse(raw) as { tokens?: { access_token?: string } };
    return auth.tokens?.access_token ?? null;
  } catch {
    return null;
  }
})();

function isConfigured(provider: ProviderName): boolean {
  if (provider === 'anthropic') return Boolean(process.env.ANTHROPIC_API_KEY);
  if (provider === 'openai') return Boolean(process.env.OPENAI_API_KEY) || Boolean(CODEX_TOKEN);
  if (provider === 'google') return Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
  return false;
}

function modelFor(provider: ProviderName, modelId?: string): LanguageModel {
  const id = modelId ?? DEFAULT_MODELS[provider];
  switch (provider) {
    case 'anthropic':
      return anthropic(id);
    case 'openai': {
      if (!process.env.OPENAI_API_KEY && CODEX_TOKEN) return createOpenAI({ apiKey: CODEX_TOKEN })(id);
      return openai(id);
    }
    case 'google':
      return google(id);
  }
}

export function resolveModel(provider?: ProviderName, modelId?: string): LanguageModel {
  if (provider && isConfigured(provider)) {
    return modelFor(provider, modelId);
  }

  const order = (process.env.ROUTER_ORDER ?? 'anthropic,openai,google')
    .split(',')
    .map(s => s.trim() as ProviderName)
    .filter(isConfigured);

  if (order.length === 0) {
    throw new Error(
      'No LLM provider configured. Set at least one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY'
    );
  }

  // Use default model for the fallback provider, not the caller's provider-specific modelId.
  return modelFor(order[0]);
}

// Fast-model variants — smallest/cheapest tier of each provider, for auxiliary calls
// like Fast Apply. Reuses the module-level CODEX_TOKEN cache — no credential files
// are read outside this module.
const FAST_MODELS: Record<ProviderName, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-5-mini',
  google: 'gemini-3.5-flash',
};

export function resolveFastModel(provider?: ProviderName): LanguageModel {
  // Prefer the user's selected provider so billing stays consistent.
  if (provider && isConfigured(provider)) {
    return modelFor(provider, FAST_MODELS[provider]);
  }
  // Fallback: first configured provider in ROUTER_ORDER.
  const order = (process.env.ROUTER_ORDER ?? 'anthropic,openai,google')
    .split(',')
    .map(s => s.trim() as ProviderName)
    .filter(isConfigured);
  if (order.length === 0) {
    throw new Error('No LLM provider available for fast apply');
  }
  return modelFor(order[0], FAST_MODELS[order[0]]);
}

export function availableProviders(): ProviderName[] {
  const all: ProviderName[] = ['anthropic', 'openai', 'google'];
  return all.filter(isConfigured);
}

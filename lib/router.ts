import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { ProviderName, ApiKeys } from './types';

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

// Per-provider key resolution. BYOK keys (supplied per-request from the UI) win over
// server env vars, so a public deployment runs on the visitor's own credentials.
function keyFor(provider: ProviderName, keys?: ApiKeys): string | undefined {
  switch (provider) {
    case 'anthropic': return keys?.anthropic || process.env.ANTHROPIC_API_KEY || undefined;
    case 'openai': return keys?.openai || process.env.OPENAI_API_KEY || CODEX_TOKEN || undefined;
    case 'google': return keys?.google || process.env.GOOGLE_GENERATIVE_AI_API_KEY || undefined;
  }
}

function isConfigured(provider: ProviderName, keys?: ApiKeys): boolean {
  return Boolean(keyFor(provider, keys));
}

function modelFor(provider: ProviderName, modelId: string | undefined, keys?: ApiKeys): LanguageModel {
  const id = modelId ?? DEFAULT_MODELS[provider];
  const apiKey = keyFor(provider, keys);
  switch (provider) {
    case 'anthropic':
      return createAnthropic({ apiKey })(id);
    case 'openai':
      return createOpenAI({ apiKey })(id);
    case 'google':
      return createGoogleGenerativeAI({ apiKey })(id);
  }
}

function routerOrder(keys?: ApiKeys): ProviderName[] {
  return (process.env.ROUTER_ORDER ?? 'anthropic,openai,google')
    .split(',')
    .map(s => s.trim() as ProviderName)
    .filter(p => isConfigured(p, keys));
}

export function resolveModel(provider?: ProviderName, modelId?: string, keys?: ApiKeys): LanguageModel {
  if (provider && isConfigured(provider, keys)) {
    return modelFor(provider, modelId, keys);
  }

  const order = routerOrder(keys);
  if (order.length === 0) {
    throw new Error(
      'No LLM provider configured. Add an Anthropic, OpenAI, or Google API key (via the key panel in the UI or a server env var).'
    );
  }

  // Use default model for the fallback provider, not the caller's provider-specific modelId.
  return modelFor(order[0], undefined, keys);
}

// Fast-model variants — smallest/cheapest tier of each provider, for auxiliary calls
// like Fast Apply. Reuses the module-level CODEX_TOKEN cache — no credential files
// are read outside this module.
const FAST_MODELS: Record<ProviderName, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-5-mini',
  google: 'gemini-3.5-flash',
};

export function resolveFastModel(provider?: ProviderName, keys?: ApiKeys): LanguageModel {
  // Prefer the user's selected provider so billing stays consistent.
  if (provider && isConfigured(provider, keys)) {
    return modelFor(provider, FAST_MODELS[provider], keys);
  }
  // Fallback: first configured provider in ROUTER_ORDER.
  const order = routerOrder(keys);
  if (order.length === 0) {
    throw new Error('No LLM provider available for fast apply');
  }
  return modelFor(order[0], FAST_MODELS[order[0]], keys);
}

export function availableProviders(keys?: ApiKeys): ProviderName[] {
  const all: ProviderName[] = ['anthropic', 'openai', 'google'];
  return all.filter(p => isConfigured(p, keys));
}

import { NextResponse } from 'next/server';
import { availableProviders } from '@/lib/router';
import type { ProviderName } from '@/lib/types';

// Tells the client whether THIS deployment can run on its own server-side credentials.
// A public, key-less deployment returns serverReady:false, so the UI can nudge visitors to
// enter their own keys (BYOK). Also reports which providers have a server-side key, so the
// model picker can disable the rest instead of letting a visitor pick a model that silently
// falls back on the server. No secrets are exposed — only booleans.
export function GET() {
  const e2b = Boolean(process.env.E2B_API_KEY);
  const providers = availableProviders(); // env-configured providers only (no BYOK keys here)
  const configured: Record<ProviderName, boolean> = {
    anthropic: providers.includes('anthropic'),
    openai: providers.includes('openai'),
    google: providers.includes('google'),
    cerebras: providers.includes('cerebras'),
  };
  return NextResponse.json({ serverReady: e2b && providers.length > 0, providers: configured });
}

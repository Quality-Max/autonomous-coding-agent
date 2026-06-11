import { NextResponse } from 'next/server';
import { availableProviders } from '@/lib/router';

// Tells the client whether THIS deployment can run on its own server-side credentials.
// A public, key-less deployment returns serverReady:false, so the UI can nudge visitors to
// enter their own keys (BYOK). No secrets are exposed — only booleans.
export function GET() {
  const e2b = Boolean(process.env.E2B_API_KEY);
  const providers = availableProviders(); // env-configured providers only (no BYOK keys here)
  return NextResponse.json({ serverReady: e2b && providers.length > 0 });
}

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listServerTools, isSafeSSEUrl, getEnvServerConfig, SAFE_AUTH } from '@/lib/mcp';

// Two request shapes:
//  - User server: a full config — public http(s) URL (SSRF-guarded) + optional auth header.
//  - Env server: just a name; the URL/credential is resolved server-side so it never reaches
//    the client. `url` is therefore optional and its absence selects the env-lookup branch.
const ServerSchema = z.object({
  name: z.string().min(1).max(64),
  url: z.string().refine(isSafeSSEUrl, { message: 'URL must be a safe public http(s) endpoint' }).optional(),
  auth: z.string().regex(SAFE_AUTH).optional(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = ServerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 });
  }

  // No URL → must name an env-configured server, whose credential stays server-side.
  const { name, url, auth } = parsed.data;
  const config = url ? { name, url, auth } : getEnvServerConfig(name);
  if (!config) {
    return NextResponse.json({ error: 'Unknown server' }, { status: 400 });
  }

  try {
    const tools = await listServerTools(config);
    return NextResponse.json({ tools });
  } catch (err) {
    // Log only the message — the full Error can carry request headers/URL with auth tokens.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[mcp] Failed to list tools for "${name}":`, msg);
    return NextResponse.json({ error: 'Could not connect to server' }, { status: 502 });
  }
}

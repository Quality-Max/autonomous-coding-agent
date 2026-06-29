import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { startLivePreview, killPreviewSandbox } from '@/lib/preview';
import { killSandbox } from '@/lib/sandbox';
import { killPlaywrightVisualRun } from '@/lib/playwrightRunner';

// Creating a desktop sandbox + starting the stream takes a few seconds.
export const maxDuration = 60;

const CreateSchema = z.object({
  sessionId: z.string().min(1).max(128),
  url: z.string().url(),
  // BYOK: the visitor's E2B key for spinning up the desktop-preview sandbox.
  e2bKey: z.string().max(512).optional(),
});

// POST — user clicked the Desktop preview: spin up (or reuse) the session's desktop
// sandbox and open `url` in it. startLivePreview validates the URL (http(s) + non-private
// host) before it reaches the sandbox.
export async function POST(req: NextRequest) {
  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  try {
    const { streamUrl } = await startLivePreview(parsed.data.sessionId, parsed.data.url, parsed.data.e2bKey);
    return NextResponse.json({ streamUrl });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

const TeardownSchema = z.object({
  sessionId: z.string().min(1).max(128),
  e2bKey: z.string().max(512).optional(),
});

// DELETE — tear down every sandbox for the session (coding + desktop preview). Called when
// the user stops the run or starts a new session so nothing is left running.
export async function DELETE(req: NextRequest) {
  const parsed = TeardownSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  await Promise.allSettled([
    killSandbox(parsed.data.sessionId, parsed.data.e2bKey),
    killPreviewSandbox(parsed.data.sessionId, parsed.data.e2bKey),
    killPlaywrightVisualRun(parsed.data.sessionId, parsed.data.e2bKey),
  ]);
  return NextResponse.json({ ok: true });
}

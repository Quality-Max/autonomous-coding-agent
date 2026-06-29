import { generateText } from 'ai';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveModel } from '@/lib/router';
import {
  VISION_SYSTEM_PROMPT,
  VISION_USER_PROMPT,
  isMultimodalModel,
  decodeImageInput,
  extractTestCode,
  estimateCostUsd,
  tokensPerSecond,
} from '@/lib/vision';

// Recognition is a single fast call (no agent loop), so the short default is plenty.
export const maxDuration = 60;

// 8 MB cap on the decoded image — matches typical full-page screenshots while keeping
// the request body bounded. base64 inflates ~33%, hence the ~11 MB string cap.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const VisionRequestSchema = z.object({
  // Raw base64 OR a `data:image/...;base64,...` URI. Upload/paste only — no URL
  // fetching, so there is no SSRF surface here.
  imageBase64: z.string().min(16).max(12_000_000),
  instructions: z.string().max(4000).optional(),
  model: z.string().max(128).default('gemma-4-31b'),
  baselineModel: z.string().max(128).optional(),
  maxTokens: z.number().int().min(64).max(4096).default(1200),
  keys: z.object({ cerebras: z.string().max(512).optional() }).optional(),
});

type VisionResult = {
  model: string;
  provider: 'cerebras';
  ok: boolean;
  multimodal: boolean;
  sawScreenshot: boolean;
  testCode?: string;
  error?: string;
  accessPending?: boolean;
  elapsedMs: number;
  inputTokens?: number;
  outputTokens?: number;
  tokensPerSec?: number;
  costUsd?: number;
};

async function runOne(
  modelId: string,
  dataUri: string,
  instructions: string,
  maxTokens: number,
  keys: { cerebras?: string } | undefined,
): Promise<VisionResult> {
  const multimodal = isMultimodalModel(modelId);
  // Force the Cerebras provider (not the router's fallback) — the demo must show the
  // true result for the exact model, never a silently-swapped substitute.
  const model = resolveModel('cerebras', modelId, keys);

  // Only multimodal models get the screenshot; a text-only model would 400 on an image,
  // so it just gets the instruction (speed-only comparison).
  const userContent = multimodal
    ? ([
        { type: 'text', text: instructions },
        { type: 'image', image: dataUri },
      ] as const)
    : instructions;

  const t0 = Date.now();
  try {
    const res = await generateText({
      model,
      maxOutputTokens: maxTokens,
      temperature: 0,
      messages: [
        { role: 'system', content: VISION_SYSTEM_PROMPT },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { role: 'user', content: userContent as any },
      ],
    });
    const elapsedMs = Date.now() - t0;
    const inputTokens = res.usage?.inputTokens ?? 0;
    const outputTokens = res.usage?.outputTokens ?? 0;
    return {
      model: modelId,
      provider: 'cerebras',
      ok: true,
      multimodal,
      sawScreenshot: multimodal,
      testCode: extractTestCode(res.text),
      elapsedMs,
      inputTokens,
      outputTokens,
      tokensPerSec: tokensPerSecond(outputTokens, elapsedMs),
      costUsd: estimateCostUsd(modelId, inputTokens, outputTokens),
    };
  } catch (err) {
    const elapsedMs = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    const accessPending = /model_not_found|do not have access|not exist|404/i.test(msg);
    return { model: modelId, provider: 'cerebras', ok: false, multimodal, sawScreenshot: false, error: msg, accessPending, elapsedMs };
  }
}

export async function POST(req: NextRequest) {
  const parsed = VisionRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 });
  }
  const { imageBase64, instructions, model, baselineModel, maxTokens, keys } = parsed.data;

  if (!keys?.cerebras && !process.env.CEREBRAS_API_KEY) {
    return NextResponse.json(
      { error: 'No Cerebras key configured. Add CEREBRAS_API_KEY (server env) or your key in the UI.' },
      { status: 503 },
    );
  }

  const { base64, mediaType } = decodeImageInput(imageBase64);
  if (base64.length * 0.75 > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: 'Image exceeds 8 MB limit.' }, { status: 400 });
  }
  if (!/^image\//.test(mediaType)) {
    return NextResponse.json({ error: 'Uploaded data is not an image.' }, { status: 400 });
  }
  const dataUri = `data:${mediaType};base64,${base64}`;
  const userPrompt = instructions?.trim() || VISION_USER_PROMPT;

  const primary = await runOne(model, dataUri, userPrompt, maxTokens, keys);
  const baseline = baselineModel ? await runOne(baselineModel, dataUri, userPrompt, maxTokens, keys) : null;

  return NextResponse.json({ screenshot: dataUri, mediaType, primary, baseline });
}

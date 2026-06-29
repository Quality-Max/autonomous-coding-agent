// Cerebras × Gemma 4 "recognition" demo — pure helpers, no I/O.
//
// A multimodal model on Cerebras looks at a screenshot of a web page and writes a
// Playwright test for the primary flow it can see. These helpers are kept free of
// network/SDK calls so they can be unit-tested directly; the route in
// app/api/vision/route.ts wires them to the LLM.

// Models on Cerebras that can actually see an image. Sending an image to a text-only
// model (e.g. gpt-oss-120b) is a 400, so the route gates uploads on this.
const MULTIMODAL_MODELS = new Set(['gemma-4-31b']);

export function isMultimodalModel(model: string): boolean {
  return MULTIMODAL_MODELS.has(model) || model.toLowerCase().startsWith('gemma-4');
}

export const VISION_SYSTEM_PROMPT =
  'You are a senior QA automation engineer. You are shown a screenshot of a web page. ' +
  'Output ONLY a complete, runnable Playwright test in TypeScript that exercises the ' +
  'primary user flow visible in the screenshot. Prefer stable selectors (role, ' +
  'data-test, label) over brittle CSS. No prose, no markdown fences.';

export const VISION_USER_PROMPT =
  'Generate a Playwright test for the page in this screenshot. Cover the main ' +
  'interactive flow you can see (forms, primary buttons, navigation).';

// Approximate Cerebras pricing. Cerebras publishes a single blended per-MTok rate
// rather than a split in/out price, and the gemma-4-31b preview has no public price,
// so these are best-effort estimates for the demo's cost panel — not billing-grade.
const COST_PER_MTOK: Record<string, { input: number; output: number }> = {
  'gpt-oss-120b': { input: 0.25, output: 0.69 },
  'zai-glm-4.7': { input: 0.4, output: 1.2 },
  'gemma-4-31b': { input: 0.2, output: 0.2 },
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const rate = COST_PER_MTOK[model] ?? COST_PER_MTOK[model.toLowerCase()] ?? { input: 0.3, output: 0.6 };
  return (inputTokens / 1_000_000) * rate.input + (outputTokens / 1_000_000) * rate.output;
}

// Strip markdown code fences a model sometimes wraps around its output despite being
// told not to, so the result pane and any downstream runner get raw test source.
export function extractTestCode(raw: string): string {
  const text = (raw ?? '').trim();
  const fence = text.match(/```(?:[a-zA-Z]+)?\n([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  return text;
}

// Normalize an uploaded value (raw base64 OR a `data:...;base64,...` URI) into both a
// clean base64 payload and a media type, for re-embedding as a data URI to the model.
export function decodeImageInput(input: string): { base64: string; mediaType: string } {
  let mediaType = 'image/png';
  let data = (input ?? '').trim();
  if (data.startsWith('data:')) {
    const comma = data.indexOf(',');
    const header = data.slice(5, comma); // between "data:" and ","
    const semi = header.indexOf(';');
    if (semi > 0) mediaType = header.slice(0, semi) || mediaType;
    data = data.slice(comma + 1);
  }
  return { base64: data, mediaType };
}

export function tokensPerSecond(outputTokens: number, elapsedMs: number): number {
  return Math.round((outputTokens / Math.max(elapsedMs / 1000, 0.001)) * 10) / 10;
}
